export * as WorkflowProjector from "./projector"

import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { WorkflowState } from "./state"
import { WorkflowRunTable, WorkflowStageTable, WorkflowArtifactTable } from "./sql"

type DB = Database.Interface["db"]

export class LifecycleConflict extends Error {
  constructor(
    readonly workflowID: Workflow.ID,
    readonly stageID?: Workflow.StageID,
  ) {
    super(
      stageID
        ? `Workflow stage lifecycle conflict: ${workflowID}/${stageID}`
        : `Workflow lifecycle conflict: ${workflowID}`,
    )
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getStage(db: DB, stageID: Workflow.StageID) {
  return db.select().from(WorkflowStageTable).where(eq(WorkflowStageTable.id, stageID)).get().pipe(Effect.orDie)
}

function getRun(db: DB, workflowID: Workflow.ID) {
  return db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, workflowID)).get().pipe(Effect.orDie)
}

function requireStage(db: DB, workflowID: Workflow.ID, stageID: Workflow.StageID) {
  return Effect.gen(function* () {
    const row = yield* getStage(db, stageID)
    if (!row || row.workflow_id !== workflowID) throw new LifecycleConflict(workflowID, stageID)
    return row
  })
}

function requireRun(db: DB, workflowID: Workflow.ID) {
  return Effect.gen(function* () {
    const row = yield* getRun(db, workflowID)
    if (!row) throw new LifecycleConflict(workflowID)
    return row
  })
}

function requireNotCancelled(db: DB, workflowID: Workflow.ID, stageID?: Workflow.StageID) {
  return Effect.gen(function* () {
    const row = yield* requireRun(db, workflowID)
    if (row.cancel_requested_at !== null) throw new LifecycleConflict(workflowID, stageID)
    return row
  })
}

function guardTransition(db: DB, workflowID: Workflow.ID, stageID: Workflow.StageID, to: Workflow.StageStatus) {
  return Effect.gen(function* () {
    const row = yield* requireStage(db, workflowID, stageID)
    WorkflowState.assertStageTransition(row.status, to)
    return row
  })
}

function requireLeaseOwner(workflowID: Workflow.ID, stageID: Workflow.StageID, owner: string | undefined) {
  if (!owner?.trim()) throw new LifecycleConflict(workflowID, stageID)
  return owner
}

function requireFencing(
  row: typeof WorkflowStageTable.$inferSelect,
  input: {
    readonly workflowID: Workflow.ID
    readonly stageID: Workflow.StageID
    readonly attempt: number
    readonly leaseOwner?: string
  },
) {
  const leaseOwner = requireLeaseOwner(input.workflowID, input.stageID, input.leaseOwner)
  if (input.attempt !== row.attempt || leaseOwner !== row.lease_owner) {
    throw new LifecycleConflict(input.workflowID, input.stageID)
  }
  return leaseOwner
}

function requireLiveLease(
  row: typeof WorkflowStageTable.$inferSelect,
  input: {
    readonly workflowID: Workflow.ID
    readonly stageID: Workflow.StageID
    readonly attempt: number
    readonly leaseOwner?: string
    readonly timestamp: DateTime.Utc
  },
) {
  const leaseOwner = requireFencing(row, input)
  if (row.lease_expires_at === null || DateTime.toEpochMillis(input.timestamp) > row.lease_expires_at) {
    throw new LifecycleConflict(input.workflowID, input.stageID)
  }
  return leaseOwner
}

