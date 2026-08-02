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
import { it, testEffect } from "./lib/effect"

const projectorIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([EventV2.node, WorkflowV2.node, WorkflowStore.node])),
)

const workerOptions: WorkflowExecutionLocal.Options = {
  ownerID: "worker-cancel-restart",
  leaseDurationMs: 5_000,
  heartbeatIntervalMs: 1_000,
  pollIntervalMs: 5,
  concurrency: 1,
}

const restartExecutorCalls = { value: 0 }
const restartExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: () =>
      Effect.sync(() => {
        restartExecutorCalls.value += 1
        return { usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 } }
      }),
  }),
)

const createInput = (suffix: string): Workflow.CreateInput => ({
  id: Workflow.ID.make(`wfl_${suffix}`),
  type: "development",
  input: { brief: `Build ${suffix}` },
  budget: { maxAttempts: 3 },
  stages: [
    {
      id: Workflow.StageID.make(`wfs_${suffix}`),
      type: "design",
      ordinal: 0,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe",
      idempotencyKey: `${suffix}/design`,
      input: {},
    },
  ],
})

describe("Workflow cancellation", () => {
  projectorIt.effect("rejects artifact and success projection after durable cancellation wins the race", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const input = createInput("cancel_fence")
      yield* workflow.create(input)
      const now = DateTime.toEpochMillis(yield* DateTime.now)
      const claimed = Option.getOrThrow(
        yield* store.claim({ owner: "worker-cancel-fence", now, leaseDurationMs: 5_000 }),
      )
      yield* events.publish(WorkflowEvent.Stage.Started, {
        workflowID: input.id!,
        stageID: input.stages[0].id!,
        timestamp: DateTime.makeUnsafe(now),
        attempt: claimed.attempt,
        leaseOwner: "worker-cancel-fence",
      })
      yield* workflow.cancel(input.id!)

      const artifact = yield* events
        .publish(WorkflowEvent.Artifact.Created, {
          workflowID: input.id!,
          stageID: input.stages[0].id!,
          timestamp: DateTime.makeUnsafe(now + 1),
          artifact: Workflow.Artifact.make({
            id: Workflow.ArtifactID.make("wfa_cancel_fence"),
            workflowID: input.id!,
            stageID: input.stages[0].id!,
            kind: "result",
            uri: "artifact://cancel/result.json",
            mime: "application/json",
            sha256: "c".repeat(64),
            size: 2,
            metadata: {},
            timeCreated: DateTime.makeUnsafe(now + 1),
          }),
        })
        .pipe(Effect.exit)
      const success = yield* events
        .publish(WorkflowEvent.Stage.Succeeded, {
          workflowID: input.id!,
          stageID: input.stages[0].id!,
          timestamp: DateTime.makeUnsafe(now + 2),
          attempt: claimed.attempt,
          leaseOwner: "worker-cancel-fence",
          usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 },
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(artifact)).toBe(true)
      expect(Exit.isFailure(success)).toBe(true)
      const detail = yield* workflow.get(input.id!)
      expect(detail.artifacts).toEqual([])
      expect(detail.stages[0].status).toBe("running")
    }),
  )

  it.live(
    "finishes a persisted cancel request after restart without invoking the executor",
    () =>
      Effect.gen(function* () {
        restartExecutorCalls.value = 0
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const database = Database.layerFromPath(path.join(tmp.path, "workflow-cancel.sqlite"))
        const requestLayer = AppNodeBuilder.build(
          LayerNode.group([Database.node, WorkflowV2.node, WorkflowStore.node]),
          [[Database.node, database]],
        )

        const first = createInput("cancel_restart")
        const input: Workflow.CreateInput = {
          ...first,
          stages: [
            first.stages[0],
            {
              id: Workflow.StageID.make("wfs_cancel_restart_build"),
              type: "build",
              ordinal: 1,
              maxAttempts: 3,
              recoveryPolicy: "restart_safe",
              idempotencyKey: "cancel_restart/build",
              input: {},
            },
          ],
        }
        yield* Effect.gen(function* () {
          const workflow = yield* WorkflowV2.Service
          yield* workflow.create(input)
          yield* workflow.cancel(input.id!)
          const detail = yield* workflow.get(input.id!)
          expect(detail.run.cancelRequestedAt).toBeDefined()
          const history = yield* workflow.history({ workflowID: input.id!, limit: 20 })
          expect(history.events.filter((event) => event.type === "workflow.cancel.requested")).toHaveLength(1)
        }).pipe(Effect.provide(requestLayer), Effect.scoped)

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
            [WorkflowExecutor.node, restartExecutor],
            [WorkflowExecution.node, WorkflowExecutionLocal.nodeWith(workerOptions)],
          ],
        )

        yield* Effect.gen(function* () {
          const workflow = yield* WorkflowV2.Service
          const completed = yield* workflow.events({ workflowID: input.id! }).pipe(
            Stream.filter((event) => event.type === "workflow.cancelled"),
            Stream.runHead,
            Effect.timeout("2 seconds"),
          )
          expect(Option.isSome(completed)).toBe(true)

          const detail = yield* workflow.get(input.id!)
          expect(detail.run.status).toBe("cancelled")
          expect(detail.stages.map((stage) => stage.status)).toEqual(["cancelled", "cancelled"])
          expect(restartExecutorCalls.value).toBe(0)

          yield* workflow.cancel(input.id!)
          const history = yield* workflow.history({ workflowID: input.id!, limit: 20 })
          expect(history.events.filter((event) => event.type === "workflow.cancel.requested")).toHaveLength(1)
          expect(history.events.filter((event) => event.type === "workflow.stage.cancelled")).toHaveLength(2)
          expect(history.events.filter((event) => event.type === "workflow.cancelled")).toHaveLength(1)
        }).pipe(Effect.provide(restartLayer), Effect.scoped)
      }),
    5_000,
  )
})
