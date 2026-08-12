export * as WorkflowExecutionLocal from "./local"

import { and, inArray, isNotNull } from "drizzle-orm"
import { Cause, Data, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, PubSub, Semaphore, Stream } from "effect"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Database } from "../../database/database"
import { makeGlobalNode } from "../../effect/app-node"
import { EventV2 } from "../../event"
import { ResponsesV2 } from "../../responses"
import { WorkflowExecution } from "../execution"
import { WorkflowExecutor, type ExecutionFailure } from "../executor"
import { WorkflowProjector } from "../projector"
import { WorkflowRetry } from "../retry"
import { WorkflowSecretGuard } from "../secret-guard"
import { WorkflowRunTable } from "../sql"
import { WorkflowState } from "../state"
import { WorkflowStageMachine } from "../stage-machine"
import { WorkflowStore } from "../store"

class CancelRequested extends Data.TaggedError("CancelRequested")<{
  readonly workflowID: Workflow.ID
}> {}

export interface Options {
  readonly ownerID: string
  readonly leaseDurationMs: number
  readonly heartbeatIntervalMs: number
  readonly pollIntervalMs: number
  readonly concurrency: number
}

export const defaults: Options = {
  ownerID: `worker_${crypto.randomUUID()}`,
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 250,
  concurrency: 2,
}

const MAX_CHECKPOINT_BYTES = 256 * 1024

