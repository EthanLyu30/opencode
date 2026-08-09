import { Buffer } from "node:buffer"
import { Effect, Schema } from "effect"
import { requireModelCapability } from "../capabilities"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"
import * as OpenAIChat from "../protocols/openai-chat"
import * as ProviderShared from "../protocols/shared"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import type { RouteDefaultsInput } from "../route/client"
import {
  GenerationOptions,
  LLMRequest,
  MediaPart,
  Message,
  ProviderID,
  mergeProviderOptions,
  type ModelID,
  type ProviderOptions,
  type ReasoningEffort,
} from "../schema"

export const id = ProviderID.make("kimi")
export const DEFAULT_BASE_URL = "https://api.moonshot.cn/v1"

const KIMI_REASONING_EFFORTS = ["low", "high", "max"] as const
type KimiReasoningEffort = Extract<ReasoningEffort, (typeof KIMI_REASONING_EFFORTS)[number]>

export interface KimiChatOptionsInput {
  readonly [key: string]: unknown
  readonly reasoningEffort?: KimiReasoningEffort
}

export type KimiProviderOptionsInput = ProviderOptions & {
  readonly kimi?: KimiChatOptionsInput
}

export type ModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: KimiProviderOptionsInput
  }

const KimiResponseFormat = Schema.Struct({
  type: Schema.Literal("json_schema"),
  json_schema: Schema.Struct({
    name: Schema.String,
    strict: Schema.Literal(true),
    schema: ProviderShared.JsonObject,
  }),
})

export const KimiChatBody = Schema.Struct({
  model: OpenAIChat.bodyFields.model,
  messages: OpenAIChat.bodyFields.messages,
  tools: OpenAIChat.bodyFields.tools,
  tool_choice: OpenAIChat.bodyFields.tool_choice,
  stream: OpenAIChat.bodyFields.stream,
  stream_options: OpenAIChat.bodyFields.stream_options,
  stop: OpenAIChat.bodyFields.stop,
  reasoning_effort: Schema.Literals(KIMI_REASONING_EFFORTS),
  max_completion_tokens: Schema.optional(Schema.Number),
  response_format: Schema.optional(KimiResponseFormat),
})
export type KimiChatBody = Schema.Schema.Type<typeof KimiChatBody>

const invalid = ProviderShared.invalidRequest
const KIMI_IMAGE_MIMES = new Set<string>(ProviderShared.IMAGE_MIMES)
const MOONSHOT_FILE_REFERENCE = /^ms:\/\/[^/?#\s]+$/
const PUBLIC_URL = /^https?:\/\//i

const definedKeys = (input: Record<string, unknown> | undefined) =>
  input
    ? Object.entries(input)
        .filter((entry) => entry[1] !== undefined)
        .map(([key]) => key)
    : []

const kimiEffort = (request: LLMRequest) => request.providerOptions?.kimi?.reasoningEffort
const isKimiReasoningEffort = (value: unknown): value is KimiReasoningEffort =>
  value === "low" || value === "high" || value === "max"

const validateRequest = Effect.fn("KimiK3.validateRequest")(function* (request: LLMRequest) {
  if (String(request.model.id) !== "kimi-k3") return yield* invalid("Kimi Chat supports exactly the kimi-k3 model")

  const openAIOptions = definedKeys(request.providerOptions?.openai)
  if (openAIOptions.length > 0)
    return yield* invalid(
      `Kimi K3 requires providerOptions.kimi; OpenAI option(s) are not accepted: ${openAIOptions.join(", ")}`,
    )

  const options = request.providerOptions?.kimi
  const unknownOptions = definedKeys(options).filter((key) => key !== "reasoningEffort")
  if (unknownOptions.length > 0)
    return yield* invalid(`Kimi K3 does not support option(s): ${unknownOptions.join(", ")}`)

  const effort = kimiEffort(request)
  if (!isKimiReasoningEffort(effort)) return yield* invalid("Kimi K3 reasoningEffort must be low, high, or max")

  if (request.responseFormat?.type === "tool")
    return yield* invalid("Kimi K3 structured output requires a JSON responseFormat")
  if (request.responseFormat?.type === "json" && !ProviderShared.isRecord(request.responseFormat.schema))
    return yield* invalid("Kimi K3 JSON responseFormat schema must be an object")

  if (request.http?.body?.n !== undefined) return yield* invalid("Kimi K3 fixes n to 1; omit n instead of sending it")
  return effort
})

const maskMoonshotReferences = Effect.fn("KimiK3.maskMoonshotReferences")(function* (request: LLMRequest) {
  const byDataUrl = new Map<string, string>()
  const messages: Message[] = []
  let referenceIndex = 0

  for (const message of request.messages) {
    if (message.role !== "user") {
      messages.push(message)
      continue
    }

    const content = [] as Message["content"][number][]
    for (const part of message.content) {
      if (part.type !== "media" || typeof part.data !== "string") {
        content.push(part)
        continue
      }
      if (PUBLIC_URL.test(part.data))
        return yield* invalid("Kimi K3 public image URLs are unsupported; use base64 or ms:// file references")
      if (!part.data.startsWith("ms://")) {
        content.push(part)
        continue
      }
      if (!MOONSHOT_FILE_REFERENCE.test(part.data))
        return yield* invalid("Kimi K3 Moonshot file references must use ms://<file-id>")
      const mime = part.mediaType.toLowerCase()
      if (!KIMI_IMAGE_MIMES.has(mime))
        return yield* invalid(`Kimi K3 does not support image media type ${part.mediaType}`)

      const placeholder = Buffer.from(`opencode-kimi-reference:${referenceIndex++}:${part.data}`).toString("base64")
      const dataUrl = `data:${mime};base64,${placeholder}`
      byDataUrl.set(dataUrl, part.data)
      content.push(MediaPart.make({ ...part, data: placeholder }))
    }
    messages.push(
      Message.make({
        id: message.id,
        role: message.role,
        content,
        metadata: message.metadata,
        native: message.native,
      }),
    )
  }

  return { request: LLMRequest.update(request, { messages }), byDataUrl }
})

const restoreMoonshotReferences = (
  messages: OpenAIChat.OpenAIChatBody["messages"],
  references: ReadonlyMap<string, string>,
): OpenAIChat.OpenAIChatBody["messages"] =>
  messages.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") return message
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "image_url" && references.has(part.image_url.url)
          ? { ...part, image_url: { url: references.get(part.image_url.url)! } }
          : part,
      ),
    }
  })

