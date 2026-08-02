import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Option, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowStageTable } from "@opencode-ai/core/workflow/sql"
import { Workflow } from "@opencode-ai/schema/workflow"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([WorkflowV2.node, WorkflowStore.node, WorkflowExecutor.node])),
)

const successfulExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) =>
      Effect.succeed({
        checkpoint: { completed: stage.type },
        usage: { tokens: 120, turns: 1, toolCalls: 0, attempts: 0 },
        artifacts: [
          {
            kind: "result",
            uri: `artifact://${stage.workflowID}/result.json`,
            mime: "application/json",
            sha256: "a".repeat(64),
            size: 2,
            metadata: {},
          },
        ],
      }),
  }),
)

const workerOptions: WorkflowExecutionLocal.Options = {
  ownerID: "worker-test",
  leaseDurationMs: 5_000,
  heartbeatIntervalMs: 1_000,
  pollIntervalMs: 5,
  concurrency: 1,
}

const makeWorkerIt = (
  executor: Layer.Layer<WorkflowExecutor.Service>,
  options: WorkflowExecutionLocal.Options = workerOptions,
) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        WorkflowV2.node,
        WorkflowStore.node,
        WorkflowExecutor.node,
        WorkflowExecution.node,
      ]),
      [
        [WorkflowExecution.node, WorkflowExecutionLocal.nodeWith(options)],
        [WorkflowExecutor.node, executor],
      ],
    ),
  )

const workerIt = makeWorkerIt(successfulExecutor)

const duplicateArtifactExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) =>
      Effect.succeed({
        usage: { tokens: 20, turns: 1, toolCalls: 0, attempts: 0 },
        artifacts: [
          {
            kind: "result",
            uri: `artifact://${stage.workflowID}/result.json`,
            mime: "application/json",
            sha256: "b".repeat(64),
            size: 2,
            metadata: {},
          },
          {
            kind: "result",
            uri: `artifact://${stage.workflowID}/result-copy.json`,
            mime: "application/json",
            sha256: "b".repeat(64),
            size: 2,
            metadata: {},
          },
        ],
      }),
  }),
)

const duplicateArtifactIt = makeWorkerIt(duplicateArtifactExecutor)

const slowExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: () => Effect.sleep(200).pipe(Effect.as({ usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 } })),
  }),
)

const leaseLossIt = makeWorkerIt(slowExecutor, {
  ownerID: "worker-lease-loss",
  leaseDurationMs: 5_000,
  heartbeatIntervalMs: 30,
  pollIntervalMs: 5,
  concurrency: 1,
})

const concurrencyProbe = { active: 0, max: 0 }
const concurrentExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: () =>
      Effect.sync(() => {
        concurrencyProbe.active += 1
        concurrencyProbe.max = Math.max(concurrencyProbe.max, concurrencyProbe.active)
      }).pipe(
        Effect.andThen(Effect.sleep(75)),
        Effect.ensuring(
          Effect.sync(() => {
            concurrencyProbe.active -= 1
          }),
        ),
        Effect.as({ usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 } }),
      ),
  }),
)

const concurrencyIt = makeWorkerIt(concurrentExecutor, {
  ...workerOptions,
  ownerID: "worker-concurrency",
  concurrency: 2,
})

const interruptIt = makeWorkerIt(slowExecutor, {
  ...workerOptions,
  ownerID: "worker-interrupt",
})

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

