import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { WorkflowRunTable, WorkflowStageTable } from "@opencode-ai/core/workflow/sql"
import { EventTable } from "@opencode-ai/core/event/sql"
import { testEffect } from "./lib/effect"
import { eq } from "drizzle-orm"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, WorkflowProjector.node])))

const workflowID = Workflow.ID.make("wfl_test")
const designStageID = Workflow.StageID.make("wfs_design")
const buildStageID = Workflow.StageID.make("wfs_build")

const createdData: (typeof WorkflowEvent.Created.Type)["data"] = {
  workflowID,
  timestamp: DateTime.makeUnsafe(1_000),
  type: "development",
  input: { brief: "Build a page" },
  budget: { maxAttempts: 3 },
  stages: [
    {
      id: designStageID,
      type: "design",
      ordinal: 0,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe" as const,
      idempotencyKey: "wfl_test/design",
      input: {},
    },
    {
      id: buildStageID,
      type: "build",
      ordinal: 1,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe" as const,
      idempotencyKey: "wfl_test/build",
      input: {},
    },
  ],
}

const leasedData = (opts: { owner: string; attempt: number }) => ({
  workflowID,
  stageID: designStageID,
  timestamp: DateTime.makeUnsafe(2_000),
  attempt: opts.attempt,
  leaseOwner: opts.owner,
  leaseExpiresAt: DateTime.makeUnsafe(32_000),
})

const startedData = (opts: { owner: string; attempt: number }) => ({
  workflowID,
  stageID: designStageID,
  timestamp: DateTime.makeUnsafe(3_000),
  attempt: opts.attempt,
  leaseOwner: opts.owner,
})

const checkpointedData = (opts: { owner: string; attempt: number }) => ({
  workflowID,
  stageID: designStageID,
  timestamp: DateTime.makeUnsafe(3_500),
  attempt: opts.attempt,
  leaseOwner: opts.owner,
  checkpoint: { kind: "workflow.model.continuation", version: 1, turns: [] },
})

const retryData = (opts: { owner: string; attempt: number }) => ({
  workflowID,
  stageID: designStageID,
  timestamp: DateTime.makeUnsafe(4_000),
  attempt: opts.attempt,
  leaseOwner: opts.owner,
  failure: { category: "transient" as const, code: "http_503", message: "busy" },
  usage: { tokens: 50, turns: 1, toolCalls: 0, attempts: 0 },
  notBefore: DateTime.makeUnsafe(5_000),
})

const succeededData = (opts: { owner: string; attempt: number }) => ({
  workflowID,
  stageID: designStageID,
  timestamp: DateTime.makeUnsafe(6_000),
  attempt: opts.attempt,
  leaseOwner: opts.owner,
  usage: { tokens: 100, turns: 1, toolCalls: 0, attempts: 0 },
})

