export * as WorkflowWorkspaceMaterialization from "./workspace-materialization"

/** Operation-lifetime sealed Snapshot authority. It owns no filesystem cache, root, lease, or cleanup state. */

import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { Location } from "../location"
import { RelativePath } from "../schema"
import { Snapshot } from "../snapshot"
import { Hash } from "../util/hash"

export interface Sealed {
  readonly schemaVersion: 1
  readonly authoritySha256: string
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly revision: number
  readonly location: Location.Ref
  readonly snapshotRef: Snapshot.ID
  readonly manifestSha256: string
  readonly workspaceSha256: string
  readonly archive: Archive
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
const SealedSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  authoritySha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  workflowID: Workflow.ID,
  stageID: Workflow.StageID,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  location: Location.Ref,
  snapshotRef: Snapshot.ID,
  manifestSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  workspaceSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  archive: ArchiveSchema,
}).annotate({ identifier: "WorkflowWorkspaceMaterialization.Sealed", ...exact })

export interface BindInput {
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly revision: number
  readonly location: Location.Ref
  readonly snapshotRef: Snapshot.ID
  readonly manifestSha256: string
  readonly workspaceSha256: string
  readonly archive: Archive
}

export function bind(input: BindInput): Sealed {
  assertSha256(input.manifestSha256)
  assertSha256(input.workspaceSha256)
  if (!Number.isSafeInteger(input.revision) || input.revision < 0)
    throw new TypeError("Invalid sealed Snapshot revision")
  const archive = validateArchive(input.archive)
  if (archive.workspaceSha256 !== input.workspaceSha256)
    throw new TypeError("Sealed Snapshot archive differs from its authority")
  const authoritySha256 = authority(input, archive)
  return Object.freeze({
    schemaVersion: 1,
    authoritySha256,
    workflowID: input.workflowID,
    stageID: input.stageID,
    revision: input.revision,
    location: Object.freeze({ ...input.location }),
    snapshotRef: input.snapshotRef,
    manifestSha256: input.manifestSha256,
    workspaceSha256: input.workspaceSha256,
    archive,
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
      throw new TypeError("Workspace sealed archive bytes differ from the exact Snapshot entry")
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
    if (split === undefined) throw new TypeError("Workspace sealed archive path exceeds ustar bounds")
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
  if (encoded.length >= length) throw new TypeError("Workspace sealed archive field exceeds ustar bounds")
  target.write(encoded, offset, length - 1, "ascii")
  target[offset + length - 1] = 0
}

function archive(entriesInput: readonly ArchiveEntry[], expectedArchive?: string, expectedWorkspace?: string): Archive {
  const entries = Snapshot.canonicalEntries(entriesInput)
  if (entries.length !== entriesInput.length) throw new TypeError("Workspace sealed archive entries are invalid")
  const sealed = entries.map((entry, index) => {
    const source = entriesInput[index]
    if (
      source.path !== entry.path ||
      source.type !== entry.type ||
      source.sha256 !== entry.sha256 ||
      source.size !== entry.size
    )
      throw new TypeError("Workspace sealed archive entries are not canonical")
    const decoded = Buffer.from(source.contentBase64, "base64")
    if (
      decoded.toString("base64") !== source.contentBase64 ||
      decoded.byteLength !== source.size ||
      Hash.sha256(decoded) !== source.sha256
    )
      throw new TypeError("Workspace sealed archive entry bytes are invalid")
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
    throw new TypeError("Workspace sealed archive aggregate is invalid")
  if (expectedArchive !== undefined && expectedArchive !== archiveSha256)
    throw new TypeError("Workspace sealed archive identity is invalid")
  return Object.freeze({ schemaVersion: 1, archiveSha256, workspaceSha256, entries: Object.freeze(sealed) })
}

export function validate(input: unknown): Sealed {
  const value = Schema.decodeUnknownSync(SealedSchema)(input)
  const expected = bind(value)
  if (expected.authoritySha256 !== value.authoritySha256)
    throw new TypeError("Sealed Snapshot authority identity mismatch")
  return expected
}

export function assertAuthority(
  sealed: Sealed,
  expected: Omit<BindInput, "snapshotRef" | "archive"> & { readonly snapshotRef?: Snapshot.ID },
): Sealed {
  const value = validate(sealed)
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
    throw new TypeError("Sealed Snapshot differs from durable authority")
  return value
}

function authority(input: BindInput, archive: Archive): string {
  return Hash.sha256(
    Buffer.from(
      JSON.stringify([
        1,
        input.workflowID,
        input.stageID,
        input.revision,
        input.location.directory,
        input.location.workspaceID ?? null,
        input.snapshotRef,
        input.manifestSha256,
        input.workspaceSha256,
        archive.archiveSha256,
      ]),
      "utf8",
    ),
  )
}

function assertSha256(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Invalid sealed Snapshot SHA-256")
}
