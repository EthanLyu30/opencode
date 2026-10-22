import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { timingSafeEqual } from "node:crypto"
import { canonicalJson } from "../campaign/canonical"
import type { PublicToolHost } from "./public-tools"
import { createServer, createConnection } from "node:net"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { sha256Bytes } from "../hash"
export function publicCaptureContent(raw: unknown) {
  const value = Schema.decodeUnknownSync(
    Schema.Struct({
      screenshotSha256: Schema.String,
      evidenceSha256: Schema.String,
      identity: Schema.Struct({
        previewID: Schema.String,
        viewportID: Schema.Literals(["mobile", "tablet", "desktop"]),
        candidateSha256: Schema.String,
      }),
      image: Schema.Struct({
        mimeType: Schema.Literal("image/png"),
        data: Schema.String,
        bytes: Schema.Int,
        sha256: Schema.String,
      }),
    }),
  )(raw, { onExcessProperty: "error" })
  const bytes = Buffer.from(value.image.data, "base64")
  if (
    bytes.length !== value.image.bytes ||
    bytes.length < 8 ||
    bytes.length > 8388608 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.toString("base64") !== value.image.data ||
    sha256Bytes(bytes) !== value.image.sha256 ||
    value.image.sha256 !== value.screenshotSha256 ||
    ![value.identity.previewID, value.identity.candidateSha256, value.screenshotSha256, value.evidenceSha256].every(
      (v) => /^[a-f0-9]{64}$/.test(v),
    )
  )
    throw new TypeError("TASK24_PUBLIC_IMAGE_BINDING")
  const { image, ...metadata } = value
  return [
    { type: "image" as const, data: image.data, mimeType: image.mimeType },
    { type: "text" as const, text: canonicalJson(metadata) },
  ]
}

const PipeCall = Schema.Struct({
  capability: Schema.String,
  name: Schema.Literals(["read", "write", "check", "preview", "capture"]),
  parameters: Schema.Unknown,
})
const maxFrame = 12 * 1024 * 1024
const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false) }),
])

function decodeFrame(chunks: readonly Buffer[], bytes: number): unknown {
  if (bytes === 0 || bytes > maxFrame) throw Error("frame")
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) throw Error("frame")
  return JSON.parse(text)
}