function applyUsage(db: DB, workflowID: Workflow.ID, usage: Workflow.Usage, timestamp: DateTime.Utc) {
  return Effect.gen(function* () {
    const updated = yield* db
      .update(WorkflowRunTable)
      .set({
        usage: sql`json_set(
          ${WorkflowRunTable.usage},
          '$.tokens', json_extract(${WorkflowRunTable.usage}, '$.tokens') + ${usage.tokens},
          '$.turns', json_extract(${WorkflowRunTable.usage}, '$.turns') + ${usage.turns},
          '$.toolCalls', json_extract(${WorkflowRunTable.usage}, '$.toolCalls') + ${usage.toolCalls}
        )`,
        time_updated: DateTime.toEpochMillis(timestamp),
      })
      .where(eq(WorkflowRunTable.id, workflowID))
      .returning({ id: WorkflowRunTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!updated) throw new LifecycleConflict(workflowID)
  })
}

function budgetMask(usage: Workflow.Usage, budget: Workflow.Budget) {
  const ratios = [
    budget.maxTokens === undefined ? undefined : usage.tokens / budget.maxTokens,
    budget.maxTurns === undefined ? undefined : usage.turns / budget.maxTurns,
    budget.maxToolCalls === undefined ? undefined : usage.toolCalls / budget.maxToolCalls,
    budget.maxAttempts === undefined ? undefined : usage.attempts / budget.maxAttempts,
  ].filter((ratio): ratio is number => ratio !== undefined)
  return (
    (ratios.some((ratio) => ratio >= 0.5) ? 1 : 0) |
    (ratios.some((ratio) => ratio >= 0.8) ? 2 : 0) |
    (ratios.some((ratio) => ratio >= 1) ? 4 : 0)
  )
}

// ── Projector layer ──────────────────────────────────────────────────────────

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    // workflow.created — insert run and stages atomically
    yield* events.project(WorkflowEvent.Created, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* db
          .insert(WorkflowRunTable)
          .values({
            id: data.workflowID,
            type: data.type,
            status: "queued",
            input: data.input,
            budget: data.budget,
            usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
            version: 0,
            time_created: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .run()
          .pipe(Effect.orDie)

        const now = DateTime.toEpochMillis(data.timestamp)
        for (const stage of data.stages) {
          yield* db
            .insert(WorkflowStageTable)
            .values({
              id: stage.id!,
              workflow_id: data.workflowID,
              stage_type: stage.type,
              ordinal: stage.ordinal,
              status: "pending",
              attempt: 0,
              max_attempts: stage.maxAttempts,
              recovery_policy: stage.recoveryPolicy,
              idempotency_key: stage.idempotencyKey,
              input: stage.input,
              time_created: now,
              time_updated: now,
            })
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )

    // workflow.started
    yield* events.project(WorkflowEvent.Started, (event) =>
      Effect.gen(function* () {
        yield* requireNotCancelled(db, event.data.workflowID)
        yield* db
          .update(WorkflowRunTable)
          .set({ status: "running", time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(WorkflowRunTable.id, event.data.workflowID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    // workflow.stage.leased
    yield* events.project(WorkflowEvent.Stage.Leased, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* requireNotCancelled(db, data.workflowID, data.stageID)
        const row = yield* guardTransition(db, data.workflowID, data.stageID, "leased")
        const leaseOwner = requireLeaseOwner(data.workflowID, data.stageID, data.leaseOwner)
        if (data.attempt !== row.attempt + 1) {
          throw new LifecycleConflict(data.workflowID, data.stageID)
        }
        if (DateTime.toEpochMillis(data.leaseExpiresAt) <= DateTime.toEpochMillis(data.timestamp)) {
          throw new LifecycleConflict(data.workflowID, data.stageID)
        }

        const updated = yield* db
          .update(WorkflowStageTable)
          .set({
            status: "leased",
            attempt: data.attempt,
            lease_owner: leaseOwner,
            lease_expires_at: DateTime.toEpochMillis(data.leaseExpiresAt),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(
            and(
              eq(WorkflowStageTable.id, data.stageID),
              eq(WorkflowStageTable.workflow_id, data.workflowID),
              eq(WorkflowStageTable.status, row.status),
              eq(WorkflowStageTable.attempt, row.attempt),
            ),
          )
          .returning({ id: WorkflowStageTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.workflowID, data.stageID)

        const run = yield* db
          .update(WorkflowRunTable)
          .set({
            usage: sql`json_set(${WorkflowRunTable.usage}, '$.attempts', json_extract(${WorkflowRunTable.usage}, '$.attempts') + 1)`,
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowRunTable.id, data.workflowID))
          .returning({ id: WorkflowRunTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!run) throw new LifecycleConflict(data.workflowID, data.stageID)
      }),
    )

    // workflow.stage.started
    yield* events.project(WorkflowEvent.Stage.Started, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* requireNotCancelled(db, data.workflowID, data.stageID)
        const row = yield* guardTransition(db, data.workflowID, data.stageID, "running")
        const leaseOwner = requireLiveLease(row, data)
        const updated = yield* db
          .update(WorkflowStageTable)
          .set({
            status: "running",
            time_started: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(
            and(
              eq(WorkflowStageTable.id, data.stageID),
              eq(WorkflowStageTable.workflow_id, data.workflowID),
              eq(WorkflowStageTable.status, row.status),
              eq(WorkflowStageTable.attempt, data.attempt),
              eq(WorkflowStageTable.lease_owner, leaseOwner),
              gte(WorkflowStageTable.lease_expires_at, DateTime.toEpochMillis(data.timestamp)),
            ),
          )
          .returning({ id: WorkflowStageTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.workflowID, data.stageID)

        // Set current stage on run
        yield* db
          .update(WorkflowRunTable)
          .set({ current_stage_id: data.stageID, time_updated: DateTime.toEpochMillis(data.timestamp) })
          .where(eq(WorkflowRunTable.id, data.workflowID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    // workflow.stage.retry_scheduled
    yield* events.project(WorkflowEvent.Stage.RetryScheduled, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* requireNotCancelled(db, data.workflowID, data.stageID)
        const row = yield* guardTransition(db, data.workflowID, data.stageID, "retry_wait")
        const leaseOwner = requireFencing(row, data)
        const updated = yield* db
          .update(WorkflowStageTable)
          .set({
            status: "retry_wait",
            lease_owner: null,
            lease_expires_at: null,
            not_before: DateTime.toEpochMillis(data.notBefore),
            error: data.failure,
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(
            and(
              eq(WorkflowStageTable.id, data.stageID),
              eq(WorkflowStageTable.workflow_id, data.workflowID),
              eq(WorkflowStageTable.status, row.status),
              eq(WorkflowStageTable.attempt, data.attempt),
              eq(WorkflowStageTable.lease_owner, leaseOwner),
            ),
          )
          .returning({ id: WorkflowStageTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.workflowID, data.stageID)
        yield* applyUsage(db, data.workflowID, data.usage, data.timestamp)
      }),
    )

    // workflow.stage.succeeded
    yield* events.project(WorkflowEvent.Stage.Succeeded, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* requireNotCancelled(db, data.workflowID, data.stageID)
        const row = yield* guardTransition(db, data.workflowID, data.stageID, "succeeded")
        const leaseOwner = requireLiveLease(row, data)
        const updated = yield* db
          .update(WorkflowStageTable)
          .set({
            status: "succeeded",
            lease_owner: null,
            lease_expires_at: null,
            checkpoint: data.checkpoint ?? null,
            time_completed: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(
            and(
              eq(WorkflowStageTable.id, data.stageID),
              eq(WorkflowStageTable.workflow_id, data.workflowID),
              eq(WorkflowStageTable.status, row.status),
              eq(WorkflowStageTable.attempt, data.attempt),
              eq(WorkflowStageTable.lease_owner, leaseOwner),
              gte(WorkflowStageTable.lease_expires_at, DateTime.toEpochMillis(data.timestamp)),
            ),
          )
          .returning({ id: WorkflowStageTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.workflowID, data.stageID)
        yield* applyUsage(db, data.workflowID, data.usage, data.timestamp)
      }),
    )

    // workflow.stage.failed
    yield* events.project(WorkflowEvent.Stage.Failed, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* requireNotCancelled(db, data.workflowID, data.stageID)
        const row = yield* guardTransition(db, data.workflowID, data.stageID, "failed")
        const leaseOwner = data.source === "execution" ? requireLiveLease(row, data) : undefined
        if (data.source === "execution") {
          if (!leaseOwner) throw new LifecycleConflict(data.workflowID, data.stageID)
        } else if (row.recovery_action !== "fail") {
          throw new LifecycleConflict(data.workflowID, data.stageID)
        }
        const updated = yield* db
          .update(WorkflowStageTable)
          .set({
            status: "failed",
            lease_owner: null,
            lease_expires_at: null,
            error: data.failure,
            time_completed: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(
            and(
              eq(WorkflowStageTable.id, data.stageID),
              eq(WorkflowStageTable.workflow_id, data.workflowID),
              eq(WorkflowStageTable.status, row.status),
              ...(leaseOwner === undefined
                ? []
                : [
                    eq(WorkflowStageTable.attempt, data.attempt),
                    eq(WorkflowStageTable.lease_owner, leaseOwner),
                    gte(WorkflowStageTable.lease_expires_at, DateTime.toEpochMillis(data.timestamp)),
                  ]),
            ),
          )
          .returning({ id: WorkflowStageTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.workflowID, data.stageID)
        yield* applyUsage(db, data.workflowID, data.usage, data.timestamp)
      }),
    )

    // workflow.artifact.created
    yield* events.project(WorkflowEvent.Artifact.Created, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* requireNotCancelled(db, data.workflowID, data.stageID)
        yield* db
          .insert(WorkflowArtifactTable)
          .values({
            id: data.artifact.id,
            workflow_id: data.workflowID,
            stage_id: data.stageID,
            kind: data.artifact.kind,
            uri: data.artifact.uri,
            mime: data.artifact.mime,
            sha256: data.artifact.sha256,
            size: data.artifact.size,
            metadata: data.artifact.metadata,
            time_created: DateTime.toEpochMillis(data.artifact.timeCreated),
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }),
    )

    yield* events.project(WorkflowEvent.Budget.ThresholdReached, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* requireRun(db, data.workflowID)
        const bit = data.percent === 50 ? 1 : data.percent === 80 ? 2 : 4
        const updated = yield* db
          .update(WorkflowRunTable)
          .set({
            budget_notified: sql`${WorkflowRunTable.budget_notified} | ${bit}`,
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowRunTable.id, data.workflowID))
          .returning({ id: WorkflowRunTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.workflowID)
      }),
    )

    yield* events.project(WorkflowEvent.Budget.Updated, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const row = yield* requireRun(db, data.workflowID)
        if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled") {
          throw new LifecycleConflict(data.workflowID)
        }
        const updated = yield* db
          .update(WorkflowRunTable)
          .set({
            budget: data.budget,
            budget_notified: budgetMask(row.usage, data.budget),
            version: sql`${WorkflowRunTable.version} + 1`,
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(
            and(
              eq(WorkflowRunTable.id, data.workflowID),
              inArray(WorkflowRunTable.status, ["queued", "running", "waiting_approval"]),
            ),
          )
          .returning({ id: WorkflowRunTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.workflowID)
      }),
    )

    // workflow.cancel.requested
    yield* events.project(WorkflowEvent.CancelRequested, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const updated = yield* db
          .update(WorkflowRunTable)
          .set({
            cancel_requested_at: DateTime.toEpochMillis(data.timestamp),
            version: sql`${WorkflowRunTable.version} + 1`,
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(
            and(
              eq(WorkflowRunTable.id, data.workflowID),
              isNull(WorkflowRunTable.cancel_requested_at),
              inArray(WorkflowRunTable.status, ["queued", "running", "waiting_approval"]),
            ),
          )
          .returning({ id: WorkflowRunTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.workflowID)
      }),
    )

    // workflow.stage.cancelled
    yield* events.project(WorkflowEvent.Stage.Cancelled, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const run = yield* requireRun(db, data.workflowID)
        if (run.cancel_requested_at === null) throw new LifecycleConflict(data.workflowID, data.stageID)
        const row = yield* guardTransition(db, data.workflowID, data.stageID, "cancelled")
        if (data.source === "execution") {
          if (data.attempt !== row.attempt || data.leaseOwner !== row.lease_owner) {
            throw new LifecycleConflict(data.workflowID, data.stageID)
          }
          if (row.lease_expires_at && DateTime.toEpochMillis(data.timestamp) > row.lease_expires_at) {
            throw new LifecycleConflict(data.workflowID, data.stageID)
          }
        }
        yield* db
          .update(WorkflowStageTable)
          .set({
            status: "cancelled",
            lease_owner: null,
            lease_expires_at: null,
            time_completed: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowStageTable.id, data.stageID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    // workflow.succeeded — terminal run
    yield* events.project(WorkflowEvent.Succeeded, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const row = yield* requireRun(db, data.workflowID)
        const stages = yield* db
          .select({ status: WorkflowStageTable.status })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.workflow_id, data.workflowID))
          .all()
          .pipe(Effect.orDie)
        if (
          row.cancel_requested_at !== null ||
          row.status === "succeeded" ||
          row.status === "failed" ||
          row.status === "cancelled" ||
          stages.some((stage) => stage.status !== "succeeded" && stage.status !== "skipped")
        ) {
          throw new LifecycleConflict(data.workflowID)
        }
        const updated = yield* db
          .update(WorkflowRunTable)
          .set({
            status: "succeeded",
            time_completed: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(
            and(
              eq(WorkflowRunTable.id, data.workflowID),
              isNull(WorkflowRunTable.cancel_requested_at),
              inArray(WorkflowRunTable.status, ["queued", "running", "waiting_approval"]),
            ),
          )
          .returning({ id: WorkflowRunTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.workflowID)
      }),
    )

    // workflow.failed — terminal run
    yield* events.project(WorkflowEvent.Failed, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const row = yield* requireRun(db, data.workflowID)
        const failed = yield* db
          .select({ id: WorkflowStageTable.id })
          .from(WorkflowStageTable)
          .where(and(eq(WorkflowStageTable.workflow_id, data.workflowID), eq(WorkflowStageTable.status, "failed")))
          .get()
          .pipe(Effect.orDie)
        if (!failed || row.status === "succeeded" || row.status === "failed" || row.status === "cancelled") {
          throw new LifecycleConflict(data.workflowID)
        }
        const updated = yield* db
          .update(WorkflowRunTable)
          .set({
            status: "failed",
            time_completed: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(
            and(
              eq(WorkflowRunTable.id, data.workflowID),
              inArray(WorkflowRunTable.status, ["queued", "running", "waiting_approval"]),
            ),
          )
          .returning({ id: WorkflowRunTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.workflowID)
      }),
    )

    // workflow.cancelled — terminal run
    yield* events.project(WorkflowEvent.Cancelled, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const row = yield* requireRun(db, data.workflowID)
        const stages = yield* db
          .select({ status: WorkflowStageTable.status })
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.workflow_id, data.workflowID))
          .all()
          .pipe(Effect.orDie)
        if (
          row.cancel_requested_at === null ||
          row.status === "succeeded" ||
          row.status === "failed" ||
          stages.some((stage) => !WorkflowState.isTerminal(stage.status))
        ) {
          throw new LifecycleConflict(data.workflowID)
        }
        const updated = yield* db
          .update(WorkflowRunTable)
          .set({
            status: "cancelled",
            time_completed: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(
            and(
              eq(WorkflowRunTable.id, data.workflowID),
              inArray(WorkflowRunTable.status, ["queued", "running", "waiting_approval"]),
            ),
          )
          .returning({ id: WorkflowRunTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.workflowID)
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "workflow-projector", layer, deps: [EventV2.node, Database.node] })
