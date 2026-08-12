import { Effect, Schema } from "effect"
import { requireModelCapability } from "../capabilities"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"
import * as OpenAIResponses from "../protocols/openai-responses"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { Auth } from "../route/auth"
import { Route, type RouteDefaultsInput } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { Protocol } from "../route/protocol"
import { HttpTransport } from "../route/transport"
import {
  LLMRequest,
  Message,
  ProviderID,
  ToolDefinition,
  type ModelID,
  type ProviderOptions,
  type ReasoningEffort,
} from "../schema"
import * as ProviderShared from "../protocols/shared"

export const id = ProviderID.make("deepseek")
export const DEFAULT_BASE_URL = "https://api.deepseek.com"

export interface DeepSeekResponsesOptionsInput {
  readonly [key: string]: unknown
  readonly reasoningEffort?: ReasoningEffort
  readonly topLogprobs?: number
}

export type DeepSeekProviderOptionsInput = ProviderOptions & {
  readonly deepseek?: DeepSeekResponsesOptionsInput
}

export type ModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: DeepSeekProviderOptionsInput
  }

const invalid = ProviderShared.invalidRequest

const ALLOWED_HTTP_OVERLAY_FIELDS = new Set(["instructions", "user"])

const definedKeys = (input: Record<string, unknown> | undefined) =>
  input
    ? Object.entries(input)
        .filter((entry) => entry[1] !== undefined)
        .map(([key]) => key)
    : []

const normalizeReasoningEffort = (effort: unknown) => {
  if (effort === undefined) return undefined
  if (effort === "high" || effort === "max") return effort
  // DeepSeek documents these OpenAI-compatibility mappings. Normalize them
  // locally so the wire body contains only values that affect the model.
  if (effort === "low" || effort === "medium") return "high" as const
  if (effort === "xhigh") return "max" as const
  return undefined
}

const normalizeMessages = (request: LLMRequest) =>
  request.messages.map((message) => {
    if (message.role !== "assistant" || !message.content.some((part) => part.type === "reasoning")) return message
    return Message.make({
      id: message.id,
      role: message.role,
      metadata: message.metadata,
      native: message.native,
      // DeepSeek accepts plaintext reasoning input by merging it into the
      // adjacent assistant message; it does not accept OpenAI encrypted or
      // summary replay items. Project reasoning to ordinary assistant text.
      content: message.content.map((part) =>
        part.type === "reasoning"
          ? {
              type: "text" as const,
              text: part.text,
              metadata: part.metadata,
              providerMetadata: part.providerMetadata,
            }
          : part,
      ),
    })
  })

const nativeDeepSeekTool = (tool: ToolDefinition) => {
  const deepseek = tool.native?.deepseek
  return ProviderShared.isRecord(deepseek) ? deepseek : undefined
}

const isNativeWebSearch = (tool: ToolDefinition) => nativeDeepSeekTool(tool)?.type === "web_search"

/** A server-executed DeepSeek web-search tool definition. */
export const webSearchTool = () =>
  ToolDefinition.make({
    name: "web_search",
    description: "Search the web using DeepSeek's hosted search tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    native: { deepseek: { type: "web_search" } },
  })

const projectTools = (
  request: LLMRequest,
  lowered: OpenAIResponses.OpenAIResponsesBody["tools"],
): OpenAIResponses.OpenAIResponsesBody["tools"] =>
  lowered?.map((tool, index) => {
    const definition = request.tools[index]
    if (definition?.name === "apply_patch") return { type: "custom", name: "apply_patch" }
    if (definition && isNativeWebSearch(definition)) return { type: "web_search" }
    return tool
  })

const hostedWebSearchReplay = (request: LLMRequest) => {
  const items = new Map<string, OpenAIResponses.OpenAIResponsesBody["input"][number]>()
  for (const message of request.messages) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.providerExecuted !== true || part.result.type !== "json") continue
      const value = part.result.value
      if (!ProviderShared.isRecord(value) || value.type !== "web_search_call" || typeof value.id !== "string") continue
      const openai = part.providerMetadata?.openai
      const itemID = ProviderShared.isRecord(openai) && typeof openai.itemId === "string" ? openai.itemId : value.id
      items.set(itemID, value as OpenAIResponses.OpenAIResponsesBody["input"][number])
    }
  }
  return items
}

