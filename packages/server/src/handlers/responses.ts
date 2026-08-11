import { EventV2 } from "@opencode-ai/core/event"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { Capabilities } from "@opencode-ai/llm"
import {
  InvalidRequestError,
  ResponseConflictError,
  ResponseNotFoundError,
  UnsupportedCapabilityError,
  UnsupportedModelCapabilityError,
  WorkflowNotFoundError,
} from "@opencode-ai/protocol/errors"
import { ResponseStreamEvent, unsupportedResponseFields } from "@opencode-ai/protocol/groups/responses"
import { Effect, Schema, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

const terminal = new Set(["response.completed", "response.incomplete", "response.failed", "response.cancelled"])
const terminalStatus = new Set(["completed", "incomplete", "failed", "cancelled"])
const isStreamEvent = Schema.is(ResponseStreamEvent)

const notFound = (error: ResponsesV2.NotFoundError) =>
  new ResponseNotFoundError({
    responseID: error.responseID,
    message: `Response not found: ${error.responseID}`,
  })

const conflict = (error: ResponsesV2.ConflictError) =>
  new ResponseConflictError({
    resourceID: error.resourceID,
    operation: error.operation,
    message: `Response ${error.operation} conflicts with its current state`,
  })

const unsafePersistence = (error: WorkflowV2.WorkflowSecretGuard.UnsafePersistenceError) =>
  new InvalidRequestError({
    message: "Unsafe value cannot be persisted in a response",
    kind: "unsafe_persistence",
    field: error.path,
  })

export const ResponsesHandler = HttpApiBuilder.group(Api, "server.responses", (handlers) =>
  Effect.gen(function* () {
    const responses = yield* ResponsesV2.Service
    const workflow = yield* WorkflowV2.Service
    const events = yield* EventV2.Service

    return handlers
      .handle(
        "responses.create",
        Effect.fn(function* (ctx) {
          const unsupported = unsupportedResponseFields(ctx.payload)
          if (unsupported.length > 0) {
            return yield* new UnsupportedCapabilityError({
              capability: unsupported[0],
              message: `Unsupported Responses capability: ${unsupported.join(", ")}`,
              supportedAlternatives: ["input", "previousResponseID", "conversationID"],
            })
          }
          yield* Effect.try({
            try: () =>
              Capabilities.requireModelCapability({
                provider: "deepseek",
                model: ctx.payload.model,
                required: "responses",
              }),
            catch: (error) =>
              error instanceof Capabilities.UnsupportedModelCapability
                ? new UnsupportedModelCapabilityError({
                    provider: error.provider,
                    model: error.model,
                    required: error.required,
                    supported: error.supported,
                    planned: error.planned,
                    message: error.message,
                  })
                : new InvalidRequestError({ message: String(error), kind: "invalid_model" }),
          })
          if (
            ctx.payload.previousResponseID !== undefined &&
            ctx.payload.previous_response_id !== undefined &&
            ctx.payload.previousResponseID !== ctx.payload.previous_response_id
          ) {
            return yield* new InvalidRequestError({
              message: "previousResponseID and previous_response_id must match when both are provided",
              kind: "conflicting_alias",
              field: "previous_response_id",
            })
          }
          if (
            ctx.payload.conversationID !== undefined &&
            ctx.payload.conversation !== undefined &&
            ctx.payload.conversationID !== ctx.payload.conversation
          ) {
            return yield* new InvalidRequestError({
              message: "conversationID and conversation must match when both are provided",
              kind: "conflicting_alias",
              field: "conversation",
            })
          }
          const previousResponseID = ctx.payload.previousResponseID ?? ctx.payload.previous_response_id
          const conversationID = ctx.payload.conversationID ?? ctx.payload.conversation
          yield* workflow.get(ctx.payload.workflowID).pipe(
            Effect.catchTag(
              "Workflow.NotFoundError",
              (error) =>
                new WorkflowNotFoundError({
                  workflowID: error.workflowID,
                  message: `Workflow not found: ${error.workflowID}`,
                }),
            ),
          )
          return yield* responses
            .create({
              ...(ctx.payload.id === undefined ? {} : { id: ctx.payload.id }),
              workflowID: ctx.payload.workflowID,
              model: ctx.payload.model,
              background: ctx.payload.background,
              store: ctx.payload.store,
              ...(previousResponseID === undefined ? {} : { previousResponseID }),
              ...(conversationID === undefined ? {} : { conversationID }),
              requestHash: ctx.payload.requestHash,
              input: ctx.payload.input,
            })
            .pipe(
              Effect.catchTag("Responses.ConflictError", conflict),
              Effect.catchTag("Workflow.UnsafePersistenceError", unsafePersistence),
            )
        }),
      )
      .handle(
        "responses.get",
        Effect.fn(function* (ctx) {
          return yield* responses.get(ctx.params.responseID).pipe(Effect.catchTag("Responses.NotFoundError", notFound))
        }),
      )
      .handle(
        "responses.delete",
        Effect.fn(function* (ctx) {
          yield* responses
            .delete(ctx.params.responseID)
            .pipe(
              Effect.catchTag("Responses.NotFoundError", notFound),
              Effect.catchTag("Responses.ConflictError", conflict),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "responses.cancel",
        Effect.fn(function* (ctx) {
          const cancelled = yield* responses
            .cancel({ responseID: ctx.params.responseID })
            .pipe(
              Effect.catchTag("Responses.NotFoundError", notFound),
              Effect.catchTag("Responses.ConflictError", conflict),
              Effect.catchTag("Workflow.UnsafePersistenceError", unsafePersistence),
            )
          yield* workflow.cancel(cancelled.workflowID).pipe(
            Effect.catchTag("Workflow.NotFoundError", () => Effect.void),
            Effect.catchTag("Workflow.ConflictError", () => Effect.void),
          )
          return cancelled
        }),
      )
      .handle(
        "responses.inputItems",
        Effect.fn(function* (ctx) {
          return {
            data: yield* responses
              .inputItems(ctx.params.responseID)
              .pipe(Effect.catchTag("Responses.NotFoundError", notFound)),
          }
        }),
      )
      .handle(
        "responses.events",
        Effect.fn(function* (ctx) {
          const response = yield* responses
            .get(ctx.params.responseID)
            .pipe(Effect.catchTag("Responses.NotFoundError", notFound))
          const after = ctx.query.after
          return events
            .durable({
              aggregateID: ctx.params.responseID,
              ...(terminalStatus.has(response.status) ? {} : { after }),
            })
            .pipe(
              Stream.map((event) =>
                event.durable && event.type !== "response.deleted"
                  ? { type: event.type, sequenceNumber: event.durable.seq, data: event.data }
                  : undefined,
              ),
              Stream.filter((event): event is ResponseStreamEvent => event !== undefined && isStreamEvent(event)),
              Stream.takeUntil((event) => terminal.has(event.type)),
              Stream.filter((event) => after === undefined || event.sequenceNumber > after),
              Stream.orDie,
            )
        }),
      )
  }),
)
