export * as WindowsWorkflowEnvironment from "./windows-workflow-environment"

import { Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { FileIdentity } from "../contracts"
import { fileIdentity, directoryIdentity } from "../storage"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Bytes, sha256Text } from "../../hash"

export const Host = Schema.Struct({
  armID: Schema.Literal("A"),
  transport: FileIdentity,
  connection: FileIdentity,
  engine: FileIdentity,
  image: Schema.String,
})
export const pathNames = [
  "OPENCODE_WORKFLOW_HOST_ROOT",
  "OPENCODE_WORKFLOW_HOST_DATA",
  "OPENCODE_WORKFLOW_EVIDENCE_ROOT",
  "OPENCODE_WORKFLOW_HOST_RUNTIME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "OPENCODE_WORKFLOW_HOST_CACHE",
  "OPENCODE_WORKFLOW_HOST_TEMP",
  "OPENCODE_WORKFLOW_SANDBOX_CONFIG",
  "OPENCODE_WORKFLOW_SANDBOX_TEMP",
  "OPENCODE_WORKFLOW_SANDBOX_ENGINE",
  "OPENCODE_BENCHMARK_HOST_FILE",
] as const

const Connection = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  campaignID: Schema.String,
  runID: Schema.String,
  bindingSha256: Schema.String,
  host: Schema.Literal("127.0.0.1"),
  port: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1024), Schema.isLessThanOrEqualTo(65535)),
  capability: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  expiresAt: Schema.Int,
  enginePath: Schema.String,
})
const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/))
const Profile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  campaignID: ID,
  runID: ID,
  brokerOrigin: Schema.String,
  providerPaths: Schema.Struct({ kimi: Schema.Literal("/v1/kimi"), deepseek: Schema.Literal("/v1/deepseek") }),
  evidenceMode: Schema.Literal("production"),
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  grant: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(4096)),
})
const inside = (root: string, value: string) =>
  value.toLowerCase() === root.toLowerCase() || value.toLowerCase().startsWith(root.toLowerCase() + "\\")