describe("WorkflowProjector", () => {
  it.effect("rejects unsafe and oversized checkpoints before projection or durable insertion", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))

      const unsafe = yield* events
        .publish(WorkflowEvent.Stage.Checkpointed, {
          ...checkpointedData({ owner: "worker-a", attempt: 1 }),
          checkpoint: { apiKey: "sk-direct-checkpoint-secret" },
        })
        .pipe(Effect.exit)
      const oversized = yield* events
        .publish(WorkflowEvent.Stage.Checkpointed, {
          ...checkpointedData({ owner: "worker-a", attempt: 1 }),
          checkpoint: { payload: "x".repeat(256 * 1024) },
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(unsafe)).toBe(true)
      expect(Exit.isFailure(oversized)).toBe(true)
      expect(
        yield* db
          .select({ checkpoint: WorkflowStageTable.checkpoint })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ checkpoint: null })
      expect(
        yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(WorkflowEvent.Stage.Checkpointed.type, 1)))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
    }),
  )

  it.effect("rejects a lease whose attempt exceeds the stage maximum", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* events.publish(WorkflowEvent.Created, {
        ...createdData,
        budget: { maxAttempts: 3 },
        stages: [{ ...createdData.stages[0], maxAttempts: 1 }],
      })
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.RetryScheduled, retryData({ owner: "worker-a", attempt: 1 }))

      expect(
        Exit.isFailure(
          yield* events
            .publish(WorkflowEvent.Stage.Leased, {
              ...leasedData({ owner: "worker-b", attempt: 2 }),
              timestamp: DateTime.makeUnsafe(6_000),
              leaseExpiresAt: DateTime.makeUnsafe(36_000),
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  it.effect("persists checkpoints only for the live running lease", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Checkpointed, checkpointedData({ owner: "worker-a", attempt: 1 }))

      expect(
        yield* db
          .select({ checkpoint: WorkflowStageTable.checkpoint })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ checkpoint: checkpointedData({ owner: "worker-a", attempt: 1 }).checkpoint })

      yield* events.publish(WorkflowEvent.Stage.RetryScheduled, retryData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Leased, {
        ...leasedData({ owner: "worker-b", attempt: 2 }),
        timestamp: DateTime.makeUnsafe(6_000),
        leaseExpiresAt: DateTime.makeUnsafe(36_000),
      })
      yield* events.publish(WorkflowEvent.Stage.Started, {
        ...startedData({ owner: "worker-b", attempt: 2 }),
        timestamp: DateTime.makeUnsafe(7_000),
      })

      const stale = yield* events
        .publish(WorkflowEvent.Stage.Checkpointed, {
          ...checkpointedData({ owner: "worker-a", attempt: 1 }),
          timestamp: DateTime.makeUnsafe(8_000),
          checkpoint: { stale: true },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(stale)).toBe(true)
      expect(
        yield* db
          .select({ checkpoint: WorkflowStageTable.checkpoint })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ checkpoint: checkpointedData({ owner: "worker-a", attempt: 1 }).checkpoint })
    }),
  )

  it.effect("rejects checkpoints after cancellation", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* events.publish(WorkflowEvent.Created, createdData)
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.CancelRequested, {
        workflowID,
        timestamp: DateTime.makeUnsafe(3_250),
      })

      const cancelled = yield* events
        .publish(WorkflowEvent.Stage.Checkpointed, checkpointedData({ owner: "worker-a", attempt: 1 }))
        .pipe(Effect.exit)
      expect(Exit.isFailure(cancelled)).toBe(true)
    }),
  )

  it.effect("projects one run and ordered immutable stages", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)

      const runs = yield* db.select().from(WorkflowRunTable).all().pipe(Effect.orDie)
      const stages = yield* db
        .select()
        .from(WorkflowStageTable)
        .orderBy(WorkflowStageTable.ordinal)
        .all()
        .pipe(Effect.orDie)

      expect(runs).toMatchObject([{ id: "wfl_test", status: "queued", version: 0 }])
      expect(stages.map((s) => [s.id, s.status, s.attempt])).toEqual([
        [designStageID, "pending", 0],
        [buildStageID, "pending", 0],
      ])
    }),
  )

  it.effect("rolls back a stale completion event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* events.publish(WorkflowEvent.Created, createdData)
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.RetryScheduled, retryData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-b", attempt: 2 }))

      const failed = yield* events
        .publish(WorkflowEvent.Stage.Succeeded, succeededData({ owner: "worker-a", attempt: 1 }))
        .pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
    }),
  )

  it.effect("rejects leasing a stage through another workflow aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)

      const failed = yield* events
        .publish(WorkflowEvent.Stage.Leased, {
          ...leasedData({ owner: "worker-a", attempt: 1 }),
          workflowID: Workflow.ID.make("wfl_other"),
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(
        yield* db
          .select({ status: WorkflowStageTable.status, attempt: WorkflowStageTable.attempt })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "pending", attempt: 0 })
    }),
  )

  it.effect("projects attempt and settlement usage exactly once", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.RetryScheduled, retryData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Leased, {
        ...leasedData({ owner: "worker-b", attempt: 2 }),
        timestamp: DateTime.makeUnsafe(6_000),
        leaseExpiresAt: DateTime.makeUnsafe(36_000),
      })
      yield* events.publish(WorkflowEvent.Stage.Started, {
        ...startedData({ owner: "worker-b", attempt: 2 }),
        timestamp: DateTime.makeUnsafe(7_000),
      })
      yield* events.publish(WorkflowEvent.Stage.Succeeded, {
        ...succeededData({ owner: "worker-b", attempt: 2 }),
        timestamp: DateTime.makeUnsafe(8_000),
      })

      expect(
        yield* db
          .select({ usage: WorkflowRunTable.usage })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, workflowID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ usage: { tokens: 150, turns: 2, toolCalls: 0, attempts: 2 } })
    }),
  )

  it.effect("rolls back a final stage when its related workflow terminal projector fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const onlyStage = Workflow.StageID.make("wfs_atomic_terminal")
      yield* events.publish(WorkflowEvent.Created, {
        ...createdData,
        stages: [{ ...createdData.stages[0], id: onlyStage, ordinal: 0 }],
      })
      yield* events.publish(WorkflowEvent.Stage.Leased, {
        ...leasedData({ owner: "worker-a", attempt: 1 }),
        stageID: onlyStage,
      })
      yield* events.publish(WorkflowEvent.Stage.Started, {
        ...startedData({ owner: "worker-a", attempt: 1 }),
        stageID: onlyStage,
      })
      yield* events.project(WorkflowEvent.Succeeded, () => Effect.die(new Error("injected terminal failure")))

      const failed = yield* events
        .publish(
          WorkflowEvent.Stage.Succeeded,
          {
            ...succeededData({ owner: "worker-a", attempt: 1 }),
            stageID: onlyStage,
          },
          {
            related: [
              {
                definition: WorkflowEvent.Succeeded,
                data: {
                  workflowID,
                  timestamp: DateTime.makeUnsafe(6_000),
                  usage: { tokens: 100, turns: 1, toolCalls: 0, attempts: 1 },
                },
              },
            ],
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(
        yield* db
          .select({ run: WorkflowRunTable.status, stage: WorkflowStageTable.status })
          .from(WorkflowStageTable)
          .innerJoin(WorkflowRunTable, eq(WorkflowRunTable.id, WorkflowStageTable.workflow_id))
          .where(eq(WorkflowStageTable.id, onlyStage))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ run: "queued", stage: "running" })
    }),
  )

  it.effect("rejects workflow success while a stage is nonterminal", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)

      const failed = yield* events
        .publish(WorkflowEvent.Succeeded, {
          workflowID,
          timestamp: DateTime.makeUnsafe(2_000),
          usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(
        yield* db
          .select({ status: WorkflowRunTable.status })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, workflowID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "queued" })
    }),
  )

  it.effect("pauses only the run for budget approval and resumes it after an increase", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)
      yield* events.publish(WorkflowEvent.Approval.Requested, {
        workflowID,
        timestamp: DateTime.makeUnsafe(2_000),
        reason: "budget_exhausted",
      })

      expect(
        yield* db
          .select({ status: WorkflowRunTable.status })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, workflowID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "waiting_approval" })
      expect(
        yield* db
          .select({ status: WorkflowStageTable.status })
          .from(WorkflowStageTable)
          .orderBy(WorkflowStageTable.ordinal)
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ status: "pending" }, { status: "pending" }])

      yield* events.publish(WorkflowEvent.Budget.Updated, {
        workflowID,
        timestamp: DateTime.makeUnsafe(3_000),
        budget: { maxAttempts: 4 },
      })
      expect(
        yield* db
          .select({ status: WorkflowRunTable.status })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, workflowID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "queued" })
    }),
  )

  it.effect("keeps ambiguous execution approval paused across a budget increase", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Approval.Requested, {
        workflowID,
        stageID: designStageID,
        timestamp: DateTime.makeUnsafe(4_000),
        reason: "ambiguous_execution",
        failure: { category: "ambiguous", code: "lost", message: "unknown result" },
      })
      yield* events.publish(WorkflowEvent.Budget.Updated, {
        workflowID,
        timestamp: DateTime.makeUnsafe(5_000),
        budget: { maxAttempts: 4 },
      })

      expect(
        yield* db
          .select({ status: WorkflowRunTable.status })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, workflowID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "waiting_approval" })
      expect(
        yield* db
          .select({ status: WorkflowStageTable.status, leaseOwner: WorkflowStageTable.lease_owner })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "waiting_approval", leaseOwner: null })
    }),
  )

  it.effect("consumes recovery retry authorization at the next durable checkpoint", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Approval.Requested, {
        workflowID,
        stageID: designStageID,
        timestamp: DateTime.makeUnsafe(4_000),
        reason: "ambiguous_execution",
        failure: { category: "ambiguous", code: "tool_execution_ambiguous", message: "unknown result" },
      })
      yield* events.publish(
        WorkflowEvent.Approval.Resolved,
        {
          workflowID,
          stageID: designStageID,
          timestamp: DateTime.makeUnsafe(5_000),
          action: "retry",
        },
        {
          related: [
            {
              definition: WorkflowEvent.Stage.RetryScheduled,
              data: {
                workflowID,
                stageID: designStageID,
                timestamp: DateTime.makeUnsafe(5_000),
                attempt: 1,
                failure: { category: "ambiguous", code: "recovery_retry", message: "explicit retry" },
                usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
                notBefore: DateTime.makeUnsafe(5_000),
              },
            },
          ],
        },
      )
      yield* events.publish(WorkflowEvent.Stage.Leased, {
        ...leasedData({ owner: "worker-b", attempt: 2 }),
        timestamp: DateTime.makeUnsafe(6_000),
        leaseExpiresAt: DateTime.makeUnsafe(36_000),
      })
      yield* events.publish(WorkflowEvent.Stage.Started, {
        ...startedData({ owner: "worker-b", attempt: 2 }),
        timestamp: DateTime.makeUnsafe(6_100),
      })
      yield* events.publish(WorkflowEvent.Stage.Checkpointed, {
        ...checkpointedData({ owner: "worker-b", attempt: 2 }),
        timestamp: DateTime.makeUnsafe(6_200),
        checkpoint: { kind: "workflow.model.continuation", version: 1, activeTurn: { pendingCallID: "call-1" } },
      })

      expect(
        yield* db
          .select({ recoveryAction: WorkflowStageTable.recovery_action })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ recoveryAction: null })
      yield* events.publish(WorkflowEvent.Approval.Requested, {
        workflowID,
        stageID: designStageID,
        timestamp: DateTime.makeUnsafe(6_300),
        reason: "ambiguous_execution",
        failure: { category: "ambiguous", code: "tool_execution_ambiguous", message: "unknown again" },
      })
      expect(
        yield* db
          .select({ status: WorkflowStageTable.status, recoveryAction: WorkflowStageTable.recovery_action })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "waiting_approval", recoveryAction: null })
    }),
  )

  it.effect("rejects a stale budget event that would reduce a concurrently increased limit", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, {
        ...createdData,
        budget: { maxTokens: 100, maxAttempts: 3 },
      })
      yield* events.publish(WorkflowEvent.Budget.Updated, {
        workflowID,
        timestamp: DateTime.makeUnsafe(2_000),
        budget: { maxTokens: 200, maxAttempts: 3 },
      })
      const stale = yield* events
        .publish(WorkflowEvent.Budget.Updated, {
          workflowID,
          timestamp: DateTime.makeUnsafe(2_001),
          budget: { maxTokens: 150, maxAttempts: 3 },
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(stale)).toBe(true)
      expect(
        yield* db
          .select({ budget: WorkflowRunTable.budget })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, workflowID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ budget: { maxTokens: 200, maxAttempts: 3 } })
    }),
  )
})
