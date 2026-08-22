export * as EvidenceLedger from "./evidence-ledger"

import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"

export interface Service {
  readonly used: (workflowID: string) => Promise<number>
  readonly reserve: (workflowID: string, bytes: number, limit: number) => Promise<boolean>
  readonly close: () => Promise<void>
}

export type Operation =
  | "open"
  | "pragma-journal"
  | "pragma-synchronous"
  | "pragma-busy-timeout"
  | "pragma-trusted-schema"
  | "schema"
  | "quick-check-prepare"
  | "quick-check-get"
  | "select-prepare"
  | "upsert-prepare"
  | "select-get"
  | "begin"
  | "upsert-run"
  | "commit"
  | "rollback"
  | "close"

export interface OpenOptions {
  readonly rootPolicy?: (canonicalLedgerRoot: string) => void
  readonly onBoundary?: (boundary: { readonly operation: Operation; readonly phase: "before" | "after" }) => void
}

/**
 * Bun SQLite accepts a pathname rather than an already verified no-follow descriptor. Production must replace this
 * fail-closed policy with an ACL check proving the host root is not writable by workspace or model-controlled code.
 */
export const productionRootPolicyRequired = (): never => {
  throw new TypeError(
    "Workflow host root must be ACL-owned and non-writable by workspace or model code; configure a deployment root policy",
  )
}

const databaseName = "evidence.sqlite"
const ownedFileNames = [databaseName, `${databaseName}-wal`, `${databaseName}-shm`] as const

export function open(root: string, options: OpenOptions = {}): Service {
  if (!path.isAbsolute(root)) throw new TypeError("Evidence ledger root must be absolute")
  if (options.rootPolicy === undefined) fs.mkdirSync(root, { recursive: true })
  else options.rootPolicy(path.resolve(root))
  const canonical = verifyRoot(root)
  guardRoot(canonical, options)
  const databasePath = path.join(canonical, databaseName)
  guardRoot(canonical, options)
  if (!fs.existsSync(databasePath)) {
    let descriptor: number | undefined
    try {
      guardRoot(canonical, options)
      descriptor = fs.openSync(databasePath, "wx", 0o600)
      fs.fsyncSync(descriptor)
    } catch (cause) {
      throw new TypeError("Evidence database could not be created exclusively", { cause })
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
  }
  guardRoot(canonical, options, true)

  return initializeDatabase(databasePath, canonical, options)
}

function initializeDatabase(databasePath: string, root: string, options: OpenOptions): Service {
  const database = checkedAcquire(
    root,
    options,
    "open",
    () => new Database(databasePath, { create: false, readwrite: true }),
    (acquired) => acquired.close(),
  )
  let transferred = false
  try {
    checked(root, options, "pragma-journal", () => database.run("PRAGMA journal_mode = WAL"))
    checked(root, options, "pragma-synchronous", () => database.run("PRAGMA synchronous = FULL"))
    checked(root, options, "pragma-busy-timeout", () => database.run("PRAGMA busy_timeout = 5000"))
    checked(root, options, "pragma-trusted-schema", () => database.run("PRAGMA trusted_schema = OFF"))
    checked(root, options, "schema", () =>
      database.run(`
        CREATE TABLE IF NOT EXISTS workflow_evidence (
          workflow_id TEXT PRIMARY KEY NOT NULL,
          evidence_bytes INTEGER NOT NULL
            CHECK(typeof(evidence_bytes) = 'integer')
            CHECK(evidence_bytes >= 0 AND evidence_bytes <= ${WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES})
        ) STRICT
      `),
    )
    const quickCheck = checked(root, options, "quick-check-prepare", () =>
      database.query<{ readonly quick_check: string }, []>("PRAGMA quick_check"),
    )
    const integrity = checked(root, options, "quick-check-get", () => quickCheck.get())
    if (integrity?.quick_check !== "ok") throw new Error("Evidence ledger integrity check failed")
    const select = checked(root, options, "select-prepare", () =>
      database.query<{ readonly evidence_bytes: number }, [string]>(
        "SELECT evidence_bytes FROM workflow_evidence WHERE workflow_id = ?",
      ),
    )
    const upsert = checked(root, options, "upsert-prepare", () =>
      database.query<unknown, [string, number]>(`
        INSERT INTO workflow_evidence (workflow_id, evidence_bytes) VALUES (?, ?)
        ON CONFLICT(workflow_id) DO UPDATE SET evidence_bytes = excluded.evidence_bytes
      `),
    )
    const service = makeService(
      root,
      options,
      database,
      (workflowID) => select.get(workflowID),
      (workflowID, evidenceBytes) => upsert.run(workflowID, evidenceBytes),
    )
    transferred = true
    return service
  } finally {
    if (!transferred) closeAfterFailure(root, options, database)
  }
}

function makeService(
  root: string,
  options: OpenOptions,
  database: Database,
  select: (workflowID: string) => { readonly evidence_bytes: number } | null,
  upsert: (workflowID: string, evidenceBytes: number) => unknown,
): Service {
  let closed = false

  const closeAfter = (cause: unknown): never => {
    closed = true
    closeAfterFailure(root, options, database)
    throw cause
  }
  const selectUsed = (workflowID: string): number => {
    const value = checked(root, options, "select-get", () => select(workflowID))?.evidence_bytes ?? 0
    if (!Number.isSafeInteger(value) || value < 0 || value > WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES) {
      throw new Error("Evidence ledger contains an invalid total")
    }
    return value
  }

  return {
    used: async (workflowID) => {
      try {
        if (closed) throw new Error("Evidence ledger is closed")
        if (typeof workflowID !== "string" || workflowID.length === 0) throw new TypeError("Workflow ID is required")
        return selectUsed(workflowID)
      } catch (cause) {
        return closeAfter(cause)
      }
    },
    reserve: async (workflowID, bytes, limit) => {
      try {
        if (closed) throw new Error("Evidence ledger is closed")
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || limit !== WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES) {
          throw new TypeError("Evidence reservation is not bounded")
        }
        checked(root, options, "begin", () => database.run("BEGIN IMMEDIATE"))
        try {
          const next = selectUsed(workflowID) + bytes
          if (next > limit) {
            checked(root, options, "rollback", () => database.run("ROLLBACK"))
            return false
          }
          checked(root, options, "upsert-run", () => upsert(workflowID, next))
          checked(root, options, "commit", () => database.run("COMMIT"))
          return true
        } catch (cause) {
          let failure = cause
          try {
            if (database.inTransaction) checked(root, options, "rollback", () => database.run("ROLLBACK"))
          } catch (rollbackCause) {
            failure = new AggregateError([cause, rollbackCause], "Evidence transaction and rollback failed")
          } finally {
            verifyOwnedFiles(root, true)
          }
          throw failure
        }
      } catch (cause) {
        return closeAfter(cause)
      }
    },
    close: async () => {
      if (closed) return
      closed = true
      try {
        checked(root, options, "close", () => database.close())
      } catch (cause) {
        closeAfterFailure(root, options, database)
        throw cause
      }
    },
  }
}