export const layerWith = (options: Options) =>
  Layer.effect(
    WorkflowExecution.Service,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const executor = yield* WorkflowExecutor.Service
      const store = yield* WorkflowStore.Service
      const db = (yield* Database.Service).db
      const wake = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown)
      const fibers = new Map<Workflow.ID, Set<Fiber.Fiber<void>>>()
      const slots = yield* Semaphore.make(options.concurrency)

      const hasCapacity = () => {
        let active = 0
        for (const set of fibers.values()) active += set.size
        return active < options.concurrency
      }

      const currentLease = Effect.fnUntraced(function* (stage: Workflow.Stage, now: number) {
        const detail = yield* store.get(stage.workflowID)
        const current = detail?.stages.find((item) => item.id === stage.id)
        if (!detail || !current || detail.run.cancelRequestedAt !== undefined) return undefined
        if (
          current.attempt !== stage.attempt ||
          current.leaseOwner !== options.ownerID ||
          current.leaseExpiresAt === undefined ||
          DateTime.toEpochMillis(current.leaseExpiresAt) < now ||
          (current.status !== "leased" && current.status !== "running")
        ) {
          return undefined
        }
        return detail
      })

      const ensureNotCancelled = Effect.fnUntraced(function* (workflowID: Workflow.ID) {
        const detail = yield* store.get(workflowID)
        if (detail?.run.cancelRequestedAt === undefined) return
        yield* new CancelRequested({ workflowID })
      })

      const activeResponses = (detail: Workflow.Detail) => responses.activeByWorkflowID(detail.run.id)

      const settleStageCancellation = Effect.fnUntraced(function* (
        stage: Workflow.Stage,
        source: "execution" | "request",
      ) {
        const detail = yield* store.get(stage.workflowID)
        const current = detail?.stages.find((item) => item.id === stage.id)
        if (
          !detail ||
          detail.run.cancelRequestedAt === undefined ||
          !current ||
          WorkflowState.isTerminal(current.status)
        ) {
          return
        }

        if (source === "execution") {
          const now = DateTime.toEpochMillis(yield* DateTime.now)
          if (
            current.attempt !== stage.attempt ||
            current.leaseOwner !== options.ownerID ||
            current.leaseExpiresAt === undefined ||
            DateTime.toEpochMillis(current.leaseExpiresAt) < now ||
            (current.status !== "leased" && current.status !== "running")
          ) {
            return
          }
        }

        yield* events
          .publish(WorkflowEvent.Stage.Cancelled, {
            workflowID: stage.workflowID,
            stageID: stage.id,
            timestamp: yield* DateTime.now,
            attempt: source === "execution" ? stage.attempt : current.attempt,
            leaseOwner: source === "execution" ? options.ownerID : current.leaseOwner,
            source,
          })
          .pipe(
            Effect.catchCause((cause) => {
              if (!(Cause.squash(cause) instanceof WorkflowProjector.LifecycleConflict)) {
                return Effect.failCause(cause)
              }
              return store
                .get(stage.workflowID)
                .pipe(
                  Effect.flatMap((latest) =>
                    latest?.stages.some((item) => item.id === stage.id && WorkflowState.isTerminal(item.status))
                      ? Effect.void
                      : Effect.failCause(cause),
                  ),
                )
            }),
          )
      })

      const settleCancellation = Effect.fnUntraced(function* (workflowID: Workflow.ID) {
        const detail = yield* store.get(workflowID)
        if (
          !detail ||
          detail.run.cancelRequestedAt === undefined ||
          detail.run.status === "succeeded" ||
          detail.run.status === "failed" ||
          detail.run.status === "cancelled"
        ) {
          return
        }

        yield* Effect.forEach(
          detail.stages.filter((stage) => !WorkflowState.isTerminal(stage.status)),
          (stage) => settleStageCancellation(stage, "request"),
          { concurrency: 1, discard: true },
        )

        const settled = yield* store.get(workflowID)
        if (!settled || settled.stages.some((stage) => !WorkflowState.isTerminal(stage.status))) return
        const active = yield* activeResponses(settled)
        const timestamp = yield* DateTime.now
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* events
              .publish(
                WorkflowEvent.Cancelled,
                {
                  workflowID,
                  timestamp,
                },
                {
                  related: active.map((response) => ({
                    definition: ResponseEvent.Cancelled,
                    data: { responseID: response.id, timestamp },
                  })),
                },
              )
              .pipe(
                Effect.catchCause((cause) => {
                  if (!(Cause.squash(cause) instanceof WorkflowProjector.LifecycleConflict)) {
                    return Effect.failCause(cause)
                  }
                  return store
                    .get(workflowID)
                    .pipe(
                      Effect.flatMap((latest) =>
                        latest?.run.status === "cancelled" ? Effect.void : Effect.failCause(cause),
                      ),
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
                  timestamp,
                }),
              { discard: true },
            )
          }),
        )
      })

      const settlePersistedCancellations = Effect.gen(function* () {
        const runs = yield* db
          .select({ id: WorkflowRunTable.id })
          .from(WorkflowRunTable)
          .where(
            and(
              isNotNull(WorkflowRunTable.cancel_requested_at),
              inArray(WorkflowRunTable.status, ["queued", "running", "waiting_approval"]),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        yield* Effect.forEach(runs, (run) => (fibers.has(run.id) ? Effect.void : settleCancellation(run.id)), {
          concurrency: 1,
          discard: true,
        })
      })

      const settleExpiredLeases = Effect.gen(function* () {
        const now = yield* DateTime.now
        const expired = yield* store.expired(DateTime.toEpochMillis(now))
        yield* Effect.forEach(
          expired,
          (stage) =>
            Effect.gen(function* () {
              const detail = yield* store.get(stage.workflowID)
              const current = detail?.stages.find((item) => item.id === stage.id)
              if (!detail || !current || detail.run.cancelRequestedAt !== undefined) {
                if (detail?.run.cancelRequestedAt !== undefined) yield* settleCancellation(stage.workflowID)
                return
              }
              if (
                current.attempt !== stage.attempt ||
                current.leaseOwner !== stage.leaseOwner ||
                current.status !== stage.status ||
                current.leaseExpiresAt === undefined ||
                DateTime.toEpochMillis(current.leaseExpiresAt) >= DateTime.toEpochMillis(now)
              ) {
                return
              }

              if (current.recoveryPolicy === "restart_safe" && current.attempt < current.maxAttempts) {
                yield* events.publish(WorkflowEvent.Stage.RetryScheduled, {
                  workflowID: current.workflowID,
                  stageID: current.id,
                  timestamp: now,
                  attempt: current.attempt,
                  leaseOwner: current.leaseOwner,
                  failure: {
                    category: "transient",
                    code: "lease_expired",
                    message: "The previous worker lease expired before settlement.",
                  },
                  usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
                  notBefore: now,
                })
                return
              }

              yield* events.publish(WorkflowEvent.Approval.Requested, {
                workflowID: current.workflowID,
                stageID: current.id,
                timestamp: now,
                reason: "ambiguous_execution",
                failure: {
                  category: "ambiguous",
                  code: current.attempt >= current.maxAttempts ? "max_attempts_exhausted" : "lease_expired",
                  message:
                    current.attempt >= current.maxAttempts
                      ? "The stage exhausted its maximum attempts after the worker lease expired."
                      : "Execution may have produced side effects before the worker lease expired.",
                },
                usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
              })
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.squash(cause) instanceof WorkflowProjector.LifecycleConflict
                  ? Effect.void
                  : Effect.failCause(cause),
              ),
            ),
          { concurrency: 1, discard: true },
        )
      })

      const heartbeat = Effect.fnUntraced(function* (stage: Workflow.Stage) {
        while (true) {
          yield* Effect.sleep(options.heartbeatIntervalMs)
          const now = DateTime.toEpochMillis(yield* DateTime.now)
          const renewed = yield* store.renew({
            stageID: stage.id,
            owner: options.ownerID,
            attempt: stage.attempt,
            now,
            expiresAt: now + options.leaseDurationMs,
          })
          if (!renewed) return
        }
      })

      const runStage = Effect.fnUntraced(function* (stage: Workflow.Stage) {
        if (stage.leaseExpiresAt === undefined || stage.leaseOwner !== options.ownerID) return
        const initial = yield* store.get(stage.workflowID)
        if (!initial) return
        yield* ensureNotCancelled(stage.workflowID)

        if (initial.run.status === "queued") {
          yield* events.publish(WorkflowEvent.Started, {
            workflowID: stage.workflowID,
            timestamp: yield* DateTime.now,
          })
        }

        yield* events.publish(WorkflowEvent.Stage.Started, {
          workflowID: stage.workflowID,
          stageID: stage.id,
          timestamp: yield* DateTime.now,
          attempt: stage.attempt,
          leaseOwner: options.ownerID,
        })

        yield* ensureNotCancelled(stage.workflowID)

        const executionStartedAt = DateTime.toEpochMillis(yield* DateTime.now)
        const remainingDurationMs =
          initial.run.budget.maxDurationMs === undefined
            ? undefined
            : Math.max(
                0,
                initial.run.budget.maxDurationMs -
                  (executionStartedAt - DateTime.toEpochMillis(initial.run.time.created)),
              )
        const saveCheckpoint: WorkflowExecutor.ExecutionInput["saveCheckpoint"] = (checkpoint) =>
          Effect.gen(function* () {
            const encoded = yield* Effect.try({
              try: () => {
                WorkflowSecretGuard.assertSafe(checkpoint)
                return JSON.stringify(checkpoint)
              },
              catch: () => checkpointFailure("unsafe_checkpoint", "Workflow checkpoint is not safe to persist"),
            })
            if (Buffer.byteLength(encoded) > MAX_CHECKPOINT_BYTES) {
              return yield* Effect.fail(
                checkpointFailure("checkpoint_too_large", "Workflow checkpoint exceeds the 256 KiB limit"),
              )
            }
            yield* ensureNotCancelled(stage.workflowID).pipe(
              Effect.mapError(() =>
                checkpointFailure("checkpoint_cancelled", "Workflow cancellation fenced checkpoint"),
              ),
            )
            const timestamp = yield* DateTime.now
            if (!(yield* currentLease(stage, DateTime.toEpochMillis(timestamp)))) {
              return yield* Effect.fail(
                checkpointFailure("stale_checkpoint_lease", "Workflow lease no longer owns checkpoint persistence"),
              )
            }
            const published = yield* events
              .publish(WorkflowEvent.Stage.Checkpointed, {
                workflowID: stage.workflowID,
                stageID: stage.id,
                timestamp,
                attempt: stage.attempt,
                leaseOwner: options.ownerID,
                checkpoint,
              })
              .pipe(Effect.exit)
            if (Exit.isFailure(published)) {
              return yield* Effect.fail(
                checkpointFailure("stale_checkpoint_lease", "Workflow checkpoint lost its fenced lease"),
              )
            }
          })

        const execution = executor.execute({
          workflow: initial.run,
          stage,
          stages: initial.stages,
          artifacts: initial.artifacts,
          remainingDurationMs,
          lease: {
            owner: options.ownerID,
            attempt: stage.attempt,
            expiresAt: stage.leaseExpiresAt,
          },
          saveCheckpoint,
        })

        const outcome = yield* Effect.raceFirst(
          (remainingDurationMs === undefined
            ? execution
            : execution.pipe(
                Effect.timeoutOrElse({
                  duration: remainingDurationMs,
                  orElse: () =>
                    Effect.fail<ExecutionFailure>({
                      failure: {
                        category: "transient" as const,
                        code: "workflow_deadline",
                        message: "Workflow duration budget elapsed",
                      },
                      usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
                    }),
                }),
              )
          ).pipe(
            Effect.exit,
            Effect.map((exit) => ({ type: "execution" as const, exit })),
          ),
          heartbeat(stage).pipe(Effect.as({ type: "lease_lost" as const })),
        )
        if (outcome.type === "lease_lost") return
        if (Exit.isFailure(outcome.exit)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(outcome.exit.cause))
          if (!error) {
            yield* Effect.failCause(outcome.exit.cause)
            return
          }

          const completedAt = yield* DateTime.now
          yield* ensureNotCancelled(stage.workflowID)
          if (!(yield* currentLease(stage, DateTime.toEpochMillis(completedAt)))) return
          const failure = WorkflowSecretGuard.sanitizeFailure(error.failure)
          const decision = WorkflowRetry.decide({
            failure,
            attempt: stage.attempt,
            maxAttempts: stage.maxAttempts,
            now: DateTime.toEpochMillis(completedAt),
            randomUnit: Math.random(),
          })

          if (decision.type === "retry") {
            yield* events.publish(WorkflowEvent.Stage.RetryScheduled, {
              workflowID: stage.workflowID,
              stageID: stage.id,
              timestamp: completedAt,
              attempt: stage.attempt,
              leaseOwner: options.ownerID,
              failure,
              usage: error.usage,
              notBefore: DateTime.makeUnsafe(decision.notBefore),
            })
            if (
              !(yield* store.gateBudget({
                workflowID: stage.workflowID,
                now: DateTime.toEpochMillis(completedAt),
              }))
            ) {
              yield* PubSub.publish(wake, undefined)
            }
            return
          }

          if (decision.type === "approval") {
            yield* events.publish(WorkflowEvent.Approval.Requested, {
              workflowID: stage.workflowID,
              stageID: stage.id,
              timestamp: completedAt,
              reason: "ambiguous_execution",
              failure,
              usage: error.usage,
            })
            yield* store.gateBudget({
              workflowID: stage.workflowID,
              now: DateTime.toEpochMillis(completedAt),
            })
            return
          }

          const active = yield* activeResponses(initial)
          const responseSettlements = active.map((response) =>
            error.responseSettlement?.responseID === response.id
              ? { ...error.responseSettlement, requestHash: response.requestHash }
              : {
                  type: "failed" as const,
                  responseID: response.id,
                  requestHash: response.requestHash,
                  error: { type: failure.category, code: failure.code, message: failure.message },
                  store: response.store,
                },
          )
          const responseRelated: Array<{ definition: EventV2.Definition; data: unknown }> = []
          for (const settlement of responseSettlements) {
            if (settlement.type === "incomplete") {
              responseRelated.push({
                definition: ResponseEvent.Incomplete,
                data: {
                  responseID: settlement.responseID,
                  timestamp: completedAt,
                  output: settlement.store ? settlement.output : undefined,
                  error: settlement.store ? settlement.error : undefined,
                  usage: settlement.store ? settlement.usage : undefined,
                },
              })
              if (settlement.store && settlement.conversationID !== undefined) {
                for (const payload of settlement.output) {
                  responseRelated.push({
                    definition: ResponseEvent.Conversation.ItemAdded,
                    data: {
                      conversationID: settlement.conversationID,
                      timestamp: completedAt,
                      responseID: settlement.responseID,
                      payload,
                    },
                  })
                }
              }
            } else {
              responseRelated.push({
                definition: ResponseEvent.Failed,
                data: {
                  responseID: settlement.responseID,
                  timestamp: completedAt,
                  error: settlement.store ? settlement.error : undefined,
                  usage: settlement.store ? settlement.usage : undefined,
                },
              })
            }
          }

          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* events.publish(
                WorkflowEvent.Stage.Failed,
                {
                  workflowID: stage.workflowID,
                  stageID: stage.id,
                  timestamp: completedAt,
                  attempt: stage.attempt,
                  leaseOwner: options.ownerID,
                  failure,
                  usage: error.usage,
                  source: "execution",
                },
                {
                  related: [
                    {
                      definition: WorkflowEvent.Failed,
                      data: {
                        workflowID: stage.workflowID,
                        timestamp: completedAt,
                        failure,
                        usage: addUsage(initial.run.usage, error.usage),
                      },
                    },
                    ...responseRelated,
                  ],
                },
              )
              yield* Effect.forEach(
                responseSettlements.filter((settlement) => !settlement.store),
                (settlement) =>
                  responses.settleTransient({
                    responseID: settlement.responseID,
                    requestHash: settlement.requestHash,
                    status: settlement.type === "incomplete" ? "incomplete" : "failed",
                    timestamp: completedAt,
                    ...(settlement.type === "incomplete" ? { output: settlement.output } : {}),
                    error: settlement.error,
                    usage: settlement.usage,
                  }),
                { discard: true },
              )
            }),
          )
          return
        }

        const executionResult = outcome.exit.value
        const committedArtifacts = [] as Workflow.Artifact[]
        for (const commit of executionResult.artifacts ?? []) {
          yield* ensureNotCancelled(stage.workflowID)
          const now = yield* DateTime.now
          if (!(yield* currentLease(stage, DateTime.toEpochMillis(now)))) return
          WorkflowSecretGuard.assertSafe(commit)
          committedArtifacts.push(
            Workflow.Artifact.make({
              id: Workflow.ArtifactID.create(),
              workflowID: stage.workflowID,
              stageID: stage.id,
              ...commit,
              timeCreated: now,
            }),
          )
        }

        const storedCompletionCandidate = yield* store.get(stage.workflowID)
        const completionCandidate =
          storedCompletionCandidate === undefined
            ? undefined
            : {
                ...storedCompletionCandidate,
                artifacts: [...storedCompletionCandidate.artifacts, ...committedArtifacts],
              }
        if (
          completionCandidate &&
          completionCandidate.stages.every(
            (item) => item.id === stage.id || item.status === "succeeded" || item.status === "skipped",
          ) &&
          completionCandidate.artifacts.some((artifact) => artifact.kind === WorkflowStageMachine.OUTCOME_ARTIFACT_KIND)
        ) {
          const completion = yield* WorkflowStageMachine.replay({
            stages: completionCandidate.stages,
            artifacts: completionCandidate.artifacts,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ type: "invalid" as const, error }),
              onSuccess: (state) => ({ type: "state" as const, state }),
            }),
          )
          let failure: Workflow.Failure | undefined
          if (completion.type === "invalid") {
            failure = {
              category: "schema",
              code: "invalid_role_history",
              message: `Role workflow history is invalid: ${completion.error.code}`,
            }
          } else if (completion.state.status === "active") {
            failure = {
              category: "invalid_request",
              code: "incomplete_role_workflow",
              message: `Role workflow stopped before ${completion.state.role}`,
            }
          }
          if (failure) {
            const failedAt = yield* DateTime.now
            yield* ensureNotCancelled(stage.workflowID)
            if (!(yield* currentLease(stage, DateTime.toEpochMillis(failedAt)))) return
            const active = yield* activeResponses(completionCandidate)
            const outcomeSettlement = executionResult.responseSettlement
            const responseSettlements = active.map((response) => {
              return {
                responseID: response.id,
                requestHash: response.requestHash,
                store: response.store,
                error: { type: failure.category, code: failure.code, message: failure.message },
                usage: outcomeSettlement?.responseID === response.id ? outcomeSettlement.usage : undefined,
              }
            })
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* events.publish(
                  WorkflowEvent.Stage.Failed,
                  {
                    workflowID: stage.workflowID,
                    stageID: stage.id,
                    timestamp: failedAt,
                    attempt: stage.attempt,
                    leaseOwner: options.ownerID,
                    failure,
                    usage: executionResult.usage,
                    source: "execution",
                  },
                  {
                    related: [
                      {
                        definition: WorkflowEvent.Failed,
                        data: {
                          workflowID: stage.workflowID,
                          timestamp: failedAt,
                          failure,
                          usage: addUsage(initial.run.usage, executionResult.usage),
                        },
                      },
                      ...responseSettlements.map((settlement) => ({
                        definition: ResponseEvent.Failed,
                        data: {
                          responseID: settlement.responseID,
                          timestamp: failedAt,
                          error: settlement.store ? settlement.error : undefined,
                          usage: settlement.store ? settlement.usage : undefined,
                        },
                      })),
                    ],
                  },
                )
                yield* Effect.forEach(
                  responseSettlements.filter((settlement) => !settlement.store),
                  (settlement) =>
                    responses.settleTransient({
                      responseID: settlement.responseID,
                      requestHash: settlement.requestHash,
                      status: "failed",
                      timestamp: failedAt,
                      error: settlement.error,
                      usage: settlement.usage,
                    }),
                  { discard: true },
                )
              }),
            )
            return
          }
        }

        const completedAt = yield* DateTime.now
        yield* ensureNotCancelled(stage.workflowID)
        if (!(yield* currentLease(stage, DateTime.toEpochMillis(completedAt)))) return
        if (executionResult.checkpoint !== undefined) {
          WorkflowSecretGuard.assertSafe(executionResult.checkpoint)
        }
        const responseSettlement = executionResult.responseSettlement
        const responseResource =
          responseSettlement === undefined
            ? undefined
            : (yield* activeResponses(initial)).find((response) => response.id === responseSettlement.responseID)
        const completesWorkflow =
          completionCandidate?.stages.every(
            (item) => item.id === stage.id || item.status === "succeeded" || item.status === "skipped",
          ) === true
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* events.publish(
              WorkflowEvent.Stage.Succeeded,
              {
                workflowID: stage.workflowID,
                stageID: stage.id,
                timestamp: completedAt,
                attempt: stage.attempt,
                leaseOwner: options.ownerID,
                usage: executionResult.usage,
                checkpoint: executionResult.checkpoint,
              },
              {
                related: [
                  ...committedArtifacts.map((artifact) => ({
                    definition: WorkflowEvent.Artifact.Created,
                    data: {
                      workflowID: stage.workflowID,
                      stageID: stage.id,
                      timestamp: artifact.timeCreated,
                      artifact,
                    },
                  })),
                  ...(completesWorkflow
                    ? [
                        {
                          definition: WorkflowEvent.Succeeded,
                          data: {
                            workflowID: stage.workflowID,
                            timestamp: completedAt,
                            usage: addUsage(initial.run.usage, executionResult.usage),
                          },
                        },
                      ]
                    : []),
                  ...(responseSettlement?.type === "completed"
                    ? [
                        {
                          definition: ResponseEvent.Completed,
                          data: {
                            responseID: responseSettlement.responseID,
                            timestamp: completedAt,
                            output: responseSettlement.store ? responseSettlement.output : undefined,
                            usage: responseSettlement.store ? responseSettlement.usage : undefined,
                          },
                        },
                        ...(responseSettlement.store && responseSettlement.conversationID !== undefined
                          ? responseSettlement.output.map((payload) => ({
                              definition: ResponseEvent.Conversation.ItemAdded,
                              data: {
                                conversationID: responseSettlement.conversationID!,
                                timestamp: completedAt,
                                responseID: responseSettlement.responseID,
                                payload,
                              },
                            }))
                          : []),
                      ]
                    : []),
                ],
              },
            )
            if (responseSettlement?.type === "completed" && !responseSettlement.store) {
              yield* responses.settleTransient({
                responseID: responseSettlement.responseID,
                requestHash: responseResource?.requestHash,
                status: "completed",
                timestamp: completedAt,
                output: responseSettlement.output,
                usage: responseSettlement.usage,
              })
            }
          }),
        )

        const settled = yield* store.get(stage.workflowID)
        if (!settled) return
        yield* ensureNotCancelled(stage.workflowID)
        const paused = yield* store.gateBudget({
          workflowID: stage.workflowID,
          now: DateTime.toEpochMillis(completedAt),
        })
        if (settled.run.status === "succeeded") return
        if (paused) return
        if (settled.stages.some((item) => !WorkflowState.isTerminal(item.status))) {
          yield* PubSub.publish(wake, undefined)
        }
      })

      const start = Effect.fnUntraced(function* (stage: Workflow.Stage) {
        const ready = yield* Deferred.make<void>()
        const entry: { fiber?: Fiber.Fiber<void> } = {}
        const cleanup = Effect.sync(() => {
          const fiber = entry.fiber
          if (!fiber) return
          const set = fibers.get(stage.workflowID)
          set?.delete(fiber)
          if (set?.size === 0) fibers.delete(stage.workflowID)
        }).pipe(Effect.andThen(PubSub.publish(wake, undefined)), Effect.asVoid)
        const task = Deferred.await(ready).pipe(
          Effect.andThen(
            slots.withPermit(
              runStage(stage).pipe(
                Effect.catchTag("CancelRequested", () => settleStageCancellation(stage, "execution")),
                Effect.onInterrupt(() => settleStageCancellation(stage, "execution")),
              ),
            ),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Workflow stage execution failed", cause).pipe(
                  Effect.annotateLogs({ workflowID: stage.workflowID, stageID: stage.id }),
                ),
          ),
          Effect.onExit(() => cleanup),
        )
        const fiber = yield* task.pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Effect.sync(() => {
          entry.fiber = fiber
          const set = fibers.get(stage.workflowID) ?? new Set<Fiber.Fiber<void>>()
          set.add(fiber)
          fibers.set(stage.workflowID, set)
          Deferred.doneUnsafe(ready, Effect.void)
        })
      })

      const fill = Effect.forEach(
        Array.from({ length: options.concurrency }),
        () =>
          Effect.gen(function* () {
            if (!hasCapacity()) return
            const now = DateTime.toEpochMillis(yield* DateTime.now)
            const claimed = yield* store.claim({
              owner: options.ownerID,
              now,
              leaseDurationMs: options.leaseDurationMs,
            })
            if (Option.isNone(claimed)) return
            yield* start(claimed.value)
          }),
        { concurrency: 1, discard: true },
      )

      yield* settlePersistedCancellations
      yield* settleExpiredLeases

      yield* Stream.merge(Stream.fromPubSub(wake), Stream.tick(options.pollIntervalMs)).pipe(
        Stream.runForEach(() =>
          settlePersistedCancellations.pipe(
            Effect.andThen(fill),
            Effect.catchCause((cause) => Effect.logError("Workflow scheduler iteration failed", cause)),
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )

      return WorkflowExecution.Service.of({
        wake: PubSub.publish(wake, undefined).pipe(Effect.asVoid),
        active: Effect.sync(() => new Set(fibers.keys())),
        interrupt: (workflowID) =>
          Effect.forEach(Array.from(fibers.get(workflowID) ?? []), Fiber.interrupt, { discard: true }).pipe(
            Effect.andThen(settleCancellation(workflowID)),
          ),
      })
    }),
  )

export const nodeWith = (options: Options) =>
  makeGlobalNode({
    service: WorkflowExecution.Service,
    layer: layerWith(options),
    deps: [
      Database.node,
      EventV2.node,
      ResponsesV2.node,
      WorkflowProjector.node,
      WorkflowStore.node,
      WorkflowExecutor.node,
    ],
  })

export const node = nodeWith(defaults)

function addUsage(left: Workflow.Usage, right: Workflow.Usage): Workflow.Usage {
  return {
    tokens: left.tokens + right.tokens,
    turns: left.turns + right.turns,
    toolCalls: left.toolCalls + right.toolCalls,
    attempts: left.attempts + right.attempts,
  }
}

function checkpointFailure(code: string, message: string): ExecutionFailure {
  return {
    failure: { category: "ambiguous", code, message },
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
  }
}
