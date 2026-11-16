export * as WorkflowBenchmarkGit from "./benchmark-git"

import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { WorkflowBenchmarkTransport } from "./benchmark-transport"

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
const Result = Schema.Struct({
  exit: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
})

/** Early Project/Snapshot discovery runs before the Server host layer exists.
 * Missing flag means zero reads; a present stale/malformed binding never falls
 * back to spawning host Git inside the isolated process. */
export function load(environment: Readonly<Record<string, string | undefined>>) {
  if (environment.OPENCODE_BENCHMARK_HOST_FILE === undefined) return undefined
  const data = environment.OPENCODE_BENCHMARK_RUN_DATA_ROOT
  const hostFile = environment.OPENCODE_BENCHMARK_HOST_FILE
  const transportFile = environment.OPENCODE_BENCHMARK_TRANSPORT_FILE
  if (
    !data ||
    !transportFile ||
    path.parse(data).root.toLowerCase() !== "d:\\" ||
    hostFile !== path.join(data, "benchmark-host.json") ||
    transportFile !== path.join(data, "benchmark-transport.json")
  )
    throw Error("TASK24_BENCHMARK_GIT_AUTHORITY")
  const transportPath = transportFile
  const transport = read(transportFile)
  const binding = WorkflowBenchmarkTransport.freezeProfile({
    authority: "server",
    profile: JSON.parse(transport.text),
    expectedCampaignID: environment.OPENCODE_BENCHMARK_CAMPAIGN_ID!,
    expectedRunID: environment.OPENCODE_BENCHMARK_RUN_ID!,
  })
  const frozen = read(hostFile)
  const connection = Schema.decodeUnknownSync(Connection)(JSON.parse(frozen.text), { onExcessProperty: "error" })
  if (
    binding.evidenceMode !== "production" ||
    connection.campaignID !== binding.campaignID ||
    connection.runID !== binding.runID ||
    connection.bindingSha256 !== binding.bindingSha256 ||
    connection.expiresAt <= Date.now() ||
    connection.expiresAt > binding.expiresAt ||
    connection.expiresAt > Date.now() + 3600000 ||
    connection.enginePath !== environment.OPENCODE_WORKFLOW_SANDBOX_ENGINE
  )
    throw Error("TASK24_BENCHMARK_GIT_AUTHORITY")
  function guard() {
    if (
      connection.expiresAt <= Date.now() ||
      read(hostFile).identity !== frozen.identity ||
      read(transportPath).identity !== transport.identity
    )
      throw Error("TASK24_BENCHMARK_GIT_STALE")
  }
  return Object.freeze({
    async execute(input: { cwd: string; argv: readonly string[]; stdin?: string | Uint8Array }, abort: AbortSignal) {
      guard()
      abort.throwIfAborted()
      const stdin = input.stdin === undefined ? undefined : Buffer.from(input.stdin)
      if (
        input.argv.length > 32 ||
        input.argv.some((arg) => !arg || arg.includes("\0") || arg.length > 4096) ||
        (stdin && stdin.length > 1048576)
      )
        throw Error("TASK24_BENCHMARK_GIT_LIMIT")
      const signal = AbortSignal.any([
        abort,
        AbortSignal.timeout(Math.max(1, Math.min(15000, connection.expiresAt - Date.now()))),
      ])
      const response = await fetch(`http://127.0.0.1:${connection.port}/task24/production-git`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        proxy: "",
        redirect: "error",
        signal,
        body: JSON.stringify({
          capability: connection.capability,
          cwd: input.cwd,
          argv: input.argv,
          ...(stdin === undefined ? {} : { stdin: stdin.toString("base64") }),
        }),
      })
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel()
        throw Error("TASK24_BENCHMARK_GIT_DENIED")
      }
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = response.body.getReader()
      try {
        for (;;) {
          const item = await reader.read()
          if (item.done) break
          size += item.value.byteLength
          if (size > 6291456) throw Error("TASK24_BENCHMARK_GIT_LIMIT")
          chunks.push(item.value)
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      signal.throwIfAborted()
      guard()
      const result = Schema.decodeUnknownSync(Result)(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))),
        { onExcessProperty: "error" },
      )
      const stdout = Buffer.from(result.stdout, "base64"),
        stderr = Buffer.from(result.stderr, "base64")
      if (
        stdout.toString("base64") !== result.stdout ||
        stderr.toString("base64") !== result.stderr ||
        stdout.length > 2097152 ||
        stderr.length > 2097152
      )
        throw Error("TASK24_BENCHMARK_GIT_RESULT")
      return { exit: result.exit, stdout, stderr, truncated: result.truncated }
    },
  })
}

function read(file: string) {
  if (path.parse(file).root.toLowerCase() !== "d:\\" || fs.realpathSync.native(file) !== file)
    throw Error("TASK24_BENCHMARK_GIT_FILE")
  const stat = fs.lstatSync(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 65536n)
    throw Error("TASK24_BENCHMARK_GIT_FILE")
  const fd = fs.openSync(file, "r")
  try {
    const pinned = fs.fstatSync(fd, { bigint: true })
    if (
      pinned.dev !== stat.dev ||
      pinned.ino !== stat.ino ||
      pinned.size !== stat.size ||
      pinned.mtimeNs !== stat.mtimeNs
    )
      throw Error("TASK24_BENCHMARK_GIT_FILE")
    const bytes = Buffer.alloc(Number(stat.size) + 1)
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0)
    const after = fs.fstatSync(fd, { bigint: true }),
      leaf = fs.lstatSync(file, { bigint: true })
    if (
      size !== Number(stat.size) ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      leaf.dev !== stat.dev ||
      leaf.ino !== stat.ino ||
      leaf.size !== stat.size ||
      leaf.mtimeNs !== stat.mtimeNs ||
      leaf.nlink !== 1n ||
      leaf.isSymbolicLink()
    )
      throw Error("TASK24_BENCHMARK_GIT_FILE")
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
      identity: [
        stat.dev,
        stat.ino,
        stat.birthtimeNs,
        stat.size,
        stat.mtimeNs,
        createHash("sha256").update(bytes.subarray(0, size)).digest("hex"),
      ].join(":"),
    }
  } finally {
    fs.closeSync(fd)
  }
}
