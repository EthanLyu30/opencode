import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Workspace } from "@opencode-ai/schema/workspace"
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Session } from "@opencode-ai/schema/session"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { WorkflowStageMachine } from "@opencode-ai/core/workflow/stage-machine"
import { WorkflowArtifactTable, WorkflowRunTable, WorkflowStageTable } from "@opencode-ai/core/workflow/sql"
import { EventTable } from "@opencode-ai/core/event/sql"
import { testEffect } from "./lib/effect"
import { eq } from "drizzle-orm"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, WorkflowProjector.node])))

const workflowID = Workflow.ID.make("wfl_test")
const designStageID = Workflow.StageID.make("wfs_design")
const buildStageID = Workflow.StageID.make("wfs_build")
const workspaceID = Workspace.ID.make("wrk_projector")
const location = Location.Ref.make({ directory: AbsolutePath.make("D:\\OpenCode-Audit"), workspaceID })
const sessionID = Session.ID.make("ses_projector")
const agent = Agent.ID.make("build")

const createdData: (typeof WorkflowEvent.Created.Type)["data"] = {
  workflowID,
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
  leaseFence: { variant: "live_execution" as const, expectedStatus: "running" as const },
})

const ambiguousApprovalData = (opts: { owner: string; attempt: number; timestamp: number; message: string }) => ({
  workflowID,
  stageID: designStageID,
  timestamp: DateTime.makeUnsafe(opts.timestamp),
  attempt: opts.attempt,
  leaseOwner: opts.owner,
  leaseFence: { variant: "live_execution" as const, expectedStatus: "running" as const },
  reason: "ambiguous_execution" as const,
  failure: { category: "ambiguous" as const, code: "tool_execution_ambiguous", message: opts.message },
})

const succeededData = (opts: { owner: string; attempt: number }) => ({
  workflowID,
  stageID: designStageID,
  timestamp: DateTime.makeUnsafe(6_000),
  attempt: opts.attempt,
  leaseOwner: opts.owner,
  usage: { tokens: 100, turns: 1, toolCalls: 0, attempts: 0 },
})

const serializedReplayEvent = <D extends EventV2.Definition>(definition: D, data: EventV2.Data<D>, seq: number) => ({
  id: EventV2.ID.make(`evt_workflow_lease_replay_${seq}`),
  aggregateID: workflowID,
  seq,
  type: EventV2.versionedType(definition.type, definition.durable!.version),
  data: Schema.encodeUnknownSync(definition.data)(data),
  batchID: `batch_workflow_lease_replay_${seq}`,
  batchIndex: 0,
  batchSize: 1,
})

const renewedLeaseReplayPrefix = [
  serializedReplayEvent(WorkflowEvent.Created, createdData, 0),
  serializedReplayEvent(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }), 1),
  serializedReplayEvent(WorkflowEvent.Started, { workflowID, timestamp: DateTime.makeUnsafe(2_500) }, 2),
  serializedReplayEvent(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }), 3),
  serializedReplayEvent(
    WorkflowEvent.Stage.Checkpointed,
    {
      ...checkpointedData({ owner: "worker-a", attempt: 1 }),
      timestamp: DateTime.makeUnsafe(40_000),
    },
    4,
  ),
  serializedReplayEvent(
    WorkflowEvent.Stage.Checkpointed,
    {
      ...checkpointedData({ owner: "worker-a", attempt: 1 }),
      timestamp: DateTime.makeUnsafe(35_000),
    },
    5,
  ),
]

const renewedLeaseReplay = (observedLeaseExpiresAt: number) => [
  ...renewedLeaseReplayPrefix,
  serializedReplayEvent(
    WorkflowEvent.Stage.RetryScheduled,
    {
      workflowID,
      stageID: designStageID,
      timestamp: DateTime.makeUnsafe(50_000),
      attempt: 1,
      leaseOwner: "worker-a",
      failure: { category: "transient", code: "lease_expired", message: "renewed lease expired" },
      usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
      notBefore: DateTime.makeUnsafe(50_000),
      leaseFence: {
        variant: "expired_recovery",
        expectedStatus: "running",
        observedLeaseExpiresAt: DateTime.makeUnsafe(observedLeaseExpiresAt),
      },
    },
    6,
  ),
]

