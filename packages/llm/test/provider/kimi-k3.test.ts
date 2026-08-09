import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, MediaPart, Message, ToolCallPart, Usage } from "../../src"
import * as Kimi from "../../src/providers/kimi"
import { LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const model = Kimi.configure({ baseURL: "https://api.moonshot.test/v1", apiKey: "test" }).model("kimi-k3")

const request = LLM.request({
  model,
  system: "You are the design lead.",
  prompt: "Design the page.",
  generation: {
    maxTokens: 4096,
    temperature: 1,
    topP: 0.95,
    frequencyPenalty: 0,
    presencePenalty: 0,
  },
})

const ObjectFixture = Schema.Record(Schema.String, Schema.Unknown)
const EventFixture = Schema.Array(ObjectFixture)
const fixtureFile = (name: string) => Bun.file(new URL(`../fixtures/kimi-k3/${name}.json`, import.meta.url)).json()
const objectFixture = (name: string) => fixtureFile(name).then(Schema.decodeUnknownSync(ObjectFixture))
const eventFixture = (name: string) => fixtureFile(name).then(Schema.decodeUnknownSync(EventFixture))

describe("Kimi K3-only Chat adapter", () => {
  it.effect("admits only the exact K3 model on the Moonshot Chat endpoint", () =>
    Effect.gen(function* () {
      expect(String(Kimi.model("kimi-k3").id)).toBe("kimi-k3")
      expect(Kimi.model("kimi-k3").route.id).toBe("openai-compatible-chat")
      expect(Kimi.model("kimi-k3").route.endpoint.baseURL).toBe("https://api.moonshot.cn/v1")

      for (const unsupported of ["kimi-k2.6", "kimi-k2.7", "kimi-k2.7-code"]) {
        expect(() => Kimi.model(unsupported)).toThrow()
      }

      yield* LLMClient.generate(LLM.updateRequest(request, { generation: { maxTokens: 64 } })).pipe(
        Effect.provide(
          dynamicResponse(({ request: outgoing, text, respond }) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(outgoing).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.moonshot.test/v1/chat/completions")
              expect(web.headers.get("authorization")).toBe("Bearer test")
              expect(JSON.parse(text)).toMatchObject({ model: "kimi-k3", reasoning_effort: "max" })
              return respond(sseEvents({ choices: [{ delta: {}, finish_reason: "stop" }], usage: null }))
            }),
          ),
        ),
      )
    }),
  )

  it.effect("defaults to max effort and omits K3 fixed sampling controls", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<Record<string, unknown>>(request)

      expect(prepared.body).toEqual({
        model: "kimi-k3",
        messages: [
          { role: "system", content: "You are the design lead." },
          { role: "user", content: "Design the page." },
        ],
        stream: true,
        stream_options: { include_usage: true },
        reasoning_effort: "max",
        max_completion_tokens: 4096,
      })
      for (const field of ["temperature", "top_p", "n", "presence_penalty", "frequency_penalty", "max_tokens"]) {
        expect(prepared.body).not.toHaveProperty(field)
      }
    }),
  )

  it.effect("accepts only low, high, and max reasoning effort", () =>
    Effect.gen(function* () {
      for (const reasoningEffort of ["low", "high", "max"] as const) {
        const prepared = yield* LLMClient.prepare<Record<string, unknown>>(
          LLM.updateRequest(request, { providerOptions: { kimi: { reasoningEffort } } }),
        )
        expect(prepared.body.reasoning_effort).toBe(reasoningEffort)
      }

      for (const reasoningEffort of ["none", "medium", "xhigh"]) {
        const error = yield* LLMClient.prepare(
          LLM.updateRequest(request, { providerOptions: { kimi: { reasoningEffort } } }),
        ).pipe(Effect.flip)
        expect(error.message).toContain("low, high, or max")
      }
    }),
  )

  it.effect("lowers base64 images and Moonshot file references as content arrays", () =>
    Effect.gen(function* () {
      const expected = yield* Effect.promise(() => objectFixture("vision-request"))
      const prepared = yield* LLMClient.prepare<Record<string, unknown>>(
        LLM.request({
          model,
          messages: [
            Message.user([
              { type: "media", mediaType: "image/png", data: new Uint8Array([0, 1, 2, 3]) },
              MediaPart.reference({ mediaType: "image/png", uri: "ms://file_reference_1" }),
              { type: "text", text: "对比参考图与实现图。" },
            ]),
          ],
        }),
      )

      expect(prepared.body).toEqual(expected)
    }),
  )

  it.effect("rejects public image URLs before transport", () =>
    Effect.gen(function* () {
      for (const url of ["https://example.com/reference.png", "http://example.com/reference.png"]) {
        const error = yield* LLMClient.prepare(
          LLM.request({
            model,
            messages: [Message.user({ type: "media", mediaType: "image/png", data: url })],
          }),
        ).pipe(Effect.flip)
        expect(error.message).toContain("public image URLs")
        expect(error.message).toContain("base64 or ms://")
      }
    }),
  )

  it.effect("uses strict JSON Schema for design and review DTOs", () =>
    Effect.gen(function* () {
      const expected = yield* Effect.promise(() => objectFixture("structured-request"))
      const prepared = yield* LLMClient.prepare<Record<string, unknown>>(
        LLM.request({
          model,
          prompt: "复审页面。",
          responseFormat: {
            type: "json",
            schema: {
              type: "object",
              properties: {
                approved: { type: "boolean" },
                issues: { type: "array", items: { type: "string" } },
              },
              required: ["approved", "issues"],
              additionalProperties: false,
            },
          },
        }),
      )

      expect(prepared.body).toEqual(expected)
    }),
  )

  it.effect("normalizes K3 reasoning, text, usage, and finish events", () =>
    Effect.gen(function* () {
      const events = yield* Effect.promise(() => eventFixture("text-stream"))
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(sseEvents(...events))))

      expect(response.reasoning).toBe("先梳理页面层级。")
      expect(response.text).toBe("设计规范已完成。")
      expect(response.usage).toEqual(
        new Usage({
          inputTokens: 40,
          outputTokens: 12,
          nonCachedInputTokens: 24,
          cacheReadInputTokens: 16,
          reasoningTokens: 7,
          totalTokens: 52,
          providerMetadata: {
            openai: {
              prompt_tokens: 40,
              completion_tokens: 12,
              total_tokens: 52,
              prompt_tokens_details: { cached_tokens: 16 },
              completion_tokens_details: { reasoning_tokens: 7 },
            },
          },
        }),
      )
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
    }),
  )

  it.effect("replays the complete assistant reasoning and tool call on the next turn", () =>
    Effect.gen(function* () {
      const events = yield* Effect.promise(() => eventFixture("tool-stream"))
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(sseEvents(...events))))

      expect(response.message.content).toEqual([
        expect.objectContaining({ type: "reasoning", text: "需要先读取设计令牌。" }),
        expect.objectContaining({
          type: "tool-call",
          id: "call_read_1",
          name: "read_file",
          input: { path: "tokens.json" },
        }),
      ])

      const replay = yield* LLMClient.prepare<Record<string, unknown>>(
        LLM.request({
          model,
          tools: [
            {
              name: "read_file",
              description: "Read a project file.",
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
                additionalProperties: false,
              },
            },
          ],
          messages: [
            Message.user("Design the page."),
            response.message,
            Message.tool({ id: "call_read_1", name: "read_file", result: { color: "#111827" } }),
            Message.user("Continue."),
          ],
        }),
      )

      expect(replay.body.messages).toEqual([
        { role: "user", content: "Design the page." },
        {
          role: "assistant",
          content: null,
          reasoning_content: "需要先读取设计令牌。",
          tool_calls: [
            {
              id: "call_read_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"tokens.json"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_read_1", content: '{"color":"#111827"}' },
        { role: "user", content: "Continue." },
      ])
      expect(response.toolCalls).toContainEqual(
        expect.objectContaining({ id: "call_read_1", name: "read_file", input: { path: "tokens.json" } }),
      )
    }),
  )

  it.effect("keeps an explicitly authored assistant reasoning and tool call in one replay message", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<Record<string, unknown>>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              { type: "reasoning", text: "Inspect first." },
              ToolCallPart.make({ id: "call_1", name: "inspect", input: { target: "page" } }),
            ]),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "assistant",
          content: null,
          reasoning_content: "Inspect first.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "inspect", arguments: '{"target":"page"}' },
            },
          ],
        },
      ])
    }),
  )
})
