export * as EvidenceLedger from "./evidence-ledger"

import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"

export type Item = WorkflowVisualHost.EvidenceSummary & {
  readonly bytes?: Uint8Array
  readonly ownerNonce?: string
}

export type BeginCaptureResult =
  | { readonly status: "acquired" }
  | { readonly status: "ambiguous" }
  | { readonly status: "existing"; readonly item: Item }
  | { readonly status: "terminal"; readonly item: Item }

export interface Service {
  readonly used: (workflowID: string) => Promise<number>
  readonly reserve: (workflowID: string, bytes: number, limit: number) => Promise<boolean>
  readonly beginCapture: (input: {
    readonly coordinates: WorkflowVisualHost.EvidenceCoordinates
    readonly ownerNonce: string
    readonly now: number
  }) => Promise<BeginCaptureResult>
  readonly clearCapture: (input: {
    readonly coordinates: WorkflowVisualHost.EvidenceCoordinates
    readonly ownerNonce: string
  }) => Promise<boolean>
  readonly completeCapture: (input: {
    readonly receipt: WorkflowVisualHost.EvidenceReceipt
    readonly bytes: Uint8Array
    readonly ownerNonce: string
    readonly now: number
    readonly limit: number
  }) => Promise<Item>
  readonly get: (coordinates: WorkflowVisualHost.EvidenceCoordinates) => Promise<Item | undefined>
  readonly commit: (input: WorkflowVisualHost.BindEvidenceInput, now: number) => Promise<Item>
  readonly release: (input: WorkflowVisualHost.BindEvidenceInput, now: number) => Promise<Item>
  readonly abandon: (input: WorkflowVisualHost.AbandonEvidenceInput, now: number) => Promise<Item>
  readonly reconcile: (
    input: WorkflowVisualHost.ReconcileEvidenceInput,
    now: number,
  ) => Promise<WorkflowVisualHost.ReconcileEvidenceResult>
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
  | "select-item"
  | "list-items"
  | "begin"
  | "insert-capture"
  | "delete-capture"
  | "complete-capture"
  | "commit-item"
  | "release-item"
  | "abandon-item"
  | "upsert-run"
  | "commit"
  | "rollback"
  | "close"

export interface OpenOptions {
  readonly rootPolicy?: (canonicalLedgerRoot: string) => void
  readonly onBoundary?: (boundary: { readonly operation: Operation; readonly phase: "before" | "after" }) => void
}

/** Production supplies the reviewed ACL descriptor policy; tests may use a private D-drive fixture root. */
export const productionRootPolicyRequired = (): never => {
  throw new TypeError(
    "Workflow host root must be ACL-owned and non-writable by workspace or model code; configure a deployment root policy",
  )
}

const databaseName = "evidence.sqlite"
const ownedFileNames = [databaseName, `${databaseName}-wal`, `${databaseName}-shm`] as const
const sha256Pattern = /^[a-f0-9]{64}$/

interface FileIdentity {
  readonly dev: number
  readonly ino: number
  readonly birthtimeMs: number
}

interface EvidenceRow {
  readonly evidence_id: string
  readonly workflow_id: string
  readonly stage_id: string
  readonly preview_kind: string
  readonly revision: number
  readonly viewport_name: string
  readonly viewport_width: number
  readonly viewport_height: number
  readonly config_sha256: string
  readonly source_sha256: string
  readonly ready_selector_sha256: string
  readonly state: string
  readonly owner_nonce: string | null
  readonly png_blob: Uint8Array | null
  readonly png_sha256: string | null
  readonly evidence_bytes: number
  readonly receipt_json: string | null
  readonly artifact_json: string | null
  readonly abandonment_json: string | null
  readonly created_at: number
  readonly updated_at: number
}

interface State {
  readonly root: string
  readonly options: OpenOptions
  readonly database: Database
  readonly databaseIdentity: FileIdentity
  closed: boolean
}

class FatalEvidenceError extends Error {
  constructor(readonly detail: unknown) {
    super("Evidence ledger ownership, SQLite, or durable content validation failed", { cause: detail })
  }
}

export function open(root: string, options: OpenOptions = {}): Service {
  if (!path.isAbsolute(root)) throw new TypeError("Evidence ledger root must be absolute")
  const expectedRoot = path.resolve(root)
  if (options.rootPolicy === undefined) fs.mkdirSync(expectedRoot, { recursive: true })
  options.rootPolicy?.(expectedRoot)
  const canonical = verifyRoot(expectedRoot)
  verifyOwnedFiles(canonical)
  const databasePath = path.join(canonical, databaseName)
  if (!fs.existsSync(databasePath)) createDatabaseFile(canonical, databasePath)
  verifyOwnedFiles(canonical, true)
  const initialIdentity = fileIdentity(databasePath)
  const acquired: Database[] = []
  try {
    const database = checkedBoundary(canonical, options, initialIdentity, "open", () => {
      const handle = new Database(databasePath, { create: false, readwrite: true })
      acquired.push(handle)
      return handle
    })
    const state: State = {
      root: canonical,
      options,
      database,
      databaseIdentity: fileIdentity(databasePath),
      closed: false,
    }
    initialize(state)
    publicGuard(state)
    acquired.pop()
    return makeService(state)
  } catch (cause) {
    try {
      acquired.pop()?.close()
    } catch {
      // Best effort only; the initiating ownership/SQLite failure remains authoritative.
    }
    throw unwrapFatal(cause)
  }
}

function initialize(state: State): void {
  sql(state, "pragma-journal", () => state.database.run("PRAGMA journal_mode = WAL"))
  sql(state, "pragma-synchronous", () => state.database.run("PRAGMA synchronous = FULL"))
  sql(state, "pragma-busy-timeout", () => state.database.run("PRAGMA busy_timeout = 5000"))
  sql(state, "pragma-trusted-schema", () => state.database.run("PRAGMA trusted_schema = OFF"))
  sql(state, "schema", () =>
    state.database.run(`
      CREATE TABLE IF NOT EXISTS workflow_evidence (
        workflow_id TEXT PRIMARY KEY NOT NULL,
        evidence_bytes INTEGER NOT NULL
          CHECK(typeof(evidence_bytes) = 'integer')
          CHECK(evidence_bytes >= 0 AND evidence_bytes <= ${WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES})
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_evidence_item (
        evidence_id TEXT PRIMARY KEY NOT NULL,
        workflow_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        preview_kind TEXT NOT NULL CHECK(preview_kind IN ('reference', 'implementation')),
        revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
        viewport_name TEXT NOT NULL,
        viewport_width INTEGER NOT NULL CHECK(typeof(viewport_width) = 'integer' AND viewport_width > 0),
        viewport_height INTEGER NOT NULL CHECK(typeof(viewport_height) = 'integer' AND viewport_height > 0),
        config_sha256 TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        ready_selector_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('capturing', 'staged', 'committed', 'released', 'abandoned')),
        owner_nonce TEXT,
        png_blob BLOB,
        png_sha256 TEXT,
        evidence_bytes INTEGER NOT NULL CHECK(typeof(evidence_bytes) = 'integer' AND evidence_bytes >= 0),
        receipt_json TEXT,
        artifact_json TEXT,
        abandonment_json TEXT,
        created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= 0)
      ) STRICT
    `),
  )
  const quickCheck = sql(state, "quick-check-prepare", () =>
    state.database.query<{ readonly quick_check: string }, []>("PRAGMA quick_check"),
  )
  const integrity = sql(state, "quick-check-get", () => quickCheck.get())
  if (integrity?.quick_check !== "ok") throw new FatalEvidenceError(new Error("Evidence ledger integrity check failed"))
  sql(state, "select-prepare", () =>
    state.database.query<{ readonly evidence_bytes: number }, [string]>(
      "SELECT evidence_bytes FROM workflow_evidence WHERE workflow_id = ?",
    ),
  )
  sql(state, "upsert-prepare", () =>
    state.database.query<unknown, [string, number]>(`
      INSERT INTO workflow_evidence (workflow_id, evidence_bytes) VALUES (?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET evidence_bytes = excluded.evidence_bytes
    `),
  )
}

function makeService(state: State): Service {
  return {
    used: async (workflowID) => operate(state, () => selectUsed(state, validateWorkflowID(workflowID))),
    reserve: async (workflowID, bytes, limit) =>
      operate(state, () => {
        const owner = validateWorkflowID(workflowID)
        validateReservation(bytes, limit)
        return transaction(state, () => {
          const next = selectUsed(state, owner) + bytes
          if (next > limit) return false
          setUsed(state, owner, next)
          return true
        })
      }),
    beginCapture: async (input) =>
      operate(state, () => {
        const coordinates = WorkflowVisualHost.validateEvidenceCoordinates(input.coordinates)
        const ownerNonce = validateOwnerNonce(input.ownerNonce)
        const now = validateTimestamp(input.now)
        const id = WorkflowVisualHost.evidenceID(coordinates)
        return transaction(state, () => {
          const existing = readItem(state, id)
          if (existing !== undefined) {
            assertCoordinates(existing.coordinates, coordinates)
            if (existing.state === "capturing") {
              return existing.ownerNonce === ownerNonce ? { status: "acquired" } : { status: "ambiguous" }
            }
            return existing.state === "released" || existing.state === "abandoned"
              ? { status: "terminal", item: existing }
              : { status: "existing", item: existing }
          }
          const result = sql(state, "insert-capture", () =>
            state.database.run(
              `INSERT INTO workflow_evidence_item (
                evidence_id, workflow_id, stage_id, preview_kind, revision,
                viewport_name, viewport_width, viewport_height,
                config_sha256, source_sha256, ready_selector_sha256,
                state, owner_nonce, evidence_bytes, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'capturing', ?, 0, ?, ?)`,
              [
                id,
                coordinates.workflowID,
                coordinates.stageID,
                coordinates.kind,
                coordinates.revision,
                coordinates.viewport.name,
                coordinates.viewport.width,
                coordinates.viewport.height,
                coordinates.configSha256,
                coordinates.sourceSha256,
                coordinates.readySelectorSha256,
                ownerNonce,
                now,
                now,
              ],
            ),
          )
          if (result.changes !== 1) throw new FatalEvidenceError(new Error("Capture intent insert was not exact"))
          return { status: "acquired" }
        })
      }),
    clearCapture: async (input) =>
      operate(state, () => {
        const coordinates = WorkflowVisualHost.validateEvidenceCoordinates(input.coordinates)
        const ownerNonce = validateOwnerNonce(input.ownerNonce)
        const id = WorkflowVisualHost.evidenceID(coordinates)
        return transaction(state, () => {
          const existing = readItem(state, id)
          if (existing === undefined) return false
          assertCoordinates(existing.coordinates, coordinates)
          if (existing.state !== "capturing" || existing.ownerNonce !== ownerNonce) {
            throw new TypeError("Only the exact capture owner may clear an unfinished intent")
          }
          const result = sql(state, "delete-capture", () =>
            state.database.run(
              "DELETE FROM workflow_evidence_item WHERE evidence_id = ? AND state = 'capturing' AND owner_nonce = ?",
              [id, ownerNonce],
            ),
          )
          if (result.changes !== 1) throw new FatalEvidenceError(new Error("Capture intent delete was not exact"))
          return true
        })
      }),
    completeCapture: async (input) => operate(state, () => completeCapture(state, input)),
    get: async (coordinatesInput) =>
      operate(state, () => {
        const coordinates = WorkflowVisualHost.validateEvidenceCoordinates(coordinatesInput)
        const item = readItem(state, WorkflowVisualHost.evidenceID(coordinates))
        if (item !== undefined) assertCoordinates(item.coordinates, coordinates)
        return item
      }),
    commit: async (input, now) =>
      operate(state, () => transaction(state, () => commitItem(state, input, validateTimestamp(now)))),
    release: async (input, now) =>
      operate(state, () => transaction(state, () => releaseItem(state, input, validateTimestamp(now)))),
    abandon: async (input, now) =>
      operate(state, () => transaction(state, () => abandonItem(state, input, validateTimestamp(now)))),
    reconcile: async (input, now) => operate(state, () => reconcile(state, input, validateTimestamp(now))),
    close: async () => close(state),
  }
}

function completeCapture(
  state: State,
  input: {
    readonly receipt: WorkflowVisualHost.EvidenceReceipt
    readonly bytes: Uint8Array
    readonly ownerNonce: string
    readonly now: number
    readonly limit: number
  },
): Item {
  const receipt = WorkflowVisualHost.validateEvidenceReceipt(input.receipt)
  const image = WorkflowVisualHost.restoreCapturedImage({ receipt, bytes: input.bytes })
  const ownerNonce = validateOwnerNonce(input.ownerNonce)
  const now = validateTimestamp(input.now)
  if (input.limit !== WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES) {
    throw new TypeError("Evidence completion limit is not the production bound")
  }
  return transaction(state, () => {
    const existing = readItem(state, receipt.evidenceID)
    if (existing === undefined) throw new TypeError("Capture intent is unknown")
    assertCoordinates(existing.coordinates, receipt.coordinates)
    if (existing.state !== "capturing") {
      if (existing.receipt !== undefined && sameJSON(existing.receipt, receipt) && existing.bytes !== undefined) {
        WorkflowVisualHost.restoreCapturedImage({ receipt, bytes: existing.bytes })
        return existing
      }
      throw new TypeError("Evidence completion conflicts with durable state")
    }
    if (existing.ownerNonce !== ownerNonce) throw new TypeError("Evidence completion owner differs")
    const workflowID = String(receipt.coordinates.workflowID)
    const next = selectUsed(state, workflowID) + image.evidenceBytes
    if (next > input.limit) {
      throw new WorkflowVisualHost.Failure({
        operation: "capture",
        code: "workflow_evidence_limit_exceeded",
        message: "Workflow screenshot evidence exceeds 128 MiB",
      })
    }
    const result = sql(state, "complete-capture", () =>
      state.database.run(
        `UPDATE workflow_evidence_item SET
          state = 'staged', owner_nonce = NULL, png_blob = ?, png_sha256 = ?,
          evidence_bytes = ?, receipt_json = ?, updated_at = ?
        WHERE evidence_id = ? AND state = 'capturing' AND owner_nonce = ?`,
        [
          image.bytes,
          receipt.pngSha256,
          receipt.evidenceBytes,
          JSON.stringify(receipt),
          now,
          receipt.evidenceID,
          ownerNonce,
        ],
      ),
    )
    if (result.changes !== 1) throw new FatalEvidenceError(new Error("Evidence completion was not exact"))
    setUsed(state, workflowID, next)
    return requireItem(state, receipt.evidenceID)
  })
}

function commitItem(state: State, input: WorkflowVisualHost.BindEvidenceInput, now: number): Item {
  const receipt = WorkflowVisualHost.validateEvidenceReceipt(input.receipt)
  const artifact = WorkflowVisualHost.evidenceArtifactBinding(input)
  const item = requireItem(state, receipt.evidenceID)
  assertReceipt(item, receipt)
  if (item.state === "capturing" || item.state === "abandoned") {
    throw evidenceConflict("commit_evidence", "Evidence cannot be committed from its durable state")
  }
  if (item.state === "committed" || item.state === "released") {
    if (!sameJSON(item.artifact, artifact)) {
      throw evidenceConflict("commit_evidence", "Evidence is bound to another artifact")
    }
    return item
  }
  const result = sql(state, "commit-item", () =>
    state.database.run(
      "UPDATE workflow_evidence_item SET state = 'committed', artifact_json = ?, updated_at = ? WHERE evidence_id = ? AND state = 'staged'",
      [JSON.stringify(artifact), now, receipt.evidenceID],
    ),
  )
  if (result.changes !== 1) throw new FatalEvidenceError(new Error("Evidence commit was not exact"))
  return requireItem(state, receipt.evidenceID)
}

function releaseItem(state: State, input: WorkflowVisualHost.BindEvidenceInput, now: number): Item {
  const receipt = WorkflowVisualHost.validateEvidenceReceipt(input.receipt)
  const artifact = WorkflowVisualHost.evidenceArtifactBinding(input)
  const item = requireItem(state, receipt.evidenceID)
  assertReceipt(item, receipt)
  if (item.state === "released") {
    if (!sameJSON(item.artifact, artifact)) {
      throw evidenceConflict("release_evidence", "Evidence release binding differs")
    }
    return item
  }
  if (item.state !== "committed" || !sameJSON(item.artifact, artifact)) {
    throw evidenceConflict("release_evidence", "Evidence must be committed to the exact artifact before release")
  }
  const result = sql(state, "release-item", () =>
    state.database.run(
      "UPDATE workflow_evidence_item SET state = 'released', png_blob = NULL, updated_at = ? WHERE evidence_id = ? AND state = 'committed'",
      [now, receipt.evidenceID],
    ),
  )
  if (result.changes !== 1) throw new FatalEvidenceError(new Error("Evidence release was not exact"))
  return requireItem(state, receipt.evidenceID)
}

function abandonItem(state: State, input: WorkflowVisualHost.AbandonEvidenceInput, now: number): Item {
  const receipt = WorkflowVisualHost.validateEvidenceReceipt(input.receipt)
  const abandonment = WorkflowVisualHost.evidenceAbandonmentBinding(input)
  const item = requireItem(state, receipt.evidenceID)
  assertReceipt(item, receipt)
  if (item.state === "abandoned") {
    if (!sameJSON(item.abandonment, abandonment)) throw new TypeError("Evidence has another terminal authority")
    return item
  }
  if (item.state !== "staged") throw new TypeError("Only uncommitted staged evidence can be abandoned")
  const result = sql(state, "abandon-item", () =>
    state.database.run(
      `UPDATE workflow_evidence_item SET
        state = 'abandoned', png_blob = NULL, abandonment_json = ?, updated_at = ?
      WHERE evidence_id = ? AND state = 'staged'`,
      [JSON.stringify(abandonment), now, receipt.evidenceID],
    ),
  )
  if (result.changes !== 1) throw new FatalEvidenceError(new Error("Evidence abandonment was not exact"))
  return requireItem(state, receipt.evidenceID)
}

function reconcile(
  state: State,
  input: WorkflowVisualHost.ReconcileEvidenceInput,
  now: number,
): WorkflowVisualHost.ReconcileEvidenceResult {
  const workflowID = validateWorkflowID(String(input.workflowID))
  const active = new Map<WorkflowVisualHost.EvidenceID, WorkflowVisualHost.EvidenceCoordinates>()
  for (const candidate of input.active) {
    const coordinates = WorkflowVisualHost.validateEvidenceCoordinates(candidate)
    if (coordinates.workflowID !== workflowID) throw new TypeError("Active evidence belongs to another workflow")
    active.set(WorkflowVisualHost.evidenceID(coordinates), coordinates)
  }
  const abandoned = new Set<WorkflowVisualHost.EvidenceID>()
  for (const authority of input.abandoned) {
    const receipt = WorkflowVisualHost.validateEvidenceReceipt(authority.receipt)
    WorkflowVisualHost.evidenceAbandonmentBinding(authority)
    if (receipt.coordinates.workflowID !== workflowID || active.has(receipt.evidenceID)) {
      throw new TypeError("Abandoned evidence authority conflicts")
    }
    abandoned.add(receipt.evidenceID)
  }
  for (const authority of input.committed) {
    const receipt = WorkflowVisualHost.validateEvidenceReceipt(authority.receipt)
    WorkflowVisualHost.evidenceArtifactBinding(authority)
    if (
      receipt.coordinates.workflowID !== workflowID ||
      active.has(receipt.evidenceID) ||
      abandoned.has(receipt.evidenceID)
    ) {
      throw new TypeError("Committed evidence authority conflicts")
    }
  }
  return transaction(state, () => {
    for (const authority of input.abandoned) abandonItem(state, authority, now)
    for (const authority of input.committed) {
      commitItem(state, authority, now)
      if (authority.release) releaseItem(state, authority, now)
    }
    const result: { [K in keyof WorkflowVisualHost.ReconcileEvidenceResult]: WorkflowVisualHost.EvidenceSummary[] } = {
      active: [],
      committed: [],
      released: [],
      abandoned: [],
      ambiguous: [],
    }
    for (const item of listItems(state, workflowID)) {
      const summary = toSummary(item)
      if (item.state === "released") result.released.push(summary)
      else if (item.state === "abandoned") result.abandoned.push(summary)
      else if (item.state !== "capturing" && active.has(item.evidenceID)) result.active.push(summary)
      else if (item.state === "committed") result.committed.push(summary)
      else result.ambiguous.push(summary)
    }
    return Object.freeze({
      active: Object.freeze(result.active),
      committed: Object.freeze(result.committed),
      released: Object.freeze(result.released),
      abandoned: Object.freeze(result.abandoned),
      ambiguous: Object.freeze(result.ambiguous),
    })
  })
}

function toSummary(item: Item): WorkflowVisualHost.EvidenceSummary {
  return Object.freeze({
    evidenceID: item.evidenceID,
    coordinates: item.coordinates,
    ...(item.receipt === undefined ? {} : { receipt: item.receipt }),
    state: item.state,
    ...(item.artifact === undefined ? {} : { artifact: item.artifact }),
    ...(item.abandonment === undefined ? {} : { abandonment: item.abandonment }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  })
}

function readItem(state: State, evidenceID: WorkflowVisualHost.EvidenceID): Item | undefined {
  const row = sql(state, "select-item", () =>
    state.database
      .query<EvidenceRow, [string]>("SELECT * FROM workflow_evidence_item WHERE evidence_id = ?")
      .get(evidenceID),
  )
  return row === null ? undefined : decodeRow(row)
}

function requireItem(state: State, evidenceID: WorkflowVisualHost.EvidenceID): Item {
  const item = readItem(state, evidenceID)
  if (item === undefined) throw new TypeError("Evidence receipt is unknown")
  return item
}

function listItems(state: State, workflowID: string): readonly Item[] {
  const rows = sql(state, "list-items", () =>
    state.database
      .query<
        EvidenceRow,
        [string]
      >("SELECT * FROM workflow_evidence_item WHERE workflow_id = ? ORDER BY evidence_id ASC")
      .all(workflowID),
  )
  return rows.map(decodeRow)
}

function decodeRow(row: EvidenceRow): Item {
  try {
    if (
      !Number.isSafeInteger(row.created_at) ||
      row.created_at < 0 ||
      !Number.isSafeInteger(row.updated_at) ||
      row.updated_at < 0
    ) {
      throw new TypeError("Evidence timestamps are invalid")
    }
    const coordinates = WorkflowVisualHost.validateEvidenceCoordinates({
      schemaVersion: 1,
      workflowID: row.workflow_id,
      stageID: row.stage_id,
      kind: row.preview_kind,
      revision: row.revision,
      viewport: { name: row.viewport_name, width: row.viewport_width, height: row.viewport_height },
      configSha256: row.config_sha256,
      sourceSha256: row.source_sha256,
      readySelectorSha256: row.ready_selector_sha256,
    })
    const evidenceID = WorkflowVisualHost.evidenceID(coordinates)
    if (row.evidence_id !== evidenceID || !Number.isSafeInteger(row.evidence_bytes) || row.evidence_bytes < 0) {
      throw new TypeError("Evidence row identity or accounting is invalid")
    }
    const base = { evidenceID, coordinates, createdAt: row.created_at, updatedAt: row.updated_at }
    if (row.state === "capturing") {
      if (
        row.owner_nonce === null ||
        !sha256Pattern.test(row.owner_nonce) ||
        row.png_blob !== null ||
        row.png_sha256 !== null ||
        row.evidence_bytes !== 0 ||
        row.receipt_json !== null ||
        row.artifact_json !== null ||
        row.abandonment_json !== null
      ) {
        throw new TypeError("Capturing intent is invalid")
      }
      return Object.freeze({ ...base, state: "capturing", ownerNonce: row.owner_nonce })
    }
    if (row.state !== "staged" && row.state !== "committed" && row.state !== "released" && row.state !== "abandoned") {
      throw new TypeError("Evidence state is invalid")
    }
    if (row.owner_nonce !== null || row.receipt_json === null || row.png_sha256 === null) {
      throw new TypeError("Completed evidence metadata is invalid")
    }
    const receipt = parseReceipt(row.receipt_json)
    if (
      receipt.evidenceID !== evidenceID ||
      !sameJSON(receipt.coordinates, coordinates) ||
      receipt.pngSha256 !== row.png_sha256 ||
      receipt.evidenceBytes !== row.evidence_bytes
    ) {
      throw new TypeError("Evidence receipt differs from its durable row")
    }
    const artifact = row.artifact_json === null ? undefined : parseArtifact(row.artifact_json, receipt)
    const abandonment = row.abandonment_json === null ? undefined : parseAbandonment(row.abandonment_json, receipt)
    if (row.state === "staged" && (artifact !== undefined || abandonment !== undefined)) {
      throw new TypeError("Staged evidence carries terminal binding")
    }
    if (
      (row.state === "committed" || row.state === "released") &&
      (artifact === undefined || abandonment !== undefined)
    ) {
      throw new TypeError("Artifact-bound evidence metadata is invalid")
    }
    if (row.state === "abandoned" && (artifact !== undefined || abandonment === undefined)) {
      throw new TypeError("Abandoned evidence metadata is invalid")
    }
    if (row.state === "released" || row.state === "abandoned") {
      if (row.png_blob !== null) throw new TypeError("Terminal evidence retained a staging BLOB")
      return Object.freeze({ ...base, receipt, state: row.state, artifact, abandonment })
    }
    if (!(row.png_blob instanceof Uint8Array)) throw new TypeError("Active evidence BLOB is missing")
    const restored = WorkflowVisualHost.restoreCapturedImage({ receipt, bytes: row.png_blob })
    return Object.freeze({
      ...base,
      receipt,
      state: row.state,
      artifact,
      bytes: Uint8Array.from(restored.bytes),
    })
  } catch (cause) {
    throw new FatalEvidenceError(cause)
  }
}

function parseReceipt(value: string): WorkflowVisualHost.EvidenceReceipt {
  return WorkflowVisualHost.validateEvidenceReceipt(parseJSON(value))
}

function parseArtifact(
  value: string,
  receipt: WorkflowVisualHost.EvidenceReceipt,
): WorkflowVisualHost.EvidenceArtifactBinding {
  return WorkflowVisualHost.validateEvidenceArtifactBinding(parseJSON(value), receipt)
}

function parseAbandonment(
  value: string,
  receipt: WorkflowVisualHost.EvidenceReceipt,
): WorkflowVisualHost.EvidenceAbandonmentBinding {
  return WorkflowVisualHost.evidenceAbandonmentBinding({
    receipt,
    terminal: parseJSON(value),
  })
}

function selectUsed(state: State, workflowID: string): number {
  const row = sql(state, "select-get", () =>
    state.database
      .query<
        { readonly evidence_bytes: number },
        [string]
      >("SELECT evidence_bytes FROM workflow_evidence WHERE workflow_id = ?")
      .get(workflowID),
  )
  const value = row?.evidence_bytes ?? 0
  if (!Number.isSafeInteger(value) || value < 0 || value > WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES) {
    throw new FatalEvidenceError(new Error("Evidence ledger contains an invalid total"))
  }
  return value
}

function setUsed(state: State, workflowID: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES) {
    throw new TypeError("Evidence total is outside the production bound")
  }
  sql(state, "upsert-run", () =>
    state.database.run(
      `INSERT INTO workflow_evidence (workflow_id, evidence_bytes) VALUES (?, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET evidence_bytes = excluded.evidence_bytes`,
      [workflowID, value],
    ),
  )
}

function transaction<A>(state: State, work: () => A): A {
  sql(state, "begin", () => state.database.run("BEGIN IMMEDIATE"))
  try {
    const value = work()
    sql(state, "commit", () => state.database.run("COMMIT"))
    return value
  } catch (cause) {
    try {
      if (state.database.inTransaction) sql(state, "rollback", () => state.database.run("ROLLBACK"))
    } catch (rollbackCause) {
      throw new FatalEvidenceError(
        new AggregateError(
          [unwrapFatal(cause), unwrapFatal(rollbackCause)],
          "Evidence transaction and rollback failed",
        ),
      )
    }
    throw cause
  }
}

function operate<A>(state: State, work: () => A): A {
  if (state.closed) throw new Error("Evidence ledger is closed")
  let result: { readonly value: A } | undefined
  let failure: unknown
  try {
    publicGuard(state)
    result = { value: work() }
  } catch (cause) {
    failure = cause
  }
  try {
    publicGuard(state)
  } catch (cause) {
    // The post-fence is the last ownership authority. Never discard it behind
    // an earlier caller/validation error or the service could remain usable
    // after its verified pathname diverged from the open SQLite handle.
    failure = cause
  }
  if (failure !== undefined) {
    if (failure instanceof FatalEvidenceError) {
      state.closed = true
      closeRaw(state)
    }
    throw unwrapFatal(failure)
  }
  if (result === undefined) throw new Error("Evidence operation produced no result")
  return result.value
}

function close(state: State): void {
  if (state.closed) return
  let failure: unknown
  try {
    publicGuard(state)
    sql(state, "close", () => state.database.close())
  } catch (cause) {
    failure = cause
  }
  try {
    publicGuard(state)
  } catch (cause) {
    failure ??= cause
  }
  state.closed = true
  if (failure !== undefined) {
    closeRaw(state)
    throw unwrapFatal(failure)
  }
}

function publicGuard(state: State): void {
  try {
    state.options.rootPolicy?.(state.root)
    cheapGuard(state.root, state.databaseIdentity)
  } catch (cause) {
    throw new FatalEvidenceError(cause)
  }
}

function sql<A>(state: State, operation: Operation, work: () => A): A {
  return checkedBoundary(state.root, state.options, state.databaseIdentity, operation, work)
}

function checkedBoundary<A>(
  root: string,
  options: OpenOptions,
  identity: FileIdentity,
  operation: Operation,
  work: () => A,
): A {
  try {
    options.onBoundary?.({ operation, phase: "before" })
    cheapGuard(root, identity)
    let value: A
    let failure: unknown
    try {
      value = work()
    } catch (cause) {
      failure = cause
    }
    try {
      options.onBoundary?.({ operation, phase: "after" })
      cheapGuard(root, identity)
    } catch (cause) {
      failure =
        failure === undefined ? cause : new AggregateError([failure, cause], `Evidence ${operation} boundary failed`)
    }
    if (failure !== undefined) throw failure
    return value!
  } catch (cause) {
    throw cause instanceof FatalEvidenceError ? cause : new FatalEvidenceError(cause)
  }
}

function closeRaw(state: State): void {
  try {
    state.database.close()
  } catch {
    // Best effort only; preserve the initiating ownership/SQLite/content failure.
  }
}

function createDatabaseFile(root: string, databasePath: string): void {
  let descriptor: number | undefined
  try {
    verifyOwnedFiles(root)
    descriptor = fs.openSync(databasePath, "wx", 0o600)
    fs.fsyncSync(descriptor)
  } catch (cause) {
    throw new TypeError("Evidence database could not be created exclusively", { cause })
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function cheapGuard(root: string, identity: FileIdentity): void {
  verifyOwnedFiles(root, true)
  const current = fileIdentity(path.join(root, databaseName))
  if (!sameFileIdentity(current, identity)) throw new TypeError("Evidence database path changed file identity")
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

function fileIdentity(file: string): FileIdentity {
  const value = fs.lstatSync(file)
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) {
    throw new TypeError("Evidence database must be a singly-owned regular file")
  }
  return Object.freeze({ dev: value.dev, ino: value.ino, birthtimeMs: value.birthtimeMs })
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs
}

function validateWorkflowID(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("Workflow ID is required")
  return value
}

function validateOwnerNonce(value: string): string {
  if (!sha256Pattern.test(value)) throw new TypeError("Capture owner nonce must be an opaque 256-bit value")
  return value
}

function validateTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Evidence timestamp is invalid")
  return value
}

function validateReservation(bytes: number, limit: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || limit !== WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES) {
    throw new TypeError("Evidence reservation is not bounded")
  }
}

function assertCoordinates(
  left: WorkflowVisualHost.EvidenceCoordinates,
  right: WorkflowVisualHost.EvidenceCoordinates,
): void {
  if (!sameJSON(left, right)) throw new FatalEvidenceError(new Error("Evidence ID has conflicting logical coordinates"))
}

function assertReceipt(item: Item, receipt: WorkflowVisualHost.EvidenceReceipt): void {
  if (item.receipt === undefined || !sameJSON(item.receipt, receipt)) {
    throw new TypeError("Evidence receipt differs from durable state")
  }
}

function sameJSON(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function parseJSON(value: string): unknown {
  return JSON.parse(value)
}

function evidenceConflict(
  operation: "commit_evidence" | "release_evidence",
  message: string,
): WorkflowVisualHost.Failure {
  return new WorkflowVisualHost.Failure({ operation, code: "evidence_conflict", message })
}

function unwrapFatal(cause: unknown): unknown {
  return cause instanceof FatalEvidenceError ? cause.detail : cause
}

function samePath(left: string, right: string): boolean {
  const first = path.resolve(left)
  const second = path.resolve(right)
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second
}

function isMissing(cause: unknown): boolean {
  return cause !== null && typeof cause === "object" && Reflect.get(cause, "code") === "ENOENT"
}