const validateRequest = Effect.fn("DeepSeekResponses.validateRequest")(function* (request: LLMRequest) {
  const openai = request.providerOptions?.openai
  const openAIOptions = definedKeys(openai)
  if (openAIOptions.length > 0)
    return yield* invalid(
      `DeepSeek Responses requires providerOptions.deepseek; OpenAI option(s) are not accepted: ${openAIOptions.join(", ")}`,
    )

  const deepseek = request.providerOptions?.deepseek
  const unknownDeepSeek = definedKeys(deepseek).filter((key) => key !== "reasoningEffort" && key !== "topLogprobs")
  if (unknownDeepSeek.length > 0)
    return yield* invalid(`DeepSeek Responses does not support option(s): ${unknownDeepSeek.join(", ")}`)

  const reasoningEffort = deepseek?.reasoningEffort
  if (reasoningEffort !== undefined && normalizeReasoningEffort(reasoningEffort) === undefined)
    return yield* invalid(
      `DeepSeek Responses reasoningEffort must be high or max (OpenAI-compatible low, medium, and xhigh are normalized)`,
    )

  if (
    deepseek?.topLogprobs !== undefined &&
    (typeof deepseek.topLogprobs !== "number" ||
      !Number.isInteger(deepseek.topLogprobs) ||
      deepseek.topLogprobs < 0 ||
      deepseek.topLogprobs > 20)
  )
    return yield* invalid("DeepSeek Responses topLogprobs must be an integer from 0 through 20")

  if (request.generation?.temperature !== undefined || request.generation?.topP !== undefined)
    return yield* invalid(
      "DeepSeek Responses thinking mode ignores temperature and topP; omit them instead of requesting ineffective controls",
    )

  const unsupportedGeneration = [
    ["topK", request.generation?.topK],
    ["frequencyPenalty", request.generation?.frequencyPenalty],
    ["presencePenalty", request.generation?.presencePenalty],
    ["seed", request.generation?.seed],
    ["stop", request.generation?.stop],
  ].filter((entry) => entry[1] !== undefined)
  if (unsupportedGeneration.length > 0)
    return yield* invalid(
      `DeepSeek Responses does not support generation option(s): ${unsupportedGeneration.map(([key]) => key).join(", ")}`,
    )

  if (request.responseFormat?.type === "tool")
    return yield* invalid("DeepSeek Responses does not support tool responseFormat; use a required function tool")
  if (request.responseFormat?.type === "json" && !ProviderShared.isRecord(request.responseFormat.schema))
    return yield* invalid("DeepSeek Responses JSON responseFormat schema must be an object")

  if (request.toolChoice?.type === "tool" && request.toolChoice.name === "apply_patch")
    return yield* invalid(
      "DeepSeek Responses cannot select custom apply_patch by name; use required with apply_patch as the only tool",
    )

  const hostedItemIDs = new Set<string>()
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type === "media")
        return yield* invalid(`DeepSeek Responses does not support image or file input (${part.mediaType})`)
      if (
        part.type === "tool-result" &&
        part.result.type === "content" &&
        part.result.value.some((item: unknown) => ProviderShared.isRecord(item) && item.type === "file")
      )
        return yield* invalid("DeepSeek Responses does not support image or file tool-result input")
      if (part.type === "tool-result" && part.providerExecuted === true && part.result.type === "json") {
        const value = part.result.value
        if (ProviderShared.isRecord(value) && value.type === "web_search_call" && typeof value.id === "string") {
          const openai = part.providerMetadata?.openai
          const itemID = ProviderShared.isRecord(openai) && typeof openai.itemId === "string" ? openai.itemId : value.id
          if (hostedItemIDs.has(itemID)) {
            return yield* invalid(`DeepSeek Responses cannot replay duplicate hosted item id: ${itemID}`)
          }
          hostedItemIDs.add(itemID)
        }
      }
    }
  }

  const unsupportedHTTP = definedKeys(request.http?.body).filter((key) => !ALLOWED_HTTP_OVERLAY_FIELDS.has(key))
  if (unsupportedHTTP.length > 0)
    return yield* invalid(
      `DeepSeek Responses http.body only permits instructions and user; unsupported field(s): ${unsupportedHTTP.join(", ")}`,
    )
  if (request.http?.body?.instructions !== undefined && typeof request.http.body.instructions !== "string")
    return yield* invalid("DeepSeek Responses HTTP instructions must be a string")
  if (request.http?.body?.user !== undefined && typeof request.http.body.user !== "string")
    return yield* invalid("DeepSeek Responses HTTP user must be a string")
})

