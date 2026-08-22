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

export function open(root: string): Service {
  if (!path.isAbsolute(root)) throw new TypeError("Evidence ledger root must be absolute")
  fs.mkdirSync(root, { recursive: true })
  const canonical = fs.realpathSync.native(root)
  const expected = path.resolve(root)
  const ownsCanonicalRoot =
    process.platform === "win32" ? canonical.toLowerCase() === expected.toLowerCase() : canonical === expected
  if (!ownsCanonicalRoot) throw new TypeError("Evidence ledger root must not be an alias")
  if (!fs.statSync(canonical).isDirectory()) throw new TypeError("Evidence ledger root must be a directory")
  const database = new Database(path.join(canonical, "evidence.sqlite"), { create: true, readwrite: true })
  database.run("PRAGMA journal_mode = WAL")
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
  const integrity = database.query<{ readonly quick_check: string }, []>("PRAGMA quick_check").get()
  if (integrity?.quick_check !== "ok") {
    database.close()
    throw new Error("Evidence ledger integrity check failed")
  }
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
      database.run("BEGIN IMMEDIATE")
      try {
        const next = used(workflowID) + bytes
        if (next > limit) {
          database.run("ROLLBACK")
          return false
        }
        upsert.run(workflowID, next)
        database.run("COMMIT")
        return true
      } catch (cause) {
        if (database.inTransaction) database.run("ROLLBACK")
        throw cause
      }
    },
    close: async () => {
      if (closed) return
      closed = true
      database.close()
    },
  }
}
