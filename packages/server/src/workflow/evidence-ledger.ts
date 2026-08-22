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

const databaseName = "evidence.sqlite"
const ownedFileNames = [databaseName, `${databaseName}-wal`, `${databaseName}-shm`] as const

export function open(root: string): Service {
  if (!path.isAbsolute(root)) throw new TypeError("Evidence ledger root must be absolute")
  fs.mkdirSync(root, { recursive: true })
  const canonical = verifyRoot(root)
  const databasePath = path.join(canonical, databaseName)
  verifyOwnedFiles(canonical)
  if (!fs.existsSync(databasePath)) {
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(databasePath, "wx", 0o600)
      fs.fsyncSync(descriptor)
    } catch (cause) {
      throw new TypeError("Evidence database could not be created exclusively", { cause })
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
  }
  verifyOwnedFiles(canonical, true)

  const database = initializeDatabase(databasePath, canonical)
  const select = database.query<{ readonly evidence_bytes: number }, [string]>(
    "SELECT evidence_bytes FROM workflow_evidence WHERE workflow_id = ?",
  )
  const upsert = database.query<unknown, [string, number]>(`
    INSERT INTO workflow_evidence (workflow_id, evidence_bytes) VALUES (?, ?)
    ON CONFLICT(workflow_id) DO UPDATE SET evidence_bytes = excluded.evidence_bytes
  `)
  let closed = false

  const used = (workflowID: string): number => {
    if (closed) throw new Error("Evidence ledger is closed")
    if (typeof workflowID !== "string" || workflowID.length === 0) throw new TypeError("Workflow ID is required")
    verifyOwnedFiles(canonical, true)
    const value = select.get(workflowID)?.evidence_bytes ?? 0
    if (!Number.isSafeInteger(value) || value < 0 || value > WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES) {
      throw new Error("Evidence ledger contains an invalid total")
    }
    return value
  }

  return {
    used: async (workflowID) => used(workflowID),
    reserve: async (workflowID, bytes, limit) => {
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || limit !== WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES) {
        throw new TypeError("Evidence reservation is not bounded")
      }
      verifyOwnedFiles(canonical, true)
      database.run("BEGIN IMMEDIATE")
      try {
        const next = used(workflowID) + bytes
        if (next > limit) {
          database.run("ROLLBACK")
          verifyOwnedFiles(canonical, true)
          return false
        }
        upsert.run(workflowID, next)
        database.run("COMMIT")
        verifyOwnedFiles(canonical, true)
        return true
      } catch (cause) {
        if (database.inTransaction) database.run("ROLLBACK")
        throw cause
      }
    },
    close: async () => {
      if (closed) return
      verifyOwnedFiles(canonical, true)
      closed = true
      database.close()
      verifyOwnedFiles(canonical, true)
    },
  }
}

function initializeDatabase(databasePath: string, root: string): Database {
  const database = new Database(databasePath, { create: false, readwrite: true })
  try {
    verifyOwnedFiles(root, true)
    database.run("PRAGMA journal_mode = WAL")
    verifyOwnedFiles(root, true)
    database.run("PRAGMA synchronous = FULL")
    database.run("PRAGMA busy_timeout = 5000")
    database.run("PRAGMA trusted_schema = OFF")
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_evidence (
        workflow_id TEXT PRIMARY KEY NOT NULL,
        evidence_bytes INTEGER NOT NULL
          CHECK(typeof(evidence_bytes) = 'integer')
          CHECK(evidence_bytes >= 0 AND evidence_bytes <= ${WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES})
      ) STRICT
    `)
    verifyOwnedFiles(root, true)
    const integrity = database.query<{ readonly quick_check: string }, []>("PRAGMA quick_check").get()
    if (integrity?.quick_check !== "ok") throw new Error("Evidence ledger integrity check failed")
    verifyOwnedFiles(root, true)
    return database
  } catch (cause) {
    database.close()
    throw cause
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