// A single admitted port is usable by a restricted worker without granting access
// to arbitrary named pipes. Authority remains a per-run token, never a model arg.
export async function startPublicToolLoopback(input: {
  host: Pick<PublicToolHost, "read" | "write" | "check" | "preview" | "capture">
  lifecycle?: AbortController
  cleanupTimeoutMs?: number
}) {
  const cleanupTimeoutMs = input.cleanupTimeoutMs ?? 5000
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 5000)
    throw new TypeError("TASK24_PUBLIC_LOOPBACK_CLEANUP_LIMIT")
  const capability = randomBytes(32).toString("hex")
  const lifecycle = input.lifecycle ?? new AbortController()
  const pending = new Set<Promise<void>>()
  let closed = false
  let active = 0
  const denied = () => new Response('{"ok":false}\n', { status: 403, headers: { "content-type": "application/json" } })
  // HTTP supplies bounded request framing without depending on Bun's TCP
  // half-close semantics. This is a private bridge, not a public MCP endpoint.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: maxFrame,
    idleTimeout: 30,
    async fetch(request, server) {
      if (
        closed ||
        lifecycle.signal.aborted ||
        active >= 16 ||
        server.requestIP(request)?.address !== "127.0.0.1" ||
        request.method !== "POST" ||
        request.url !== `http://127.0.0.1:${server.port}/task24/public-tools` ||
        request.headers.has("origin") ||
        request.headers.get("content-type") !== "application/json"
      )
        return denied()
      active++
      const settled = Promise.withResolvers<void>()
      pending.add(settled.promise)
      const reader = request.body?.getReader()
      let expired = false
      const timer = setTimeout(() => {
        expired = true
        void reader?.cancel().catch(() => {})
      }, 30000)
      try {
        if (!reader) throw Error("body")
        const chunks: Buffer[] = []
        let bytes = 0
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > maxFrame) throw Error("limit")
          chunks.push(Buffer.from(chunk.value))
        }
        if (closed || expired || lifecycle.signal.aborted || request.signal.aborted) throw Error("closed")
        clearTimeout(timer)
        const call = Schema.decodeUnknownSync(PipeCall)(decodeFrame(chunks, bytes), { onExcessProperty: "error" })
        if (
          !/^[a-f0-9]{64}$/.test(call.capability) ||
          !timingSafeEqual(Buffer.from(call.capability), Buffer.from(capability))
        )
          throw Error("cap")
        const value = await input.host[call.name](call.parameters)
        const out = canonicalJson({ ok: true, value }) + "\n"
        if (closed || Buffer.byteLength(out) > maxFrame) throw Error("limit")
        return new Response(out, { headers: { "content-type": "application/json" } })
      } catch {
        return denied()
      } finally {
        clearTimeout(timer)
        await reader?.cancel().catch(() => {})
        active--
        pending.delete(settled.promise)
        settled.resolve()
      }
    },
  })
  let closing: Promise<void> | undefined
  return {
    host: "127.0.0.1" as const,
    port: server.port!,
    capability,
    close() {
      return (closing ??= (async () => {
        closed = true
        lifecycle.abort()
        // Forced stop can free Bun's HTTP context while a deferred tool promise
        // still owns it. Stop accepting, revoke authority, then drain gracefully.
        const stopped = server.stop(false)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            Promise.all([Promise.allSettled([...pending]), stopped]),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    Object.assign(new Error("TASK24_PUBLIC_LOOPBACK_CLEANUP_UNCERTAIN"), {
                      cleanupUncertain: true,
                    }),
                  ),
                cleanupTimeoutMs,
              )
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      })())
    },
  }
}

export async function callPublicToolLoopback(input: {
  host: string
  port: number
  capability: string
  name: string
  parameters: unknown
}): Promise<unknown> {
  if (
    input.host !== "127.0.0.1" ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(input.capability)
  )
    throw new TypeError("TASK24_PUBLIC_LOOPBACK")
  const frame = canonicalJson({ capability: input.capability, name: input.name, parameters: input.parameters }) + "\n"
  if (Buffer.byteLength(frame) > maxFrame) throw new TypeError("TASK24_PUBLIC_LOOPBACK_LIMIT")
  const response = await fetch(`http://127.0.0.1:${input.port}/task24/public-tools`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: frame,
    redirect: "error",
    proxy: "",
    signal: AbortSignal.timeout(30000),
  })
  const reader = response.body?.getReader()
  try {
    if (response.status !== 200 || !reader) throw Error("denied")
    const chunks: Buffer[] = []
    let bytes = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxFrame) throw Error("limit")
      chunks.push(Buffer.from(chunk.value))
    }
    const value = Schema.decodeUnknownSync(Reply)(decodeFrame(chunks, bytes), { onExcessProperty: "error" })
    if (!value.ok) throw Error("denied")
    return value.value
  } catch {
    throw new TypeError("TASK24_PUBLIC_LOOPBACK_DENIED")
  } finally {
    await reader?.cancel().catch(() => {})
  }
}