/** Controller-side admission only; native launch separately pins and hashes the files. */
export async function verify(
  input: {
    environment: Readonly<Record<string, string | undefined>>
    readonly: readonly string[]
    writable: readonly string[]
    ports: readonly number[]
    authority?: { campaignID: string; runID: string; bindingSha256: string; expiresAt: number }
    host: typeof Host.Type
  },
  read: (file: string) => Promise<Buffer> = (file) => fs.readFile(file),
): Promise<readonly (typeof FileIdentity.Type)[]> {
  if (!input.authority || input.host.armID !== "A") throw new TypeError("TASK24_WORKFLOW_HOST_AUTHORITY")
  const env = input.environment
  if (pathNames.some((name) => !env[name]) || !env.OPENCODE_WORKFLOW_SANDBOX_IMAGE)
    throw new TypeError("TASK24_WORKFLOW_HOST_ENVIRONMENT")
  const directories = pathNames
    .filter((name) => name !== "OPENCODE_WORKFLOW_SANDBOX_ENGINE" && name !== "OPENCODE_BENCHMARK_HOST_FILE")
    .map((name) => env[name]!)
  for (const directory of directories) {
    if (
      !/^D:\\/.test(directory) ||
      path.resolve(directory) !== directory ||
      !input.writable.some((root) => inside(root, directory))
    )
      throw new TypeError("TASK24_WORKFLOW_HOST_ROOT")
    await directoryIdentity(directory)
  }
  const deployment = env.OPENCODE_WORKFLOW_HOST_ROOT!
  const leaves = [
    env.OPENCODE_WORKFLOW_HOST_DATA!,
    env.OPENCODE_WORKFLOW_HOST_RUNTIME!,
    env.OPENCODE_WORKFLOW_HOST_CACHE!,
    env.OPENCODE_WORKFLOW_HOST_TEMP!,
    env.OPENCODE_WORKFLOW_SANDBOX_CONFIG!,
    env.OPENCODE_WORKFLOW_SANDBOX_TEMP!,
  ]
  if (
    env.OPENCODE_WORKFLOW_HOST_DATA !== env.OPENCODE_WORKFLOW_EVIDENCE_ROOT ||
    env.OPENCODE_WORKFLOW_HOST_RUNTIME !== env.PLAYWRIGHT_BROWSERS_PATH ||
    leaves.some((leaf) => leaf === deployment || !inside(deployment, leaf)) ||
    leaves.some((leaf, i) => leaves.some((other, j) => i !== j && (inside(leaf, other) || inside(other, leaf))))
  )
    throw new TypeError("TASK24_WORKFLOW_HOST_TOPOLOGY")
  const host = input.host
  if (
    host.transport.path !== env.OPENCODE_BENCHMARK_TRANSPORT_FILE ||
    host.connection.path !== env.OPENCODE_BENCHMARK_HOST_FILE ||
    host.connection.path !== path.join(env.OPENCODE_BENCHMARK_RUN_DATA_ROOT!, "benchmark-host.json") ||
    host.engine.path !== env.OPENCODE_WORKFLOW_SANDBOX_ENGINE ||
    !/\\docker\.exe$/i.test(host.engine.path) ||
    !input.readonly.some((root) => inside(root, host.engine.path)) ||
    input.writable.some((root) => inside(root, host.engine.path)) ||
    host.image !== env.OPENCODE_WORKFLOW_SANDBOX_IMAGE ||
    !/^(?:[a-z0-9][a-z0-9._/-]*|127\.0\.0\.1:5000\/[a-z0-9][a-z0-9._/-]*)@sha256:[a-f0-9]{64}$/.test(host.image)
  )
    throw new TypeError("TASK24_WORKFLOW_HOST_ARTIFACT")
  const files = [host.transport, host.connection, host.engine]
  if ((await fs.lstat(host.transport.path)).size > 16384 || (await fs.lstat(host.connection.path)).size > 16384)
    throw new TypeError("TASK24_WORKFLOW_HOST_LIMIT")
  if ((await fs.lstat(host.engine.path)).size > 256 * 1048576) throw new TypeError("TASK24_WORKFLOW_HOST_LIMIT")
  for (const file of files)
    if (canonicalJson(await fileIdentity(file.path)) !== canonicalJson(file))
      throw new TypeError("TASK24_WORKFLOW_HOST_ARTIFACT")
  const json = async (file: typeof FileIdentity.Type) => {
    const bytes = await read(file.path)
    if (bytes.length > 16384) throw new TypeError("TASK24_WORKFLOW_HOST_LIMIT")
    if (sha256Bytes(bytes) !== file.sha256) throw new TypeError("TASK24_WORKFLOW_HOST_ARTIFACT")
    return Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(bytes.toString("utf8"))
  }
  const raw = await json(host.connection)
  const connection = Schema.decodeUnknownOption(Connection)(raw._tag === "Some" ? raw.value : undefined, {
    onExcessProperty: "error",
  })
  if (connection._tag !== "Some") throw new TypeError("TASK24_WORKFLOW_HOST_CONNECTION")
  const transport = await json(host.transport)
  const profile = Schema.decodeUnknownOption(Profile)(transport._tag === "Some" ? transport.value : undefined, {
    onExcessProperty: "error",
  })
  if (profile._tag !== "Some") throw new TypeError("TASK24_WORKFLOW_HOST_BINDING")
  const p = profile.value
  const origin = new URL(p.brokerOrigin)
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.origin !== p.brokerOrigin ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    Number(origin.port) < 1024 ||
    p.expiresAt <= Date.now() ||
    p.grant.trim() !== p.grant ||
    p.campaignID !== env.OPENCODE_BENCHMARK_CAMPAIGN_ID ||
    p.runID !== env.OPENCODE_BENCHMARK_RUN_ID ||
    !/^D:\\OpenCode-Benchmark\\Task24\\(?:runs|workspaces)\\.+/.test(env.OPENCODE_BENCHMARK_RUN_DATA_ROOT ?? "") ||
    host.transport.path === env.OPENCODE_BENCHMARK_RUN_DATA_ROOT ||
    !inside(env.OPENCODE_BENCHMARK_RUN_DATA_ROOT!, host.transport.path)
  )
    throw new TypeError("TASK24_WORKFLOW_HOST_BINDING")
  await directoryIdentity(env.OPENCODE_BENCHMARK_RUN_DATA_ROOT!)
  // Closed wire-contract verification, not a new routing/budget algorithm.
  // All binding keys are ASCII identifiers; this matches the Core canonical
  // encoding and is covered against real freezeProfile() and Runtime.load().
  const base = {
    kind: "workflow.benchmark-transport.v1",
    campaignID: p.campaignID,
    runID: p.runID,
    brokerOrigin: p.brokerOrigin,
    providerPaths: p.providerPaths,
    evidenceMode: p.evidenceMode,
    expiresAt: p.expiresAt,
    grantSha256: sha256Text(p.grant),
  }
  const binding = { ...base, bindingSha256: sha256Text(canonicalJson(base)) }
  const c = connection.value
  if (
    binding.campaignID !== input.authority.campaignID ||
    binding.runID !== input.authority.runID ||
    binding.bindingSha256 !== input.authority.bindingSha256 ||
    c.campaignID !== binding.campaignID ||
    c.runID !== binding.runID ||
    c.bindingSha256 !== binding.bindingSha256 ||
    c.enginePath !== host.engine.path ||
    c.expiresAt <= Date.now() ||
    c.expiresAt > binding.expiresAt ||
    c.expiresAt > input.authority.expiresAt ||
    input.authority.expiresAt <= Date.now() ||
    !inside(env.OPENCODE_BENCHMARK_RUN_DATA_ROOT!, env.OPENCODE_WORKFLOW_HOST_TEMP!)
  )
    throw new TypeError("TASK24_WORKFLOW_HOST_BINDING")
  const ports = [...new Set([Number(new URL(binding.brokerOrigin).port), c.port])].sort((a, b) => a - b)
  if (canonicalJson([...input.ports].sort((a, b) => a - b)) !== canonicalJson(ports))
    throw new TypeError("TASK24_WORKFLOW_HOST_PORTS")
  return files
}