const fromResponsesRequest = Effect.fn("DeepSeekResponses.fromRequest")(function* (request: LLMRequest) {
  yield* validateRequest(request)
  const options = request.providerOptions?.deepseek
  const effort = normalizeReasoningEffort(options?.reasoningEffort)
  const topLogprobs = typeof options?.topLogprobs === "number" ? options.topLogprobs : undefined
  const projected = LLMRequest.update(request, {
    messages: normalizeMessages(request),
    // Reuse the common Responses message/tool lowerer without presenting
    // DeepSeek-only values to the OpenAI option validator.
    providerOptions: undefined,
  })
  const body = yield* OpenAIResponses.fromRequest(projected)
  const {
    store: _store,
    service_tier: _serviceTier,
    prompt_cache_key: _promptCacheKey,
    include: _include,
    reasoning: _reasoning,
    ...native
  } = body

  const hosted = hostedWebSearchReplay(request)
  const input = native.input.map((item) =>
    "type" in item && item.type === "item_reference" ? (hosted.get(item.id) ?? item) : item,
  )
  if (input.some((item) => "type" in item && item.type === "item_reference"))
    return yield* invalid(
      "DeepSeek Responses cannot replay an OpenAI item_reference; replay the provider-hosted item content instead",
    )

  const format =
    request.responseFormat?.type === "json"
      ? {
          type: "json_schema" as const,
          name: "response",
          schema: request.responseFormat.schema as Record<string, unknown>,
          strict: true,
        }
      : undefined

  return {
    ...native,
    input,
    tools: projectTools(request, native.tools),
    tool_choice:
      request.toolChoice?.type === "tool" &&
      request.toolChoice.name !== undefined &&
      request.tools.some((tool) => tool.name === request.toolChoice?.name && isNativeWebSearch(tool))
        ? { type: "web_search" as const }
        : native.tool_choice,
    ...(format === undefined ? {} : { text: { format } }),
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    ...(topLogprobs === undefined ? {} : { top_logprobs: topLogprobs }),
  }
})

export const DeepSeekResponsesBody = Schema.Struct({
  ...OpenAIResponses.OpenAIResponsesCoreFields,
  reasoning: Schema.optional(
    Schema.Struct({
      effort: Schema.optional(Schema.Literals(["high", "max"])),
      summary: Schema.optional(Schema.Literal("auto")),
    }),
  ),
  stream: Schema.Literal(true),
})
export type DeepSeekResponsesBody = Schema.Schema.Type<typeof DeepSeekResponsesBody>

const responsesProtocol = Protocol.make({
  id: OpenAIResponses.protocol.id,
  body: {
    schema: DeepSeekResponsesBody,
    from: fromResponsesRequest,
  },
  stream: OpenAIResponses.protocol.stream,
})

const nativeResponsesRoute = Route.make({
  id: OpenAIResponses.route.id,
  provider: id,
  protocol: responsesProtocol,
  endpoint: Endpoint.path<DeepSeekResponsesBody>(OpenAIResponses.PATH, { baseURL: DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: HttpTransport.sseJson.with<DeepSeekResponsesBody>(),
})

export const routes = [nativeResponsesRoute, OpenAICompatibleChat.route]

const defaults = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL: _baseURL, ...rest } = input
  return rest
}

const auth = (input: ModelOptions) => AuthOptions.bearer(input, "DEEPSEEK_API_KEY")

export const configure = (input: ModelOptions = {}) => {
  const routeDefaults = defaults(input)
  const responsesRoute = nativeResponsesRoute.with({
    ...routeDefaults,
    provider: id,
    endpoint: { baseURL: input.baseURL ?? DEFAULT_BASE_URL },
    auth: auth(input),
  })
  const chatRoute = OpenAICompatibleChat.route.with({
    ...routeDefaults,
    provider: id,
    endpoint: { baseURL: input.baseURL ?? DEFAULT_BASE_URL },
    auth: auth(input),
  })
  const responses = (modelID: string | ModelID) => {
    const profile = requireModelCapability({ provider: id, model: modelID, required: "responses" })
    return responsesRoute.model({ id: profile.model })
  }
  const chat = (modelID: string | ModelID) => {
    const profile = requireModelCapability({ provider: id, model: modelID, required: "chat" })
    return chatRoute.model({ id: profile.model })
  }

  return {
    id,
    model: responses,
    responses,
    chat,
    configure,
  }
}

export const provider = configure()
export const model = provider.model
export const responses = provider.responses
export const chat = provider.chat
