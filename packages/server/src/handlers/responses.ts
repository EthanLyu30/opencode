import { EventV2 } from "@opencode-ai/core/event"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
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

const guardSafe = (value: unknown) =>
  Effect.try({
    try: () => WorkflowV2.WorkflowSecretGuard.assertSafe(value),
    catch: (error) =>
      error instanceof WorkflowV2.WorkflowSecretGuard.UnsafePersistenceError
        ? error
        : new WorkflowV2.WorkflowSecretGuard.UnsafePersistenceError({
            path: "$",
            message: "Response input could not be inspected safely",
          }),
  })

export const ResponsesHandler = HttpApiBuilder.group(Api, "server.responses", (handlers) =>
  Effect.gen(function* () {
    const responses = yield* ResponsesV2.Service
    const workflow = yield* WorkflowV2.Service
    const execution = yield* WorkflowExecution.Service
    const events = yield* EventV2.Service

    const responseEvents = (response: Effect.Success<ReturnType<ResponsesV2.Interface["get"]>>, after?: number) =>
      events
        .durable({
          aggregateID: response.id,
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

    const transientResponseEvents = (
      response: Effect.Success<ReturnType<ResponsesV2.Interface["get"]>>,
      settledResponse: Effect.Effect<{
        readonly resource: Effect.Success<ReturnType<ResponsesV2.Interface["get"]>>
        readonly sequenceNumber: number
      }>,
    ) =>
      responseEvents(response).pipe(
        Stream.filter((event) => !terminal.has(event.type)),
        Stream.concat(
          Stream.fromEffect(settledResponse).pipe(
            Stream.map(({ resource: settled, sequenceNumber }) => {
              if (settled.status === "queued" || settled.status === "in_progress") {
                throw new Error(`Invalid transient terminal response: ${settled.status}`)
              }
              const event = {
                type: {
                  completed: "response.completed",
                  incomplete: "response.incomplete",
                  failed: "response.failed",
                  cancelled: "response.cancelled",
                }[settled.status],
                sequenceNumber,
                data: {
                  responseID: settled.id,
                  timestamp: settled.completedAt ?? settled.createdAt,
                  ...(settled.status === "completed" || settled.status === "incomplete"
                    ? { output: settled.output, usage: settled.usage, error: settled.error }
                    : { usage: settled.usage, error: settled.error }),
                },
              }
              if (!isStreamEvent(event)) throw new Error(`Invalid transient terminal response: ${settled.status}`)
              return event
            }),
          ),
        ),
      )

    return handlers
      .handle(
        "responses.create",
        Effect.fn(function* (ctx) {
          if (ctx.payload.background && ctx.payload.stream === true) {
            return yield* new InvalidRequestError({
              message: "background Responses cannot be streamed",
              kind: "invalid_combination",
              field: "stream",
            })
          }
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
          yield* guardSafe(ctx.payload.input).pipe(
            Effect.catchTag("Workflow.UnsafePersistenceError", unsafePersistence),
          )
          const existingRequest = yield* responses.findByRequestHash(ctx.payload.requestHash)
          const responseID = ctx.payload.id ?? existingRequest?.id ?? ResponsesV2.ID.create()
          const workflowDetail = yield* workflow.get(ctx.payload.workflowID).pipe(
            Effect.catchTag(
              "Workflow.NotFoundError",
              (error) =>
                new WorkflowNotFoundError({
                  workflowID: error.workflowID,
                  message: `Workflow not found: ${error.workflowID}`,
                }),
            ),
          )
          if (existingRequest === undefined) {
            if (
              workflowDetail.run.cancelRequestedAt !== undefined ||
              workflowDetail.run.status === "succeeded" ||
              workflowDetail.run.status === "failed" ||
              workflowDetail.run.status === "cancelled"
            ) {
              return yield* new InvalidRequestError({
                message: "A Response cannot be admitted for a terminal or cancelling workflow",
                kind: "invalid_response_binding",
                field: "workflowID",
              })
            }
            const deliver = workflowDetail.stages.filter((stage) => stage.type === "deliver")
            const explicit = deliver.filter(
              (stage) => stage.input.responseBinding === undefined && stage.input.responseID === responseID,
            )
            const implicit = deliver.filter(
              (stage) => stage.input.responseID === undefined && stage.input.responseBinding === "workflow",
            )
            const bound = explicit.length === 1 || (explicit.length === 0 && implicit.length === 1)
            if (!bound) {
              return yield* new InvalidRequestError({
                message: "A Response requires exactly one matching deliver-stage binding",
                kind: "invalid_response_binding",
                field: "workflowID",
              })
            }
          }
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              let transientLease =
                !ctx.payload.store && !ctx.payload.background
                  ? yield* responses.acquireTransient({ requestHash: ctx.payload.requestHash, responseID })
                  : undefined
              return yield* restore(
                Effect.gen(function* () {
                  const admitted = yield* responses
                    .create({
                      id: responseID,
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
                  if (transientLease) yield* responses.registerTransient(admitted)
                  yield* execution.wake
                  if (admitted.background) return admitted
                  if (transientLease && ctx.payload.stream !== true) {
                    return yield* transientLease.await.pipe(
                      Effect.map((settled) => settled.resource),
                      Effect.ensuring(transientLease.release),
                    )
                  }
                  if (ctx.payload.stream === true) {
                    return admitted.store
                      ? responseEvents(admitted)
                      : transientResponseEvents(admitted, transientLease!.await).pipe(
                          Stream.ensuring(transientLease!.release),
                        )
                  }
                  yield* responseEvents(admitted).pipe(Stream.runDrain)
                  return yield* responses.get(admitted.id).pipe(Effect.orDie)
                }),
              ).pipe(Effect.onError(() => transientLease?.release ?? Effect.void))
            }),
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
            .cancelWorkflow({ responseID: ctx.params.responseID })
            .pipe(
              Effect.catchTag("Responses.NotFoundError", notFound),
              Effect.catchTag("Responses.ConflictError", conflict),
              Effect.catchTag("Workflow.UnsafePersistenceError", unsafePersistence),
            )
          yield* execution.interrupt(cancelled.workflowID).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Response cancellation interrupt failed", {
                workflowID: cancelled.workflowID,
                responseID: cancelled.id,
                cause,
              }),
            ),
            Effect.forkDetach({ startImmediately: true }),
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
          return responseEvents(response, ctx.query.after)
        }),
      )
  }),
)
