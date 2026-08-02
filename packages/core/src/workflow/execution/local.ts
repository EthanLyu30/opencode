export * as WorkflowExecutionLocal from "./local"

import { and, inArray, isNotNull } from "drizzle-orm"
import { Cause, Data, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, PubSub, Semaphore, Stream } from "effect"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Database } from "../../database/database"
import { makeGlobalNode } from "../../effect/app-node"
import { EventV2 } from "../../event"
import { WorkflowExecution } from "../execution"
import { WorkflowExecutor } from "../executor"
import { WorkflowProjector } from "../projector"
import { WorkflowSecretGuard } from "../secret-guard"
import { WorkflowRunTable } from "../sql"
import { WorkflowState } from "../state"
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

export const layerWith = (options: Options) =>
  Layer.effect(
    WorkflowExecution.Service,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
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
        yield* events
          .publish(WorkflowEvent.Cancelled, {
            workflowID,
            timestamp: yield* DateTime.now,
          })
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

        const outcome = yield* Effect.raceFirst(
          executor
            .execute({
              workflow: initial.run,
              stage,
              lease: {
                owner: options.ownerID,
                attempt: stage.attempt,
                expiresAt: stage.leaseExpiresAt,
              },
            })
            .pipe(
              Effect.exit,
              Effect.map((exit) => ({ type: "execution" as const, exit })),
            ),
          heartbeat(stage).pipe(Effect.as({ type: "lease_lost" as const })),
        )
        if (outcome.type === "lease_lost" || Exit.isFailure(outcome.exit)) return

        for (const commit of outcome.exit.value.artifacts ?? []) {
          yield* ensureNotCancelled(stage.workflowID)
          const now = yield* DateTime.now
          if (!(yield* currentLease(stage, DateTime.toEpochMillis(now)))) return
          WorkflowSecretGuard.assertSafe(commit)
          const artifact = Workflow.Artifact.make({
            id: Workflow.ArtifactID.create(),
            workflowID: stage.workflowID,
            stageID: stage.id,
            ...commit,
            timeCreated: now,
          })
          yield* events.publish(WorkflowEvent.Artifact.Created, {
            workflowID: stage.workflowID,
            stageID: stage.id,
            timestamp: now,
            artifact,
          })
        }

        const completedAt = yield* DateTime.now
        yield* ensureNotCancelled(stage.workflowID)
        if (!(yield* currentLease(stage, DateTime.toEpochMillis(completedAt)))) return
        if (outcome.exit.value.checkpoint !== undefined) {
          WorkflowSecretGuard.assertSafe(outcome.exit.value.checkpoint)
        }
        yield* events.publish(WorkflowEvent.Stage.Succeeded, {
          workflowID: stage.workflowID,
          stageID: stage.id,
          timestamp: completedAt,
          attempt: stage.attempt,
          leaseOwner: options.ownerID,
          usage: outcome.exit.value.usage,
          checkpoint: outcome.exit.value.checkpoint,
        })

        const settled = yield* store.get(stage.workflowID)
        if (!settled) return
        yield* ensureNotCancelled(stage.workflowID)
        if (settled.stages.every((item) => item.status === "succeeded" || item.status === "skipped")) {
          yield* events.publish(WorkflowEvent.Succeeded, {
            workflowID: stage.workflowID,
            timestamp: yield* DateTime.now,
            usage: settled.run.usage,
          })
          return
        }
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
    deps: [Database.node, EventV2.node, WorkflowProjector.node, WorkflowStore.node, WorkflowExecutor.node],
  })

export const node = nodeWith(defaults)
