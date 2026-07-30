import { describe, expect } from "bun:test"
import { DateTime, Effect, Option } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { Workflow } from "@opencode-ai/schema/workflow"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([WorkflowV2.node, WorkflowStore.node, WorkflowExecutor.node])),
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
