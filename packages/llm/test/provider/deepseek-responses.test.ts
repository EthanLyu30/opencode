import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, Message, Usage } from "../../src"
import * as DeepSeek from "../../src/providers/deepseek"
import * as OpenAIResponses from "../../src/protocols/openai-responses"
import { LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"

const model = DeepSeek.configure({ baseURL: "https://api.deepseek.test", apiKey: "test" }).responses(
  "deepseek-v4-flash",
)

const request = LLM.request({
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 64 },
})

const proRequest = LLM.request({
  model: DeepSeek.configure({ baseURL: "https://api.deepseek.test", apiKey: "test" }).responses("deepseek-v4-pro"),
  prompt: "Return a title.",
  responseFormat: {
    type: "json",
    schema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
  },
  tools: [
    {
      name: "read_file",
      description: "Read one file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ],
})

const fixture = (name: string) =>
  Bun.file(new URL(`../fixtures/deepseek-responses/${name}.json`, import.meta.url)).json() as Promise<
    ReadonlyArray<Record<string, unknown>>
  >

// DeepSeek Responses terminates with response.completed/incomplete/failed and
// intentionally does not send the Chat Completions `data: [DONE]` sentinel.
const deepSeekSSE = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")

describe("DeepSeek native Responses route", () => {
  it.effect("projects only documented effective request fields to /responses", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(request)

      expect(prepared.route).toBe("openai-responses")
      expect(prepared.protocol).toBe("openai-responses")
      expect(prepared.body).toEqual({
        model: "deepseek-v4-flash",
        input: [
          { role: "system", content: "You are concise." },
          { role: "user", content: [{ type: "input_text", text: "Say hello." }] },
        ],
        stream: true,
        max_output_tokens: 64,
      })
      expect(prepared.body).not.toHaveProperty("store")
      expect(prepared.body).not.toHaveProperty("include")
      expect(prepared.body).not.toHaveProperty("prompt_cache_key")
      expect(prepared.body).not.toHaveProperty("service_tier")
    }),
  )

  it.effect("posts the native body to the DeepSeek /responses endpoint", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(request).pipe(
        Effect.provide(
          dynamicResponse(({ request, text, respond }) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.deepseek.test/responses")
              expect(JSON.parse(text)).not.toHaveProperty("store")
              const events = yield* Effect.promise(() => fixture("text-stream"))
              return respond(deepSeekSSE(events), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("routes V4 Pro through native Responses without changing its model id or contract", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(proRequest)
      expect(prepared.route).toBe("openai-responses")
      expect(prepared.body.model).toBe("deepseek-v4-pro")
      expect(prepared.body.tools).toEqual([
        expect.objectContaining({ type: "function", name: "read_file", strict: false }),
      ])
      expect(prepared.body.text).toEqual({
        format: expect.objectContaining({ type: "json_schema", name: "response", strict: true }),
      })

      const events = yield* Effect.promise(() => fixture("text-stream"))
      const response = yield* LLMClient.generate(proRequest).pipe(
        Effect.provide(
          dynamicResponse(({ request, text, respond }) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.deepseek.test/responses")
              expect(JSON.parse(text)).toMatchObject({ model: "deepseek-v4-pro", stream: true })
              return respond(deepSeekSSE(events), { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
      )
      expect(response.text).toBe("你好！")
      expect(response.usage).toEqual(expect.objectContaining({ totalTokens: 135 }))
    }),
  )

  it.effect("lowers DeepSeek-only effort and logprob options without OpenAI state fields", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<DeepSeek.DeepSeekResponsesBody>(
        LLM.updateRequest(request, {
          providerOptions: { deepseek: { reasoningEffort: "low", topLogprobs: 4 } },
        }),
      )

      expect(prepared.body.reasoning).toEqual({ effort: "high", summary: undefined })
      expect(prepared.body.top_logprobs).toBe(4)
      expect(prepared.body).not.toHaveProperty("store")
    }),
  )

  it.effect("keeps DeepSeek native max reasoning effort out of the OpenAI option validator", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<DeepSeek.DeepSeekResponsesBody>(
        LLM.updateRequest(request, {
          providerOptions: { deepseek: { reasoningEffort: "max" } },
        }),
      )

      expect(prepared.body.reasoning).toEqual({ effort: "max", summary: undefined })
    }),
  )

  it.effect("lowers structured output through Responses text.format", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, {
          responseFormat: {
            type: "json",
            schema: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
              additionalProperties: false,
            },
          },
        }),
      )

      expect(prepared.body.text).toEqual({
        format: {
          type: "json_schema",
          name: "response",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
          strict: true,
        },
      })
    }),
  )

  it.effect("projects custom apply_patch and hosted web search onto native tool types", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, {
          tools: [
            {
              name: "apply_patch",
              description: "Apply a patch.",
              inputSchema: {
                type: "object",
                properties: { patchText: { type: "string" } },
                required: ["patchText"],
                additionalProperties: false,
              },
            },
            DeepSeek.webSearchTool(),
          ],
          toolChoice: "web_search",
        }),
      )

      expect(prepared.body.tools).toEqual([{ type: "custom", name: "apply_patch" }, { type: "web_search" }])
      expect(prepared.body.tool_choice).toEqual({ type: "web_search" })
    }),
  )

  it.effect("rejects meaningful unsupported OpenAI state and media locally", () =>
    Effect.gen(function* () {
      const stateError = yield* LLMClient.prepare(
        LLM.updateRequest(request, { providerOptions: { openai: { store: true } } }),
      ).pipe(Effect.flip)
      expect(stateError.message).toContain("store")
      expect(stateError.message).toContain("DeepSeek Responses")

      const mediaError = yield* LLMClient.prepare(
        LLM.request({
          model,
          messages: [Message.user({ type: "media", mediaType: "image/png", data: "AAECAw==" })],
        }),
      ).pipe(Effect.flip)
      expect(mediaError.message).toContain("image")
      expect(mediaError.message).toContain("DeepSeek Responses")

      const samplingError = yield* LLMClient.prepare(
        LLM.updateRequest(request, { generation: { temperature: 0.5 } }),
      ).pipe(Effect.flip)
      expect(samplingError.message).toContain("ignores temperature and topP")

      const nestedError = yield* LLMClient.prepare(
        LLM.updateRequest(request, { http: { body: { text: { verbosity: "high" } } } }),
      ).pipe(Effect.flip)
      expect(nestedError.message).toContain("unsupported field(s): text")
    }),
  )

  it.effect("parses native text, reasoning and detailed usage without a DONE sentinel", () =>
    Effect.gen(function* () {
      const events = yield* Effect.promise(() => fixture("text-stream"))
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(deepSeekSSE(events))))

      expect(response.text).toBe("你好！")
      expect(response.reasoning).toBe("先检查约束。")
      expect(response.usage).toEqual(
        new Usage({
          inputTokens: 120,
          outputTokens: 15,
          nonCachedInputTokens: 40,
          cacheReadInputTokens: 80,
          reasoningTokens: 9,
          totalTokens: 135,
          providerMetadata: {
            openai: {
              input_tokens: 120,
              input_tokens_details: { cached_tokens: 80 },
              output_tokens: 15,
              output_tokens_details: { reasoning_tokens: 9 },
              total_tokens: 135,
            },
          },
        }),
      )
    }),
  )

  it.effect("assembles function and custom apply_patch inputs exactly once and preserves web search", () =>
    Effect.gen(function* () {
      const events = yield* Effect.promise(() => fixture("tool-stream"))
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(deepSeekSSE(events))))
      const calls = response.events.filter((event) => event.type === "tool-call")
      const results = response.events.filter((event) => event.type === "tool-result")
      const statuses = response.events.filter((event) => event.type === "tool-status")

      expect(calls).toContainEqual(
        expect.objectContaining({ id: "call_read_1", name: "read_file", input: { path: "README.md" } }),
      )
      expect(calls).toContainEqual(
        expect.objectContaining({
          id: "call_patch_1",
          name: "apply_patch",
          input: { patchText: "*** Begin Patch\n*** End Patch" },
        }),
      )
      expect(calls).toContainEqual(
        expect.objectContaining({ id: "search_1", name: "web_search", providerExecuted: true }),
      )
      expect(calls.filter((event) => event.id === "call_read_1")).toHaveLength(1)
      expect(calls.filter((event) => event.id === "call_patch_1")).toHaveLength(1)
      expect(statuses).toEqual([
        expect.objectContaining({ id: "search_1", name: "web_search", status: "in_progress" }),
        expect.objectContaining({ id: "search_1", name: "web_search", status: "searching" }),
        expect.objectContaining({ id: "search_1", name: "web_search", status: "completed" }),
      ])
      expect(results).toContainEqual(
        expect.objectContaining({
          id: "search_1",
          result: {
            type: "json",
            value: expect.objectContaining({
              status: "completed",
              action: { type: "search", query: "OpenCode" },
            }),
          },
        }),
      )

      const hostedContent = response.message.content.filter(
        (part) => "providerExecuted" in part && part.providerExecuted === true,
      )
      const replay = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [Message.assistant(hostedContent), Message.user("Continue after search.")],
        }),
      )
      expect(replay.body.input).toContainEqual(
        expect.objectContaining({ type: "web_search_call", id: "search_1", status: "completed" }),
      )
    }),
  )

  it.effect("preserves failed hosted items and rejects duplicate hosted ids in output and replay input", () =>
    Effect.gen(function* () {
      const failedItem = {
        type: "web_search_call",
        id: "search_failed_1",
        status: "failed",
        action: { type: "search", query: "failed query" },
        error: { code: "search_unavailable", message: "offline fixture failure" },
      } as const
      const failed = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            deepSeekSSE([
              { type: "response.created", sequence_number: 0, response: { id: "resp_hosted_failed" } },
              { type: "response.output_item.done", sequence_number: 1, item: failedItem },
              { type: "response.completed", sequence_number: 2, response: { id: "resp_hosted_failed" } },
            ]),
          ),
        ),
      )
      expect(failed.events.filter((event) => event.type === "tool-call" || event.type === "tool-result")).toEqual([
        {
          type: "tool-call",
          id: "search_failed_1",
          name: "web_search",
          input: { type: "search", query: "failed query" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "search_failed_1" } },
        },
        {
          type: "tool-result",
          id: "search_failed_1",
          name: "web_search",
          providerExecuted: true,
          result: { type: "json", value: failedItem },
          output: undefined,
          providerMetadata: { openai: { itemId: "search_failed_1" } },
        },
      ])

      const duplicateOutput = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            deepSeekSSE([
              { type: "response.created", sequence_number: 0, response: { id: "resp_hosted_duplicate" } },
              {
                type: "response.output_item.done",
                sequence_number: 1,
                item: { type: "web_search_call", id: "search_duplicate", status: "completed", results: ["A"] },
              },
              {
                type: "response.output_item.done",
                sequence_number: 2,
                item: { type: "web_search_call", id: "search_duplicate", status: "failed", results: ["B"] },
              },
              { type: "response.completed", sequence_number: 3, response: { id: "resp_hosted_duplicate" } },
            ]),
          ),
        ),
        Effect.flip,
      )
      expect(duplicateOutput.reason).toMatchObject({ _tag: "InvalidProviderOutput" })

      const hostedPart = (value: Record<string, unknown>) => [
        {
          type: "tool-call" as const,
          id: "search_duplicate",
          name: "web_search",
          input: {},
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "search_duplicate" } },
        },
        {
          type: "tool-result" as const,
          id: "search_duplicate",
          name: "web_search",
          result: { type: "json" as const, value },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "search_duplicate" } },
        },
      ]
      const duplicateReplay = yield* LLMClient.prepare(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ...hostedPart({ type: "web_search_call", id: "search_duplicate", status: "completed", result: "A" }),
              ...hostedPart({ type: "web_search_call", id: "search_duplicate", status: "failed", result: "B" }),
            ]),
          ],
        }),
      ).pipe(Effect.flip)
      expect(duplicateReplay.reason).toMatchObject({ _tag: "InvalidRequest" })
    }),
  )

  it.effect("marks incomplete without a known reason even when a function call completed", () =>
    Effect.gen(function* () {
      const incomplete = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            deepSeekSSE([
              { type: "response.created", sequence_number: 0, response: { id: "resp_incomplete_unknown" } },
              {
                type: "response.output_item.done",
                sequence_number: 1,
                item: {
                  type: "function_call",
                  id: "fc_incomplete_unknown",
                  call_id: "call_incomplete_unknown",
                  name: "read_file",
                  arguments: '{"path":"partial.md"}',
                  status: "completed",
                },
              },
              {
                type: "response.incomplete",
                sequence_number: 2,
                response: {
                  id: "resp_incomplete_unknown",
                  usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
                },
              },
            ]),
          ),
        ),
      )
      expect(incomplete.finishReason).toBe("unknown")
      expect(incomplete.toolCalls).toEqual([
        expect.objectContaining({ id: "call_incomplete_unknown", name: "read_file", input: { path: "partial.md" } }),
      ])
      expect(incomplete.usage?.totalTokens).toBe(11)
    }),
  )

  it.effect("maps incomplete and failed terminal events without a DONE sentinel", () =>
    Effect.gen(function* () {
      const incompleteEvents = yield* Effect.promise(() => fixture("incomplete-stream"))
      const incomplete = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(deepSeekSSE(incompleteEvents))),
      )
      expect(incomplete.text).toBe("未完成")
      expect(incomplete.finishReason).toBe("length")
      expect(incomplete.usage?.cacheReadInputTokens).toBe(4)
      expect(incomplete.usage?.reasoningTokens).toBe(3)

      const failedEvents = yield* Effect.promise(() => fixture("failed-stream"))
      const failedUsage = {
        input_tokens: 9,
        output_tokens: 2,
        total_tokens: 11,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 1 },
      }
      const failedWithUsage = failedEvents.map((event) =>
        event.type === "response.failed"
          ? { ...event, response: { ...(event.response as Record<string, unknown>), usage: failedUsage } }
          : event,
      )
      const failed = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(deepSeekSSE(failedWithUsage))),
      )
      expect(failed.events).toEqual([
        {
          type: "provider-error",
          message: "server_error: DeepSeek upstream unavailable",
          usage: new Usage({
            inputTokens: 9,
            outputTokens: 2,
            nonCachedInputTokens: 6,
            cacheReadInputTokens: 3,
            reasoningTokens: 1,
            totalTokens: 11,
            providerMetadata: { openai: failedUsage },
          }),
        },
      ])
      expect(failed.usage?.totalTokens).toBe(11)
    }),
  )

  it.effect("surfaces non-monotonic sequence_number ordering", () =>
    Effect.gen(function* () {
      const events = yield* Effect.promise(() => fixture("text-stream"))
      const outOfOrder = events.map((event, index) => (index === 4 ? { ...event, sequence_number: 2 } : event))
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(deepSeekSSE(outOfOrder))),
        Effect.flip,
      )

      expect(error.message).toContain("sequence_number")
      expect(error.message).toContain("2")
      expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
    }),
  )
})
