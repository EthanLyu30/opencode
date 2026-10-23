export * as BenchmarkHostRuntime from "./benchmark-host-runtime"

import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { ProductionHostRuntime } from "./production-host-runtime"
import { Docker } from "./docker"
import type { PlaywrightCapture } from "./playwright"

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
const Image = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
  bytes: Schema.Int,
  sha256: Schema.String,
})
const maxFrame = 12 * 1024 * 1024

/** No flag means no reads, endpoint selection, or changes to the production host. */
export function load(
  environment: Readonly<Record<string, string | undefined>>,
): { readonly engine: Docker.Engine; readonly browser: PlaywrightCapture.Runtime } | undefined {
  if (environment.OPENCODE_BENCHMARK_HOST_FILE === undefined) return undefined
  const binding = ProductionHostRuntime.loadBenchmarkTransport(environment)
  if (!binding || binding.evidenceMode !== "production") throw new TypeError("TASK24_BENCHMARK_HOST_AUTHORITY")
  const file = environment.OPENCODE_BENCHMARK_HOST_FILE
  if (file !== path.join(environment.OPENCODE_BENCHMARK_RUN_DATA_ROOT!, "benchmark-host.json"))
    throw new TypeError("TASK24_BENCHMARK_HOST_CONFIG")
  const frozen = read(file)
  const parsed = Schema.decodeUnknownOption(Connection)(decodeJson(frozen.text), { onExcessProperty: "error" })
  if (parsed._tag !== "Some") throw new TypeError("TASK24_BENCHMARK_HOST_CONFIG")
  const connection = parsed.value
  if (
    connection.campaignID !== binding.campaignID ||
    connection.runID !== binding.runID ||
    connection.bindingSha256 !== binding.bindingSha256 ||
    connection.expiresAt <= Date.now() ||
    connection.expiresAt > binding.expiresAt ||
    connection.expiresAt > Date.now() + 3600000 ||
    connection.enginePath !== environment.OPENCODE_WORKFLOW_SANDBOX_ENGINE ||
    path.parse(connection.enginePath).root.toLowerCase() !== "d:\\"
  )
    throw new TypeError("TASK24_BENCHMARK_HOST_AUTHORITY")
  const lifecycle = new AbortController()
  function guard() {
    if (
      lifecycle.signal.aborted ||
      connection.expiresAt <= Date.now() ||
      read(file).identity !== frozen.identity ||
      ProductionHostRuntime.loadBenchmarkTransport(environment)?.bindingSha256 !== binding!.bindingSha256
    )
      throw new TypeError("TASK24_BENCHMARK_HOST_STALE")
  }
  async function request(endpoint: "production-command" | "production-capture", body: unknown, signal: AbortSignal) {
    guard()
    const bytes = JSON.stringify(body)
    if (Buffer.byteLength(bytes) > maxFrame) throw new TypeError("TASK24_BENCHMARK_HOST_LIMIT")
    const response = await fetch(`http://127.0.0.1:${connection.port}/task24/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bytes,
      redirect: "error",
      proxy: "",
      signal,
    })
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      if (response.status !== 200 || !reader) throw new TypeError("TASK24_BENCHMARK_HOST_DENIED")
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        size += item.value.byteLength
        if (size > maxFrame) throw new TypeError("TASK24_BENCHMARK_HOST_LIMIT")
        chunks.push(item.value)
      }
      signal.throwIfAborted()
      guard()
      return decodeJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)))
    } finally {
      await reader?.cancel().catch(() => {})
    }
  }
  const engine: Docker.Engine = Object.freeze({
    async execute(input: Docker.Invocation) {
      guard()
      if (
        input.executable !== connection.enginePath ||
        !Number.isSafeInteger(input.timeoutMs) ||
        input.timeoutMs < 1 ||
        input.timeoutMs > 600000 ||
        !Number.isSafeInteger(input.maxOutputBytes) ||
        input.maxOutputBytes < 1 ||
        input.maxOutputBytes > 1048576 ||
        input.argv.length > 256 ||
        input.argv.some((v) => typeof v !== "string" || v.includes("\0"))
      )
        throw new TypeError("TASK24_BENCHMARK_HOST_INVOCATION")
      const timeout = AbortSignal.timeout(Math.min(input.timeoutMs, connection.expiresAt - Date.now()))
      const signal = AbortSignal.any([timeout, lifecycle.signal, ...(input.signal ? [input.signal] : [])])
      try {
        const stdin = input.stdin === undefined ? undefined : Buffer.from(input.stdin)
        if (stdin && stdin.length > 8388608) throw new TypeError("TASK24_BENCHMARK_HOST_LIMIT")
        const parsed = Schema.decodeUnknownOption(Result)(
          await request(
            "production-command",
            {
              capability: connection.capability,
              argv: input.argv,
              ...(stdin?.length ? { stdin: stdin.toString("base64") } : {}),
            },
            signal,
          ),
          { onExcessProperty: "error" },
        )
        if (parsed._tag !== "Some") throw new TypeError("TASK24_BENCHMARK_HOST_RESULT")
        const result = parsed.value
        if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > input.maxOutputBytes)
          throw new TypeError("TASK24_BENCHMARK_HOST_LIMIT")
        return result
      } catch (cause) {
        if (input.signal?.aborted || lifecycle.signal.aborted)
          throw new Docker.Cancelled("Benchmark host invocation cancelled", { cause })
        if (timeout.aborted) throw new Docker.Timeout("Benchmark host invocation timed out", { cause })
        throw new Docker.Unavailable("Benchmark host invocation unavailable", { cause })
      }
    },
  })
  const browser: PlaywrightCapture.Runtime = Object.freeze({
    async capture(input: PlaywrightCapture.CaptureInput) {
      guard()
      const url = new URL(input.url)
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        input.allowedOrigins.length > 1 ||
        input.allowedOrigins.some((origin) => origin !== url.origin) ||
        !Number.isSafeInteger(input.viewport.width) ||
        input.viewport.width < 1 ||
        input.viewport.width > 4096 ||
        !Number.isSafeInteger(input.viewport.height) ||
        input.viewport.height < 1 ||
        input.viewport.height > 4096 ||
        !input.readySelector ||
        input.readySelector.length > 1024
      )
        throw new TypeError("TASK24_BENCHMARK_HOST_CAPTURE")
      // This ceiling includes native launch/transport overhead; the controller
      // retains the original browser action limits and workflow budget gates.
      const signal = AbortSignal.any([
        input.signal,
        lifecycle.signal,
        AbortSignal.timeout(Math.min(120000, connection.expiresAt - Date.now())),
      ])
      const parsed = Schema.decodeUnknownOption(Image)(
        await request(
          "production-capture",
          {
            capability: connection.capability,
            url: input.url,
            viewport: input.viewport,
            readySelector: input.readySelector,
            allowedOrigins: input.allowedOrigins,
          },
          signal,
        ),
        { onExcessProperty: "error" },
      )
      if (parsed._tag !== "Some") throw new TypeError("TASK24_BENCHMARK_HOST_IMAGE")
      const image = parsed.value
      const bytes = Buffer.from(image.data, "base64")
      if (
        bytes.length < 8 ||
        bytes.length > 8388608 ||
        bytes.length !== image.bytes ||
        bytes.toString("base64") !== image.data ||
        bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        createHash("sha256").update(bytes).digest("hex") !== image.sha256
      )
        throw new TypeError("TASK24_BENCHMARK_HOST_IMAGE")
      return bytes
    },
    async close() {
      lifecycle.abort()
    },
  })
  return Object.freeze({ engine, browser })
}

function decodeJson(text: string): unknown {
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  if (parsed._tag !== "Some") throw new TypeError("TASK24_BENCHMARK_HOST_JSON")
  return parsed.value
}

function read(file: string) {
  const before = fs.lstatSync(file, { bigint: true })
  if (
    fs.realpathSync.native(file) !== file ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size < 1n ||
    before.size > 16384n
  )
    throw new TypeError("TASK24_BENCHMARK_HOST_FILE")
  const bytes = fs.readFileSync(file)
  const after = fs.lstatSync(file, { bigint: true })
  const id = (s: typeof before) => `${s.dev}:${s.ino}:${s.birthtimeNs}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  if (id(before) !== id(after) || BigInt(bytes.length) !== before.size)
    throw new TypeError("TASK24_BENCHMARK_HOST_FILE")
  return {
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    identity: id(before) + ":" + createHash("sha256").update(bytes).digest("hex"),
  }
}
