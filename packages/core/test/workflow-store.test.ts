import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Session } from "@opencode-ai/schema/session"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowRunTable } from "@opencode-ai/core/workflow/sql"
import { EventTable } from "@opencode-ai/core/event/sql"
import { testEffect } from "./lib/effect"
import { and, eq } from "drizzle-orm"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, WorkflowProjector.node, WorkflowStore.node])),
)

const workflowID1 = Workflow.ID.make("wfl_test1")
const workflowID2 = Workflow.ID.make("wfl_test2")
const designStageID = Workflow.StageID.make("wfs_d1")
const buildStageID = Workflow.StageID.make("wfs_b1")
const reviewStageID = Workflow.StageID.make("wfs_r2")
const location = Location.Ref.make({ directory: AbsolutePath.make("D:\\OpenCode-Audit") })
const sessionID = Session.ID.make("ses_store")
const agent = Agent.ID.make("build")

const createData1: (typeof WorkflowEvent.Created.Type)["data"] = {
  workflowID: workflowID1,
  timestamp: DateTime.makeUnsafe(1_000),
  type: "development",
  input: { brief: "Build a page" },
  budget: { maxAttempts: 3 },
  location,
  sessionID,
  agent,
  stages: [
    {
      id: designStageID,
      type: "design",
      ordinal: 0,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe" as const,
      idempotencyKey: "t1/design",
      input: {},
    },
    {
      id: buildStageID,
      type: "build",
      ordinal: 1,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe" as const,
      idempotencyKey: "t1/build",
      input: {},
    },
  ],
}

const createData2: (typeof WorkflowEvent.Created.Type)["data"] = {
  workflowID: workflowID2,
  timestamp: DateTime.makeUnsafe(2_000),
  type: "review",
  input: { pr: 42 },
  budget: { maxTokens: 5000 },
  location,
  sessionID: Session.ID.make("ses_store_review"),
  agent,
  stages: [
    {
      id: reviewStageID,
      type: "review",
      ordinal: 0,
      maxAttempts: 2,
      recoveryPolicy: "manual_required" as const,
      idempotencyKey: "t2/review",
      input: {},
    },
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

      const detail = yield* store.get(workflowID1)
      expect(detail).toBeDefined()
      expect(detail!.run.id).toBe(workflowID1)
      expect(detail!.stages).toHaveLength(2)
      expect(detail!.stages.map((s) => s.id)).toEqual([designStageID, buildStageID])
    }),
  )

  it.effect("returns immutable artifacts in creation order", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkflowStore.Service
      yield* events.publish(WorkflowEvent.Created, createData1)
      yield* events.publish(WorkflowEvent.Artifact.Created, {
        workflowID: workflowID1,
        stageID: designStageID,
        timestamp: DateTime.makeUnsafe(5_000),
        artifact: {
          id: Workflow.ArtifactID.make("wfa_a"),
          workflowID: workflowID1,
          stageID: designStageID,
          kind: "result",
          uri: "artifact://wfl_test1/result.json",
          mime: "application/json",
          sha256: "a".repeat(64),
          size: 2,
          metadata: {},
          timeCreated: DateTime.makeUnsafe(5_000),
        },
      })

      const artifacts = yield* store.artifacts(workflowID1)
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
      expect(candidates[0].id).toBe(designStageID)
    }),
  )

  it.effect("never claims an active legacy workflow without placement and durably requests configuration", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkflowStore.Service
      const { db } = yield* Database.Service
      const legacyWorkflowID = Workflow.ID.make("wfl_legacy_unbound")
      yield* events.publish(WorkflowEvent.Created, {
        ...createData1,
        workflowID: legacyWorkflowID,
        location: undefined,
        sessionID: undefined,
        agent: undefined,
        stages: [
          {
            ...createData1.stages[0],
            id: Workflow.StageID.make("wfs_legacy_unbound"),
            idempotencyKey: "wfl_legacy_unbound/design",
          },
        ],
      })

      expect(yield* store.claimCandidates({ now: 2_000, limit: 10 })).toEqual([])
      expect(
        yield* db
          .select({ status: WorkflowRunTable.status })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, legacyWorkflowID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "waiting_approval" })
      expect(
        yield* db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(
            and(
              eq(EventTable.aggregate_id, legacyWorkflowID),
              eq(EventTable.type, EventV2.versionedType(WorkflowEvent.Approval.Requested.type, 1)),
            ),
          )
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        data: {
          reason: "workflow_location_required",
          failure: { code: "workflow_location_required" },
        },
      })
    }),
  )
})