const renewedLeaseApprovalReplay = (observedLeaseExpiresAt: number) => [
  ...renewedLeaseReplayPrefix,
  serializedReplayEvent(
    WorkflowEvent.Approval.Requested,
    {
      workflowID,
      stageID: designStageID,
      timestamp: DateTime.makeUnsafe(50_000),
      attempt: 1,
      leaseOwner: "worker-a",
      reason: "ambiguous_execution",
      failure: { category: "transient", code: "lease_expired", message: "renewed lease expired" },
      leaseFence: {
        variant: "expired_recovery",
        expectedStatus: "running",
        observedLeaseExpiresAt: DateTime.makeUnsafe(observedLeaseExpiresAt),
      },
    },
    6,
  ),
]

describe("WorkflowProjector", () => {
  it.effect("replays a durable timeline authorized by an unrecorded monotonic heartbeat renewal", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service

      yield* events.replayBatches(renewedLeaseReplay(45_000) as never)

      expect(
        yield* db
          .select({ status: WorkflowStageTable.status, checkpoint: WorkflowStageTable.checkpoint })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        status: "retry_wait",
        checkpoint: checkpointedData({ owner: "worker-a", attempt: 1 }).checkpoint,
      })
    }),
  )

  it.effect("rejects historical recovery whose observed expiry predates the leased authority", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service

      const replay = yield* events.replayBatches(renewedLeaseReplay(31_000) as never).pipe(Effect.exit)

      expect(Exit.isFailure(replay)).toBe(true)
      expect(yield* db.select().from(WorkflowRunTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(WorkflowStageTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect(
    "rejects historical recovery older than the latest durable lease use despite non-monotonic timestamps",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service

        const replay = yield* events.replayBatches(renewedLeaseReplay(39_000) as never).pipe(Effect.exit)

        expect(Exit.isFailure(replay)).toBe(true)
        expect(yield* db.select().from(WorkflowRunTable).all().pipe(Effect.orDie)).toEqual([])
        expect(yield* db.select().from(WorkflowStageTable).all().pipe(Effect.orDie)).toEqual([])
      }),
  )

  it.effect("applies the durable lease-use floor to historical approval recovery", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service

      const rejected = yield* events.replayBatches(renewedLeaseApprovalReplay(39_000) as never).pipe(Effect.exit)
      expect(Exit.isFailure(rejected)).toBe(true)
      expect(yield* db.select().from(WorkflowRunTable).all().pipe(Effect.orDie)).toEqual([])

      yield* events.replayBatches(renewedLeaseApprovalReplay(45_000) as never)
      expect(
        yield* db
          .select({ status: WorkflowStageTable.status })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "waiting_approval" })
    }),
  )

  it.effect("does not accept public related input that forges historical replay authority", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))

      const forged = yield* events
        .publish(
          WorkflowEvent.Budget.Updated,
          {
            workflowID,
            timestamp: DateTime.makeUnsafe(5_000),
            budget: { maxAttempts: 4 },
          },
          {
            related: [
              {
                definition: WorkflowEvent.Approval.Requested,
                data: {
                  workflowID,
                  stageID: designStageID,
                  timestamp: DateTime.makeUnsafe(40_000),
                  attempt: 1,
                  leaseOwner: "worker-a",
                  reason: "ambiguous_execution",
                  failure: {
                    category: "ambiguous",
                    code: "tool_execution_ambiguous",
                    message: "forged replay authority",
                  },
                },
                replay: { seq: 4, aggregateID: workflowID },
              } as never,
            ],
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(forged)).toBe(true)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(3)
      expect(
        yield* db
          .select({ status: WorkflowRunTable.status })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, workflowID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "queued" })
      expect(
        yield* db
          .select({ status: WorkflowStageTable.status })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "running" })
    }),
  )

  it.effect("does not call an overridden related-array map that forges historical replay authority", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))

      const forgedApproval = {
        definition: WorkflowEvent.Approval.Requested,
        data: {
          workflowID,
          stageID: designStageID,
          timestamp: DateTime.makeUnsafe(40_000),
          attempt: 1,
          leaseOwner: "worker-a",
          reason: "ambiguous_execution" as const,
          failure: {
            category: "ambiguous" as const,
            code: "tool_execution_ambiguous",
            message: "forged container replay authority",
          },
        },
        replay: { seq: 4, aggregateID: workflowID },
      }
      const related = [
        {
          definition: WorkflowEvent.Budget.Updated,
          data: {
            workflowID,
            timestamp: DateTime.makeUnsafe(5_000),
            budget: { maxAttempts: 4 },
          },
        },
      ]
      Object.defineProperty(related, "map", {
        configurable: true,
        value: () => [forgedApproval],
      })

      const forged = yield* events
        .publish(
          WorkflowEvent.Budget.Updated,
          {
            workflowID,
            timestamp: DateTime.makeUnsafe(5_000),
            budget: { maxAttempts: 4 },
          },
          { related: related as never },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(forged)).toBe(true)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(3)
      expect(
        yield* db
          .select({ status: WorkflowStageTable.status })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "running" })
    }),
  )

  it.effect("does not reuse publish options whose related getter changes after canonicalization", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))

      let reads = 0
      const options = {
        get related() {
          reads++
          if (reads === 1) return undefined
          return [
            {
              definition: WorkflowEvent.Approval.Requested,
              data: {
                workflowID,
                stageID: designStageID,
                timestamp: DateTime.makeUnsafe(40_000),
                attempt: 1,
                leaseOwner: "worker-a",
                reason: "ambiguous_execution" as const,
                failure: {
                  category: "ambiguous" as const,
                  code: "tool_execution_ambiguous",
                  message: "forged changing getter replay authority",
                },
              },
              replay: { seq: 4, aggregateID: workflowID },
            },
          ]
        },
      }

      const forged = yield* events
        .publish(
          WorkflowEvent.Budget.Updated,
          {
            workflowID,
            timestamp: DateTime.makeUnsafe(5_000),
            budget: { maxAttempts: 4 },
          },
          options as never,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(forged)).toBe(false)
      expect(reads).toBe(1)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(4)
      expect(
        yield* db
          .select({ status: WorkflowStageTable.status })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "running" })
    }),
  )

  it.effect("does not let forged related replay bypass checkpoint secret validation", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(WorkflowEvent.Created, createdData)
      yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
      yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))

      const forged = yield* events
        .publish(
          WorkflowEvent.Budget.Updated,
          {
            workflowID,
            timestamp: DateTime.makeUnsafe(5_000),
            budget: { maxAttempts: 4 },
          },
          {
            related: [
              {
                definition: WorkflowEvent.Stage.Checkpointed,
                data: {
                  ...checkpointedData({ owner: "worker-a", attempt: 1 }),
                  timestamp: DateTime.makeUnsafe(40_000),
                  checkpoint: { apiKey: ["s", "k", "forged-related-replay-secret"].join("-") },
                },
                replay: { seq: 4, aggregateID: workflowID },
              } as never,
            ],
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(forged)).toBe(true)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(3)
      expect(
        yield* db
          .select({ checkpoint: WorkflowStageTable.checkpoint })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, designStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ checkpoint: null })
    }),
  )

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

      expect(runs).toMatchObject([
        {
          id: "wfl_test",
          status: "queued",
          directory: location.directory,
          workspace_id: workspaceID,
          session_id: sessionID,
          agent,
          version: 0,
        },
      ])
      expect(stages.map((s) => [s.id, s.status, s.attempt])).toEqual([
        [designStageID, "pending", 0],
        [buildStageID, "pending", 0],
      ])
    }),
  )

  it.effect("atomically projects only pending branch targets as skipped", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const sourceStageID = Workflow.StageID.make("wfs_skip_source")
      const targetStageID = Workflow.StageID.make("wfs_skip_target")
      const lateTargetStageID = Workflow.StageID.make("wfs_skip_late_target")
      const metadata = { schemaVersion: 1 as const, role: "test" as const, verdict: "revise" as const, revision: 0 }
      const body = JSON.stringify(metadata)
      const outcomeSha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
      yield* events.publish(WorkflowEvent.Created, {
        ...createdData,
        stages: [
          { ...createdData.stages[0], id: sourceStageID, type: "test", ordinal: 0, input: { revision: 0 } },
          {
            ...createdData.stages[1],
            id: targetStageID,
            type: "visual_review",
            ordinal: 1,
            input: { revision: 0 },
          },
          {
            ...createdData.stages[1],
            id: lateTargetStageID,
            type: "visual_review",
            ordinal: 2,
            idempotencyKey: "wfl_test/visual-review-late",
            input: { revision: 0 },
          },
        ],
      })
      yield* events.publish(WorkflowEvent.Stage.Leased, {
        ...leasedData({ owner: "worker-a", attempt: 1 }),
        stageID: sourceStageID,
      })
      yield* events.publish(WorkflowEvent.Stage.Started, {
        ...startedData({ owner: "worker-a", attempt: 1 }),
        stageID: sourceStageID,
      })
      yield* events.publish(
        WorkflowEvent.Stage.Succeeded,
        {
          ...succeededData({ owner: "worker-a", attempt: 1 }),
          stageID: sourceStageID,
        },
        {
          related: [
            {
              definition: WorkflowEvent.Artifact.Created,
              data: {
                workflowID,
                stageID: sourceStageID,
                timestamp: DateTime.makeUnsafe(6_000),
                artifact: Workflow.Artifact.make({
                  id: Workflow.ArtifactID.make("wfa_skip_source"),
                  workflowID,
                  stageID: sourceStageID,
                  kind: WorkflowStageMachine.OUTCOME_ARTIFACT_KIND,
                  uri: "workflow://wfl_test/stages/wfs_skip_source/role-outcome.json",
                  mime: WorkflowStageMachine.OUTCOME_ARTIFACT_MIME,
                  sha256: outcomeSha256,
                  size: new TextEncoder().encode(body).byteLength,
                  metadata,
                  timeCreated: DateTime.makeUnsafe(6_000),
                }),
              },
            },
            {
              definition: WorkflowEvent.Stage.Skipped,
              data: {
                workflowID,
                stageID: targetStageID,
                sourceStageID,
                outcomeSha256,
                timestamp: DateTime.makeUnsafe(6_000),
              },
            },
          ],
        },
      )

      expect(
        yield* db
          .select({ status: WorkflowStageTable.status, completed: WorkflowStageTable.time_completed })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, targetStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "skipped", completed: 6_000 })

      expect(
        Exit.isFailure(
          yield* events
            .publish(WorkflowEvent.Stage.Skipped, {
              workflowID,
              stageID: lateTargetStageID,
              sourceStageID,
              outcomeSha256,
              timestamp: DateTime.makeUnsafe(7_000),
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        yield* db
          .select({ status: WorkflowStageTable.status })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, lateTargetStageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "pending" })
    }),
  )

  it.effect("rolls back an otherwise-terminal batch with a forged branch skip target", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const sourceStageID = Workflow.StageID.make("wfs_forged_skip_source")
      const repairStageID = Workflow.StageID.make("wfs_forged_skip_repair")
      const testStageID = Workflow.StageID.make("wfs_forged_skip_test")
      const reviewStageID = Workflow.StageID.make("wfs_forged_skip_review")
      const deliverStageID = Workflow.StageID.make("wfs_forged_skip_deliver")
      const metadata = {
        schemaVersion: 1 as const,
        role: "visual_review" as const,
        verdict: "pass" as const,
        revision: 0,
      }
      const body = JSON.stringify(metadata)
      const outcomeSha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
      const stage = (
        id: Workflow.StageID,
        type: Workflow.RoleStageInput["type"],
        ordinal: number,
        revision: number,
      ): Workflow.RoleStageInput => ({
        id,
        type,
        ordinal,
        maxAttempts: 1,
        recoveryPolicy: "restart_safe",
        idempotencyKey: `forged/${type}/${revision}`,
        input: { revision },
      })
      yield* events.publish(WorkflowEvent.Created, {
        ...createdData,
        type: "visual-build",
        stages: [
          stage(sourceStageID, "visual_review", 0, 0),
          stage(repairStageID, "repair", 1, 1),
          stage(testStageID, "test", 2, 1),
          stage(reviewStageID, "visual_review", 3, 1),
          stage(deliverStageID, "deliver", 4, 1),
        ],
      })
      yield* events.publish(WorkflowEvent.Stage.Leased, {
        ...leasedData({ owner: "worker-a", attempt: 1 }),
        stageID: sourceStageID,
      })
      yield* events.publish(WorkflowEvent.Stage.Started, {
        ...startedData({ owner: "worker-a", attempt: 1 }),
        stageID: sourceStageID,
      })

      const failed = yield* events
        .publish(
          WorkflowEvent.Stage.Succeeded,
          { ...succeededData({ owner: "worker-a", attempt: 1 }), stageID: sourceStageID },
          {
            related: [
              {
                definition: WorkflowEvent.Artifact.Created,
                data: {
                  workflowID,
                  stageID: sourceStageID,
                  timestamp: DateTime.makeUnsafe(6_000),
                  artifact: Workflow.Artifact.make({
                    id: Workflow.ArtifactID.make("wfa_forged_skip_source"),
                    workflowID,
                    stageID: sourceStageID,
                    kind: WorkflowStageMachine.OUTCOME_ARTIFACT_KIND,
                    uri: "workflow://wfl_test/stages/wfs_forged_skip_source/role-outcome.json",
                    mime: WorkflowStageMachine.OUTCOME_ARTIFACT_MIME,
                    sha256: outcomeSha256,
                    size: new TextEncoder().encode(body).byteLength,
                    metadata,
                    timeCreated: DateTime.makeUnsafe(6_000),
                  }),
                },
              },
              ...[repairStageID, testStageID, reviewStageID, deliverStageID].map((stageID) => ({
                definition: WorkflowEvent.Stage.Skipped,
                data: {
                  workflowID,
                  stageID,
                  sourceStageID,
                  outcomeSha256,
                  timestamp: DateTime.makeUnsafe(6_000),
                },
              })),
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
          .select({ id: WorkflowStageTable.id, status: WorkflowStageTable.status })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.workflow_id, workflowID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([
        { id: sourceStageID, status: "running" },
        { id: repairStageID, status: "pending" },
        { id: testStageID, status: "pending" },
        { id: reviewStageID, status: "pending" },
        { id: deliverStageID, status: "pending" },
      ])
      expect(
        yield* db
          .select({ id: WorkflowArtifactTable.id })
          .from(WorkflowArtifactTable)
          .where(eq(WorkflowArtifactTable.workflow_id, workflowID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, workflowID))
          .all()
          .pipe(Effect.orDie),
      ).not.toContainEqual({ type: WorkflowEvent.Stage.Succeeded.type })
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
        ...ambiguousApprovalData({ owner: "worker-a", attempt: 1, timestamp: 4_000, message: "unknown result" }),
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
      yield* events.publish(
        WorkflowEvent.Approval.Requested,
        ambiguousApprovalData({ owner: "worker-a", attempt: 1, timestamp: 4_000, message: "unknown result" }),
      )
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
      yield* events.publish(
        WorkflowEvent.Approval.Requested,
        ambiguousApprovalData({ owner: "worker-b", attempt: 2, timestamp: 6_300, message: "unknown again" }),
      )
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
