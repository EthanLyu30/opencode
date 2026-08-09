import { describe, expect } from "bun:test"
import path from "node:path"
import { DateTime, Effect, Exit, Layer, Option, Stream } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const recoveryPolicies = ["restart_safe", "reconcile_required", "manual_required"] as const

const createInput = (policy: Workflow.RecoveryPolicy): Workflow.CreateInput => ({
  id: Workflow.ID.make(`wfl_recovery_${policy}`),
  type: "development",
  input: { brief: `Recover ${policy}` },
  budget: { maxAttempts: 3 },
  stages: [
    {
      id: Workflow.StageID.make(`wfs_recovery_${policy}`),
      type: "build",
      ordinal: 0,
      maxAttempts: 3,
      recoveryPolicy: policy,
      idempotencyKey: `recovery/${policy}`,
      input: {},
    },
  ],
})

const workerOptions: WorkflowExecutionLocal.Options = {
  ownerID: "worker-recovery-second",
  leaseDurationMs: 5_000,
  heartbeatIntervalMs: 1_000,
  pollIntervalMs: 60_000,
  concurrency: 1,
}

const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    while (!predicate(yield* effect)) {
      yield* Effect.sleep(10)
    }
  }).pipe(Effect.timeout("2 seconds"))

describe("Workflow recovery", () => {
  it.live(
    "recovers expired leases conservatively after a process restart",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ policy: Workflow.RecoveryPolicy; attempt: number }> = []
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const database = Database.layerFromPath(path.join(tmp.path, "workflow-recovery.sqlite"))
        const seedLayer = AppNodeBuilder.build(
          LayerNode.group([Database.node, EventV2.node, WorkflowV2.node, WorkflowStore.node]),
          [[Database.node, database]],
        )
        const inputs = recoveryPolicies.map(createInput)

        yield* Effect.gen(function* () {
          const events = yield* EventV2.Service
          const store = yield* WorkflowStore.Service
          const workflow = yield* WorkflowV2.Service
          const now = DateTime.toEpochMillis(yield* DateTime.now)
          for (const input of inputs) {
            yield* workflow.create(input)
            const stage = Option.getOrThrow(
              yield* store.claim({ owner: "worker-recovery-first", now, leaseDurationMs: 10 }),
            )
            yield* events.publish(WorkflowEvent.Stage.Started, {
              workflowID: input.id!,
              stageID: stage.id,
              timestamp: DateTime.makeUnsafe(now),
              attempt: stage.attempt,
              leaseOwner: "worker-recovery-first",
            })
          }
        }).pipe(Effect.provide(seedLayer), Effect.scoped)

        yield* Effect.sleep(30)

        const executor = Layer.succeed(
          WorkflowExecutor.Service,
          WorkflowExecutor.Service.of({
            execute: ({ stage }) =>
              Effect.sync(() => {
                calls.push({ policy: stage.recoveryPolicy, attempt: stage.attempt })
                return { usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 } }
              }),
          }),
        )
        const restartLayer = AppNodeBuilder.build(
          LayerNode.group([
            Database.node,
            WorkflowV2.node,
            WorkflowStore.node,
            WorkflowExecutor.node,
            WorkflowExecution.node,
          ]),
          [
            [Database.node, database],
            [WorkflowExecutor.node, executor],
            [WorkflowExecution.node, WorkflowExecutionLocal.nodeWith(workerOptions)],
          ],
        )

        yield* Effect.gen(function* () {
          const execution = yield* WorkflowExecution.Service
          const workflow = yield* WorkflowV2.Service
          const restartSafe = yield* workflow.get(inputs[0].id!)
          const reconcile = yield* workflow.get(inputs[1].id!)
          const manual = yield* workflow.get(inputs[2].id!)

          expect(restartSafe.stages[0].status).toBe("retry_wait")
          expect(restartSafe.stages[0].error).toEqual({
            category: "transient",
            code: "lease_expired",
            message: "The previous worker lease expired before settlement.",
          })
          expect(reconcile.run.status).toBe("waiting_approval")
          expect(reconcile.stages[0].status).toBe("waiting_approval")
          expect(reconcile.stages[0].error).toEqual({
            category: "ambiguous",
            code: "lease_expired",
            message: "Execution may have produced side effects before the worker lease expired.",
          })
          expect(manual.run.status).toBe("waiting_approval")
          expect(manual.stages[0].status).toBe("waiting_approval")
          expect(manual.stages[0].error).toEqual({
            category: "ambiguous",
            code: "lease_expired",
            message: "Execution may have produced side effects before the worker lease expired.",
          })
          expect(calls).toEqual([])

          yield* execution.wake
          yield* eventually(workflow.get(inputs[0].id!), (detail) => detail.run.status === "succeeded")
          expect(calls).toEqual([{ policy: "restart_safe", attempt: 2 }])
        }).pipe(Effect.provide(restartLayer), Effect.scoped)
      }),
    5_000,
  )

  it.live(
    "settles persisted cancellation before applying an expired-lease recovery policy",
    () =>
      Effect.gen(function* () {
        const calls: number[] = []
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const database = Database.layerFromPath(path.join(tmp.path, "workflow-recovery-cancel.sqlite"))
        const seedLayer = AppNodeBuilder.build(
          LayerNode.group([Database.node, EventV2.node, WorkflowV2.node, WorkflowStore.node]),
          [[Database.node, database]],
        )
        const input = createInput("restart_safe")

        yield* Effect.gen(function* () {
          const events = yield* EventV2.Service
          const store = yield* WorkflowStore.Service
          const workflow = yield* WorkflowV2.Service
          const now = DateTime.toEpochMillis(yield* DateTime.now)
          yield* workflow.create(input)
          const stage = Option.getOrThrow(
            yield* store.claim({ owner: "worker-recovery-cancel-first", now, leaseDurationMs: 10 }),
          )
          yield* events.publish(WorkflowEvent.Stage.Started, {
            workflowID: input.id!,
            stageID: stage.id,
            timestamp: DateTime.makeUnsafe(now),
            attempt: stage.attempt,
            leaseOwner: "worker-recovery-cancel-first",
          })
          yield* workflow.cancel(input.id!)
        }).pipe(Effect.provide(seedLayer), Effect.scoped)

        yield* Effect.sleep(30)
        const executor = Layer.succeed(
          WorkflowExecutor.Service,
          WorkflowExecutor.Service.of({
            execute: () =>
              Effect.sync(() => {
                calls.push(1)
                return { usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 } }
              }),
          }),
        )
        const restartLayer = AppNodeBuilder.build(
          LayerNode.group([
            Database.node,
            WorkflowV2.node,
            WorkflowStore.node,
            WorkflowExecutor.node,
            WorkflowExecution.node,
          ]),
          [
            [Database.node, database],
            [WorkflowExecutor.node, executor],
            [WorkflowExecution.node, WorkflowExecutionLocal.nodeWith(workerOptions)],
          ],
        )

        yield* Effect.gen(function* () {
          const workflow = yield* WorkflowV2.Service
          const detail = yield* workflow.get(input.id!)
          const history = yield* workflow.history({ workflowID: input.id!, limit: 20 })
          expect(detail.run.status).toBe("cancelled")
          expect(detail.stages[0].status).toBe("cancelled")
          expect(history.events.map((event) => event.type)).not.toContain("workflow.stage.retry_scheduled")
          expect(history.events.map((event) => event.type)).not.toContain("workflow.approval.requested")
          expect(calls).toEqual([])
        }).pipe(Effect.provide(restartLayer), Effect.scoped)
      }),
    5_000,
  )

  it.live(
    "applies one explicit recovery action and rejects a conflicting repeat",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const database = Database.layerFromPath(path.join(tmp.path, "workflow-recovery-resolution.sqlite"))
        const layer = AppNodeBuilder.build(
          LayerNode.group([Database.node, EventV2.node, WorkflowV2.node, WorkflowStore.node]),
          [[Database.node, database]],
        )
        const retryInput = createInput("reconcile_required")
        const failInput = createInput("manual_required")

        yield* Effect.gen(function* () {
          const events = yield* EventV2.Service
          const store = yield* WorkflowStore.Service
          const workflow = yield* WorkflowV2.Service
          const now = DateTime.toEpochMillis(yield* DateTime.now)
          for (const input of [retryInput, failInput]) {
            yield* workflow.create(input)
            const stage = Option.getOrThrow(
              yield* store.claim({ owner: "worker-recovery-resolution", now, leaseDurationMs: 5_000 }),
            )
            yield* events.publish(WorkflowEvent.Stage.Started, {
              workflowID: input.id!,
              stageID: stage.id,
              timestamp: DateTime.makeUnsafe(now),
              attempt: stage.attempt,
              leaseOwner: "worker-recovery-resolution",
            })
            yield* events.publish(WorkflowEvent.Approval.Requested, {
              workflowID: input.id!,
              stageID: stage.id,
              timestamp: DateTime.makeUnsafe(now + 1),
              reason: "ambiguous_execution",
              failure: {
                category: "ambiguous",
                code: "lease_expired",
                message: "Execution may have produced side effects before the worker lease expired.",
              },
              usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
            })
          }

          yield* workflow.resolveRecovery({
            workflowID: retryInput.id!,
            stageID: retryInput.stages[0].id!,
            action: "retry",
          })
          const retried = yield* workflow.get(retryInput.id!)
          expect(retried.run.status).toBe("running")
          expect(retried.stages[0].status).toBe("retry_wait")
          expect(retried.stages[0].recoveryAction).toBe("retry")

          yield* workflow.resolveRecovery({
            workflowID: retryInput.id!,
            stageID: retryInput.stages[0].id!,
            action: "retry",
          })
          const retryHistory = yield* workflow.history({ workflowID: retryInput.id!, limit: 20 })
          expect(retryHistory.events.filter((event) => event.type === "workflow.approval.resolved")).toHaveLength(1)
          expect(retryHistory.events.filter((event) => event.type === "workflow.stage.retry_scheduled")).toHaveLength(1)

          const conflicting = yield* workflow
            .resolveRecovery({
              workflowID: retryInput.id!,
              stageID: retryInput.stages[0].id!,
              action: "fail",
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(conflicting)).toBe(true)

          yield* workflow.resolveRecovery({
            workflowID: failInput.id!,
            stageID: failInput.stages[0].id!,
            action: "fail",
          })
          const failed = yield* workflow.get(failInput.id!)
          const failHistory = yield* workflow.history({ workflowID: failInput.id!, limit: 20 })
          expect(failed.run.status).toBe("failed")
          expect(failed.stages[0].status).toBe("failed")
          expect(failed.stages[0].recoveryAction).toBe("fail")
          expect(failHistory.events.slice(-3).map((event) => event.type)).toEqual([
            "workflow.approval.resolved",
            "workflow.stage.failed",
            "workflow.failed",
          ])
        }).pipe(Effect.provide(layer), Effect.scoped)
      }),
    5_000,
  )

  it.live(
    "uses an exclusive durable sequence across history pages and SSE replay",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const database = Database.layerFromPath(path.join(tmp.path, "workflow-replay.sqlite"))
        const layer = AppNodeBuilder.build(
          LayerNode.group([Database.node, EventV2.node, WorkflowV2.node, WorkflowStore.node]),
          [[Database.node, database]],
        )
        const input = createInput("restart_safe")

        yield* Effect.gen(function* () {
          const workflow = yield* WorkflowV2.Service
          yield* workflow.create(input)

          const first = yield* workflow.history({ workflowID: input.id!, limit: 1 })
          const cursor = first.events.at(-1)?.durable?.seq
          if (cursor === undefined) return yield* Effect.die("Expected a durable history cursor")
          const second = yield* workflow.history({ workflowID: input.id!, after: cursor, limit: 10 })
          const replayed = yield* workflow
            .events({ workflowID: input.id!, after: cursor })
            .pipe(Stream.take(second.events.length), Stream.runCollect)
          const full = yield* workflow.history({ workflowID: input.id!, limit: 10 })
          const paged = [...first.events, ...second.events]

          expect(first.hasMore).toBe(true)
          expect(new Set(paged.map((event) => event.id)).size).toBe(paged.length)
          expect(paged.map((event) => event.id)).toEqual(full.events.map((event) => event.id))
          expect(Array.from(replayed, (event) => event.id)).toEqual(second.events.map((event) => event.id))
        }).pipe(Effect.provide(layer), Effect.scoped)
      }),
    5_000,
  )
})
