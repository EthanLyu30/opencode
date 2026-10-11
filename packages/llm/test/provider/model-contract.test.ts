import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { LLM, Message, MediaPart, ToolCallPart, ModelContract } from "../../src"
import { Kimi } from "../../src/providers"
import { DeepSeek } from "../../src/providers"
import { getModelCapabilityProfile } from "../../src/capabilities"
import { LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"

const bindingInput = (providerID: "kimi" | "deepseek") => {
  const profile = WorkflowModelCatalog.adapterProfile(
    providerID === "kimi" ? "kimi-chat-k3-v1" : "deepseek-responses-v4-v1",
  )!
  return {
    providerID,
    modelID: `${providerID}-successor-fixture`,
    profileID: profile.id,
    profileSha256: profile.wireContractSha256,
    capabilities: [...profile.capabilities],
    effortLevels: [...profile.effortLevels],
    sourceSha256: "a".repeat(64),
  }
}
const tools = [{ name: "inspect", description: "Inspect the fixture", inputSchema: { type: "object", properties: {} } }]
const responseFormat = {
  type: "json" as const,
  schema: { type: "object", properties: {}, additionalProperties: false },
}
const readEvents = (name: string) =>
  Effect.promise(() => Bun.file(new URL(`../fixtures/deepseek-responses/${name}.json`, import.meta.url)).json()).pipe(
    Effect.map(Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))),
  )
const sse = (events: readonly Record<string, unknown>[]) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

