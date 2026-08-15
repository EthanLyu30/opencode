import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import * as Anthropic from "../../src/providers/anthropic"
import { CloudflareAIGateway, CloudflareWorkersAI } from "../../src/providers/cloudflare"
import * as Google from "../../src/providers/google"
import * as OpenAI from "../../src/providers/openai"
import * as OpenAICompatible from "../../src/providers/openai-compatible"
import * as OpenRouter from "../../src/providers/openrouter"
import * as XAI from "../../src/providers/xai"
import { LLM, LLMEvent, MediaPart, Message } from "../../src"
import { DeepSeek, Kimi } from "../../src/providers"
import { assertTask21CassetteSafe, makeTask21LiveBudget, redactTask21Body } from "../../script/task21-live-contract"
import { describeRecordedGoldenScenarios, generateTask21RecordedRequest } from "../recorded-golden"
import { recordedTests } from "../recorded-test"

const openAI = OpenAI.configure({
  apiKey: process.env.OPENAI_API_KEY ?? "fixture",
})
const openAIChat = openAI.chat("gpt-4o-mini")
const openAIResponses = openAI.responses("gpt-5.5")
const openAIResponsesWebSocket = openAI.responsesWebSocket("gpt-4.1-mini")
const anthropic = Anthropic.configure({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "fixture",
})
const anthropicHaiku = anthropic.model("claude-haiku-4-5-20251001")
const anthropicOpus = anthropic.model("claude-opus-4-7")
const google = Google.configure({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "fixture" })
const gemini = google.model("gemini-2.5-flash")
const xai = XAI.configure({ apiKey: process.env.XAI_API_KEY ?? "fixture" })
const xaiBasic = xai.model("grok-3-mini")
const xaiFlagship = xai.model("grok-4.3")
const cloudflareAIGateway = CloudflareAIGateway.configure({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "fixture-account",
  gatewayId:
    process.env.CLOUDFLARE_GATEWAY_ID && process.env.CLOUDFLARE_GATEWAY_ID !== process.env.CLOUDFLARE_ACCOUNT_ID
      ? process.env.CLOUDFLARE_GATEWAY_ID
      : undefined,
  gatewayApiKey: process.env.CLOUDFLARE_API_TOKEN ?? "fixture",
})
const cloudflareWorkers = CloudflareWorkersAI.configure({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "fixture-account",
  apiKey: process.env.CLOUDFLARE_API_KEY ?? "fixture",
})
const cloudflareAIGatewayWorkers = cloudflareAIGateway.model("workers-ai/@cf/meta/llama-3.1-8b-instruct")
const cloudflareAIGatewayWorkersTools = cloudflareAIGateway.model("workers-ai/@cf/openai/gpt-oss-20b")
const cloudflareWorkersAI = cloudflareWorkers.model("@cf/meta/llama-3.1-8b-instruct")
const cloudflareWorkersAITools = cloudflareWorkers.model("@cf/openai/gpt-oss-20b")
const deepseek = OpenAICompatible.deepseek
  .configure({ apiKey: process.env.DEEPSEEK_API_KEY ?? "fixture" })
  .model("deepseek-chat")
const together = OpenAICompatible.togetherai
  .configure({
    apiKey: process.env.TOGETHER_AI_API_KEY ?? "fixture",
  })
  .model("meta-llama/Llama-3.3-70B-Instruct-Turbo")
const groq = OpenAICompatible.groq
  .configure({ apiKey: process.env.GROQ_API_KEY ?? "fixture" })
  .model("llama-3.3-70b-versatile")
const openRouter = OpenRouter.configure({ apiKey: process.env.OPENROUTER_API_KEY ?? "fixture" })
const openrouter = openRouter.model("openai/gpt-4o-mini")
const openrouterGpt55 = openRouter.model("openai/gpt-5.5")
const openrouterOpus = OpenRouter.configure({
  apiKey: process.env.OPENROUTER_API_KEY ?? "fixture",
}).model("anthropic/claude-opus-4.7")

