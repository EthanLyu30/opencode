export * as BenchmarkAclAuthority from "./benchmark-acl-authority"

import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { BenchmarkAclNative } from "./benchmark-acl-native"
import { BenchmarkAclProbe } from "./benchmark-acl-probe"
import { HostRootPolicy } from "./host-root-policy"
import { WorkflowBenchmarkModels } from "@opencode-ai/schema/workflow-benchmark-models"

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Record = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  nonce: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  campaignID: Schema.String,
  runID: Schema.String,
  bindingSha256: digest,
  expiresAt: Schema.Int,
  executableSha256: digest,
  models: Schema.optionalKey(WorkflowBenchmarkModels.Packet),
  grants: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      fileID: Schema.String,
      mask: Schema.Literal(0x1301bf),
      flags: Schema.Literal(3),
    }),
  ),
})
const Observation = Schema.Struct({
  tokenSid: Schema.String.check(Schema.isPattern(/^S-1-15-2-(?:\d+-){6}\d+$/)),
  profileSid: Schema.String,
  flags: Schema.Array(Schema.Int),
})

/** The record's bytes are committed into the native launcher's package identity.
 * A writable file or caller-supplied SID alone can never mint this authority. */
export function make(input: {
  readonly binding: {
    readonly campaignID: string
    readonly runID: string
    readonly bindingSha256: string
    readonly expiresAt: number
    readonly evidenceMode: string
  }
  readonly tempRoot: string
  readonly guard: () => void
  readonly executable?: string
  readonly collect?: typeof BenchmarkAclNative.collect
}) {
  const executable = input.executable ?? process.execPath
  const file = path.join(path.dirname(executable), "benchmark-acl-authority.json")
  const frozen = read(file, 65536)
  const text = frozen.bytes.toString("utf8")
  const decoded = Schema.decodeUnknownOption(Record)(json(text), { onExcessProperty: "error" })
  if (decoded._tag !== "Some") throw new TypeError("TASK24_BENCHMARK_ACL_RECORD")
  const record = decoded.value
  const profile = "opencode.task24." + createHash("sha256").update(text).digest("hex").slice(0, 48)
  if (
    input.binding.evidenceMode !== "production" ||
    record.campaignID !== input.binding.campaignID ||
    record.runID !== input.binding.runID ||
    record.bindingSha256 !== input.binding.bindingSha256 ||
    record.expiresAt > input.binding.expiresAt ||
    record.expiresAt > Date.now() + 3600000 ||
    !record.grants.length ||
    record.grants.length > 64 ||
    new Set(record.grants.map((grant) => grant.path.toLowerCase())).size !== record.grants.length ||
    record.executableSha256 !==
      createHash("sha256")
        .update(read(executable, 256 * 1048576).bytes)
        .digest("hex")
  )
    throw new TypeError("TASK24_BENCHMARK_ACL_AUTHORITY")
  const observations = new WeakMap<HostRootPolicy.AclSnapshot, { root: string; value: typeof Observation.Type }>()
  const guard = () => {
    input.guard()
    if (record.expiresAt <= Date.now() || read(file, 65536).identity !== frozen.identity)
      throw new TypeError("TASK24_BENCHMARK_ACL_STALE")
    for (const grant of record.grants) {
      if (
        !/^D:\\OpenCode-Benchmark\\Task24\\(?:tmp|workspaces)\\[^\\]+\\/i.test(grant.path) ||
        identity(grant.path) !== grant.fileID
      )
        throw new TypeError("TASK24_BENCHMARK_ACL_ROOT_CHANGED")
    }
  }
  guard()
  let observation: typeof Observation.Type | undefined
  const collect = input.collect ?? BenchmarkAclNative.collect
  const probe = BenchmarkAclProbe.make({
    tempRoot: input.tempRoot,
    guard,
    run(invocation) {
      observation = undefined
      const result = collect(invocation.env.OPENCODE_ACL_PROBE_TARGET!, undefined, { profile })
      if (result.status !== null) {
        if (result.status === 0) {
          const raw = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(result.stdout ?? "")
          const value = Schema.decodeUnknownOption(Observation)(
            raw._tag === "Some" && raw.value !== null && typeof raw.value === "object"
              ? Reflect.get(raw.value, "benchmark")
              : undefined,
            { onExcessProperty: "error" },
          )
          if (value._tag !== "Some" || value.value.tokenSid !== value.value.profileSid) {
            fs.writeSync(invocation.stderr, "Unproven benchmark package identity")
            return { status: 1 }
          }
          observation = value.value
        }
        fs.writeSync(invocation.stdout, result.stdout ?? "")
        fs.writeSync(invocation.stderr, result.stderr ?? "")
      }
      return { status: result.status, error: "error" in result ? result.error : undefined }
    },
  })
  function authenticatedProbe(root: string) {
    const snapshot = probe(root)
    if (!observation || observation.flags.length !== snapshot.aces.length)
      throw new TypeError("TASK24_BENCHMARK_ACL_TOKEN")
    observations.set(snapshot, { root, value: observation })
    return snapshot
  }
  return Object.freeze({
    probe: authenticatedProbe,
    modelSnapshot() {
      guard()
      if (record.models === undefined) return undefined
      // Full record bytes (including this packet) determine the actual package
      // identity. A caller-controlled JSON file is not sufficient authority.
      authenticatedProbe(record.grants[0]!.path)
      return structuredClone(record.models)
    },
    writeGrant(root: string, snapshot: HostRootPolicy.AclSnapshot, ace: HostRootPolicy.Ace) {
      guard()
      const seen = observations.get(snapshot)
      const grant = record.grants.find((grant) => grant.path === root)
      const index = snapshot.aces.indexOf(ace)
      return (
        !!seen &&
        seen.root === root &&
        !!grant &&
        index >= 0 &&
        snapshot.aces.filter((entry) => entry.sid === seen.value.tokenSid).length === 1 &&
        ace.sid === seen.value.tokenSid &&
        ace.allow &&
        !ace.inherited &&
        ace.mask >>> 0 === grant.mask &&
        seen.value.flags[index] === grant.flags
      )
    },
  })
}

function identity(directory: string) {
  const stat = fs.lstatSync(directory, { bigint: true })
  if (fs.realpathSync.native(directory) !== directory || !stat.isDirectory() || stat.isSymbolicLink())
    throw new TypeError("TASK24_BENCHMARK_ACL_ROOT_CHANGED")
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

function read(file: string, limit: number) {
  const before = fs.lstatSync(file, { bigint: true })
  const id = (stat: typeof before) =>
    `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  if (
    fs.realpathSync.native(file) !== file ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(limit)
  )
    throw new TypeError("TASK24_BENCHMARK_ACL_RECORD_IDENTITY")
  const bytes = fs.readFileSync(file)
  if (id(fs.lstatSync(file, { bigint: true })) !== id(before) || BigInt(bytes.length) !== before.size)
    throw new TypeError("TASK24_BENCHMARK_ACL_RECORD_IDENTITY")
  return {
    bytes,
    identity: id(before) + ":" + createHash("sha256").update(bytes).digest("hex"),
  }
}

function json(text: string): unknown {
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  if (decoded._tag !== "Some") throw new TypeError("TASK24_BENCHMARK_ACL_RECORD")
  return decoded.value
}
