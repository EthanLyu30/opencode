import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Exit, Option } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowBudget } from "../src/workflow/budget"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Session } from "@opencode-ai/schema/session"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([EventV2.node, WorkflowV2.node, WorkflowStore.node, WorkflowExecutor.node])),
)

const admit = (workflow: WorkflowV2.Interface, input: Workflow.CreateInput) =>
  workflow.admit({
    ...input,
    location: Location.Ref.make({ directory: AbsolutePath.make("D:\\OpenCode-Audit") }),
    sessionID: Session.ID.make("ses_workflow_budget"),
    agent: Agent.ID.make("build"),
  })

describe("WorkflowBudget", () => {
  test("reports every newly crossed threshold once", () => {
    expect(
      WorkflowBudget.evaluate({
        budget: { maxTokens: 1_000, maxAttempts: 4 },
        usage: { tokens: 810, turns: 0, toolCalls: 0, attempts: 2 },
        notified: 0,
        elapsedMs: 1_000,
      }),
    ).toEqual({
      exhausted: false,
      thresholds: [
        { percent: 50, dimension: "tokens" },
        { percent: 80, dimension: "tokens" },
      ],
    })
  })

  test("does not report a threshold whose durable bit is already set", () => {
    expect(
      WorkflowBudget.evaluate({
        budget: { maxTokens: 1_000 },
        usage: { tokens: 810, turns: 0, toolCalls: 0, attempts: 0 },
        notified: 1,
        elapsedMs: 0,
      }).thresholds,
    ).toEqual([{ percent: 80, dimension: "tokens" }])
  })

  test("uses the highest ratio and enforces duration and zero limits", () => {
    expect(
      WorkflowBudget.evaluate({
        budget: { maxTokens: 0, maxDurationMs: 100 },
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
        notified: 0,
        elapsedMs: 90,
      }),
    ).toEqual({
      exhausted: true,
      thresholds: [
        { percent: 50, dimension: "tokens" },
        { percent: 80, dimension: "tokens" },
        { percent: 100, dimension: "tokens" },
      ],
    })
  })

  test("validates only meaningful monotonic budget increases above consumption", () => {
    const base = {
      current: { maxTokens: 100, maxAttempts: 2 },
      usage: { tokens: 80, turns: 1, toolCalls: 0, attempts: 1 },
      elapsedMs: 500,
    } as const

    expect(WorkflowBudget.validateIncrease({ ...base, next: { maxTokens: 200, maxAttempts: 2 } })).toBe(true)
    expect(WorkflowBudget.validateIncrease({ ...base, next: { maxTokens: 100, maxAttempts: 2 } })).toBe(false)
    expect(WorkflowBudget.validateIncrease({ ...base, next: { maxTokens: 99, maxAttempts: 2 } })).toBe(false)
    expect(WorkflowBudget.validateIncrease({ ...base, next: { maxTokens: 200 } })).toBe(false)
    expect(
      WorkflowBudget.validateIncrease({
        ...base,
        next: { maxTokens: 200, maxAttempts: 2, maxTurns: 0 },
      }),
    ).toBe(false)
    expect(
      WorkflowBudget.validateIncrease({
        ...base,
        next: { maxTokens: 200, maxAttempts: 2, maxDurationMs: 499 },
      }),
    ).toBe(false)
  })

  it.effect("does not lease the next stage after 100 percent until budget increases", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const events = yield* EventV2.Service
      const workflowID = Workflow.ID.make("wfl_budget_gate")
      const firstID = Workflow.StageID.make("wfs_budget_gate_first")
      const secondID = Workflow.StageID.make("wfs_budget_gate_second")
      yield* admit(workflow, {
        id: workflowID,
        type: "development",
        input: {},
        budget: { maxTokens: 100, maxAttempts: 4 },
        stages: [
          {
            id: firstID,
            type: "design",
            ordinal: 0,
            maxAttempts: 2,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "budget-gate/design",
            input: {},
          },
          {
            id: secondID,
            type: "build",
            ordinal: 1,
            maxAttempts: 2,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "budget-gate/build",
            input: {},
          },
        ],
      })

      const first = Option.getOrThrow(yield* store.claim({ owner: "worker-a", now: 1_000, leaseDurationMs: 30_000 }))
      yield* events.publish(WorkflowEvent.Started, {
        workflowID,
        timestamp: DateTime.makeUnsafe(1_100),
      })
      yield* events.publish(WorkflowEvent.Stage.Started, {
        workflowID,
        stageID: first.id,
        timestamp: DateTime.makeUnsafe(1_200),
        attempt: first.attempt,
        leaseOwner: first.leaseOwner,
      })
      yield* events.publish(WorkflowEvent.Stage.Succeeded, {
        workflowID,
        stageID: first.id,
        timestamp: DateTime.makeUnsafe(1_300),
        attempt: first.attempt,
        leaseOwner: first.leaseOwner,
        usage: { tokens: 100, turns: 1, toolCalls: 0, attempts: 0 },
      })

      const blocked = yield* Effect.all(
        [
          store.claim({ owner: "worker-b", now: 2_000, leaseDurationMs: 30_000 }),
          store.claim({ owner: "worker-c", now: 2_000, leaseDurationMs: 30_000 }),
        ],
        { concurrency: "unbounded" },
      )
      expect(blocked.every(Option.isNone)).toBe(true)
      expect((yield* workflow.get(workflowID)).run.status).toBe("waiting_approval")
      const history = yield* workflow.history({ workflowID, limit: 50 })
      expect(
        history.events
          .filter((event) => event.type === "workflow.budget.threshold_reached")
          .map((event) => event.data.percent),
      ).toEqual([50, 80, 100])
      expect(history.events.filter((event) => event.type === "workflow.approval.requested")).toHaveLength(1)

      yield* workflow.updateBudget({
        workflowID,
        budget: { maxTokens: 200, maxAttempts: 4 },
      })
      const second = yield* store.claim({ owner: "worker-b", now: 2_001, leaseDurationMs: 30_000 })
      expect(Option.isSome(second)).toBe(true)
      expect(Option.getOrThrow(second).id).toBe(secondID)
    }),
  )

  it.effect("rejects unchanged, reduced, and already-consumed budget updates through the service", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const events = yield* EventV2.Service
      const workflowID = Workflow.ID.make("wfl_budget_update_validation")
      const stageID = Workflow.StageID.make("wfs_budget_update_validation")
      yield* admit(workflow, {
        id: workflowID,
        type: "development",
        input: {},
        budget: { maxTokens: 100, maxAttempts: 4 },
        stages: [
          {
            id: stageID,
            type: "design",
            ordinal: 0,
            maxAttempts: 2,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "budget-update/design",
            input: {},
          },
        ],
      })
      const stage = Option.getOrThrow(yield* store.claim({ owner: "worker-a", now: 1_000, leaseDurationMs: 30_000 }))
      yield* events.publish(WorkflowEvent.Started, { workflowID, timestamp: DateTime.makeUnsafe(1_100) })
      yield* events.publish(WorkflowEvent.Stage.Started, {
        workflowID,
        stageID,
        timestamp: DateTime.makeUnsafe(1_200),
        attempt: stage.attempt,
        leaseOwner: stage.leaseOwner,
      })
      yield* events.publish(WorkflowEvent.Stage.Succeeded, {
        workflowID,
        stageID,
        timestamp: DateTime.makeUnsafe(1_300),
        attempt: stage.attempt,
        leaseOwner: stage.leaseOwner,
        usage: { tokens: 80, turns: 1, toolCalls: 0, attempts: 0 },
      })

      const updates = yield* Effect.all(
        [
          workflow.updateBudget({ workflowID, budget: { maxTokens: 100, maxAttempts: 4 } }),
          workflow.updateBudget({ workflowID, budget: { maxTokens: 99, maxAttempts: 4 } }),
          workflow.updateBudget({
            workflowID,
            budget: { maxTokens: 200, maxTurns: 0, maxAttempts: 4 },
          }),
        ].map(Effect.exit),
        { concurrency: 1 },
      )
      expect(updates.every(Exit.isFailure)).toBe(true)
    }),
  )
})
