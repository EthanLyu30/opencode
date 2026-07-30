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
})