const redactCloudflareURL = (url: string) =>
  url
    .replace(/\/client\/v4\/accounts\/[^/]+\/ai\/v1\//, "/client/v4/accounts/{account}/ai/v1/")
    .replace(/\/v1\/[^/]+\/[^/]+\/compat\//, "/v1/{account}/{gateway}/compat/")

const cloudflareOptions = {
  redact: { url: redactCloudflareURL },
}

describeRecordedGoldenScenarios([
  {
    name: "OpenAI Chat gpt-4o-mini",
    prefix: "openai-chat",
    model: openAIChat,
    requires: ["OPENAI_API_KEY"],
    scenarios: ["text", "tool-call", "tool-loop", { id: "image-tool-result", maxTokens: 40 }],
  },
  {
    name: "OpenAI Responses gpt-5.5",
    prefix: "openai-responses",
    model: openAIResponses,
    requires: ["OPENAI_API_KEY"],
    tags: ["flagship"],
    scenarios: [
      { id: "text", temperature: false },
      { id: "reasoning", temperature: false },
      { id: "reasoning-continuation", temperature: false },
      { id: "tool-call", temperature: false },
      { id: "tool-loop", temperature: false },
      { id: "image-tool-result", temperature: false, maxTokens: 40 },
    ],
  },
  {
    name: "OpenAI Responses WebSocket gpt-4.1-mini",
    prefix: "openai-responses-websocket",
    model: openAIResponsesWebSocket,
    transport: "websocket",
    requires: ["OPENAI_API_KEY"],
    scenarios: ["tool-loop"],
  },
  {
    name: "Anthropic Haiku 4.5",
    prefix: "anthropic-messages",
    model: anthropicHaiku,
    requires: ["ANTHROPIC_API_KEY"],
    options: { redact: { allowRequestHeaders: ["anthropic-version"] } },
    scenarios: ["text", "tool-call"],
  },
  {
    name: "Anthropic Opus 4.7",
    prefix: "anthropic-messages",
    model: anthropicOpus,
    requires: ["ANTHROPIC_API_KEY"],
    tags: ["flagship"],
    options: { redact: { allowRequestHeaders: ["anthropic-version"] } },
    scenarios: [
      { id: "tool-loop", temperature: false },
      { id: "image-tool-result", temperature: false, maxTokens: 40 },
    ],
  },
  {
    name: "Gemini 2.5 Flash",
    prefix: "gemini",
    model: gemini,
    requires: ["GOOGLE_GENERATIVE_AI_API_KEY"],
    scenarios: [
      { id: "text", maxTokens: 80 },
      "tool-call",
      { id: "image", maxTokens: 160 },
      { id: "image-tool-result", maxTokens: 40 },
    ],
  },
  {
    name: "xAI Grok 3 Mini",
    prefix: "xai",
    model: xaiBasic,
    requires: ["XAI_API_KEY"],
    scenarios: ["text", "tool-call"],
  },
  {
    name: "xAI Grok 4.3",
    prefix: "xai",
    model: xaiFlagship,
    requires: ["XAI_API_KEY"],
    tags: ["flagship"],
    scenarios: [{ id: "tool-loop", timeout: 30_000 }],
  },
  {
    name: "Cloudflare AI Gateway Workers AI Llama 3.1 8B",
    prefix: "cloudflare-ai-gateway",
    model: cloudflareAIGatewayWorkers,
    requires: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
    options: cloudflareOptions,
    scenarios: ["text"],
  },
  {
    name: "Cloudflare AI Gateway Workers AI GPT OSS 20B Tools",
    prefix: "cloudflare-ai-gateway",
    model: cloudflareAIGatewayWorkersTools,
    requires: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
    options: cloudflareOptions,
    scenarios: [{ id: "tool-call", maxTokens: 120 }],
  },
  {
    name: "Cloudflare Workers AI Llama 3.1 8B",
    prefix: "cloudflare-workers-ai",
    model: cloudflareWorkersAI,
    requires: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"],
    options: cloudflareOptions,
    scenarios: ["text"],
  },
  {
    name: "Cloudflare Workers AI GPT OSS 20B Tools",
    prefix: "cloudflare-workers-ai",
    model: cloudflareWorkersAITools,
    requires: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"],
    options: cloudflareOptions,
    scenarios: [{ id: "tool-call", maxTokens: 120 }],
  },
  {
    name: "DeepSeek Chat",
    prefix: "openai-compatible-chat",
    model: deepseek,
    requires: ["DEEPSEEK_API_KEY"],
    scenarios: ["text"],
  },
  {
    name: "TogetherAI Llama 3.3 70B",
    prefix: "openai-compatible-chat",
    model: together,
    requires: ["TOGETHER_AI_API_KEY"],
    scenarios: ["text", "tool-call"],
  },
  {
    name: "Groq Llama 3.3 70B",
    prefix: "openai-compatible-chat",
    model: groq,
    requires: ["GROQ_API_KEY"],
    scenarios: ["text", "tool-call", { id: "tool-loop", timeout: 30_000 }],
  },
  {
    name: "OpenRouter gpt-4o-mini",
    prefix: "openai-compatible-chat",
    model: openrouter,
    requires: ["OPENROUTER_API_KEY"],
    scenarios: ["text", "tool-call", "tool-loop"],
  },
  {
    name: "OpenRouter gpt-5.5",
    prefix: "openai-compatible-chat",
    model: openrouterGpt55,
    requires: ["OPENROUTER_API_KEY"],
    tags: ["flagship"],
    scenarios: ["tool-loop"],
  },
  {
    name: "OpenRouter Claude Opus 4.7",
    prefix: "openai-compatible-chat",
    model: openrouterOpus,
    requires: ["OPENROUTER_API_KEY"],
    tags: ["flagship"],
    scenarios: ["tool-loop"],
  },
])

const task21RecorderOptions = {
  redact: {
    headers: ["authorization", "cookie", "set-cookie", "x-request-id"],
    jsonFields: ["authorization", "cookie", "request_id"],
    body: redactTask21Body,
  },
}

const task21ReplayEnv = {
  RECORD: "true",
  RECORDED_PREFIX: "kimi-k3,deepseek-responses",
  TASK21_LIVE_TOKEN_CEILING: "512",
  DEEPSEEK_API_KEY: "fixture-deepseek-key",
  MOONSHOT_API_KEY: "fixture-kimi-key",
}

let task21Budget: ReturnType<typeof makeTask21LiveBudget> | undefined
const getTask21Budget = () =>
  (task21Budget ??= makeTask21LiveBudget(process.env.RECORD === "true" ? process.env : task21ReplayEnv))

const assertTask21Fixture = (relative: string) =>
  Effect.promise(() => Bun.file(new URL(`../fixtures/recordings/${relative}.json`, import.meta.url)).json()).pipe(
    Effect.tap((cassette) => Effect.sync(() => assertTask21CassetteSafe(cassette))),
  )

const kimiTask21 = recordedTests({
  prefix: "kimi-k3",
  provider: "kimi",
  protocol: "openai-compatible-chat",
  requires: ["MOONSHOT_API_KEY"],
  tags: ["task21", "vision", "structured-output"],
  options: task21RecorderOptions,
})

const Task21Review = Schema.Struct({ approved: Schema.Boolean, summary: Schema.String })
const decodeTask21Review = Schema.decodeUnknownSync(Schema.fromJsonString(Task21Review))

describe("Kimi K3 Task21 recorded", () => {
  kimiTask21.effect.with("design vision review", { cassette: "kimi-k3/design-vision-review" }, () =>
    Effect.gen(function* () {
      const request = LLM.request({
        model: Kimi.configure({ apiKey: process.env.MOONSHOT_API_KEY ?? "fixture" }).model("kimi-k3"),
        system: "Review one reference image. Return only the requested compact JSON object.",
        messages: [
          Message.user([
            MediaPart.make({
              mediaType: "image/png",
              data: Uint8Array.from(
                Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                  "base64",
                ),
              ),
            }),
            Message.text("Approve this one-pixel reference and summarize it in at most eight words."),
          ]),
        ],
        responseFormat: {
          type: "json",
          schema: {
            type: "object",
            properties: { approved: { type: "boolean" }, summary: { type: "string" } },
            required: ["approved", "summary"],
            additionalProperties: false,
          },
        },
        generation: { maxTokens: 256 },
        providerOptions: { kimi: { reasoningEffort: "low" } },
      })
      const response = yield* generateTask21RecordedRequest(getTask21Budget(), "design-vision-review", request)
      const review = decodeTask21Review(response.text)

      expect(review.summary.length).toBeGreaterThan(0)
      expect(response.events.filter(LLMEvent.is.finish)).toHaveLength(1)
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
      expect(response.usage?.inputTokens ?? 0).toBeGreaterThan(0)
      expect(response.usage?.outputTokens ?? 0).toBeGreaterThan(0)
      yield* assertTask21Fixture("kimi-k3/design-vision-review")
    }),
  )
})

const deepseekTask21 = recordedTests({
  prefix: "deepseek-responses",
  provider: "deepseek",
  protocol: "openai-responses",
  requires: ["DEEPSEEK_API_KEY"],
  tags: ["task21", "text", "tool"],
  options: task21RecorderOptions,
})

describe("DeepSeek Responses Task21 recorded", () => {
  deepseekTask21.effect.with("flash text tool", { cassette: "deepseek-responses/flash-text-tool" }, () =>
    Effect.gen(function* () {
      const model = DeepSeek.configure({ apiKey: process.env.DEEPSEEK_API_KEY ?? "fixture" }).responses(
        "deepseek-v4-flash",
      )
      const first = LLM.request({
        model,
        system:
          "Call read_file exactly once. After its result, answer exactly `primary=#0057ff`; do not call another tool.",
        prompt: "Read tokens.json and report its primary color.",
        tools: [
          {
            name: "read_file",
            description: "Read one named design-token file.",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            },
          },
        ],
        generation: { maxTokens: 128 },
      })
      const toolResponse = yield* generateTask21RecordedRequest(getTask21Budget(), "flash-text-tool", first)
      const calls = toolResponse.events.filter(LLMEvent.is.toolCall)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ name: "read_file", input: { path: "tokens.json" } })

      const call = calls[0]
      const second = LLM.updateRequest(first, {
        tools: [],
        messages: [
          ...first.messages,
          toolResponse.message,
          Message.tool({ id: call.id, name: call.name, result: { primary: "#0057ff" } }),
        ],
      })
      const response = yield* generateTask21RecordedRequest(getTask21Budget(), "flash-text-tool", second)

      expect(response.text.toLowerCase()).toContain("primary=#0057ff")
      expect(response.events.filter(LLMEvent.is.finish)).toHaveLength(1)
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
      expect(response.usage?.inputTokens ?? 0).toBeGreaterThan(0)
      expect(response.usage?.outputTokens ?? 0).toBeGreaterThan(0)
      yield* assertTask21Fixture("deepseek-responses/flash-text-tool")
    }),
  )
})