function checked<A>(root: string, options: OpenOptions, operation: Operation, work: () => A): A {
  guardRoot(root, options, true)
  options.onBoundary?.({ operation, phase: "before" })
  guardRoot(root, options, true)
  try {
    return work()
  } finally {
    guardRoot(root, options, true)
    options.onBoundary?.({ operation, phase: "after" })
    guardRoot(root, options, true)
  }
}

function guardRoot(root: string, options: OpenOptions, requireDatabase = false): void {
  verifyOwnedFiles(root, requireDatabase)
  options.rootPolicy?.(root)
  if (!samePath(verifyRoot(root), root)) throw new TypeError("Evidence ledger root policy changed identity")
  verifyOwnedFiles(root, requireDatabase)
}

function checkedAcquire<A extends object>(
  root: string,
  options: OpenOptions,
  operation: Operation,
  acquire: () => A,
  release: (acquired: A) => void,
): A {
  const owner: A[] = []
  try {
    const value = checked(root, options, operation, () => {
      const acquired = acquire()
      owner.push(acquired)
      return acquired
    })
    owner.pop()
    return value
  } catch (cause) {
    const acquired = owner.pop()
    if (acquired !== undefined) {
      try {
        release(acquired)
      } catch (releaseCause) {
        const acquireDetail = cause instanceof Error ? cause.message : String(cause)
        throw new Error(`Evidence ${operation} acquisition failed before release: ${acquireDetail}`, {
          cause: releaseCause,
        })
      }
    }
    throw cause
  }
}

function closeAfterFailure(root: string, options: OpenOptions, database: Database): void {
  try {
    checked(root, options, "close", () => database.close())
  } catch {
    try {
      database.close()
    } catch {
      // Best effort only: preserve the initiating ownership or SQLite failure.
    } finally {
      try {
        verifyOwnedFiles(root, true)
      } catch {
        // The initiating ownership failure remains authoritative.
      }
    }
  }
}

function verifyRoot(root: string): string {
  const expected = path.resolve(root)
  const canonical = fs.realpathSync.native(expected)
  const value = fs.lstatSync(expected)
  if (!value.isDirectory() || value.isSymbolicLink() || !samePath(canonical, expected)) {
    throw new TypeError("Evidence ledger root must be an owned directory")
  }
  return canonical
}

function verifyOwnedFiles(root: string, requireDatabase = false): void {
  if (!samePath(verifyRoot(root), root)) throw new TypeError("Evidence ledger root identity changed")
  for (const name of ownedFileNames) {
    const file = path.join(root, name)
    let value: fs.Stats
    try {
      value = fs.lstatSync(file)
    } catch (cause) {
      if (isMissing(cause) && (!requireDatabase || name !== databaseName)) continue
      throw cause
    }
    if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) {
      throw new TypeError("Evidence ledger files must be singly-owned regular files")
    }
    const canonical = fs.realpathSync.native(file)
    if (!samePath(canonical, file) || !samePath(path.dirname(canonical), root)) {
      throw new TypeError("Evidence ledger files must remain beneath the owned root")
    }
  }
}

function samePath(left: string, right: string): boolean {
  const first = path.resolve(left)
  const second = path.resolve(right)
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second
}

function isMissing(cause: unknown): boolean {
  return cause !== null && typeof cause === "object" && Reflect.get(cause, "code") === "ENOENT"
}
