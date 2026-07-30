import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Option } from "effect"
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

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, WorkflowProjector.node])),
)

const createdData = {
  workflowID: "wfl_test",
  timestamp: DateTime.makeUnsafe(1_000),
  type: "development",
  input: { brief: "Build a page" },
  budget: { maxAttempts: 3 },
  stages: [
    {
      id: "wfs_design",
      type: "design",
      ordinal: 0,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe" as const,
      idempotencyKey: "wfl_test/design",
      input: {},
    },
    {
      id: "wfs_build",
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
  workflowID: "wfl_test",
  stageID: "wfs_design",
  timestamp: DateTime.makeUnsafe(2_000),
  attempt: opts.attempt,
  leaseOwner: opts.owner,
  leaseExpiresAt: DateTime.makeUnsafe(32_000),
})

const startedData = (opts: { owner: string; attempt: number }) => ({
  workflowID: "wfl_test",
  stageID: "wfs_design",
  timestamp: DateTime.makeUnsafe(3_000),
  attempt: opts.attempt,
  leaseOwner: opts.owner,
})

const retryData = (opts: { owner: string; attempt: number }) => ({
  workflowID: "wfl_test",
  stageID: "wfs_design",
  timestamp: DateTime.makeUnsafe(4_000),
  attempt: opts.attempt,
  leaseOwner: opts.owner,
  failure: { category: "transient" as const, code: "http_503", message: "busy" },
  usage: { tokens: 50, turns: 1, toolCalls: 0, attempts: 0 },
  notBefore: DateTime.makeUnsafe(5_000),
})

const succeededData = (opts: { owner: string; attempt: number }) => ({
  workflowID: "wfl_test",
  stageID: "wfs_design",
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
        ["wfs_design", "pending", 0],
        ["wfs_build", "pending", 0],
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
})
