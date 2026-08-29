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
  /** Host-sealed immutable bytes. The filesystem root is a reconstructable cache only. */
  readonly archive?: Archive
}

export interface ArchiveEntry extends Snapshot.Entry {
  readonly contentBase64: string
}

export interface Archive {
  readonly schemaVersion: 1
  readonly archiveSha256: string
  readonly workspaceSha256: string
  readonly entries: readonly ArchiveEntry[]
}

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const ArchiveEntrySchema = Schema.Struct({
  path: RelativePath,
  type: Schema.Literals(["file", "executable"]),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentBase64: Schema.String,
})
const ArchiveSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  archiveSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  workspaceSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  entries: Schema.Array(ArchiveEntrySchema),
})
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
  archive: Schema.optional(ArchiveSchema),
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
  readonly archive?: Archive
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
  const archive = input.archive === undefined ? undefined : validateArchive(input.archive)
  if (archive !== undefined && archive.workspaceSha256 !== input.workspaceSha256)
    throw new TypeError("Workspace materialization archive differs from its authority")
  const identity = materializationID(input)
  const leaseID = Hash.sha256(
    Buffer.from(JSON.stringify([identity, input.stageID, input.root, archive?.archiveSha256 ?? null]), "utf8"),
  )
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
    ...(archive === undefined ? {} : { archive }),
  })
}

/** Seal exact Snapshot entries into immutable, content-addressed host-owned bytes. */
export async function seal(
  entriesInput: readonly Snapshot.Entry[],
  read: (path: RelativePath) => Promise<Uint8Array>,
): Promise<Archive> {
  const entries = Snapshot.canonicalEntries(entriesInput)
  const sealed: ArchiveEntry[] = []
  for (const entry of entries) {
    const bytes = Buffer.from(await read(entry.path))
    if (bytes.byteLength !== entry.size || Hash.sha256(bytes) !== entry.sha256)
      throw new TypeError("Workspace materialization archive bytes differ from the exact Snapshot entry")
    sealed.push({ ...entry, contentBase64: bytes.toString("base64") })
  }
  return archive(sealed)
}

/** Validate every entry and aggregate before exposing fresh byte copies to a consumer. */
export function validateArchive(input: unknown): Archive {
  const value = Schema.decodeUnknownSync(ArchiveSchema)(input)
  return archive(value.entries, value.archiveSha256, value.workspaceSha256)
}

export function bytes(input: Archive): ReadonlyMap<RelativePath, Uint8Array> {
  const value = validateArchive(input)
  return new Map(
    value.entries.map((entry) => [entry.path, Uint8Array.from(Buffer.from(entry.contentBase64, "base64"))]),
  )
}

/** Deterministic ustar bytes imported into an owned container without reopening a host path. */
export function tarBytes(input: Archive): Uint8Array {
  const value = validateArchive(input)
  const records: Buffer[] = []
  const directories = new Set<string>(["workspace/"])
  for (const entry of value.entries) {
    const parts = entry.path.split("/")
    for (let index = 1; index < parts.length; index++) directories.add(`workspace/${parts.slice(0, index).join("/")}/`)
  }
  for (const directory of [...directories].sort((left, right) => left.localeCompare(right, "en"))) {
    records.push(tarHeader(directory, 0, 0o755, "5"))
  }
  for (const entry of value.entries) {
    const content = Buffer.from(entry.contentBase64, "base64")
    records.push(
      tarHeader(`workspace/${entry.path}`, content.byteLength, entry.type === "executable" ? 0o755 : 0o644, "0"),
    )
    records.push(content)
    const padding = (512 - (content.byteLength % 512)) % 512
    if (padding > 0) records.push(Buffer.alloc(padding))
  }
  records.push(Buffer.alloc(1024))
  return Uint8Array.from(Buffer.concat(records))
}

function tarHeader(nameInput: string, size: number, mode: number, type: "0" | "5"): Buffer {
  const header = Buffer.alloc(512)
  let name = Buffer.from(nameInput, "utf8")
  if (name.byteLength > 100) {
    const separators = [...nameInput.matchAll(/\//g)].map((match) => match.index)
    const split = separators.reverse().find((index) => {
      const prefix = Buffer.byteLength(nameInput.slice(0, index))
      const leaf = Buffer.byteLength(nameInput.slice(index + 1))
      return prefix <= 155 && leaf <= 100
    })
    if (split === undefined) throw new TypeError("Workspace materialization archive path exceeds ustar bounds")
    const prefix = Buffer.from(nameInput.slice(0, split), "utf8")
    name = Buffer.from(nameInput.slice(split + 1), "utf8")
    prefix.copy(header, 345)
  }
  name.copy(header, 0)
  writeTarOctal(header, 100, 8, mode)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, size)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, "ascii")
  header.write("ustar\0", 257, 6, "ascii")
  header.write("00", 263, 2, "ascii")
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  const encoded = checksum.toString(8).padStart(6, "0")
  header.write(encoded, 148, 6, "ascii")
  header[154] = 0
  header[155] = 0x20
  return header
}

function writeTarOctal(target: Buffer, offset: number, length: number, value: number) {
  const encoded = value.toString(8).padStart(length - 1, "0")
  if (encoded.length >= length) throw new TypeError("Workspace materialization archive field exceeds ustar bounds")
  target.write(encoded, offset, length - 1, "ascii")
  target[offset + length - 1] = 0
}

function archive(entriesInput: readonly ArchiveEntry[], expectedArchive?: string, expectedWorkspace?: string): Archive {
  const entries = Snapshot.canonicalEntries(entriesInput)
  if (entries.length !== entriesInput.length)
    throw new TypeError("Workspace materialization archive entries are invalid")
  const sealed = entries.map((entry, index) => {
    const source = entriesInput[index]
    if (
      source.path !== entry.path ||
      source.type !== entry.type ||
      source.sha256 !== entry.sha256 ||
      source.size !== entry.size
    )
      throw new TypeError("Workspace materialization archive entries are not canonical")
    const decoded = Buffer.from(source.contentBase64, "base64")
    if (
      decoded.toString("base64") !== source.contentBase64 ||
      decoded.byteLength !== source.size ||
      Hash.sha256(decoded) !== source.sha256
    )
      throw new TypeError("Workspace materialization archive entry bytes are invalid")
    return Object.freeze({ ...source })
  })
  const workspaceSha256 = Snapshot.workspaceSha256(sealed)
  const archiveSha256 = Hash.sha256(
    Buffer.from(
      JSON.stringify([
        1,
        workspaceSha256,
        sealed.map((entry) => [entry.path, entry.type, entry.sha256, entry.size, entry.contentBase64]),
      ]),
      "utf8",
    ),
  )
  if (expectedWorkspace !== undefined && expectedWorkspace !== workspaceSha256)
    throw new TypeError("Workspace materialization archive aggregate is invalid")
  if (expectedArchive !== undefined && expectedArchive !== archiveSha256)
    throw new TypeError("Workspace materialization archive identity is invalid")
  return Object.freeze({ schemaVersion: 1, archiveSha256, workspaceSha256, entries: Object.freeze(sealed) })
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
