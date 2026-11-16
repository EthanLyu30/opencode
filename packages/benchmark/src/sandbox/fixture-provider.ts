import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { sha256Text } from "../hash"
const issued = new WeakSet<object>()
export function requireFixtureCapabilityProvider(value: object) {
  if (!issued.has(value)) throw new TypeError("TASK24_FIXTURE_PROVIDER_AUTHORITY")
}
export const FixtureReply = Schema.Struct({
  protocol: Schema.Literals(["chat_completions", "responses"]),
  model: Schema.Literals(["kimi-k3", "deepseek-v4-pro", "deepseek-v4-flash"]),
  events: Schema.Array(Schema.Struct({ event: Schema.optionalKey(Schema.String), data: Schema.Unknown })),
})
export type FixtureReply = typeof FixtureReply.Type
function fixtureToolOutputs(body: unknown) {
  if (!body || typeof body !== "object") return []
  return ["messages", "input"].flatMap((key) => {
    const list = (body as Record<string, unknown>)[key]
    if (!Array.isArray(list)) return []
    return list.flatMap((raw: unknown) => {
      if (!raw || typeof raw !== "object") return []
      const item = raw as Record<string, unknown>
      const callID =
        item.role === "tool" ? item.tool_call_id : item.type === "function_call_output" ? item.call_id : undefined
      if (typeof callID !== "string") return []
      return [{ callID, output: item.role === "tool" ? item.content : item.output }]
    })
  })
}
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
  for (const item of fixtureToolOutputs(body)) {
    const value = decode(item.output)
    if (value) values.set(item.callID, value)
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
  const names = new Map<string, string>()
  const results = new Map<
    string,
    Readonly<{ callID: string; name: string; bytes: number; sha256: string; text?: string }>
  >()
  function remember(raw: unknown) {
    if (!raw || typeof raw !== "object") return
    const event = raw as Record<string, unknown>
    const response =
      event.response && typeof event.response === "object" ? (event.response as Record<string, unknown>) : undefined
    const choices = Array.isArray(event.choices) ? event.choices : []
    const calls: unknown[] = [
      event.item,
      ...(Array.isArray(response?.output) ? response.output : []),
      ...choices.flatMap((choice: unknown) => {
        if (
          !choice ||
          typeof choice !== "object" ||
          !("delta" in choice) ||
          !choice.delta ||
          typeof choice.delta !== "object"
        )
          return []
        return "tool_calls" in choice.delta && Array.isArray(choice.delta.tool_calls) ? choice.delta.tool_calls : []
      }),
    ]
    for (const rawCall of calls) {
      if (!rawCall || typeof rawCall !== "object") continue
      const call = rawCall as Record<string, unknown>
      if (call.type !== "function_call" && call.type !== "function") continue
      const fn =
        call.function && typeof call.function === "object" ? (call.function as Record<string, unknown>) : undefined
      const callID = call.type === "function_call" ? call.call_id : call.id
      const name = call.type === "function_call" ? call.name : fn?.name
      if (typeof callID !== "string" || typeof name !== "string") continue
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(callID) ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(name) ||
        (names.has(callID) ? names.get(callID) !== name : names.size >= 128)
      )
        throw new TypeError("TASK24_FIXTURE_TOOL_BINDING")
      names.set(callID, name)
    }
  }
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
        for (const item of fixtureToolOutputs(body)) {
          const name = names.get(item.callID)
          if (!name || item.output === undefined) continue
          const text = typeof item.output === "string" ? item.output : JSON.stringify(item.output)
          const sha256 = sha256Text(text)
          if (results.has(item.callID) && results.get(item.callID)!.sha256 !== sha256)
            throw new TypeError("TASK24_FIXTURE_TOOL_BINDING")
          const bytes = Buffer.byteLength(text)
          results.set(
            item.callID,
            Object.freeze({ callID: item.callID, name, bytes, sha256, ...(bytes <= 4096 ? { text } : {}) }),
          )
        }
        events = step.events.map((e) => bindFixtureOutputs(e.data, body))
        events.forEach(remember)
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
  const provider = Object.freeze({
    origin: `http://127.0.0.1:${server.port}`,
    grant,
    observation: () => ({ calls: index, rejected, complete: index === steps.length && rejected === 0 }),
    toolResults: () => Object.freeze([...results.values()]),
    async stop() {
      issued.delete(provider)
      await server.stop(true)
    },
  })
  issued.add(provider)
  return provider
}
