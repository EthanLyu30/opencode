export * as WorkflowV2 from "./workflow"
export * from "./workflow/schema"

import { Cause, Context, Effect, Layer, Schema, Stream } from "effect"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { WorkflowDurable } from "@opencode-ai/schema/durable-event-manifest"
import { WorkflowStore } from "./workflow/store"
import { WorkflowBudget } from "./workflow/budget"
import { WorkflowSecretGuard } from "./workflow/secret-guard"
import { WorkflowExecution } from "./workflow/execution"
import { WorkflowModelExecution } from "./workflow/execution/model"
import { WorkflowProjector } from "./workflow/projector"
import { WorkflowRetry } from "./workflow/retry"
import { ResponsesV2 } from "./responses"
import { DateTime } from "effect"
import {
  ConflictError,
  matchesAdmissionInput,
  matchesCreateInput,
  prepare as prepareAdmission,
} from "./workflow/admission"

// ── Errors ────────────────────────────────────────────────────────────────────

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Workflow.NotFoundError", {
  workflowID: Workflow.ID,
}) {}

export class StageNotFoundError extends Schema.TaggedErrorClass<StageNotFoundError>()("Workflow.StageNotFoundError", {
  workflowID: Workflow.ID,
  stageID: Workflow.StageID,
}) {}

export { ConflictError }

export { WorkflowSecretGuard }

// ── Interface ─────────────────────────────────────────────────────────────────

export interface Interface {
  readonly admit: (
    input: Workflow.AdmissionInput,
  ) => Effect.Effect<Workflow.Info, WorkflowSecretGuard.UnsafePersistenceError | ConflictError>
  readonly create: (
    input: Workflow.CreateInput,
  ) => Effect.Effect<Workflow.Info, WorkflowSecretGuard.UnsafePersistenceError | ConflictError>
  readonly list: (input?: {
    readonly status?: Workflow.RunStatus
    readonly limit?: number
  }) => Effect.Effect<Workflow.Info[]>
  readonly get: (workflowID: Workflow.ID) => Effect.Effect<Workflow.Detail, NotFoundError>
  readonly events: (input: {
    readonly workflowID: Workflow.ID
    readonly after?: number
  }) => Stream.Stream<WorkflowEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    readonly workflowID: Workflow.ID
    readonly after?: number
    readonly limit: number
  }) => Effect.Effect<
    { readonly events: ReadonlyArray<WorkflowEvent.DurableEvent>; readonly hasMore: boolean },
    NotFoundError
  >
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

function guardSafe(value: unknown) {
  return Effect.try({
    try: () => WorkflowSecretGuard.assertSafe(value),
    catch: (error) =>
      error instanceof WorkflowSecretGuard.UnsafePersistenceError
        ? error
        : new WorkflowSecretGuard.UnsafePersistenceError({
            path: "$",
            message: "Persistence value could not be inspected safely",
          }),
  })
}

