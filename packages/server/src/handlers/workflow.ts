import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowAdmission } from "@opencode-ai/core/workflow/admission"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { DateTime, Effect, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import {
  InvalidRequestError,
  WorkflowConflictError,
  WorkflowNotFoundError,
  WorkflowStageNotFoundError,
} from "@opencode-ai/protocol/errors"
import { reservedAgent } from "./session"

const DefaultWorkflowListLimit = 50
const DefaultWorkflowHistoryLimit = 50
const terminalResponseStatus = new Set(["completed", "incomplete", "failed", "cancelled"])
const terminalResponseEvent = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.cancelled",
])

const notFound = (error: WorkflowV2.NotFoundError) =>
  new WorkflowNotFoundError({
    workflowID: error.workflowID,
    message: `Workflow not found: ${error.workflowID}`,
  })

const stageNotFound = (error: WorkflowV2.StageNotFoundError) =>
  new WorkflowStageNotFoundError({
    workflowID: error.workflowID,
    stageID: error.stageID,
    message: `Workflow stage not found: ${error.stageID}`,
  })

const conflict = (error: WorkflowV2.ConflictError) =>
  new WorkflowConflictError({
    workflowID: error.workflowID,
    operation: error.operation,
    message: `Workflow ${error.operation} conflicts with its current state`,
  })

const unsafePersistence = (error: WorkflowV2.WorkflowSecretGuard.UnsafePersistenceError) =>
  new InvalidRequestError({
    message: "Unsafe value cannot be persisted in a workflow",
    kind: "unsafe_persistence",
    field: error.path,
  })

const invalidIdempotencyKey = (error: WorkflowAdmission.InvalidIdempotencyKey) =>
  new InvalidRequestError({
    message: error.message,
    kind: "invalid_idempotency_key",
    field: "Idempotency-Key",
  })

const invalidAdmission = (error: WorkflowAdmission.InvalidAdmission) =>
  new InvalidRequestError({ message: error.message, kind: error.reason })

export const WorkflowHandler = HttpApiBuilder.group(Api, "server.workflow", (handlers) =>
  Effect.gen(function* () {
    const workflow = yield* WorkflowV2.Service
    const admission = yield* WorkflowAdmission.Service
    const responses = yield* ResponsesV2.Service
    const events = yield* EventV2.Service

    const followResponse = Effect.fn("WorkflowHandler.followVisualBuildResponse")(function* (
      admitted: WorkflowAdmission.Admission,
    ) {
      if (!terminalResponseStatus.has(admitted.response.status)) {
        yield* events.durable({ aggregateID: admitted.response.id }).pipe(
          Stream.filter((event) => terminalResponseEvent.has(event.type)),
          Stream.take(1),
          Stream.runDrain,
        )
      }
      return { ...admitted, response: yield* responses.get(admitted.response.id).pipe(Effect.orDie) }
    })

    return handlers
      .handle(
        "workflow.visualBuildCreate",
        Effect.fn(function* (ctx) {
          const current = yield* Location.Service
          const location = Location.Ref.make({
            directory: current.directory,
            ...(current.workspaceID === undefined ? {} : { workspaceID: current.workspaceID }),
          })
          const admitted = yield* admission
            .admitVisualBuild(ctx.payload, location, ctx.headers["idempotency-key"])
            .pipe(
              Effect.catchTag("Workflow.ConflictError", conflict),
              Effect.catchTag("WorkflowAdmission.InvalidAdmission", invalidAdmission),
              Effect.catchTag("WorkflowAdmission.InvalidIdempotencyKey", invalidIdempotencyKey),
              Effect.catchTag("Workflow.UnsafePersistenceError", unsafePersistence),
              Effect.catchTag("AgentV2.ReservedSelectionError", reservedAgent),
            )
          return {
            data: ctx.payload.delivery === "foreground" ? yield* followResponse(admitted) : admitted,
          }
        }),
      )
      .handle(
        "workflow.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* workflow
              .create(ctx.payload)
              .pipe(
                Effect.catchTag("Workflow.ConflictError", conflict),
                Effect.catchTag("Workflow.UnsafePersistenceError", unsafePersistence),
              ),
          }
        }),
      )
      .handle(
        "workflow.list",
        Effect.fn(function* (ctx) {
          return {
            data: yield* workflow.list({
              status: ctx.query.status,
              limit: ctx.query.limit ?? DefaultWorkflowListLimit,
            }),
          }
        }),
      )
      .handle(
        "workflow.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* workflow.get(ctx.params.workflowID).pipe(Effect.catchTag("Workflow.NotFoundError", notFound)),
          }
        }),
      )
      .handle(
        "workflow.history",
        Effect.fn(function* (ctx) {
          return yield* workflow
            .history({
              workflowID: ctx.params.workflowID,
              after: ctx.query.after,
              limit: ctx.query.limit ?? DefaultWorkflowHistoryLimit,
            })
            .pipe(
              Effect.map((page) => ({ data: page.events, hasMore: page.hasMore })),
              Effect.catchTag("Workflow.NotFoundError", notFound),
            )
        }),
      )
      .handle(
        "workflow.events",
        Effect.fn((ctx) =>
          workflow
            .get(ctx.params.workflowID)
            .pipe(
              Effect.as(
                workflow.events({ workflowID: ctx.params.workflowID, after: ctx.query.after }).pipe(Stream.orDie),
              ),
              Effect.catchTag("Workflow.NotFoundError", notFound),
            ),
        ),
      )
      .handle(
        "workflow.artifacts",
        Effect.fn(function* (ctx) {
          return {
            data: yield* workflow
              .artifacts(ctx.params.workflowID)
              .pipe(Effect.catchTag("Workflow.NotFoundError", notFound)),
          }
        }),
      )
      .handle(
        "workflow.cancel",
        Effect.fn(function* (ctx) {
          yield* workflow
            .cancel(ctx.params.workflowID)
            .pipe(
              Effect.catchTag("Workflow.NotFoundError", notFound),
              Effect.catchTag("Workflow.ConflictError", conflict),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "workflow.updateBudget",
        Effect.fn(function* (ctx) {
          return {
            data: yield* workflow
              .updateBudget({ workflowID: ctx.params.workflowID, budget: ctx.payload.budget })
              .pipe(
                Effect.catchTag("Workflow.NotFoundError", notFound),
                Effect.catchTag("Workflow.ConflictError", conflict),
                Effect.catchTag("Workflow.UnsafePersistenceError", unsafePersistence),
              ),
          }
        }),
      )
      .handle(
        "workflow.resolveRecovery",
        Effect.fn(function* (ctx) {
          yield* workflow
            .resolveRecovery({ ...ctx.params, action: ctx.payload.action })
            .pipe(
              Effect.catchTag("Workflow.NotFoundError", notFound),
              Effect.catchTag("Workflow.StageNotFoundError", stageNotFound),
              Effect.catchTag("Workflow.ConflictError", conflict),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