describe("factory-owned per-instance model contract", () => {
  test("binding is immutable and never registers a future model globally", () => {
    const input = bindingInput("deepseek")
    const binding = ModelContract.bind(input)
    input.capabilities.length = 0
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding.capabilities)).toBe(true)
    expect(binding.capabilities).toContain("responses")
    expect(getModelCapabilityProfile("deepseek", binding.modelID)).toBeUndefined()
    expect(String(DeepSeek.configure({ modelContract: binding }).responses(binding.modelID).id)).toBe(binding.modelID)
    expect(() => DeepSeek.configure().responses(binding.modelID)).toThrow()
    expect(() => DeepSeek.configure({ modelContract: binding }).responses("deepseek-other-fixture")).toThrow()
    expect(() => DeepSeek.configure({ modelContract: { ...binding } }).responses(binding.modelID)).toThrow()
    expect(() => Kimi.configure({ modelContract: binding }).model(binding.modelID)).toThrow()
    expect(() => DeepSeek.configure({ modelContract: binding }).chat(binding.modelID)).toThrow()
  })

  for (const patch of [
    { providerID: "kimi" },
    { profileID: "unknown" },
    { profileSha256: "b".repeat(64) },
    { sourceSha256: "not-a-hash" },
    { capabilities: ["responses", "vision_input"] },
    { effortLevels: ["high", "medium"] },
    { capabilities: ["responses", "responses"] },
    { effortLevels: ["high", "high"] },
    { modelID: "unsafe\nfixture" },
    { protocol: "openai-chat" },
  ]) {
    test(`rejects invalid or caller-invented contract fields ${JSON.stringify(patch)}`, () => {
      expect(() => ModelContract.bind({ ...bindingInput("deepseek"), ...patch })).toThrow()
    })
  }
  for (const modelID of ["kimi-k2.6", "kimi-k2.7", "kimi-k2.7-code"]) {
    test(`cannot revive the prohibited model ${modelID}`, () => {
      expect(() => ModelContract.bind({ ...bindingInput("kimi"), modelID })).toThrow()
    })
  }

  it.effect("bound Kimi sends the exact ID, strict output, tools, images and reasoning replay", () =>
    Effect.gen(function* () {
      const binding = ModelContract.bind(bindingInput("kimi"))
      const model = Kimi.configure({
        modelContract: binding,
        apiKey: "offline",
        baseURL: "https://kimi.test/v1",
      }).model(binding.modelID)
      for (const effort of ["high", "max"] as const) {
        const request = LLM.request({
          model,
          responseFormat,
          tools,
          toolChoice: "required",
          providerOptions: { kimi: { reasoningEffort: effort } },
          messages: [
            Message.user([
              MediaPart.make({ mediaType: "image/png", data: "AAECAw==" }),
              MediaPart.reference({ mediaType: "image/png", uri: "ms://fixture_2" }),
            ]),
            Message.assistant([
              { type: "reasoning", text: "Inspect first." },
              ToolCallPart.make({ id: "c1", name: "inspect", input: {} }),
            ]),
            Message.tool({ id: "c1", name: "inspect", result: "ok" }),
          ],
        })
        const prepared = yield* LLMClient.prepare<Record<string, unknown>>(request)
        expect(prepared.body).toMatchObject({
          model: binding.modelID,
          reasoning_effort: effort,
          tool_choice: "required",
          response_format: { json_schema: { strict: true } },
        })
        expect(prepared.body.messages).toMatchObject([
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64,AAECAw==" } },
              { type: "image_url", image_url: { url: "ms://fixture_2" } },
            ],
          },
          { role: "assistant", reasoning_content: "Inspect first." },
          { role: "tool", tool_call_id: "c1" },
        ])
        expect(prepared.body).not.toHaveProperty("modelContract")
        yield* LLMClient.generate(request).pipe(
          Effect.provide(
            dynamicResponse(({ request: outgoing, text, respond }) =>
              Effect.gen(function* () {
                const web = yield* HttpClientRequest.toWeb(outgoing).pipe(Effect.orDie)
                expect(web.url).toBe("https://kimi.test/v1/chat/completions")
                expect(JSON.parse(text).model).toBe("kimi-successor-fixture")
                expect(text).not.toContain("profileSha256")
                return respond(
                  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\ndata: [DONE]\n\n',
                )
              }),
            ),
          ),
        )
      }
    }),
  )

  it.effect("bound Responses preserves native wire fields and terminal usage semantics", () =>
    Effect.gen(function* () {
      const binding = ModelContract.bind(bindingInput("deepseek"))
      const model = DeepSeek.configure({
        modelContract: binding,
        apiKey: "offline",
        baseURL: "https://deepseek.test",
      }).responses(binding.modelID)
      for (const effort of ["high", "max"] as const) {
        const request = LLM.request({
          model,
          prompt: "inspect",
          responseFormat,
          tools,
          toolChoice: "required",
          providerOptions: { deepseek: { reasoningEffort: effort } },
        })
        const prepared = yield* LLMClient.prepare<Record<string, unknown>>(request)
        expect(prepared.body).toMatchObject({
          model: binding.modelID,
          reasoning: { effort },
          tool_choice: "required",
          text: { format: { strict: true } },
        })
        for (const key of ["modelContract", "store", "include", "previous_response_id"])
          expect(prepared.body).not.toHaveProperty(key)
        const events = yield* readEvents("text-stream")
        const completed = yield* LLMClient.generate(request).pipe(
          Effect.provide(
            dynamicResponse(({ request: outgoing, text, respond }) =>
              Effect.gen(function* () {
                expect((yield* HttpClientRequest.toWeb(outgoing).pipe(Effect.orDie)).url).toBe(
                  "https://deepseek.test/responses",
                )
                expect(JSON.parse(text).model).toBe("deepseek-successor-fixture")
                return respond(sse(events))
              }),
            ),
          ),
        )
        expect(completed.text).toBe("你好！")
        expect(completed.usage?.totalTokens).toBe(135)
      }
      const incomplete = yield* LLMClient.generate(LLM.request({ model, prompt: "inspect" })).pipe(
        Effect.provide(fixedResponse(sse(yield* readEvents("incomplete-stream")))),
      )
      expect(incomplete.finishReason).toBe("length")
      expect(incomplete.usage?.cacheReadInputTokens).toBe(4)
      const failed = yield* LLMClient.generate(LLM.request({ model, prompt: "inspect" })).pipe(
        Effect.provide(fixedResponse(sse(yield* readEvents("failed-stream")))),
      )
      expect(failed.events.some((event) => event.type === "provider-error")).toBe(true)
    }),
  )

  it.effect("a bound instance cannot request capabilities or effort absent from its binding", () =>
    Effect.gen(function* () {
      const binding = ModelContract.bind({ ...bindingInput("kimi"), capabilities: ["chat"], effortLevels: ["high"] })
      const model = Kimi.configure({ modelContract: binding }).model(binding.modelID)
      for (const change of [
        { providerOptions: { kimi: { reasoningEffort: "max" } } },
        { responseFormat },
        { tools, toolChoice: "required" as const },
        { messages: [Message.user(MediaPart.make({ mediaType: "image/png", data: "AAECAw==" }))] },
        { messages: [Message.assistant({ type: "reasoning", text: "fixture" })] },
      ]) {
        const error = yield* LLMClient.prepare(
          LLM.request({ model, prompt: "inspect", providerOptions: { kimi: { reasoningEffort: "high" } }, ...change }),
        ).pipe(Effect.flip)
        expect(error._tag).toBe("LLM.Error")
      }
      const deepseek = ModelContract.bind(bindingInput("deepseek"))
      const deepseekModel = DeepSeek.configure({ modelContract: deepseek }).responses(deepseek.modelID)
      for (const reasoningEffort of ["low", "medium", "xhigh"]) {
        yield* LLMClient.prepare(
          LLM.request({ model: deepseekModel, prompt: "inspect", providerOptions: { deepseek: { reasoningEffort } } }),
        ).pipe(Effect.flip)
      }
    }),
  )
})
