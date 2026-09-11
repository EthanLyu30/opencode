import { describe, expect } from "bun:test"
import path from "node:path"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
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
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Responses } from "@opencode-ai/schema/responses"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Session } from "@opencode-ai/schema/session"
import { ResponsesV2 } from "@opencode-ai/core/responses"
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

const admit = (workflow: WorkflowV2.Interface, input: Workflow.CreateInput) =>
  workflow.admit({
    ...input,
    location: Location.Ref.make({ directory: AbsolutePath.make("D:\\OpenCode-Audit") }),
    sessionID: Session.ID.make("ses_workflow_recovery"),
    agent: Agent.ID.make("build"),
  })

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
            yield* admit(workflow, input)
            const stage = Option.getOrThrowWith(
              yield* store.claim({ owner: "worker-recovery-first", now, leaseDurationMs: 10 }),
              () => new Error(`No recovery seed candidate for ${input.id}`),
            )
            yield* events.publish(WorkflowEvent.Started, { workflowID: input.id!, timestamp: DateTime.makeUnsafe(now) })
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
          yield* admit(workflow, input)
          const stage = Option.getOrThrow(
            yield* store.claim({ owner: "worker-recovery-cancel-first", now, leaseDurationMs: 10 }),
          )
          yield* events.publish(WorkflowEvent.Started, { workflowID: input.id!, timestamp: DateTime.makeUnsafe(now) })
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
        const oppositeInput: Workflow.CreateInput = {
          ...createInput("manual_required"),
          id: Workflow.ID.make("wfl_recovery_opposite_race"),
          stages: [
            {
              ...createInput("manual_required").stages[0],
              id: Workflow.StageID.make("wfs_recovery_opposite_race"),
              idempotencyKey: "recovery/opposite-race",
            },
          ],
        }

        yield* Effect.gen(function* () {
          const events = yield* EventV2.Service
          const store = yield* WorkflowStore.Service
          const workflow = yield* WorkflowV2.Service
          const now = DateTime.toEpochMillis(yield* DateTime.now)
          for (const input of [retryInput, failInput, oppositeInput]) {
            yield* admit(workflow, input)
            const stage = Option.getOrThrow(
              yield* store.claim({ owner: "worker-recovery-resolution", now, leaseDurationMs: 5_000 }),
            )
            yield* events.publish(WorkflowEvent.Started, { workflowID: input.id!, timestamp: DateTime.makeUnsafe(now) })
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
              attempt: stage.attempt,
              leaseOwner: "worker-recovery-resolution",
              leaseFence: { variant: "live_execution", expectedStatus: "running" },
              reason: "ambiguous_execution",
              failure: {
                category: "ambiguous",
                code: "lease_expired",
                message: "Execution may have produced side effects before the worker lease expired.",
              },
              usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
            })
          }

          const retryGate = yield* Deferred.make<void>()
          const retryFibers = yield* Effect.forEach(
            Array.from({ length: 8 }),
            () =>
              Deferred.await(retryGate).pipe(
                Effect.andThen(
                  workflow.resolveRecovery({
                    workflowID: retryInput.id!,
                    stageID: retryInput.stages[0].id!,
                    action: "retry",
                  }),
                ),
                Effect.forkScoped({ startImmediately: true }),
              ),
            { concurrency: "unbounded" },
          )
          yield* Deferred.succeed(retryGate, undefined)
          const retryExits = yield* Effect.forEach(retryFibers, Fiber.await, { concurrency: "unbounded" })
          expect(
            retryExits.map((exit) =>
              Exit.isSuccess(exit)
                ? "success"
                : String(Option.getOrUndefined(Cause.findErrorOption(exit.cause)) ?? Cause.squash(exit.cause)),
            ),
          ).toEqual(Array.from({ length: 8 }, () => "success"))
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

          const failGate = yield* Deferred.make<void>()
          const failFibers = yield* Effect.forEach(
            Array.from({ length: 8 }),
            () =>
              Deferred.await(failGate).pipe(
                Effect.andThen(
                  workflow.resolveRecovery({
                    workflowID: failInput.id!,
                    stageID: failInput.stages[0].id!,
                    action: "fail",
                  }),
                ),
                Effect.forkScoped({ startImmediately: true }),
              ),
            { concurrency: "unbounded" },
          )
          yield* Deferred.succeed(failGate, undefined)
          const failExits = yield* Effect.forEach(failFibers, Fiber.await, { concurrency: "unbounded" })
          expect(failExits.every(Exit.isSuccess)).toBe(true)
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

          const oppositeGate = yield* Deferred.make<void>()
          const oppositeFibers = yield* Effect.forEach(
            ["retry", "fail"] as const,
            (action) =>
              Deferred.await(oppositeGate).pipe(
                Effect.andThen(
                  workflow.resolveRecovery({
                    workflowID: oppositeInput.id!,
                    stageID: oppositeInput.stages[0].id!,
                    action,
                  }),
                ),
                Effect.forkScoped({ startImmediately: true }),
              ),
            { concurrency: "unbounded" },
          )
          yield* Deferred.succeed(oppositeGate, undefined)
          const oppositeExits = yield* Effect.forEach(oppositeFibers, Fiber.await, { concurrency: "unbounded" })
          expect(oppositeExits.filter(Exit.isSuccess)).toHaveLength(1)
          const loser = oppositeExits.find(Exit.isFailure)
          expect(loser && Option.getOrUndefined(Cause.findErrorOption(loser.cause))).toMatchObject({
            _tag: "Workflow.ConflictError",
            operation: "resolveRecovery",
          })
        }).pipe(Effect.provide(layer), Effect.scoped)
      }),
    5_000,
  )

  it.live(
    "settles checkpoint usage exactly once when approval resolves to failure",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const database = Database.layerFromPath(path.join(tmp.path, "workflow-recovery-checkpoint-usage.sqlite"))
        const layer = AppNodeBuilder.build(
          LayerNode.group([Database.node, EventV2.node, WorkflowV2.node, WorkflowStore.node]),
          [[Database.node, database]],
        )
        const input = createInput("manual_required")

        yield* Effect.gen(function* () {
          const events = yield* EventV2.Service
          const store = yield* WorkflowStore.Service
          const workflow = yield* WorkflowV2.Service
          const now = DateTime.toEpochMillis(yield* DateTime.now)
          yield* admit(workflow, input)
          const stage = Option.getOrThrow(
            yield* store.claim({ owner: "worker-checkpoint-usage", now, leaseDurationMs: 5_000 }),
          )
          yield* events.publish(WorkflowEvent.Started, { workflowID: input.id!, timestamp: DateTime.makeUnsafe(now) })
          yield* events.publish(WorkflowEvent.Stage.Started, {
            workflowID: input.id!,
            stageID: stage.id,
            timestamp: DateTime.makeUnsafe(now),
            attempt: stage.attempt,
            leaseOwner: "worker-checkpoint-usage",
          })
          const checkpointUsage = { tokens: 20, turns: 1, toolCalls: 1, attempts: 0 }
          yield* events.publish(WorkflowEvent.Stage.Checkpointed, {
            workflowID: input.id!,
            stageID: stage.id,
            timestamp: DateTime.makeUnsafe(now + 1),
            attempt: stage.attempt,
            leaseOwner: "worker-checkpoint-usage",
            checkpoint: {
              kind: "workflow.model.continuation",
              version: 1,
              providerID: "deepseek",
              modelID: "deepseek-v4-flash",
              completedTurns: 1,
              turns: [
                {
                  calls: [{ id: "call_checkpoint_usage", name: "read_file", input: { path: "README.md" } }],
                  results: [
                    {
                      id: "call_checkpoint_usage",
                      name: "read_file",
                      result: { type: "text", value: "checkpointed" },
                    },
                  ],
                },
              ],
              usage: checkpointUsage,
              providerUsage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
              responseOutput: [],
              artifacts: [],
            },
          })
          yield* events.publish(WorkflowEvent.Approval.Requested, {
            workflowID: input.id!,
            stageID: stage.id,
            timestamp: DateTime.makeUnsafe(now + 2),
            attempt: stage.attempt,
            leaseOwner: "worker-checkpoint-usage",
            leaseFence: { variant: "live_execution", expectedStatus: "running" },
            reason: "ambiguous_execution",
            failure: {
              category: "ambiguous",
              code: "lease_expired",
              message: "Execution may have completed before its lease expired.",
            },
            usage: { tokens: 5, turns: 1, toolCalls: 0, attempts: 0 },
          })

          yield* workflow.resolveRecovery({ workflowID: input.id!, stageID: stage.id, action: "fail" })

          const detail = yield* workflow.get(input.id!)
          const history = yield* workflow.history({ workflowID: input.id!, limit: 30 })
          expect(detail.run.usage).toEqual({ tokens: 25, turns: 2, toolCalls: 1, attempts: 1 })
          expect(history.events.find((event) => event.type === "workflow.stage.failed")?.data).toMatchObject({
            usage: checkpointUsage,
          })
          expect(history.events.find((event) => event.type === "workflow.failed")?.data).toMatchObject({
            usage: { tokens: 25, turns: 2, toolCalls: 1, attempts: 1 },
          })
        }).pipe(Effect.provide(layer), Effect.scoped)
      }),
    5_000,
  )

  it.live(
    "rolls back recovery resolution with its retry or failure settlement batch",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const database = Database.layerFromPath(path.join(tmp.path, "workflow-recovery-atomic.sqlite"))
        const layer = AppNodeBuilder.build(
          LayerNode.group([Database.node, EventV2.node, WorkflowV2.node, WorkflowStore.node, ResponsesV2.node]),
          [[Database.node, database]],
        )

        yield* Effect.gen(function* () {
          const events = yield* EventV2.Service
          const responses = yield* ResponsesV2.Service
          const store = yield* WorkflowStore.Service
          const workflow = yield* WorkflowV2.Service
          const now = DateTime.toEpochMillis(yield* DateTime.now)
          const responseID = Responses.ID.make("resp_recovery_atomic_fail")
          const failInput = {
            ...createInput("manual_required"),
            id: Workflow.ID.make("wfl_recovery_atomic_fail"),
            stages: [
              {
                ...createInput("manual_required").stages[0],
                id: Workflow.StageID.make("wfs_recovery_atomic_fail"),
                type: "deliver",
                idempotencyKey: "recovery/atomic-fail",
                input: { responseID },
              },
            ],
          } satisfies Workflow.CreateInput
          const retryInput = {
            ...createInput("reconcile_required"),
            id: Workflow.ID.make("wfl_recovery_atomic_retry"),
            stages: [
              {
                ...createInput("reconcile_required").stages[0],
                id: Workflow.StageID.make("wfs_recovery_atomic_retry"),
                idempotencyKey: "recovery/atomic-retry",
              },
            ],
          } satisfies Workflow.CreateInput

          for (const input of [failInput, retryInput]) {
            yield* admit(workflow, input)
            if (input.id === failInput.id) {
              yield* responses.create({
                id: responseID,
                workflowID: failInput.id!,
                model: "deepseek-v4-flash",
                background: false,
                store: true,
                requestHash: "hash:recovery-atomic-fail",
                input: [{ type: "message", role: "user", content: "fail atomically" }],
              })
            }
            const stage = Option.getOrThrow(
              yield* store.claim({ owner: "worker-recovery-atomic", now, leaseDurationMs: 5_000 }),
            )
            yield* events.publish(WorkflowEvent.Started, { workflowID: input.id!, timestamp: DateTime.makeUnsafe(now) })
            yield* events.publish(WorkflowEvent.Stage.Started, {
              workflowID: input.id!,
              stageID: stage.id,
              timestamp: DateTime.makeUnsafe(now),
              attempt: stage.attempt,
              leaseOwner: "worker-recovery-atomic",
            })
            yield* events.publish(WorkflowEvent.Approval.Requested, {
              workflowID: input.id!,
              stageID: stage.id,
              timestamp: DateTime.makeUnsafe(now + 1),
              attempt: stage.attempt,
              leaseOwner: "worker-recovery-atomic",
              leaseFence: { variant: "live_execution", expectedStatus: "running" },
              reason: "ambiguous_execution",
              failure: { category: "ambiguous", code: "lease_expired", message: "Ambiguous execution" },
              usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
            })
          }
          let failRetryProjection = true
          let failResponseProjection = true
          yield* events.project(WorkflowEvent.Stage.RetryScheduled, () =>
            failRetryProjection ? Effect.die("retry projector fault") : Effect.void,
          )
          yield* events.project(ResponseEvent.Failed, () =>
            failResponseProjection ? Effect.die("response projector fault") : Effect.void,
          )

          const retryExit = yield* workflow
            .resolveRecovery({
              workflowID: retryInput.id!,
              stageID: retryInput.stages[0].id!,
              action: "retry",
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(retryExit)).toBe(true)
          expect(yield* workflow.get(retryInput.id!)).toMatchObject({
            run: { status: "waiting_approval" },
            stages: [{ status: "waiting_approval", recoveryAction: undefined }],
          })

          const failExit = yield* workflow
            .resolveRecovery({ workflowID: failInput.id!, stageID: failInput.stages[0].id!, action: "fail" })
            .pipe(Effect.exit)
          expect(Exit.isFailure(failExit)).toBe(true)
          expect(yield* workflow.get(failInput.id!)).toMatchObject({
            run: { status: "waiting_approval" },
            stages: [{ status: "waiting_approval", recoveryAction: undefined }],
          })
          expect(yield* responses.get(responseID)).toMatchObject({ status: "queued" })

          failRetryProjection = false
          failResponseProjection = false
          yield* workflow.resolveRecovery({
            workflowID: retryInput.id!,
            stageID: retryInput.stages[0].id!,
            action: "retry",
          })
          yield* workflow.resolveRecovery({
            workflowID: failInput.id!,
            stageID: failInput.stages[0].id!,
            action: "fail",
          })
          expect(yield* workflow.get(retryInput.id!)).toMatchObject({
            run: { status: "running" },
            stages: [{ status: "retry_wait", recoveryAction: "retry" }],
          })
          expect(yield* workflow.get(failInput.id!)).toMatchObject({
            run: { status: "failed" },
            stages: [{ status: "failed", recoveryAction: "fail" }],
          })
          expect(yield* responses.get(responseID)).toMatchObject({ status: "failed" })
        }).pipe(Effect.provide(layer), Effect.scoped)
      }),
    5_000,
  )

  it.live(
    "settles checkpoint provider usage into durable and transient bound Responses",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const database = Database.layerFromPath(path.join(tmp.path, "workflow-recovery-provider-usage.sqlite"))
        const layer = AppNodeBuilder.build(
          LayerNode.group([Database.node, EventV2.node, WorkflowV2.node, WorkflowStore.node, ResponsesV2.node]),
          [[Database.node, database]],
        )

        yield* Effect.gen(function* () {
          const events = yield* EventV2.Service
          const responses = yield* ResponsesV2.Service
          const store = yield* WorkflowStore.Service
          const workflow = yield* WorkflowV2.Service
          const providerUsage = { inputTokens: 12, outputTokens: 8, totalTokens: 20 }
          const terminals = [] as Responses.Resource[]

          for (const storeResponse of [true, false]) {
            const suffix = storeResponse ? "durable" : "transient"
            const workflowID = Workflow.ID.make(`wfl_recovery_provider_usage_${suffix}`)
            const stageID = Workflow.StageID.make(`wfs_recovery_provider_usage_${suffix}`)
            const responseID = Responses.ID.make(`resp_recovery_provider_usage_${suffix}`)
            const input: Workflow.CreateInput = {
              id: workflowID,
              type: "development",
              input: {},
              budget: { maxAttempts: 1 },
              stages: [
                {
                  id: stageID,
                  type: "deliver",
                  ordinal: 0,
                  maxAttempts: 1,
                  recoveryPolicy: "manual_required",
                  idempotencyKey: `recovery/provider-usage/${suffix}`,
                  input: { responseID },
                },
              ],
            }
            yield* admit(workflow, input)
            const requestHash = `hash:recovery-provider-usage-${suffix}`
            const lease = storeResponse ? undefined : yield* responses.acquireTransient({ requestHash, responseID })
            const admitted = yield* responses.create({
              id: responseID,
              workflowID,
              model: "deepseek-v4-flash",
              background: false,
              store: storeResponse,
              requestHash,
              input: [{ type: "message", role: "user", content: "settle usage" }],
            })
            if (lease) yield* responses.registerTransient(admitted)
            const now = DateTime.toEpochMillis(yield* DateTime.now)
            const stage = Option.getOrThrow(
              yield* store.claim({ owner: `worker-provider-usage-${suffix}`, now, leaseDurationMs: 5_000 }),
            )
            yield* events.publish(WorkflowEvent.Started, { workflowID, timestamp: DateTime.makeUnsafe(now) })
            yield* events.publish(WorkflowEvent.Stage.Started, {
              workflowID,
              stageID,
              timestamp: DateTime.makeUnsafe(now),
              attempt: stage.attempt,
              leaseOwner: `worker-provider-usage-${suffix}`,
            })
            yield* events.publish(WorkflowEvent.Stage.Checkpointed, {
              workflowID,
              stageID,
              timestamp: DateTime.makeUnsafe(now + 1),
              attempt: stage.attempt,
              leaseOwner: `worker-provider-usage-${suffix}`,
              checkpoint: {
                kind: "workflow.model.continuation",
                version: 1,
                providerID: "deepseek",
                modelID: "deepseek-v4-flash",
                responseID,
                completedTurns: 1,
                turns: [
                  {
                    calls: [{ id: "call_provider_usage", name: "read_file", input: { path: "README.md" } }],
                    results: [
                      {
                        id: "call_provider_usage",
                        name: "read_file",
                        result: { type: "text", value: "checkpointed" },
                      },
                    ],
                  },
                ],
                usage: { tokens: 20, turns: 1, toolCalls: 1, attempts: 0 },
                providerUsage,
                responseOutput: [],
                artifacts: [],
              },
            })
            yield* events.publish(WorkflowEvent.Approval.Requested, {
              workflowID,
              stageID,
              timestamp: DateTime.makeUnsafe(now + 2),
              attempt: stage.attempt,
              leaseOwner: `worker-provider-usage-${suffix}`,
              leaseFence: { variant: "live_execution", expectedStatus: "running" },
              reason: "ambiguous_execution",
              failure: { category: "ambiguous", code: "lease_expired", message: "Ambiguous execution" },
              usage: { tokens: 5, turns: 1, toolCalls: 0, attempts: 0 },
            })

            yield* workflow.resolveRecovery({ workflowID, stageID, action: "fail" })
            const detail = yield* workflow.get(workflowID)
            expect(detail.run.usage).toEqual({ tokens: 25, turns: 2, toolCalls: 1, attempts: 1 })
            if (lease) {
              terminals.push((yield* lease.await).resource)
              yield* lease.release
            } else {
              terminals.push(yield* responses.get(responseID))
            }
          }

          expect(terminals.map((resource) => [resource.store, resource.status, resource.usage])).toEqual([
            [true, "failed", providerUsage],
            [false, "failed", providerUsage],
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
          yield* admit(workflow, input)

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
