import { randomBytes, timingSafeEqual } from "node:crypto"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import type { makeProductionCommandEngine } from "./production-command-bridge"

export const ProductionBridgeConnection = Schema.Struct({
  host: Schema.Literal("127.0.0.1"),
  port: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(65535)),
  capability: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  expiresAt: Schema.Int,
})

const Request = Schema.Struct({
  capability: Schema.String,
  argv: Schema.Array(Schema.String),
  stdin: Schema.optionalKey(Schema.String),
})
const Result = Schema.Struct({
  exit: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
})
const maxFrame = 12 * 1024 * 1024
const endpoint = "/task24/production-command"

/** Framing only; production admission is startProductionCommandBridge's real-runner gate. */
type CommandEngine = Awaited<ReturnType<typeof makeProductionCommandEngine>>
export async function startProductionCommandEndpoint(
  engine: Pick<CommandEngine, "execute" | "outstanding"> & Partial<Pick<CommandEngine, "retire">>,
  options: { cleanupTimeoutMs?: number } = {},
) {
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5000
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 5000)
    throw new TypeError("TASK24_PRODUCTION_COMMAND_CLEANUP_LIMIT")
  const capability = randomBytes(32).toString("hex")
  const lifecycle = new AbortController()
  const pending = new Set<Promise<void>>()
  let closed = false
  const deny = (cause?: unknown) =>
    Response.json(
      {
        code:
          cause instanceof Error && /^TASK24_[A-Z0-9_]{1,96}$/.test(cause.message)
            ? cause.message
            : "TASK24_PRODUCTION_COMMAND_DENIED",
      },
      { status: 403 },
    )
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      maxRequestBodySize: maxFrame,
      async fetch(request, server) {
        if (
          closed ||
          pending.size >= 4 ||
          server.requestIP(request)?.address !== "127.0.0.1" ||
          request.method !== "POST" ||
          request.url !== `http://127.0.0.1:${server.port}${endpoint}` ||
          request.headers.has("origin") ||
          request.headers.get("content-type") !== "application/json"
        )
          return deny()
        const completion = Promise.withResolvers<void>()
        pending.add(completion.promise)
        const readAbort = AbortSignal.timeout(10000)
        try {
          const raw = await bounded(request, readAbort)
          const value = Schema.decodeUnknownSync(Request)(JSON.parse(raw), { onExcessProperty: "error" })
          if (
            !/^[a-f0-9]{64}$/.test(value.capability) ||
            !timingSafeEqual(Buffer.from(value.capability), Buffer.from(capability))
          )
            return deny()
          const stdin = value.stdin === undefined ? undefined : Buffer.from(value.stdin, "base64")
          if (stdin && (stdin.length > 8388608 || stdin.toString("base64") !== value.stdin)) return deny()
          const timeoutMs =
            value.argv[1] === "start" ? 600000 : ["kill", "rm"].includes(value.argv[1] ?? "") ? 5000 : 15000
          const result = await engine.execute({
            argv: value.argv,
            ...(stdin?.length ? { stdin } : {}),
            timeoutMs,
            maxOutputBytes: 1048576,
            signal: AbortSignal.any([lifecycle.signal, request.signal, AbortSignal.timeout(timeoutMs)]),
          })
          if (closed) return deny()
          return Response.json(Schema.decodeUnknownSync(Result)(result, { onExcessProperty: "error" }))
        } catch (cause) {
          return deny(cause)
        } finally {
          pending.delete(completion.promise)
          completion.resolve()
        }
      },
    })
  } catch (cause) {
    try {
      await engine.retire?.()
    } catch (cleanupCause) {
      throw Object.assign(new AggregateError([cause, cleanupCause], "TASK24_PRODUCTION_ENDPOINT_RESIDUAL"), {
        residualArtifacts:
          cleanupCause instanceof Error &&
          "residualArtifacts" in cleanupCause &&
          Array.isArray(cleanupCause.residualArtifacts)
            ? cleanupCause.residualArtifacts
            : [],
      })
    }
    throw cause
  }
  let closing: Promise<void> | undefined
  return Object.freeze({
    host: "127.0.0.1" as const,
    port: server.port!,
    capability,
    close() {
      return (closing ??= (async () => {
        closed = true
        lifecycle.abort()
        const stopped = server.stop(false)
        const cleanup = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            (async () => {
              await Promise.all([stopped, ...pending])
              cleanup.signal.throwIfAborted()
              // Verify labels/policy on every cleanup; never adopt by name.
              const outstanding = engine.outstanding()
              for (const id of outstanding.containers) {
                for (const argv of [
                  ["container", "kill", id],
                  ["container", "rm", "--force", id],
                ]) {
                  cleanup.signal.throwIfAborted()
                  await engine.execute({
                    argv,
                    timeoutMs: cleanupTimeoutMs,
                    maxOutputBytes: 1048576,
                    signal: cleanup.signal,
                  })
                }
              }
              cleanup.signal.throwIfAborted()
              if (engine.outstanding().containers.length || outstanding.uncertainNames.length)
                throw Error("TASK24_PRODUCTION_COMMAND_CLEANUP_UNCERTAIN")
              await engine.retire?.()
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                cleanup.abort()
                reject(Error("TASK24_PRODUCTION_COMMAND_CLEANUP_UNCERTAIN"))
              }, cleanupTimeoutMs)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      })())
    },
  })
}

async function bounded(message: { body: ReadableStream<Uint8Array> | null }, signal: AbortSignal) {
  const reader = message.body?.getReader()
  if (!reader) throw Error("body")
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", abort, { once: true })
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      if (signal.aborted) throw Error("timeout")
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.length
      if (bytes > maxFrame) throw Error("limit")
      chunks.push(next.value)
    }
    if (signal.aborted) throw Error("timeout")
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
  }
}

export async function callProductionCommandBridge(input: {
  host: string
  port: number
  capability: string
  argv: readonly string[]
  stdin?: Uint8Array
  signal?: AbortSignal
}) {
  if (
    input.host !== "127.0.0.1" ||
    !Number.isSafeInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(input.capability)
  )
    throw new TypeError("TASK24_PRODUCTION_COMMAND_ENDPOINT")
  const body = canonicalJson({
    capability: input.capability,
    argv: input.argv,
    ...(input.stdin?.length ? { stdin: Buffer.from(input.stdin).toString("base64") } : {}),
  })
  if (Buffer.byteLength(body) > maxFrame) throw new TypeError("TASK24_PRODUCTION_COMMAND_FRAME")
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(615000)])
  const response = await fetch(`http://127.0.0.1:${input.port}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    redirect: "error",
    proxy: "",
    signal,
  })
  if (response.status !== 200) {
    const raw = await bounded(response, signal).catch(() => "")
    const value = raw.length < 256 ? JSON.parse(raw || "{}") : {}
    throw Error(
      typeof value.code === "string" && /^TASK24_[A-Z0-9_]{1,96}$/.test(value.code)
        ? value.code
        : "TASK24_PRODUCTION_COMMAND_DENIED",
    )
  }
  return Schema.decodeUnknownSync(Result)(JSON.parse(await bounded(response, signal)), { onExcessProperty: "error" })
}
