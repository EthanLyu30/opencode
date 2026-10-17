import { randomBytes } from "node:crypto"
import { Schema } from "effect"
export const FixtureReply = Schema.Struct({
  protocol: Schema.Literals(["chat_completions", "responses"]),
  model: Schema.Literals(["kimi-k3", "deepseek-v4-pro", "deepseek-v4-flash"]),
  events: Schema.Array(Schema.Struct({ event: Schema.optionalKey(Schema.String), data: Schema.Unknown })),
})
export type FixtureReply = typeof FixtureReply.Type
export function bindFixtureOutputs(event: unknown, body: unknown): unknown {
  const values = new Map<string, Record<string, unknown>>()
  function decode(input: unknown, depth = 0): Record<string, unknown> | null {
    if (depth > 8) return null
    if (typeof input === "string") {
      try {
        return decode(JSON.parse(input), depth + 1)
      } catch {
        return null
      }
    }
    if (Array.isArray(input)) {
      for (const item of input) {
        const found = decode(item, depth + 1)
        if (found) return found
      }
      return null
    }
    if (!input || typeof input !== "object") return null
    if ("previewID" in input) return input as Record<string, unknown>
    for (const name of ["content", "text", "value", "output"])
      if (name in input) {
        const found = decode(input[name as keyof typeof input], depth + 1)
        if (found) return found
      }
    return input as Record<string, unknown>
  }
  if (body && typeof body === "object")
    for (const key of ["messages", "input"]) {
      const list = (body as Record<string, unknown>)[key]
      if (Array.isArray(list))
        for (const rawItem of list as unknown[]) {
          if (!rawItem || typeof rawItem !== "object") continue
          const item = rawItem as Record<string, unknown>,
            id =
              item.role === "tool"
                ? item.tool_call_id
                : item.type === "function_call_output"
                  ? item.call_id
                  : undefined,
            raw = item.role === "tool" ? item.content : item.output
          if (typeof id === "string") {
            const value = decode(raw)
            if (value) values.set(id, value)
          }
        }
    }
  function visit(data: unknown): unknown {
    if (typeof data === "string") {
      const resolved = data.replace(
        /\{\{tool:([a-zA-Z0-9_-]{1,128}):(previewID|sha256|screenshotSha256|candidateSha256)\}\}/g,
        (_, id: string, key: string) => {
          const value = values.get(id)?.[key]
          if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
            throw new TypeError("TASK24_FIXTURE_TOOL_BINDING")
          return value
        },
      )
      if (resolved.includes("{{tool:")) throw new TypeError("TASK24_FIXTURE_TOOL_BINDING")
      return resolved
    }
    if (Array.isArray(data)) return data.map(visit)
    if (data && typeof data === "object") return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, visit(v)]))
    return data
  }
  return visit(event)
}
/** A closed in-memory transport. There is no upstream URL, credential lookup or fetch branch. */
export function startFixtureCapabilityProvider(script: readonly FixtureReply[]) {
  const steps = Schema.decodeUnknownSync(Schema.NonEmptyArray(FixtureReply))(script, { onExcessProperty: "error" })
  if (steps.length > 128 || Buffer.byteLength(JSON.stringify(steps)) > 8388608)
    throw new TypeError("TASK24_FIXTURE_SCRIPT_LIMIT")
  const grant = randomBytes(32).toString("base64url")
  let index = 0,
    rejected = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 8388608,
    async fetch(request) {
      const step = steps[index],
        url = new URL(request.url)
      if (!step || request.method !== "POST" || request.headers.get("authorization") !== "Bearer " + grant) {
        rejected++
        return new Response(null, { status: 403 })
      }
      const expected = step.protocol === "responses" ? "/v1/deepseek/responses" : "/v1/kimi/chat/completions"
      if (url.pathname !== expected) {
        rejected++
        return new Response(null, { status: 404 })
      }
      const body: unknown = await request.json().catch(() => null)
      if (!body || typeof body !== "object" || !("model" in body) || body.model !== step.model) {
        rejected++
        return new Response(null, { status: 400 })
      }
      let events: unknown[]
      try {
        events = step.events.map((e) => bindFixtureOutputs(e.data, body))
      } catch {
        rejected++
        return new Response(null, { status: 400 })
      }
      index++
      const wire =
        step.events
          .map((e, i) => (e.event ? "event: " + e.event + "\n" : "") + "data: " + JSON.stringify(events[i]) + "\n\n")
          .join("") + (step.protocol === "chat_completions" ? "data: [DONE]\n\n" : "")
      return new Response(wire, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return Object.freeze({
    origin: `http://127.0.0.1:${server.port}`,
    grant,
    observation: () => ({ calls: index, rejected, complete: index === steps.length && rejected === 0 }),
    async stop() {
      await server.stop(true)
    },
  })
}
