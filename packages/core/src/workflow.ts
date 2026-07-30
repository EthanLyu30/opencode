export * as WorkflowV2 from "./workflow"

import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { WorkflowDurable } from "@opencode-ai/schema/durable-event-manifest"
import { WorkflowStore } from "./store"
import { WorkflowSecretGuard } from "./secret-guard"
import { WorkflowExecution } from "./execution"
import { WorkflowProjector } from "./projector"
import { eq as dEq } from "drizzle-orm"
import { WorkflowRunTable } from "./sql"
import { DateTime } from "effect"

// ── Errors ────────────────────────────────────────────────────────────────────

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Workflow.NotFoundError", {
  workflowID: Workflow.ID,
}) {}

export class StageNotFoundError extends Schema.TaggedErrorClass<StageNotFoundError>()("Workflow.StageNotFoundError", {
  workflowID: Workflow.ID,
  stageID: Workflow.StageID,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("Workflow.ConflictError", {
  workflowID: Workflow.ID,
  operation: Schema.String,
}) {}

export { WorkflowSecretGuard }

// ── Interface ─────────────────────────────────────────────────────────────────

export interface Interface {
  readonly create: (input: Workflow.CreateInput) => Effect.Effect<
    Workflow.Info,
    WorkflowSecretGuard.UnsafePersistenceError | ConflictError
  >
  readonly list: (input?: { readonly status?: Workflow.RunStatus; readonly limit?: number }) => Effect.Effect<Workflow.Info[]>
  readonly get: (workflowID: Workflow.ID) => Effect.Effect<Workflow.Detail, NotFoundError>
  readonly events: (input: {
    readonly workflowID: Workflow.ID
    readonly after?: number
  }) => Stream.Stream<WorkflowEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    readonly workflowID: Workflow.ID
    readonly after?: number
    readonly limit: number
  }) => Effect.Effect<{ readonly events: ReadonlyArray<WorkflowEvent.DurableEvent>; readonly hasMore: boolean }, NotFoundError>
  readonly artifacts: (workflowID: Workflow.ID) => Effect.Effect<ReadonlyArray<Workflow.Artifact>, NotFoundError>
  readonly cancel: (workflowID: Workflow.ID) => Effect.Effect<void, NotFoundError | ConflictError>
  readonly updateBudget: (input: {
    readonly workflowID: Workflow.ID
    readonly budget: Workflow.Budget
  }) => Effect.Effect<Workflow.Info, NotFoundError | ConflictError | WorkflowSecretGuard.UnsafePersistenceError>
  readonly resolveRecovery: (input: {
    readonly workflowID: Workflow.ID
    readonly stageID: Workflow.StageID
    readonly action: "retry" | "fail"
  }) => Effect.Effect<void, NotFoundError | StageNotFoundError | ConflictError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Workflow") {}

// ── Layer ─────────────────────────────────────────────────────────────────────

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const store = yield* WorkflowStore.Service
    const execution = yield* WorkflowExecution.Service

    const isDurableWorkflowEvent = Schema.is(WorkflowEvent.Durable)

    return Service.of({
      create: Effect.fn("Workflow.create")(function* (input) {
        // Secret guard
        WorkflowSecretGuard.assertSafe(input.input)
        WorkflowSecretGuard.assertSafe(input.budget)
        for (const stage of input.stages) {
          WorkflowSecretGuard.assertSafe(stage.input)
        }

        const workflowID = input.id ?? Workflow.ID.create()
        const stages = input.stages.map((stage) => ({
          ...stage,
          id: stage.id ?? Workflow.StageID.create(),
        }))

        // Validate unique ordinals and idempotency keys
        const ordinals = new Set<number>()
        const keys = new Set<string>()
        for (const stage of stages) {
          if (ordinals.has(stage.ordinal)) {
            return yield* new ConflictError({ workflowID, operation: "create" })
          }
          ordinals.add(stage.ordinal)
          if (keys.has(stage.idempotencyKey)) {
            return yield* new ConflictError({ workflowID, operation: "create" })
          }
          keys.add(stage.idempotencyKey)
        }

        const now = yield* DateTime.now
        const timestamp = DateTime.toEpochMillis(now)

        // Check if an exact byte-equivalent workflow already exists
        const existing = yield* store.get(workflowID)
        if (existing) {
          // Idempotent retry: return existing if input matches
          const sameInput = JSON.stringify(existing.run.input) === JSON.stringify(input.input)
            && JSON.stringify(existing.run.budget) === JSON.stringify(input.budget)
            && existing.stages.length === stages.length
          if (sameInput) return existing.run
          return yield* new ConflictError({ workflowID, operation: "create" })
        }

        yield* events.publish(WorkflowEvent.Created, {
          workflowID,
          timestamp: DateTime.makeUnsafe(timestamp),
          type: input.type,
          input: input.input,
          budget: input.budget,
          stages,
        })

        // Publish stage.queued events for audit visibility
        for (const stage of stages) {
          yield* events.publish(WorkflowEvent.Stage.Queued, {
            workflowID,
            stageID: stage.id,
            timestamp: DateTime.makeUnsafe(timestamp),
          })
        }

        // Wake execution
        yield* execution.wake

        const detail = yield* store.get(workflowID)
        return detail!.run
      }),

      list: Effect.fn("Workflow.list")(function* (input) {
        return yield* store.list(input)
      }),

      get: Effect.fn("Workflow.get")(function* (workflowID) {
        const detail = yield* store.get(workflowID)
        if (!detail) return yield* new NotFoundError({ workflowID })
        return detail
      }),

      events: Effect.fn("Workflow.events")(function* (input) {
        // Verify workflow exists
        const detail = yield* store.get(input.workflowID)
        if (!detail) return yield* new NotFoundError({ workflowID: input.workflowID })

        return events.durable({ aggregateID: input.workflowID, after: input.after }).pipe(
          Stream.filter(isDurableWorkflowEvent),
        )
      }),

      history: Effect.fn("Workflow.history")(function* (input) {
        const detail = yield* store.get(input.workflowID)
        if (!detail) return yield* new NotFoundError({ workflowID: input.workflowID })

        return yield* EventV2.readAggregate(db, {
          aggregateID: input.workflowID,
          after: input.after,
          limit: input.limit,
          manifest: WorkflowDurable,
        }) as Effect.Effect<{ events: ReadonlyArray<WorkflowEvent.DurableEvent>; hasMore: boolean }>
      }),

      artifacts: Effect.fn("Workflow.artifacts")(function* (workflowID) {
        const detail = yield* store.get(workflowID)
        if (!detail) return yield* new NotFoundError({ workflowID })
        return yield* store.artifacts(workflowID)
      }),

      cancel: Effect.fn("Workflow.cancel")(function* (workflowID) {
        const detail = yield* store.get(workflowID)
        if (!detail) return yield* new NotFoundError({ workflowID })

        const run = detail.run

        if (run.cancelRequestedAt !== undefined) {
          yield* execution.interrupt(workflowID)
          return
        }
        if (run.status === "cancelled") return
        if (run.status === "succeeded" || run.status === "failed") {
          return yield* new ConflictError({ workflowID, operation: "cancel" })
        }

        const now = yield* DateTime.now
        yield* events.publish(WorkflowEvent.CancelRequested, {
          workflowID,
          timestamp: now,
        })
        yield* execution.interrupt(workflowID)
      }),

      updateBudget: Effect.fn("Workflow.updateBudget")(function* (input) {
        WorkflowSecretGuard.assertSafe(input.budget)

        const detail = yield* store.get(input.workflowID)
        if (!detail) return yield* new NotFoundError({ workflowID: input.workflowID })

        // Validate monotonic: no existing limit removed or decreased
        const current = detail.run.budget
        for (const key of ["maxTokens", "maxTurns", "maxToolCalls", "maxAttempts", "maxDurationMs"] as const) {
          const nextVal = input.budget[key]
          const curVal = current[key]
          if (curVal !== undefined && (nextVal === undefined || nextVal < curVal)) {
            return yield* new ConflictError({ workflowID: input.workflowID, operation: "updateBudget" })
          }
        }

        const now = yield* DateTime.now
        yield* events.publish(WorkflowEvent.Budget.Updated, {
          workflowID: input.workflowID,
          timestamp: now,
          budget: input.budget,
        })

        const updated = yield* store.get(input.workflowID)
        yield* execution.wake
        return updated!.run
      }),

      resolveRecovery: Effect.fn("Workflow.resolveRecovery")(function* (input) {
        const detail = yield* store.get(input.workflowID)
        if (!detail) return yield* new NotFoundError({ workflowID: input.workflowID })

        const stage = detail.stages.find((s) => s.id === input.stageID)
        if (!stage) return yield* new StageNotFoundError({ workflowID: input.workflowID, stageID: input.stageID })

        if (stage.status !== "waiting_approval") {
          return yield* new ConflictError({ workflowID: input.workflowID, operation: "resolveRecovery" })
        }

        // Idempotent: same action already applied
        if (stage.recoveryAction === input.action) return

        const now = yield* DateTime.now
        yield* events.publish(WorkflowEvent.Approval.Resolved, {
          workflowID: input.workflowID,
          stageID: input.stageID,
          timestamp: now,
          action: input.action,
        })

        if (input.action === "retry") {
          // Transition to retry_wait so the stage can be claimed again
          yield* events.publish(WorkflowEvent.Stage.RetryScheduled, {
            workflowID: input.workflowID,
            stageID: input.stageID,
            timestamp: now,
            attempt: stage.attempt,
            leaseOwner: stage.leaseOwner,
            failure: {
              category: "ambiguous",
              code: "recovery_retry",
              message: "Explicit recovery retry",
            },
            usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
            notBefore: now,
          })
          yield* execution.wake
        } else {
          // Fail the stage
          yield* events.publish(WorkflowEvent.Stage.Failed, {
            workflowID: input.workflowID,
            stageID: input.stageID,
            timestamp: now,
            attempt: stage.attempt,
            leaseOwner: stage.leaseOwner,
            failure: {
              category: "ambiguous",
              code: "recovery_fail",
              message: "Explicit recovery failure",
            },
            usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
            source: "recovery",
          })
          yield* events.publish(WorkflowEvent.Failed, {
            workflowID: input.workflowID,
            timestamp: now,
            failure: {
              category: "ambiguous",
              code: "recovery_fail",
              message: "Workflow failed via recovery resolution",
            },
            usage: detail.run.usage,
          })
        }
      }),
    })
  }),
)

export const node = makeGlobalNode({
  name: "workflow",
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, WorkflowStore.node, WorkflowExecution.node],
})
