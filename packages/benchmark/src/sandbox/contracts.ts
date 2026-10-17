import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { freeze, safePath } from "../corpus/evaluation-profile"
import { Sha256 } from "../schema"

const Text = Schema.NonEmptyString
const ID = Text.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/))
const Positive = Schema.Int.check(Schema.isGreaterThan(0))
export const FileIdentity = Schema.Struct({ path: Text, sha256: Sha256, fileID: Text })
const DiskIdentity = Schema.Struct({ path: Text, fileID: Text, volumeID: Text })
export const StorageRecord = Schema.Struct({
  backend: Schema.Literals(["wsl2", "hyperv"]),
  disk: DiskIdentity,
  dataRoot: Text,
  swap: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("disabled") }),
    Schema.Struct({ kind: Schema.Literal("file"), file: DiskIdentity }),
  ]),
  settingsSha256: Sha256,
  observedAt: Positive,
})
const Roots = Schema.Struct({ work: Text, temp: Text, config: Text, evidence: Text })
const Request = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  acceptanceID: ID,
  sourceSha256: Sha256,
  planSha256: Sha256,
  cli: FileIdentity,
  context: ID,
  endpoint: Text,
  architecture: Schema.Literals(["amd64", "arm64"]),
  roots: Roots,
})
export const EngineDescriptor = Schema.Struct({
  serverID: Text,
  version: Text,
  os: Schema.Literal("linux"),
  architecture: Schema.Literals(["amd64", "arm64"]),
  endpoint: Text,
  defaultEndpoint: Text,
})
const Pending = Schema.Struct({ id: ID, kind: Schema.Literal("pending"), recipeSha256: Sha256 })
export const Artifact = Schema.Struct({
  id: ID,
  kind: Schema.Literals(["binary", "browser", "font", "image", "dependency", "worker"]),
  sha256: Sha256,
  path: Schema.optionalKey(Text),
  image: Schema.optionalKey(Text),
})
const Base = {
  ...Request.fields,
  engine: EngineDescriptor,
  storage: StorageRecord,
  policySha256: Sha256,
  testSha256: Sha256,
  artifactManifestSha256: Sha256,
}
const Manifest = Schema.Union([
  Schema.Struct({
    ...Base,
    phase: Schema.Literal("prepare"),
    artifacts: Schema.NonEmptyArray(Schema.Union([Pending, Artifact])),
  }),
  Schema.Struct({ ...Base, phase: Schema.Literal("accept"), artifacts: Schema.NonEmptyArray(Artifact) }),
])
const Approval = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  acceptanceID: ID,
  planSha256: Sha256,
  scope: Schema.Literals(["prepare", "accept"]),
  contextFingerprint: Sha256,
  artifactManifestSha256: Sha256,
  manifestSha256: Sha256,
  allowedOperations: Schema.Array(
    Schema.Literals([
      "image-pull",
      "image-load",
      "image-build",
      "volume-prepare",
      "container-create",
      "container-start",
      "container-exec",
      "container-stop",
      "container-remove",
    ]),
  ),
  storageRoots: Schema.NonEmptyArray(Text),
  maxDiskBytes: Positive,
  expiresAt: Positive,
})
export type FileIdentity = typeof FileIdentity.Type
export type StorageProof = typeof StorageRecord.Type
export type HostRequest = typeof Request.Type
export type HostManifest = typeof Manifest.Type
export type EngineApproval = typeof Approval.Type
export type EngineDescriptor = typeof EngineDescriptor.Type
export type Gate<T> =
  | Readonly<{ kind: "ready"; value: T }>
  | Readonly<{ kind: "blocked"; code: string; missing: readonly string[] }>
export type DockerInvocation = Readonly<{
  argv: readonly string[]
  stdin?: Uint8Array
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
  signal: AbortSignal
}>
export type DockerExecution = Readonly<{
  started: boolean
  exitCode: number
  stdout: Uint8Array
  stderr: Uint8Array
  truncated: boolean
}>
export interface DockerRunner {
  execute(input: DockerInvocation): Promise<DockerExecution>
}
export type HostInventory = Readonly<{
  requestSha256: string
  cli: FileIdentity | null
  engine: EngineDescriptor | null
  storage: StorageProof | null
  rootIdentities: Readonly<Record<string, string>>
  contextFingerprint: string
  missing: readonly string[]
}>
export type EngineSession = Readonly<{ acceptanceID: string; manifestSha256: string }>
export type AuthorityGuard = () => Promise<void>
export const productionLimits = freeze({
  cpus: 1.5,
  memoryBytes: 1073741824,
  pids: 64,
  tmpBytes: 67108864,
  homeBytes: 16777216,
  maxOutputBytes: 1048576,
  engineTimeoutMs: 15000,
  cleanupTimeoutMs: 5000,
  timeoutMs: 600000,
})

export function requireDPath(value: string): string {
  if (!/^D:\\/i.test(value) || path.win32.normalize(value) !== value || value.length <= 3)
    throw new TypeError("TASK24_LINUX_PATH")
  safePath(value.slice(3).replaceAll("\\", "/"))
  return value
}
export function decodeHostRequest(input: unknown): HostRequest {
  const value = Schema.decodeUnknownSync(Request)(input, { onExcessProperty: "error" })
  requireDPath(value.cli.path)
  if (!/^npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9._-]+$/.test(value.endpoint)) throw new TypeError("TASK24_LINUX_ENDPOINT")
  const roots = Object.values(value.roots).map((v) => requireDPath(v).toLowerCase())
  for (const root of roots)
    if (!/^d:\\opencode-benchmark\\task24\\(?:tmp|workspaces|reports|toolchain)\\/.test(root))
      throw new TypeError("TASK24_LINUX_ROOT")
  if (
    roots.some((r, i) => roots.some((s, j) => i !== j && (r === s || r.startsWith(s + "\\") || s.startsWith(r + "\\"))))
  )
    throw new TypeError("TASK24_LINUX_ROOT_OVERLAP")
  return freeze(value)
}
export function requestOf(value: HostManifest): HostRequest {
  return decodeHostRequest(
    Object.fromEntries(Object.keys(Request.fields).map((k) => [k, value[k as keyof HostRequest]])),
  )
}
export function decodeHostManifest(input: unknown): HostManifest {
  canonicalJson(input)
  const value = Schema.decodeUnknownSync(Manifest)(input, { onExcessProperty: "error" })
  requestOf(value)
  if (
    value.endpoint !== value.engine.endpoint ||
    value.endpoint !== value.engine.defaultEndpoint ||
    value.architecture !== value.engine.architecture
  )
    throw new TypeError("TASK24_LINUX_ENGINE_IDENTITY")
  if (new Set(value.artifacts.map((a) => a.id)).size !== value.artifacts.length)
    throw new TypeError("TASK24_LINUX_ARTIFACT_DUPLICATE")
  for (const artifact of value.artifacts) {
    if ("path" in artifact && artifact.path) requireDPath(artifact.path)
    if ("image" in artifact && artifact.image && !/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(artifact.image))
      throw new TypeError("TASK24_LINUX_IMAGE")
  }
  if (
    value.phase === "accept" &&
    ["modified", "upstream", "browser", "fonts", "linux-runtime"].some(
      (id) => !value.artifacts.some((a) => a.id === id),
    )
  )
    throw new TypeError("TASK24_LINUX_ARTIFACT_MISSING")
  return freeze(value)
}
export function decodeEngineApproval(input: unknown): EngineApproval {
  const value = Schema.decodeUnknownSync(Approval)(input, { onExcessProperty: "error" })
  value.storageRoots.forEach(requireDPath)
  return freeze(value)
}