describe("Workflow lease acquisition", () => {
  it.effect("allows only one worker to lease one stage", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const input = createInput("one")
      yield* workflow.create(input)

      const results = yield* Effect.all(
        [
          store.claim({ owner: "worker-a", now: 1_000, leaseDurationMs: 30_000 }),
          store.claim({ owner: "worker-b", now: 1_000, leaseDurationMs: 30_000 }),
        ],
        { concurrency: "unbounded" },
      )

      expect(results.filter(Option.isSome)).toHaveLength(1)
      const stage = yield* store.stage(input.stages[0].id!)
      expect(stage?.attempt).toBe(1)
      if (!stage?.leaseOwner) throw new Error("leased stage is missing its owner")
      expect(["worker-a", "worker-b"]).toContain(stage.leaseOwner)

      const history = yield* workflow.history({ workflowID: input.id!, limit: 20 })
      expect(history.events.filter((event) => event.type === "workflow.stage.leased")).toHaveLength(1)
    }),
  )

  it.effect(
    "survives 100 repeated two-worker races without duplicate leases",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const store = yield* WorkflowStore.Service
        const winners = yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              yield* workflow.create(createInput(`race_${index}`))
              const results = yield* Effect.all(
                [
                  store.claim({ owner: `worker-a-${index}`, now: 2_000 + index, leaseDurationMs: 30_000 }),
                  store.claim({ owner: `worker-b-${index}`, now: 2_000 + index, leaseDurationMs: 30_000 }),
                ],
                { concurrency: "unbounded" },
              )
              return results.filter(Option.isSome).length
            }),
          { concurrency: 1 },
        )

        expect(winners).toEqual(Array.from({ length: 100 }, () => 1))
      }),
    30_000,
  )

  it.effect("renews only the current unexpired fencing token", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const input = createInput("renew")
      yield* workflow.create(input)
      const claimed = yield* store.claim({ owner: "worker-a", now: 1_000, leaseDurationMs: 30_000 })
      expect(Option.isSome(claimed)).toBe(true)

      expect(
        yield* store.renew({
          stageID: input.stages[0].id!,
          owner: "worker-a",
          attempt: 2,
          now: 2_000,
          expiresAt: 32_000,
        }),
      ).toBe(false)
      expect(
        yield* store.renew({
          stageID: input.stages[0].id!,
          owner: "worker-a",
          attempt: 1,
          now: 31_001,
          expiresAt: 61_001,
        }),
      ).toBe(false)
      expect(
        yield* store.renew({
          stageID: input.stages[0].id!,
          owner: "worker-a",
          attempt: 1,
          now: 30_000,
          expiresAt: 60_000,
        }),
      ).toBe(true)
    }),
  )
})

describe("Workflow executor", () => {
  it.effect("fails unsupported stages without exposing provider state", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const executor = yield* WorkflowExecutor.Service
      const input = createInput("unsupported")
      const run = yield* workflow.create(input)
      const claimed = yield* store.claim({ owner: "worker-a", now: 1_000, leaseDurationMs: 30_000 })
      const stage = Option.getOrThrow(claimed)

      const failure = yield* executor
        .execute({
          workflow: run,
          stage,
          lease: {
            owner: "worker-a",
            attempt: 1,
            expiresAt: DateTime.makeUnsafe(31_000),
          },
        })
        .pipe(Effect.flip)

      expect(failure).toEqual({
        failure: {
          category: "invalid_request",
          code: "unsupported_stage",
          message: "No executor is registered for stage type design",
        },
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
      })
    }),
  )
})

