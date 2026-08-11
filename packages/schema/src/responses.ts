export * as Responses from "./responses"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"
import { Workflow } from "./workflow"

export const ID = Schema.String.check(Schema.isStartsWith("resp_")).pipe(
  Schema.brand("Responses.ID"),
  statics((schema) => ({ create: () => schema.make("resp_" + ascending()) })),
)
export type ID = typeof ID.Type

export const ConversationID = Schema.String.check(Schema.isStartsWith("conv_")).pipe(
  Schema.brand("Responses.ConversationID"),
  statics((schema) => ({ create: () => schema.make("conv_" + ascending()) })),
)
export type ConversationID = typeof ConversationID.Type

export const Status = Schema.Literals(["queued", "in_progress", "completed", "incomplete", "failed", "cancelled"])
export type Status = typeof Status.Type

export const ItemKind = Schema.Literals(["context", "input", "output"])
export type ItemKind = typeof ItemKind.Type

export const ItemPayload = Schema.Record(Schema.String, Schema.Json)
export interface ItemPayload extends Schema.Schema.Type<typeof ItemPayload> {}

export const Error = Schema.Struct({
  code: Schema.NonEmptyString,
  message: Schema.String,
  type: Schema.String.pipe(optional),
  param: Schema.String.pipe(optional),
}).annotate({ identifier: "Responses.Error" })
export interface Error extends Schema.Schema.Type<typeof Error> {}

export const Usage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
  inputTokensDetails: Schema.Struct({ cachedTokens: NonNegativeInt }).pipe(optional),
  outputTokensDetails: Schema.Struct({ reasoningTokens: NonNegativeInt }).pipe(optional),
}).annotate({ identifier: "Responses.Usage" })
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

export const Resource = Schema.Struct({
  id: ID,
  workflowID: Workflow.ID,
  model: Schema.NonEmptyString,
  status: Status,
  background: Schema.Boolean,
  store: Schema.Boolean,
  previousResponseID: ID.pipe(optional),
  conversationID: ConversationID.pipe(optional),
  requestHash: Schema.NonEmptyString,
  output: Schema.Array(ItemPayload),
  error: Error.pipe(optional),
  usage: Usage.pipe(optional),
  createdAt: DateTimeUtcFromMillis,
  completedAt: DateTimeUtcFromMillis.pipe(optional),
  deletedAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Responses.Resource" })
export interface Resource extends Schema.Schema.Type<typeof Resource> {}

export const ResponseItem = Schema.Struct({
  responseID: ID,
  ordinal: NonNegativeInt,
  kind: ItemKind,
  payload: ItemPayload,
}).annotate({ identifier: "Responses.ResponseItem" })
export interface ResponseItem extends Schema.Schema.Type<typeof ResponseItem> {}

export const Conversation = Schema.Struct({
  id: ConversationID,
  metadata: Schema.Record(Schema.String, Schema.Json),
  createdAt: DateTimeUtcFromMillis,
  deletedAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Responses.Conversation" })
export interface Conversation extends Schema.Schema.Type<typeof Conversation> {}

export const ConversationItem = Schema.Struct({
  conversationID: ConversationID,
  ordinal: NonNegativeInt,
  responseID: ID.pipe(optional),
  payload: ItemPayload,
}).annotate({ identifier: "Responses.ConversationItem" })
export interface ConversationItem extends Schema.Schema.Type<typeof ConversationItem> {}

export const CreateInput = Schema.Struct({
  id: ID.pipe(optional),
  workflowID: Workflow.ID,
  model: Schema.NonEmptyString,
  background: Schema.Boolean,
  store: Schema.Boolean,
  previousResponseID: ID.pipe(optional),
  conversationID: ConversationID.pipe(optional),
  requestHash: Schema.NonEmptyString,
  input: Schema.NonEmptyArray(ItemPayload),
}).annotate({ identifier: "Responses.CreateInput" })
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const ConversationCreateInput = Schema.Struct({
  id: ConversationID.pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Json),
}).annotate({ identifier: "Responses.ConversationCreateInput" })
export interface ConversationCreateInput extends Schema.Schema.Type<typeof ConversationCreateInput> {}

export const ConversationAppendInput = Schema.Struct({
  conversationID: ConversationID,
  responseID: ID.pipe(optional),
  payload: ItemPayload,
}).annotate({ identifier: "Responses.ConversationAppendInput" })
export interface ConversationAppendInput extends Schema.Schema.Type<typeof ConversationAppendInput> {}
