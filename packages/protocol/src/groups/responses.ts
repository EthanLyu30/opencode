import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Responses } from "@opencode-ai/schema/responses"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  InvalidRequestError,
  ResponseConflictError,
  ResponseNotFoundError,
  UnsupportedCapabilityError,
  UnsupportedModelCapabilityError,
  WorkflowNotFoundError,
} from "../errors"

const createFields = new Set([
  "id",
  "workflowID",
  "model",
  "background",
  "store",
  "previousResponseID",
  "previous_response_id",
  "conversationID",
  "conversation",
  "requestHash",
  "input",
])

export const ResponsesCreatePayload = Schema.Struct({
  ...Responses.CreateInput.fields,
  tools: Schema.Array(Responses.ItemPayload).pipe(Schema.optional),
  include: Schema.Array(Schema.String).pipe(Schema.optional),
  prompt: Responses.ItemPayload.pipe(Schema.optional),
  truncation: Schema.String.pipe(Schema.optional),
  stream: Schema.Boolean.pipe(Schema.optional),
  instructions: Schema.String.pipe(Schema.optional),
  temperature: Schema.Number.pipe(Schema.optional),
  topP: Schema.Number.pipe(Schema.optional),
  top_p: Schema.Number.pipe(Schema.optional),
  maxOutputTokens: NonNegativeInt.pipe(Schema.optional),
  max_output_tokens: NonNegativeInt.pipe(Schema.optional),
  topLogprobs: NonNegativeInt.pipe(Schema.optional),
  top_logprobs: NonNegativeInt.pipe(Schema.optional),
  toolChoice: Schema.Union([Schema.String, Responses.ItemPayload]).pipe(Schema.optional),
  tool_choice: Schema.Union([Schema.String, Responses.ItemPayload]).pipe(Schema.optional),
  reasoning: Responses.ItemPayload.pipe(Schema.optional),
  text: Responses.ItemPayload.pipe(Schema.optional),
  user: Schema.String.pipe(Schema.optional),
  parallelToolCalls: Schema.Boolean.pipe(Schema.optional),
  parallel_tool_calls: Schema.Boolean.pipe(Schema.optional),
  maxToolCalls: NonNegativeInt.pipe(Schema.optional),
  max_tool_calls: NonNegativeInt.pipe(Schema.optional),
  metadata: Schema.Record(Schema.String, Schema.Json).pipe(Schema.optional),
  moderation: Responses.ItemPayload.pipe(Schema.optional),
  serviceTier: Schema.String.pipe(Schema.optional),
  service_tier: Schema.String.pipe(Schema.optional),
  safetyIdentifier: Schema.String.pipe(Schema.optional),
  safety_identifier: Schema.String.pipe(Schema.optional),
  promptCacheKey: Schema.String.pipe(Schema.optional),
  prompt_cache_key: Schema.String.pipe(Schema.optional),
  promptCacheRetention: Schema.String.pipe(Schema.optional),
  prompt_cache_retention: Schema.String.pipe(Schema.optional),
  promptCacheOptions: Responses.ItemPayload.pipe(Schema.optional),
  prompt_cache_options: Responses.ItemPayload.pipe(Schema.optional),
  contextManagement: Schema.Array(Responses.ItemPayload).pipe(Schema.optional),
  context_management: Schema.Array(Responses.ItemPayload).pipe(Schema.optional),
  streamOptions: Responses.ItemPayload.pipe(Schema.optional),
  stream_options: Responses.ItemPayload.pipe(Schema.optional),
  previous_response_id: Responses.ID.pipe(Schema.optional),
  conversation: Responses.ConversationID.pipe(Schema.optional),
}).annotate({ identifier: "Responses.CreatePayload" })

export function unsupportedResponseFields(input: typeof ResponsesCreatePayload.Type) {
  return Object.entries(input)
    .filter(([field, value]) => value !== undefined && !createFields.has(field) && field !== "stream")
    .map(([field]) => field)
    .toSorted()
}

export const ResponseEventsQuery = Schema.Struct({
  after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
})

const streamEvent = <Type extends string, Data extends Schema.Codec<unknown, unknown>>(type: Type, data: Data) =>
  Schema.Struct({
    type: Schema.Literal(type),
    sequenceNumber: NonNegativeInt,
    data,
  }).pipe(Schema.encodeKeys({ sequenceNumber: "sequence_number" }))

export const ResponseStreamEvent = Schema.Union([
  streamEvent(ResponseEvent.Created.type, ResponseEvent.Created.data),
  streamEvent(ResponseEvent.InProgress.type, ResponseEvent.InProgress.data),
  streamEvent(ResponseEvent.Completed.type, ResponseEvent.Completed.data),
  streamEvent(ResponseEvent.Incomplete.type, ResponseEvent.Incomplete.data),
  streamEvent(ResponseEvent.Failed.type, ResponseEvent.Failed.data),
  streamEvent(ResponseEvent.Cancelled.type, ResponseEvent.Cancelled.data),
]).annotate({ identifier: "Responses.StreamEvent" })
export type ResponseStreamEvent = typeof ResponseStreamEvent.Type

export const ResponsesGroup = HttpApiGroup.make("server.responses")
  .add(
    HttpApiEndpoint.post("responses.create", "/v1/responses", {
      payload: ResponsesCreatePayload,
      success: [Responses.Resource, HttpApiSchema.StreamSse({ data: ResponseStreamEvent })],
      error: [
        InvalidRequestError,
        UnsupportedCapabilityError,
        UnsupportedModelCapabilityError,
        WorkflowNotFoundError,
        ResponseConflictError,
      ],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v1.responses.create",
        summary: "Create response",
        description: "Admit a durable local Responses resource linked to an existing workflow.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("responses.get", "/v1/responses/:responseID", {
      params: { responseID: Responses.ID },
      success: Responses.Resource,
      error: ResponseNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v1.responses.get", summary: "Get response" })),
  )
  .add(
    HttpApiEndpoint.delete("responses.delete", "/v1/responses/:responseID", {
      params: { responseID: Responses.ID },
      success: HttpApiSchema.NoContent,
      error: [ResponseNotFoundError, ResponseConflictError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v1.responses.delete", summary: "Delete response" })),
  )
  .add(
    HttpApiEndpoint.post("responses.cancel", "/v1/responses/:responseID/cancel", {
      params: { responseID: Responses.ID },
      success: Responses.Resource,
      error: [ResponseNotFoundError, ResponseConflictError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v1.responses.cancel", summary: "Cancel response" })),
  )
  .add(
    HttpApiEndpoint.get("responses.inputItems", "/v1/responses/:responseID/input_items", {
      params: { responseID: Responses.ID },
      success: Schema.Struct({ data: Schema.Array(Responses.ResponseItem) }),
      error: ResponseNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v1.responses.inputItems", summary: "List response input items" }),
    ),
  )
  .add(
    HttpApiEndpoint.get("responses.events", "/v1/responses/:responseID/event", {
      params: { responseID: Responses.ID },
      query: ResponseEventsQuery,
      success: HttpApiSchema.StreamSse({ data: ResponseStreamEvent }),
      error: ResponseNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v1.responses.events",
        summary: "Subscribe to response events",
        description: "Replay response lifecycle events after an exclusive durable sequence, then tail new events.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "responses", description: "Durable local Responses gateway." }))
