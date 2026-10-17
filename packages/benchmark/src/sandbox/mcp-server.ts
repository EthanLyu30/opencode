import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { timingSafeEqual } from "node:crypto"
import { canonicalJson } from "../campaign/canonical"
import type { PublicToolHost } from "./public-tools"
import { createServer, createConnection } from "node:net"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"

const PipeCall = Schema.Struct({
  capability: Schema.String,
  name: Schema.Literals(["read", "write", "check", "preview", "capture"]),
  parameters: Schema.Unknown,
})
const maxFrame = 12 * 1024 * 1024
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
          if (call.capability !== capability) throw Error("cap")
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
        properties: { ...properties, capability: { type: "string" } },
        required: [...Object.keys(properties), "capability"],
        additionalProperties: false,
      },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments ?? {},
        cap = args.capability
      if (
        typeof cap !== "string" ||
        !/^[a-f0-9]{64}$/.test(cap) ||
        !timingSafeEqual(Buffer.from(cap), Buffer.from(input.capability))
      )
        throw Error("cap")
      if (!Object.hasOwn(specs, request.params.name)) throw Error("tool")
      const { capability, ...parameters } = args
      const name = request.params.name as keyof typeof specs
      const result = await input.host[name](parameters)
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
