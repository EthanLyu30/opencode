import { randomBytes } from "node:crypto"
import { Schema } from "effect"
export const FixtureReply = Schema.Struct({
  protocol: Schema.Literals(["chat_completions", "responses"]),
  model: Schema.Literals(["kimi-k3", "deepseek-v4-pro", "deepseek-v4-flash"]),
  events: Schema.Array(Schema.Struct({ event: Schema.optionalKey(Schema.String), data: Schema.Unknown })),
})
export type FixtureReply = typeof FixtureReply.Type
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
      const body: unknown = await request.json()
      if (!body || typeof body !== "object" || !("model" in body) || body.model !== step.model) {
        rejected++
        return new Response(null, { status: 400 })
      }
      index++
      const wire =
        step.events
          .map((e) => (e.event ? "event: " + e.event + "\n" : "") + "data: " + JSON.stringify(e.data) + "\n\n")
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