describe("Workflow local execution", () => {
  workerIt.live(
    "advances a created workflow through artifact commit to success",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_success")
        yield* workflow.create(input)

        const completed = yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.succeeded"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        expect(Option.isSome(completed)).toBe(true)
        const detail = yield* workflow.get(input.id!)
        expect(detail.run.status).toBe("succeeded")
        expect(detail.artifacts).toHaveLength(1)
      }),
    5_000,
  )

  workerIt.live(
    "runs two stages in ordinal order and commits each artifact before stage success",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const workflowID = Workflow.ID.make("wfl_worker_order")
        const first = Workflow.StageID.make("wfs_worker_order_first")
        const second = Workflow.StageID.make("wfs_worker_order_second")
        yield* workflow.create({
          id: workflowID,
          type: "development",
          input: { brief: "Build in order" },
          budget: { maxAttempts: 4 },
          stages: [
            {
              id: second,
              type: "build",
              ordinal: 1,
              maxAttempts: 2,
              recoveryPolicy: "restart_safe",
              idempotencyKey: "worker-order/build",
              input: {},
            },
            {
              id: first,
              type: "design",
              ordinal: 0,
              maxAttempts: 2,
              recoveryPolicy: "restart_safe",
              idempotencyKey: "worker-order/design",
              input: {},
            },
          ],
        })

        yield* workflow.events({ workflowID }).pipe(
          Stream.filter((event) => event.type === "workflow.succeeded"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        const history = yield* workflow.history({ workflowID, limit: 50 })
        const lifecycle = history.events.filter(
          (event) => event.type === "workflow.artifact.created" || event.type === "workflow.stage.succeeded",
        )
        expect(
          history.events.filter((event) => event.type === "workflow.stage.started").map((event) => event.data.stageID),
        ).toEqual([first, second])
        expect(lifecycle.map((event) => event.type)).toEqual([
          "workflow.artifact.created",
          "workflow.stage.succeeded",
          "workflow.artifact.created",
          "workflow.stage.succeeded",
        ])
      }),
    5_000,
  )

  duplicateArtifactIt.live(
    "keeps one artifact row for duplicate stage-kind-sha commits",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_duplicate_artifact")
        yield* workflow.create(input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.succeeded"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        const detail = yield* workflow.get(input.id!)
        expect(detail.artifacts).toHaveLength(1)
        expect(detail.artifacts[0].sha256).toBe("b".repeat(64))
      }),
    5_000,
  )

  leaseLossIt.live(
    "prevents stale success when heartbeat renewal loses the lease",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const execution = yield* WorkflowExecution.Service
        const database = yield* Database.Service
        const input = createInput("worker_lease_loss")
        yield* workflow.create(input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.stage.started"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )
        yield* database.db
          .update(WorkflowStageTable)
          .set({ lease_expires_at: 0 })
          .where(eq(WorkflowStageTable.id, input.stages[0].id!))
          .run()
          .pipe(Effect.orDie)
        yield* Effect.sleep(80)

        const detail = yield* workflow.get(input.id!)
        const history = yield* workflow.history({ workflowID: input.id!, limit: 50 })
        expect(detail.stages[0].status).toBe("running")
        expect(history.events.some((event) => event.type === "workflow.stage.succeeded")).toBe(false)
        expect(history.events.some((event) => event.type === "workflow.succeeded")).toBe(false)
        expect((yield* execution.active).has(input.id!)).toBe(false)
      }),
    5_000,
  )

  concurrencyIt.live(
    "runs different workflows concurrently without exceeding configured slots",
    () =>
      Effect.gen(function* () {
        concurrencyProbe.active = 0
        concurrencyProbe.max = 0
        const workflow = yield* WorkflowV2.Service
        const inputs = [
          createInput("worker_concurrent_a"),
          createInput("worker_concurrent_b"),
          createInput("worker_concurrent_c"),
        ]
        yield* Effect.forEach(inputs, workflow.create, { discard: true })
        yield* Effect.forEach(
          inputs,
          (input) =>
            workflow.events({ workflowID: input.id! }).pipe(
              Stream.filter((event) => event.type === "workflow.succeeded"),
              Stream.runHead,
              Effect.timeout("2 seconds"),
            ),
          { concurrency: "unbounded", discard: true },
        )

        expect(concurrencyProbe.max).toBe(2)
        expect(concurrencyProbe.active).toBe(0)
      }),
    5_000,
  )

  interruptIt.live(
    "returns copied active snapshots and treats idle interruption as a no-op",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const execution = yield* WorkflowExecution.Service
        const missing = Workflow.ID.make("wfl_worker_missing")
        yield* execution.interrupt(missing)

        const input = createInput("worker_interrupt")
        yield* workflow.create(input)
        yield* Effect.sleep(30)
        const first = yield* execution.active
        const second = yield* execution.active
        expect(first).not.toBe(second)
        expect(first.has(input.id!)).toBe(true)

        yield* execution.interrupt(input.id!)
        expect((yield* execution.active).has(input.id!)).toBe(false)
      }),
    5_000,
  )
})
