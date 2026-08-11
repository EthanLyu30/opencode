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
import { WorkflowStageMachine } from "@opencode-ai/core/workflow/stage-machine"
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

const incompleteRoleHistoryExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) => {
      const metadata = { schemaVersion: 1, role: "design", verdict: "ready", revision: 0 }
      const body = JSON.stringify(metadata)
      return Effect.succeed({
        usage: { tokens: 8, turns: 1, toolCalls: 0, attempts: 0 },
        artifacts: [
          {
            kind: WorkflowStageMachine.OUTCOME_ARTIFACT_KIND,
            uri: `artifact://${stage.workflowID}/incomplete-role-outcome.json`,
            mime: WorkflowStageMachine.OUTCOME_ARTIFACT_MIME,
            sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
            size: new TextEncoder().encode(body).byteLength,
            metadata,
          },
        ],
      })
    },
  }),
)

const incompleteRoleHistoryIt = makeWorkerIt(incompleteRoleHistoryExecutor)

const classifiedFailureExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) => {
      if (stage.attempt > 1) {
        return Effect.succeed({ usage: { tokens: 20, turns: 1, toolCalls: 0, attempts: 0 } })
      }
      return Effect.fail({
        failure: {
          category: "transient" as const,
          code: "rate_limit",
          message: "Bearer live-secret-token must wait",
          retryAfterMs: 0,
        },
        usage: { tokens: 10, turns: 1, toolCalls: 0, attempts: 0 },
      })
    },
  }),
)

const classifiedFailureIt = makeWorkerIt(classifiedFailureExecutor)

const permanentFailureExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: () =>
      Effect.fail({
        failure: { category: "authentication" as const, code: "invalid_key", message: "bad key" },
        usage: { tokens: 7, turns: 1, toolCalls: 0, attempts: 0 },
      }),
  }),
)

const permanentFailureIt = makeWorkerIt(permanentFailureExecutor)

const ambiguousFailureExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: () =>
      Effect.fail({
        failure: { category: "ambiguous" as const, code: "lost", message: "unknown result" },
        usage: { tokens: 5, turns: 1, toolCalls: 1, attempts: 0 },
      }),
  }),
)

const ambiguousFailureIt = makeWorkerIt(ambiguousFailureExecutor)

const deadlineProbe: { remainingDurationMs?: number } = {}
const deadlineExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: (input) =>
      Effect.sync(() => {
        deadlineProbe.remainingDurationMs = input.remainingDurationMs
      }).pipe(
        Effect.andThen(Effect.sleep(200)),
        Effect.as({ usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 } }),
      ),
  }),
)

const deadlineIt = makeWorkerIt(deadlineExecutor)

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