export async function startPublicToolPipe(input: {
  host: Pick<PublicToolHost, "read" | "write" | "check" | "preview" | "capture">
}) {
  const pipe = "\\\\.\\pipe\\opencode-task24-" + randomBytes(32).toString("hex"),
    capability = randomBytes(32).toString("hex"),
    sockets = new Set<ReturnType<typeof createConnection>>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.setTimeout(30000, () => socket.destroy())
    let text = ""
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8")
      if (Buffer.byteLength(text) > maxFrame) {
        socket.destroy()
        return
      }
      if (!text.endsWith("\n")) return
      socket.pause()
      void (async () => {
        try {
          const call = Schema.decodeUnknownSync(PipeCall)(JSON.parse(text), { onExcessProperty: "error" })
          if (
            !/^[a-f0-9]{64}$/.test(call.capability) ||
            !timingSafeEqual(Buffer.from(call.capability), Buffer.from(capability))
          )
            throw Error("cap")
          const value = await input.host[call.name](call.parameters)
          const out = canonicalJson({ ok: true, value }) + "\n"
          if (Buffer.byteLength(out) > maxFrame) throw Error("size")
          socket.end(out)
        } catch {
          socket.end('{"ok":false}\n')
        }
      })()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(pipe, () => resolve())
  })
  return {
    pipe,
    capability,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    },
  }
}
export async function callPublicToolPipe(input: {
  pipe: string
  capability: string
  name: string
  parameters: unknown
}): Promise<unknown> {
  if (!/^\\\\\.\\pipe\\opencode-task24-[a-f0-9]{64}$/.test(input.pipe) || !/^[a-f0-9]{64}$/.test(input.capability))
    throw new TypeError("TASK24_PUBLIC_PIPE")
  const frame = canonicalJson({ capability: input.capability, name: input.name, parameters: input.parameters }) + "\n"
  if (Buffer.byteLength(frame) > maxFrame) throw new TypeError("TASK24_PUBLIC_PIPE_LIMIT")
  return new Promise((resolve, reject) => {
    const socket = createConnection(input.pipe)
    let text = ""
    socket.setTimeout(30000, () => socket.destroy(Error("timeout")))
    socket.once("error", reject)
    socket.once("connect", () => socket.write(frame))
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8")
      if (Buffer.byteLength(text) > maxFrame) socket.destroy(Error("limit"))
    })
    socket.on("end", () => {
      try {
        const value = Schema.decodeUnknownSync(
          Schema.Union([
            Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
            Schema.Struct({ ok: Schema.Literal(false) }),
          ]),
        )(JSON.parse(text), { onExcessProperty: "error" })
        if (!value.ok) throw Error("denied")
        resolve(value.value)
      } catch {
        reject(new TypeError("TASK24_PUBLIC_PIPE_DENIED"))
      } finally {
        socket.destroy()
      }
    })
  })
}

export async function servePublicMcp(input: {
  host: Readonly<Record<"read" | "write" | "check" | "preview" | "capture", (input: unknown) => Promise<unknown>>>
  capability: string
  stdio?: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream }
}) {
  if (!/^[a-f0-9]{64}$/.test(input.capability)) throw new TypeError("TASK24_MCP_CAPABILITY")
  const server = new Server({ name: "task24-public-tools", version: "2" }, { capabilities: { tools: {} } })
  const specs = {
    read: { path: { type: "string" }, offset: { type: "integer" }, length: { type: "integer" } },
    write: { path: { type: "string" }, baseSha256: { type: ["string", "null"] }, content: { type: "string" } },
    check: { commandID: { type: "string" } },
    preview: { entry: { type: "string" } },
    capture: { previewID: { type: "string" }, viewportID: { type: "string", enum: ["mobile", "tablet", "desktop"] } },
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(specs).map(([name, properties]) => ({
      name,
      inputSchema: {
        type: "object" as const,
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const parameters = request.params.arguments ?? {}
      if (!Object.hasOwn(specs, request.params.name)) throw Error("tool")
      const name = request.params.name as keyof typeof specs
      const result = await input.host[name](parameters)
      if (name === "capture") return { content: publicCaptureContent(result) }
      return { content: [{ type: "text" as const, text: canonicalJson(result) }] }
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "TASK24_PUBLIC_TOOL_DENIED" }] }
    }
  })
  await server.connect(
    input.stdio
      ? new StdioServerTransport(input.stdio.stdin as NodeJS.ReadStream, input.stdio.stdout as NodeJS.WriteStream)
      : new StdioServerTransport(),
  )
  return server
}