const fromRequest = Effect.fn("KimiK3.fromRequest")(function* (request: LLMRequest) {
  const reasoningEffort = yield* validateRequest(request)
  const masked = yield* maskMoonshotReferences(request)
  const generation = masked.request.generation
  const projected = LLMRequest.update(masked.request, {
    generation:
      generation === undefined
        ? undefined
        : new GenerationOptions({
            maxTokens: generation.maxTokens,
            stop: generation.stop,
          }),
    providerOptions: undefined,
  })
  const compatible = yield* OpenAIChat.protocol.body.from(projected)
  const {
    max_tokens,
    temperature: _temperature,
    top_p: _topP,
    frequency_penalty: _frequencyPenalty,
    presence_penalty: _presencePenalty,
  } = compatible
  const responseFormat =
    request.responseFormat?.type === "json"
      ? {
          type: "json_schema" as const,
          json_schema: {
            name: "response",
            strict: true as const,
            schema: request.responseFormat.schema as Record<string, unknown>,
          },
        }
      : undefined

  const result: KimiChatBody = {
    model: compatible.model,
    messages: restoreMoonshotReferences(compatible.messages, masked.byDataUrl),
    ...(compatible.tools === undefined ? {} : { tools: compatible.tools }),
    ...(compatible.tool_choice === undefined ? {} : { tool_choice: compatible.tool_choice }),
    stream: compatible.stream,
    ...(compatible.stream_options === undefined ? {} : { stream_options: compatible.stream_options }),
    ...(compatible.stop === undefined ? {} : { stop: compatible.stop }),
    reasoning_effort: reasoningEffort,
    ...(max_tokens === undefined ? {} : { max_completion_tokens: max_tokens }),
    ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
  }
  return result
})

const route = OpenAICompatibleChat.makeProjectedRoute({ schema: KimiChatBody, from: fromRequest })

export const routes = [route]

export const configure = (input: ModelOptions = {}) => {
  const { apiKey: _, auth: _auth, baseURL, providerOptions, ...defaults } = input
  const configuredRoute = route.with({
    ...defaults,
    providerOptions: mergeProviderOptions({ kimi: { reasoningEffort: "max" } }, providerOptions),
    provider: id,
    endpoint: { baseURL: baseURL ?? DEFAULT_BASE_URL },
    auth: AuthOptions.bearer(input, "MOONSHOT_API_KEY"),
  })
  const model = (modelID: string | ModelID) => {
    const profile = requireModelCapability({ provider: id, model: modelID, required: "chat" })
    return configuredRoute.model({ id: profile.model })
  }

  return { id, model, configure }
}

export const provider = configure()
export const model = provider.model