const waitForActive = Effect.fnUntraced(function* (
  execution: WorkflowExecution.Interface,
  workflowID: Workflow.ID,
  expected: boolean,
) {
  while ((yield* execution.active).has(workflowID) !== expected) {
    yield* Effect.sleep(10)
  }
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
          stages: [stage],
          artifacts: [],
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
  incompleteRoleHistoryIt.live("fails final role validation before stage success can make the run stick", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const input = createInput("incomplete_role_history")
      yield* workflow.create(input)
      yield* workflow.events({ workflowID: input.id! }).pipe(
        Stream.filter((event) => event.type === "workflow.failed"),
        Stream.runHead,
        Effect.timeout("2 seconds"),
      )

      const detail = yield* workflow.get(input.id!)
      expect(detail.run.status).toBe("failed")
      expect(detail.stages[0].status).toBe("failed")
      expect(detail.stages[0].error?.code).toBe("incomplete_role_workflow")
    }),
  )

  deadlineIt.live(
    "times out at the workflow deadline before the duration gate requests approval",
    () =>
      Effect.gen(function* () {
        deadlineProbe.remainingDurationMs = undefined
        const workflow = yield* WorkflowV2.Service
        const input = {
          ...createInput("worker_deadline"),
          budget: { maxAttempts: 3, maxDurationMs: 100 },
        }
        yield* workflow.create(input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter(
            (event) => event.type === "workflow.approval.requested" && event.data.reason === "budget_exhausted",
          ),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        const detail = yield* workflow.get(input.id!)
        const history = yield* workflow.history({ workflowID: input.id!, limit: 50 })
        expect(deadlineProbe.remainingDurationMs).toBeGreaterThan(0)
        expect(deadlineProbe.remainingDurationMs).toBeLessThanOrEqual(100)
        expect(detail.run.status).toBe("waiting_approval")
        expect(detail.stages[0].status).toBe("retry_wait")
        expect(
          history.events.some(
            (event) =>
              event.type === "workflow.stage.retry_scheduled" && event.data.failure.code === "workflow_deadline",
          ),
        ).toBe(true)
        const retry = history.events.find((event) => event.type === "workflow.stage.retry_scheduled")
        const approval = history.events.find(
          (event) => event.type === "workflow.approval.requested" && event.data.reason === "budget_exhausted",
        )
        if (!retry || !approval) throw new Error("deadline history is incomplete")
        expect(
          DateTime.toEpochMillis(approval.data.timestamp) - DateTime.toEpochMillis(retry.data.timestamp),
        ).toBeLessThan(200)
        expect(
          history.events
            .filter((event) => event.type === "workflow.budget.threshold_reached")
            .map((event) => event.data.percent),
        ).toEqual([50, 80, 100])
      }),
    5_000,
  )

  classifiedFailureIt.live(
    "retries transient execution failures and persists sanitized history exactly once",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_retry")
        yield* workflow.create(input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.succeeded"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        const detail = yield* workflow.get(input.id!)
        const history = yield* workflow.history({ workflowID: input.id!, limit: 50 })
        expect(detail.run.usage).toEqual({ tokens: 30, turns: 2, toolCalls: 0, attempts: 2 })
        expect(history.events.filter((event) => event.type === "workflow.stage.retry_scheduled")).toHaveLength(1)
        expect(history.events.filter((event) => event.type === "workflow.stage.leased")).toHaveLength(2)
        expect(JSON.stringify(history.events)).not.toContain("live-secret")
      }),
    5_000,
  )

  permanentFailureIt.live(
    "fails the stage and run for a non-retryable execution failure",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_permanent_failure")
        yield* workflow.create(input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.failed"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        const detail = yield* workflow.get(input.id!)
        const history = yield* workflow.history({ workflowID: input.id!, limit: 50 })
        expect(detail.run.status).toBe("failed")
        expect(detail.stages[0].status).toBe("failed")
        expect(detail.run.usage).toEqual({ tokens: 7, turns: 1, toolCalls: 0, attempts: 1 })
        expect(history.events.map((event) => event.type)).toContain("workflow.stage.failed")
      }),
    5_000,
  )

  ambiguousFailureIt.live(
    "pauses an ambiguous execution for approval and accounts its usage",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_ambiguous_failure")
        yield* workflow.create(input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.approval.requested"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        const detail = yield* workflow.get(input.id!)
        expect(detail.run.status).toBe("waiting_approval")
        expect(detail.stages[0].status).toBe("waiting_approval")
        expect(detail.run.usage).toEqual({ tokens: 5, turns: 1, toolCalls: 1, attempts: 1 })
      }),
    5_000,
  )

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
        yield* waitForActive(execution, input.id!, false).pipe(Effect.timeout("2 seconds"))

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
    "settles interrupted execution as cancelled before results can commit",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_cancel")
        yield* workflow.create(input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.stage.started"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        yield* Effect.all([workflow.cancel(input.id!), workflow.cancel(input.id!)], {
          concurrency: "unbounded",
          discard: true,
        })
        yield* workflow.cancel(input.id!)

        const detail = yield* workflow.get(input.id!)
        expect(detail.run.status).toBe("cancelled")
        expect(detail.stages[0].status).toBe("cancelled")
        expect(detail.artifacts).toEqual([])

        const history = yield* workflow.history({ workflowID: input.id!, limit: 50 })
        const types = history.events.map((event) => event.type)
        expect(history.events.filter((event) => event.type === "workflow.cancel.requested")).toHaveLength(1)
        expect(history.events.filter((event) => event.type === "workflow.stage.cancelled")).toHaveLength(1)
        expect(history.events.filter((event) => event.type === "workflow.cancelled")).toHaveLength(1)
        expect(types.indexOf("workflow.cancel.requested")).toBeLessThan(types.indexOf("workflow.stage.cancelled"))
        expect(types).not.toContain("workflow.stage.succeeded")
        expect(types).not.toContain("workflow.succeeded")
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
        yield* waitForActive(execution, input.id!, true).pipe(Effect.timeout("2 seconds"))
        const first = yield* execution.active
        const second = yield* execution.active
        expect(first).not.toBe(second)
        expect(first.has(input.id!)).toBe(true)

        yield* execution.interrupt(input.id!)
        yield* waitForActive(execution, input.id!, false).pipe(Effect.timeout("2 seconds"))
        expect((yield* execution.active).has(input.id!)).toBe(false)
      }),
    5_000,
  )
})
