export * as WorkflowWorkspaceMaterialization from "./workspace-materialization"

import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Location } from "../location"
import { AbsolutePath, RelativePath } from "../schema"
import { Snapshot } from "../snapshot"
import { Hash } from "../util/hash"

export interface Lease {
  readonly schemaVersion: 1
  readonly materializationID: string
  readonly leaseID: string
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly revision: number
  readonly location: Location.Ref
  readonly snapshotRef: Snapshot.ID
  readonly manifestSha256: string
  readonly workspaceSha256: string
  readonly root: AbsolutePath
}

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const LeaseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  materializationID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  leaseID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  workflowID: Workflow.ID,
  stageID: Workflow.StageID,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  location: Location.Ref,
  snapshotRef: Snapshot.ID,
  manifestSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  workspaceSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  root: AbsolutePath,
}).annotate({ identifier: "WorkflowWorkspaceMaterialization.Lease", ...exact })

export interface MakeInput {
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly revision: number
  readonly location: Location.Ref
  readonly snapshotRef: Snapshot.ID
  readonly manifestSha256: string
  readonly workspaceSha256: string
  readonly root: AbsolutePath
}

/** One immutable tree is shared by every stage lease for the same revision authority. */
export function materializationID(input: Omit<MakeInput, "stageID" | "root">): string {
  return Hash.sha256(
    Buffer.from(
      JSON.stringify([
        1,
        input.workflowID,
        input.revision,
        input.location.directory,
        input.location.workspaceID ?? null,
        input.snapshotRef,
        input.manifestSha256,
        input.workspaceSha256,
      ]),
      "utf8",
    ),
  )
}

export function make(input: MakeInput): Lease {
  assertSha256(input.manifestSha256)
  assertSha256(input.workspaceSha256)
  if (!Number.isSafeInteger(input.revision) || input.revision < 0)
    throw new TypeError("Invalid materialization revision")
  const identity = materializationID(input)
  const leaseID = Hash.sha256(Buffer.from(JSON.stringify([identity, input.stageID, input.root]), "utf8"))
  return Object.freeze({
    schemaVersion: 1,
    materializationID: identity,
    leaseID,
    workflowID: input.workflowID,
    stageID: input.stageID,
    revision: input.revision,
    location: Object.freeze({ ...input.location }),
    snapshotRef: input.snapshotRef,
    manifestSha256: input.manifestSha256,
    workspaceSha256: input.workspaceSha256,
    root: input.root,
  })
}

export function validate(input: unknown): Lease {
  const value = Schema.decodeUnknownSync(LeaseSchema)(input)
  const expected = make(value)
  if (expected.materializationID !== value.materializationID || expected.leaseID !== value.leaseID)
    throw new TypeError("Workspace materialization lease identity mismatch")
  return expected
}

export function assertAuthority(
  lease: Lease,
  expected: Omit<MakeInput, "snapshotRef" | "root"> & { readonly snapshotRef?: Snapshot.ID },
): Lease {
  const value = validate(lease)
  if (
    value.workflowID !== expected.workflowID ||
    value.stageID !== expected.stageID ||
    value.revision !== expected.revision ||
    value.location.directory !== expected.location.directory ||
    value.location.workspaceID !== expected.location.workspaceID ||
    (expected.snapshotRef !== undefined && value.snapshotRef !== expected.snapshotRef) ||
    value.manifestSha256 !== expected.manifestSha256 ||
    value.workspaceSha256 !== expected.workspaceSha256
  )
    throw new TypeError("Workspace materialization differs from durable authority")
  return value
}

/** Re-hash every bounded regular file and reject any absence, link, extra, or mutation. */
export async function verifyRoot(leaseInput: Lease): Promise<readonly Snapshot.Entry[]> {
  const lease = validate(leaseInput)
  const root = path.resolve(lease.root)
  const result: Snapshot.Entry[] = []
  let total = 0
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const records = await fs.readdir(directory, { withFileTypes: true })
    records.sort((left, right) => left.name.localeCompare(right.name, "en"))
    for (const record of records) {
      const target = path.join(directory, record.name)
      const relative = prefix ? `${prefix}/${record.name}` : record.name
      if (record.isSymbolicLink()) throw new TypeError("Materialized workspace contains a link")
      if (record.isDirectory()) {
        await visit(target, relative)
        continue
      }
      if (!record.isFile() || result.length >= Snapshot.MAX_ENTRIES)
        throw new TypeError("Materialized workspace contains unsupported or excessive entries")
      const lexical = path.resolve(target)
      const canonical = await fs.realpath(lexical)
      const escaped = path.relative(root, canonical)
      if (canonical !== lexical || escaped === ".." || path.isAbsolute(escaped) || escaped.startsWith(`..${path.sep}`))
        throw new TypeError("Materialized workspace entry escaped its exact root")
      const stat = await fs.lstat(lexical)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > Snapshot.MAX_FILE_BYTES)
        throw new TypeError("Materialized workspace entry is unsafe or oversized")
      total += stat.size
      if (total > Snapshot.MAX_TREE_BYTES) throw new TypeError("Materialized workspace is oversized")
      const bytes = await fs.readFile(lexical)
      const settled = await fs.lstat(lexical)
      if (
        bytes.byteLength !== stat.size ||
        settled.size !== stat.size ||
        settled.mtimeMs !== stat.mtimeMs ||
        settled.ino !== stat.ino ||
        settled.dev !== stat.dev
      )
        throw new TypeError("Materialized workspace entry changed while hashing")
      result.push({
        path: RelativePath.make(relative.replaceAll("\\", "/")),
        type: (stat.mode & 0o111) === 0 ? "file" : "executable",
        sha256: Hash.sha256(bytes),
        size: bytes.byteLength,
      })
    }
  }
  await visit(root, "")
  const entries = Snapshot.canonicalEntries(result)
  if (Snapshot.workspaceSha256(entries) !== lease.workspaceSha256)
    throw new TypeError("Materialized workspace digest differs from its lease")
  return entries
}

function assertSha256(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Invalid materialization SHA-256")
}
