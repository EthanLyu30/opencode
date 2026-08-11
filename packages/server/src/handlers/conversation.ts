import { ResponsesV2 } from "@opencode-ai/core/responses"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { ConversationNotFoundError, InvalidRequestError, ResponseConflictError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

const notFound = (error: ResponsesV2.ConversationNotFoundError) =>
  new ConversationNotFoundError({
    conversationID: error.conversationID,
    message: `Conversation not found: ${error.conversationID}`,
  })

const conflict = (error: ResponsesV2.ConflictError) =>
  new ResponseConflictError({
    resourceID: error.resourceID,
    operation: error.operation,
    message: `Conversation ${error.operation} conflicts with its current state`,
  })

const unsafePersistence = (error: WorkflowV2.WorkflowSecretGuard.UnsafePersistenceError) =>
  new InvalidRequestError({
    message: "Unsafe value cannot be persisted in a conversation",
    kind: "unsafe_persistence",
    field: error.path,
  })

export const ConversationHandler = HttpApiBuilder.group(Api, "server.conversation", (handlers) =>
  Effect.gen(function* () {
    const responses = yield* ResponsesV2.Service

    return handlers
      .handle(
        "conversation.create",
        Effect.fn(function* (ctx) {
          return yield* responses
            .createConversation(ctx.payload)
            .pipe(
              Effect.catchTag("Responses.ConflictError", conflict),
              Effect.catchTag("Workflow.UnsafePersistenceError", unsafePersistence),
            )
        }),
      )
      .handle(
        "conversation.get",
        Effect.fn(function* (ctx) {
          return yield* responses
            .getConversation(ctx.params.conversationID)
            .pipe(Effect.catchTag("Responses.ConversationNotFoundError", notFound))
        }),
      )
      .handle(
        "conversation.delete",
        Effect.fn(function* (ctx) {
          yield* responses
            .deleteConversation(ctx.params.conversationID)
            .pipe(
              Effect.catchTag("Responses.ConversationNotFoundError", notFound),
              Effect.catchTag("Responses.ConflictError", conflict),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "conversation.appendItem",
        Effect.fn(function* (ctx) {
          return yield* responses
            .appendConversationItem({
              conversationID: ctx.params.conversationID,
              ...(ctx.payload.responseID === undefined ? {} : { responseID: ctx.payload.responseID }),
              payload: ctx.payload.payload,
            })
            .pipe(
              Effect.catchTag("Responses.ConversationNotFoundError", notFound),
              Effect.catchTag("Responses.ConflictError", conflict),
              Effect.catchTag("Workflow.UnsafePersistenceError", unsafePersistence),
            )
        }),
      )
      .handle(
        "conversation.items",
        Effect.fn(function* (ctx) {
          return {
            data: yield* responses
              .conversationItems(ctx.params.conversationID)
              .pipe(Effect.catchTag("Responses.ConversationNotFoundError", notFound)),
          }
        }),
      )
  }),
)