// ── Layer ─────────────────────────────────────────────────────────────────────

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const store = yield* WorkflowStore.Service
    const execution = yield* WorkflowExecution.Service
    const responses = yield* ResponsesV2.Service

    const activeResponses = (detail: Workflow.Detail) => responses.activeByWorkflowID(detail.run.id)

    const reconcileRecoveryPublish = <A>(
      effect: Effect.Effect<A>,
      input: {
        readonly workflowID: Workflow.ID
        readonly stageID: Workflow.StageID
        readonly action: "retry" | "fail"
      },
    ) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (!(Cause.squash(cause) instanceof WorkflowProjector.LifecycleConflict)) return Effect.failCause(cause)
          return store.get(input.workflowID).pipe(
            Effect.flatMap((current) => {
              const stage = current?.stages.find((candidate) => candidate.id === input.stageID)
              if (stage?.recoveryAction === input.action) return Effect.void
              if (stage?.recoveryAction !== undefined) {
                return Effect.fail(new ConflictError({ workflowID: input.workflowID, operation: "resolveRecovery" }))
              }
              return Effect.failCause(cause)
            }),
          )
        }),
      )

    const isDurableWorkflowEvent = Schema.is(WorkflowEvent.Durable)

    const create = Effect.fn("Workflow.create")(function* (
      input: Workflow.CreateInput,
      admission?: Pick<Workflow.AdmissionInput, "location" | "sessionID" | "agent">,
    ) {
      yield* guardSafe(input)

      const workflowID = input.id ?? Workflow.ID.create()
      const stages = [
        {
          ...input.stages[0],
          id: input.stages[0].id ?? Workflow.StageID.create(),
        },
        ...input.stages.slice(1).map((stage) => ({
          ...stage,
          id: stage.id ?? Workflow.StageID.create(),
        })),
      ] as const

      // Check if an exact byte-equivalent workflow already exists
      const existing = yield* store.get(workflowID)
      if (existing) {
        if (
          admission === undefined
            ? matchesCreateInput(existing, input)
            : matchesAdmissionInput(existing, { ...input, ...admission })
        ) {
          return existing.run
        }
        return yield* new ConflictError({ workflowID, operation: "create" })
      }

      const now = yield* DateTime.now
      const prepared = yield* Effect.try({
        try: () =>
          prepareAdmission(input, {
            workflowID,
            stages,
            timestamp: now,
            admission,
          }),
        catch: (error) =>
          error instanceof ConflictError ? error : new ConflictError({ workflowID, operation: "create" }),
      })

      yield* events.publish(prepared.entry.definition, prepared.entry.data)

      // Publish stage.queued events for audit visibility
      for (const queued of prepared.queued) {
        yield* events.publish(queued.definition, queued.data)
      }

      // Wake execution
      yield* execution.wake

      const detail = yield* store.get(workflowID)
      return detail!.run
    })

    return Service.of({
      admit: Effect.fn("Workflow.admit")(function* (input) {
        return yield* create(input, input)
      }),

      create,

      list: Effect.fn("Workflow.list")(function* (input) {
        return yield* store.list(input)
      }),

      get: Effect.fn("Workflow.get")(function* (workflowID) {
        const detail = yield* store.get(workflowID)
        if (!detail) return yield* new NotFoundError({ workflowID })
        return detail
      }),

      events: (input) =>
        Stream.unwrap(
          store
            .get(input.workflowID)
            .pipe(
              Effect.flatMap((detail) =>
                detail
                  ? Effect.succeed(
                      events
                        .durable({ aggregateID: input.workflowID, after: input.after })
                        .pipe(Stream.filter(isDurableWorkflowEvent)),
                    )
                  : Effect.fail(new NotFoundError({ workflowID: input.workflowID })),
              ),
            ),
        ),

      history: Effect.fn("Workflow.history")(function* (input) {
        const detail = yield* store.get(input.workflowID)
        if (!detail) return yield* new NotFoundError({ workflowID: input.workflowID })

        return yield* EventV2.readAggregate<WorkflowEvent.DurableEvent>(db, {
          aggregateID: input.workflowID,
          after: input.after,
          limit: input.limit,
          manifest: WorkflowDurable,
        })
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
          return yield* Effect.void
        }
        if (run.status === "cancelled") return yield* Effect.void
        if (run.status === "succeeded" || run.status === "failed") {
          return yield* new ConflictError({ workflowID, operation: "cancel" })
        }

        const now = yield* DateTime.now
        const active = yield* activeResponses(detail)
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* events
              .publish(
                WorkflowEvent.CancelRequested,
                {
                  workflowID,
                  timestamp: now,
                },
                {
                  related: active.map((response) => ({
                    definition: ResponseEvent.Cancelled,
                    data: { responseID: response.id, timestamp: now },
                  })),
                },
              )
              .pipe(
                Effect.catchCause((cause) => {
                  if (!(Cause.squash(cause) instanceof WorkflowProjector.LifecycleConflict)) {
                    return Effect.failCause(cause)
                  }
                  return store.get(workflowID).pipe(
                    Effect.flatMap((latest) => {
                      if (latest?.run.cancelRequestedAt !== undefined) return Effect.void
                      if (latest?.run.status === "succeeded" || latest?.run.status === "failed") {
                        return Effect.fail(new ConflictError({ workflowID, operation: "cancel" }))
                      }
                      return Effect.failCause(cause)
                    }),
                  )
                }),
              )
            yield* Effect.forEach(
              active.filter((response) => !response.store),
              (response) =>
                responses.settleTransient({
                  responseID: response.id,
                  requestHash: response.requestHash,
                  status: "cancelled",
                  timestamp: now,
                }),
              { discard: true },
            )
          }),
        )
        yield* execution.interrupt(workflowID)
        return yield* Effect.void
      }),

      updateBudget: Effect.fn("Workflow.updateBudget")(function* (input) {
        yield* guardSafe(input.budget)

        const detail = yield* store.get(input.workflowID)
        if (!detail) return yield* new NotFoundError({ workflowID: input.workflowID })

        if (detail.run.status === "succeeded" || detail.run.status === "failed" || detail.run.status === "cancelled") {
          return yield* new ConflictError({ workflowID: input.workflowID, operation: "updateBudget" })
        }

        const now = yield* DateTime.now
        if (
          !WorkflowBudget.validateIncrease({
            current: detail.run.budget,
            next: input.budget,
            usage: detail.run.usage,
            elapsedMs: DateTime.toEpochMillis(now) - DateTime.toEpochMillis(detail.run.time.created),
          })
        ) {
          return yield* new ConflictError({ workflowID: input.workflowID, operation: "updateBudget" })
        }

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

        // Idempotent: same action already applied
        if (stage.recoveryAction === input.action) return yield* Effect.void

        if (stage.status !== "waiting_approval") {
          return yield* new ConflictError({ workflowID: input.workflowID, operation: "resolveRecovery" })
        }

        const checkpoint =
          input.action === "fail"
            ? yield* WorkflowModelExecution.checkpointState(stage.checkpoint).pipe(
                Effect.mapError(
                  () => new ConflictError({ workflowID: input.workflowID, operation: "resolveRecovery" }),
                ),
              )
            : {
                usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
                providerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              }
        const unsettledUsage = WorkflowRetry.usageDelta(checkpoint.usage, {
          tokens: 0,
          turns: 0,
          toolCalls: 0,
          attempts: 0,
        })
        const now = yield* DateTime.now
        if (input.action === "retry") {
          yield* reconcileRecoveryPublish(
            events.publish(
              WorkflowEvent.Approval.Resolved,
              {
                workflowID: input.workflowID,
                stageID: input.stageID,
                timestamp: now,
                action: input.action,
              },
              {
                related: [
                  {
                    definition: WorkflowEvent.Stage.RetryScheduled,
                    data: {
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
                    },
                  },
                ],
              },
            ),
            input,
          )
          yield* execution.wake
        } else {
          // Fail the stage
          const stageFailure: Workflow.Failure = {
            category: "ambiguous",
            code: "recovery_fail",
            message: "Explicit recovery failure",
          }
          const workflowFailure: Workflow.Failure = {
            category: "ambiguous",
            code: "recovery_fail",
            message: "Workflow failed via recovery resolution",
          }
          const active = yield* activeResponses(detail)
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* reconcileRecoveryPublish(
                events.publish(
                  WorkflowEvent.Approval.Resolved,
                  {
                    workflowID: input.workflowID,
                    stageID: input.stageID,
                    timestamp: now,
                    action: input.action,
                  },
                  {
                    related: [
                      {
                        definition: WorkflowEvent.Stage.Failed,
                        data: {
                          workflowID: input.workflowID,
                          stageID: input.stageID,
                          timestamp: now,
                          attempt: stage.attempt,
                          leaseOwner: stage.leaseOwner,
                          failure: stageFailure,
                          usage: unsettledUsage,
                          source: "recovery",
                        },
                      },
                      {
                        definition: WorkflowEvent.Failed,
                        data: {
                          workflowID: input.workflowID,
                          timestamp: now,
                          failure: workflowFailure,
                          usage: WorkflowRetry.addUsage(detail.run.usage, unsettledUsage),
                        },
                      },
                      ...active.map((response) => ({
                        definition: ResponseEvent.Failed,
                        data: {
                          responseID: response.id,
                          timestamp: now,
                          error: response.store
                            ? {
                                type: workflowFailure.category,
                                code: workflowFailure.code,
                                message: workflowFailure.message,
                              }
                            : undefined,
                          usage:
                            response.store && response.id === checkpoint.responseID
                              ? checkpoint.providerUsage
                              : undefined,
                        },
                      })),
                    ],
                  },
                ),
                input,
              )
              yield* Effect.forEach(
                active.filter((response) => !response.store),
                (response) =>
                  responses.settleTransient({
                    responseID: response.id,
                    requestHash: response.requestHash,
                    status: "failed",
                    timestamp: now,
                    error: {
                      type: workflowFailure.category,
                      code: workflowFailure.code,
                      message: workflowFailure.message,
                    },
                    usage: response.id === checkpoint.responseID ? checkpoint.providerUsage : undefined,
                  }),
                { discard: true },
              )
            }),
          )
        }
        return yield* Effect.void
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventV2.node,
    WorkflowProjector.node,
    WorkflowStore.node,
    WorkflowExecution.node,
    ResponsesV2.node,
  ],
})
