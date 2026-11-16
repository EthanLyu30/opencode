import { randomBytes, timingSafeEqual } from "node:crypto"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import type { makeProductionCommandEngine } from "./production-command-bridge"
import { sha256Bytes } from "../hash"
import { ProductionGitRequest, type ProductionGit } from "./production-git"

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
const Capture = Schema.Struct({
  capability: Schema.String,
  url: Schema.String,
  viewport: Schema.Struct({ width: Schema.Int, height: Schema.Int }),
  readySelector: Schema.String,
  allowedOrigins: Schema.Array(Schema.String),
})
export type ProductionCaptureInput = Omit<typeof Capture.Type, "capability">
export type ProductionCapture = Readonly<{
  /** Controller-owned exact preview/lease admission, not a model URL allowlist. */
  admit(input: ProductionCaptureInput): Promise<void>
  capture(input: ProductionCaptureInput, signal: AbortSignal): Promise<Uint8Array>
  close(): Promise<void>
}>
export type ProductionStaticSnapshot = Readonly<{
  entrypoint: string
  root: string
  files: readonly Readonly<{ path: string; bytes: Uint8Array }>[]
}>
const Preview = Schema.Struct({
  capability: Schema.String,
  operation: Schema.Literals(["open", "close"]),
  hostID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
const GitRequest = Schema.Struct({ capability: Schema.String, ...ProductionGitRequest.fields })

/** Framing only; production admission is startProductionCommandBridge's real-runner gate. */
type CommandEngine = Awaited<ReturnType<typeof makeProductionCommandEngine>>
export async function startProductionCommandEndpoint(
  engine: Pick<CommandEngine, "execute" | "outstanding"> & Partial<Pick<CommandEngine, "retire">>,
  options: {
    cleanupTimeoutMs?: number
    capture?: ProductionCapture
    previews?: readonly ProductionStaticSnapshot[]
    previewExpiresAt?: number
    git?: ProductionGit
  } = {},
) {
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5000
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 5000)
    throw new TypeError("TASK24_PRODUCTION_COMMAND_CLEANUP_LIMIT")
  const capability = randomBytes(32).toString("hex")
  const lifecycle = new AbortController()
  const pending = new Set<Promise<void>>()
  const previews = freezePreviews(options.previews ?? [])
  const previewExpiresAt = options.previewExpiresAt ?? Date.now() + 600000
  if (
    !Number.isSafeInteger(previewExpiresAt) ||
    previewExpiresAt <= Date.now() ||
    previewExpiresAt > Date.now() + 3600000
  )
    throw new TypeError("TASK24_PRODUCTION_PREVIEW_EXPIRY")
  const leases = new Map<string, { sha256: string; active: boolean; requests: number }>()
  let closed = false
  function admitStaticPreview(url: string) {
    const match = /^http:\/\/127\.0\.0\.1:\d+\/([a-f0-9]{64})\/$/.exec(url)
    if (
      closed ||
      Date.now() >= previewExpiresAt ||
      !match ||
      url !== `http://127.0.0.1:${server.port}/${match[1]}/` ||
      !leases.get(match[1]!)?.active
    )
      throw Error("TASK24_PRODUCTION_PREVIEW_NOT_OWNED")
  }
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
          server.requestIP(request)?.address !== "127.0.0.1" ||
          request.headers.get("host") !== `127.0.0.1:${server.port}` ||
          request.headers.has("origin")
        )
          return deny()
        if (request.method === "GET") {
          if (Date.now() >= previewExpiresAt || request.headers.has("upgrade")) return deny()
          const match = /^http:\/\/127\.0\.0\.1:\d+\/([a-f0-9]{64})\/([^?#%\\]*)$/.exec(request.url)
          if (!match) return deny()
          const lease = leases.get(match[1]!)
          const snapshot = lease?.active ? previews.get(lease.sha256) : undefined
          if (!snapshot) return deny()
          const relative = match[2]!
          if (relative && !staticPath(relative)) return deny()
          const file = snapshot.files.get(
            relative === "" ? snapshot.entrypoint : snapshot.root ? `${snapshot.root}/${relative}` : relative,
          )
          if (!file) return deny()
          lease!.requests++
          return new Response(Uint8Array.from(file.bytes).buffer, {
            headers: {
              "content-type": file.type,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "referrer-policy": "no-referrer",
              "cross-origin-resource-policy": "same-origin",
              "content-security-policy":
                "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'none'; object-src 'none'; base-uri 'none'",
            },
          })
        }
        const previewing =
          previews.size > 0 && request.url === `http://127.0.0.1:${server.port}/task24/production-preview`
        const capturing =
          options.capture !== undefined && request.url === `http://127.0.0.1:${server.port}/task24/production-capture`
        const git = options.git !== undefined && request.url === `http://127.0.0.1:${server.port}/task24/production-git`
        if (
          closed ||
          pending.size >= 4 ||
          server.requestIP(request)?.address !== "127.0.0.1" ||
          request.method !== "POST" ||
          (!git && !previewing && !capturing && request.url !== `http://127.0.0.1:${server.port}${endpoint}`) ||
          request.headers.get("host") !== `127.0.0.1:${server.port}` ||
          request.headers.has("origin") ||
          request.headers.get("content-type") !== "application/json"
        )
          return deny()
        const completion = Promise.withResolvers<void>()
        pending.add(completion.promise)
        const readAbort = AbortSignal.timeout(10000)
        try {
          const raw = await bounded(request, readAbort)
          if (closed || lifecycle.signal.aborted) return deny()
          const value = git
            ? Schema.decodeUnknownSync(GitRequest)(JSON.parse(raw), { onExcessProperty: "error" })
            : previewing
              ? Schema.decodeUnknownSync(Preview)(JSON.parse(raw), { onExcessProperty: "error" })
              : capturing
                ? Schema.decodeUnknownSync(Capture)(JSON.parse(raw), { onExcessProperty: "error" })
                : Schema.decodeUnknownSync(Request)(JSON.parse(raw), { onExcessProperty: "error" })
          if (
            !/^[a-f0-9]{64}$/.test(value.capability) ||
            !timingSafeEqual(Buffer.from(value.capability), Buffer.from(capability))
          )
            return deny()
          if ("cwd" in value) {
            if (Date.now() >= previewExpiresAt) return deny()
            const input = Schema.decodeUnknownSync(ProductionGitRequest)(value)
            const result = await options.git!.execute(
              input,
              AbortSignal.any([lifecycle.signal, request.signal, AbortSignal.timeout(15000)]),
            )
            if (closed || Date.now() >= previewExpiresAt) return deny()
            return Response.json(Schema.decodeUnknownSync(Result)(result, { onExcessProperty: "error" }))
          }
          if ("operation" in value) {
            if (Date.now() >= previewExpiresAt || !previews.has(value.sha256)) return deny()
            const lease = leases.get(value.hostID)
            if (value.operation === "open") {
              if (lease ? !lease.active || lease.sha256 !== value.sha256 : leases.size >= 128) return deny()
              if (!lease) leases.set(value.hostID, { sha256: value.sha256, active: true, requests: 0 })
            } else {
              if (!lease || lease.sha256 !== value.sha256) return deny()
              lease.active = false
            }
            return Response.json({ port: server.port, hostID: value.hostID, sha256: value.sha256 })
          }
          if ("url" in value) {
            const url = new URL(value.url)
            if (
              url.protocol !== "http:" ||
              url.hostname !== "127.0.0.1" ||
              !url.port ||
              Number(url.port) < 1024 ||
              url.href !== value.url ||
              url.username ||
              url.password ||
              url.hash ||
              url.search ||
              value.allowedOrigins.length > 1 ||
              value.allowedOrigins.some((origin) => origin !== url.origin) ||
              value.viewport.width < 1 ||
              value.viewport.width > 4096 ||
              value.viewport.height < 1 ||
              value.viewport.height > 4096 ||
              !value.readySelector ||
              value.readySelector.length > 1024
            )
              return deny()
            const input = Object.freeze({
              url: value.url,
              viewport: Object.freeze({ ...value.viewport }),
              readySelector: value.readySelector,
              allowedOrigins: Object.freeze([...value.allowedOrigins]),
            })
            const signal = AbortSignal.any([lifecycle.signal, request.signal, AbortSignal.timeout(120000)])
            signal.throwIfAborted()
            if (previews.size) admitStaticPreview(input.url)
            await options.capture!.admit(input)
            signal.throwIfAborted()
            const bytes = await options.capture!.capture(input, signal)
            signal.throwIfAborted()
            await options.capture!.admit(input)
            if (previews.size) admitStaticPreview(input.url)
            signal.throwIfAborted()
            if (
              closed ||
              bytes.byteLength < 8 ||
              bytes.byteLength > 8388608 ||
              Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a"
            )
              return deny()
            return Response.json({
              mimeType: "image/png",
              data: Buffer.from(bytes).toString("base64"),
              bytes: bytes.byteLength,
              sha256: sha256Bytes(bytes),
            })
          }
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
    let timer: ReturnType<typeof setTimeout> | undefined
    const failures: unknown[] = []
    try {
      await Promise.race([
        cleanupIndependently(
          [
            async () => {
              await options.git?.close()
            },
            async () => {
              await options.capture?.close()
            },
            async () => {
              await engine.retire?.()
            },
          ],
          failures,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AggregateError(
                  [...failures, Error("TASK24_PRODUCTION_COMMAND_CLEANUP_UNCERTAIN")],
                  "TASK24_PRODUCTION_ENDPOINT_RESIDUAL",
                ),
              ),
            cleanupTimeoutMs,
          )
        }),
      ])
    } catch (cleanupCause) {
      throw Object.assign(new AggregateError([cause, cleanupCause], "TASK24_PRODUCTION_ENDPOINT_RESIDUAL"), {
        residualArtifacts:
          cleanupCause instanceof Error &&
          "residualArtifacts" in cleanupCause &&
          Array.isArray(cleanupCause.residualArtifacts)
            ? cleanupCause.residualArtifacts
            : [],
      })
    } finally {
      clearTimeout(timer)
    }
    throw cause
  }
  let closing: Promise<void> | undefined
  return Object.freeze({
    host: "127.0.0.1" as const,
    port: server.port!,
    capability,
    admitStaticPreview,
    previewObservation() {
      return Object.freeze([...leases].map(([hostID, lease]) => Object.freeze({ hostID, ...lease })))
    },
    close() {
      return (closing ??= (async () => {
        closed = true
        for (const lease of leases.values()) lease.active = false
        lifecycle.abort()
        const stopped = server.stop(false)
        const cleanup = new AbortController()
        const failures: unknown[] = []
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            (async () => {
              await Promise.all([stopped, ...pending])
              cleanup.signal.throwIfAborted()
              await cleanupIndependently(
                [
                  async () => {
                    await options.git?.close()
                  },
                  async () => {
                    await options.capture?.close()
                  },
                  async () => {
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
                  },
                ],
                failures,
              )
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                cleanup.abort()
                reject(
                  failures.length
                    ? new AggregateError(
                        [...failures, Error("TASK24_PRODUCTION_COMMAND_CLEANUP_UNCERTAIN")],
                        "TASK24_PRODUCTION_COMMAND_CLEANUP_UNCERTAIN",
                      )
                    : Error("TASK24_PRODUCTION_COMMAND_CLEANUP_UNCERTAIN"),
                )
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

function staticPath(value: string) {
  return (
    value.length <= 1024 &&
    value
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9_][A-Za-z0-9._@+()[\]-]*$/.test(part) &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
      )
  )
}

export function productionStaticSnapshotSha256(input: ProductionStaticSnapshot) {
  return sha256Bytes(
    Buffer.from(
      JSON.stringify([
        input.entrypoint,
        input.root,
        [...input.files]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((file) => [file.path, sha256Bytes(file.bytes)]),
      ]),
    ),
  )
}

function freezePreviews(inputs: readonly ProductionStaticSnapshot[]) {
  if (inputs.length > 32) throw new TypeError("TASK24_PRODUCTION_PREVIEW_LIMIT")
  const snapshots = new Map<
    string,
    { entrypoint: string; root: string; files: Map<string, { bytes: Uint8Array; type: string }> }
  >()
  let total = 0
  for (const input of inputs) {
    if (
      !staticPath(input.entrypoint) ||
      (input.root !== "" && !staticPath(input.root)) ||
      (input.root && !input.entrypoint.startsWith(input.root + "/")) ||
      !input.files.length ||
      input.files.length > 512
    )
      throw new TypeError("TASK24_PRODUCTION_PREVIEW_SNAPSHOT")
    const files = new Map<string, { bytes: Uint8Array; type: string }>()
    const keys = new Set<string>()
    for (const file of input.files) {
      total += file.bytes.byteLength
      if (
        !staticPath(file.path) ||
        keys.has(file.path.toLowerCase()) ||
        file.bytes.byteLength > 33554432 ||
        total > 67108864
      )
        throw new TypeError("TASK24_PRODUCTION_PREVIEW_SNAPSHOT")
      keys.add(file.path.toLowerCase())
      files.set(file.path, {
        bytes: Uint8Array.from(file.bytes),
        type: Bun.file(file.path).type || "application/octet-stream",
      })
    }
    if (!files.has(input.entrypoint)) throw new TypeError("TASK24_PRODUCTION_PREVIEW_SNAPSHOT")
    const sha256 = productionStaticSnapshotSha256({
      ...input,
      files: [...files].map(([path, file]) => ({ path, bytes: file.bytes })),
    })
    if (snapshots.has(sha256)) throw new TypeError("TASK24_PRODUCTION_PREVIEW_DUPLICATE")
    snapshots.set(sha256, { entrypoint: input.entrypoint, root: input.root, files })
  }
  return snapshots
}

async function cleanupIndependently(operations: readonly (() => Promise<void>)[], failures: unknown[]) {
  await Promise.all(
    operations.map(async (operation) => {
      try {
        await operation()
      } catch (cause) {
        failures.push(cause)
      }
    }),
  )
  if (failures.length === 1) throw failures[0]
  if (failures.length)
    throw Object.assign(new AggregateError(failures, "TASK24_PRODUCTION_ENDPOINT_RESIDUAL"), {
      residualArtifacts: failures.flatMap((cause) =>
        cause instanceof Error && "residualArtifacts" in cause && Array.isArray(cause.residualArtifacts)
          ? cause.residualArtifacts
          : [],
      ),
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
