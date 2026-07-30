import { describe, expect } from "bun:test"
import { DateTime, Effect, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { sql } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, WorkflowProjector.node, WorkflowStore.node])),
)

const createData1 = {
  workflowID: "wfl_test1",
  timestamp: DateTime.makeUnsafe(1_000),
  type: "development",
  input: { brief: "Build a page" },
  budget: { maxAttempts: 3 },
  stages: [
    { id: "wfs_d1", type: "design", ordinal: 0, maxAttempts: 3, recoveryPolicy: "restart_safe" as const, idempotencyKey: "t1/design", input: {} },
    { id: "wfs_b1", type: "build", ordinal: 1, maxAttempts: 3, recoveryPolicy: "restart_safe" as const, idempotencyKey: "t1/build", input: {} },
  ],
}

const createData2 = {
  workflowID: "wfl_test2",
  timestamp: DateTime.makeUnsafe(2_000),
  type: "review",
  input: { pr: 42 },
  budget: { maxTokens: 5000 },
  stages: [
    { id: "wfs_r2", type: "review", ordinal: 0, maxAttempts: 2, recoveryPolicy: "manual_required" as const, idempotencyKey: "t2/review", input: {} },
  ],
}

describe("WorkflowStore", () => {
  it.effect("lists workflows filtered by status", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkflowStore.Service
      yield* events.publish(WorkflowEvent.Created, createData1)
      yield* events.publish(WorkflowEvent.Created, createData2)

      const all = yield* store.list()
      expect(all).toHaveLength(2)

      const queued = yield* store.list({ status: "queued" })
      expect(queued).toHaveLength(2)

      const running = yield* store.list({ status: "running" })
      expect(running).toHaveLength(0)
    }),
  )

  it.effect("gets a workflow with detail including stages", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkflowStore.Service
      yield* events.publish(WorkflowEvent.Created, createData1)

      const detail = yield* store.get("wfl_test1")
      expect(detail).toBeDefined()
      expect(detail!.run.id).toBe("wfl_test1")
      expect(detail!.stages).toHaveLength(2)
      expect(detail!.stages.map((s) => s.id)).toEqual(["wfs_d1", "wfs_b1"])
    }),
  )

  it.effect("returns immutable artifacts in creation order", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkflowStore.Service
      yield* events.publish(WorkflowEvent.Created, createData1)
      yield* events.publish(WorkflowEvent.Artifact.Created, {
        workflowID: "wfl_test1",
        stageID: "wfs_d1",
        timestamp: DateTime.makeUnsafe(5_000),
        artifact: {
          id: "wfa_a",
          workflowID: "wfl_test1",
          stageID: "wfs_d1",
          kind: "result",
          uri: "artifact://wfl_test1/result.json",
          mime: "application/json",
          sha256: "a".repeat(64),
          size: 2,
          metadata: {},
          timeCreated: DateTime.makeUnsafe(5_000),
        },
      })

      const artifacts = yield* store.artifacts("wfl_test1")
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].sha256).toBe("a".repeat(64))
    }),
  )

  it.effect("claims only one candidate per stage concurrently", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkflowStore.Service
      yield* events.publish(WorkflowEvent.Created, createData1)

      const candidates = yield* store.claimCandidates({ now: 1_000, limit: 10 })
      expect(candidates).toHaveLength(1)
      expect(candidates[0].id).toBe("wfs_d1")
    }),
  )
})
