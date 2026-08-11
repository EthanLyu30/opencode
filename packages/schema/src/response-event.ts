export * as ResponseEvent from "./response-event"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, optional } from "./schema"
import { Event } from "./event"
import { Responses } from "./responses"
import { Workflow } from "./workflow"

const responseDurable = { version: 1, aggregate: "responseID" } as const
const conversationDurable = { version: 1, aggregate: "conversationID" } as const

const responseBase = {
  responseID: Responses.ID,
  timestamp: DateTimeUtcFromMillis,
}

const terminalBase = {
  ...responseBase,
  output: Schema.Array(Responses.ItemPayload).pipe(optional),
  error: Responses.Error.pipe(optional),
  usage: Responses.Usage.pipe(optional),
}

export const Created = Event.define({
  type: "response.created",
  durable: responseDurable,
  schema: {
    ...responseBase,
    workflowID: Workflow.ID,
    model: Schema.NonEmptyString,
    background: Schema.Boolean,
    store: Schema.Boolean,
    previousResponseID: Responses.ID.pipe(optional),
    conversationID: Responses.ConversationID.pipe(optional),
    requestHash: Schema.NonEmptyString,
    context: Schema.Array(Responses.ItemPayload),
    input: Schema.NonEmptyArray(Responses.ItemPayload),
  },
})
export type Created = typeof Created.Type

export const InProgress = Event.define({
  type: "response.in_progress",
  durable: responseDurable,
  schema: responseBase,
})
export type InProgress = typeof InProgress.Type

export const Completed = Event.define({
  type: "response.completed",
  durable: responseDurable,
  schema: {
    ...responseBase,
    output: Schema.Array(Responses.ItemPayload).pipe(optional),
    usage: Responses.Usage.pipe(optional),
  },
})
export type Completed = typeof Completed.Type

export const Incomplete = Event.define({
  type: "response.incomplete",
  durable: responseDurable,
  schema: terminalBase,
})
export type Incomplete = typeof Incomplete.Type

export const Failed = Event.define({
  type: "response.failed",
  durable: responseDurable,
  schema: {
    ...responseBase,
    error: Responses.Error.pipe(optional),
    usage: Responses.Usage.pipe(optional),
  },
})
export type Failed = typeof Failed.Type

export const Cancelled = Event.define({
  type: "response.cancelled",
  durable: responseDurable,
  schema: {
    ...responseBase,
    error: Responses.Error.pipe(optional),
    usage: Responses.Usage.pipe(optional),
  },
})
export type Cancelled = typeof Cancelled.Type

export const Deleted = Event.define({
  type: "response.deleted",
  durable: responseDurable,
  schema: responseBase,
})
export type Deleted = typeof Deleted.Type

export namespace Conversation {
  export const Created = Event.define({
    type: "conversation.created",
    durable: conversationDurable,
    schema: {
      conversationID: Responses.ConversationID,
      timestamp: DateTimeUtcFromMillis,
      metadata: Schema.Record(Schema.String, Schema.Json),
    },
  })
  export type Created = typeof Created.Type

  export const ItemAdded = Event.define({
    type: "conversation.item.added",
    durable: conversationDurable,
    schema: {
      conversationID: Responses.ConversationID,
      timestamp: DateTimeUtcFromMillis,
      responseID: Responses.ID.pipe(optional),
      payload: Responses.ItemPayload,
    },
  })
  export type ItemAdded = typeof ItemAdded.Type

  export const Deleted = Event.define({
    type: "conversation.deleted",
    durable: conversationDurable,
    schema: {
      conversationID: Responses.ConversationID,
      timestamp: DateTimeUtcFromMillis,
    },
  })
  export type Deleted = typeof Deleted.Type
}

export const Definitions = Event.inventory(
  Created,
  InProgress,
  Completed,
  Incomplete,
  Failed,
  Cancelled,
  Deleted,
  Conversation.Created,
  Conversation.ItemAdded,
  Conversation.Deleted,
)
export const DurableDefinitions = Definitions
export const Durable = Schema.Union(Definitions)
export type DurableEvent = typeof Durable.Type
