export * as WorkflowProjector from "./projector"

import { and, eq, gte, sql } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { WorkflowState } from "./state"
import { WorkflowRunTable, WorkflowStageTable, WorkflowArtifactTable } from "./sql"

type DB = Database.Interface["db"]

export class LifecycleConflict extends Error {
  constructor(
    readonly workflowID: string,
    readonly stageID?: string,
  ) {
    super(
      stageID
        ? `Workflow stage lifecycle conflict: ${workflowID}/${stageID}`
        : `Workflow lifecycle conflict: ${workflowID}`,
    )
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getStage(db: DB, stageID: string) {
  return db.select().from(WorkflowStageTable).where(eq(WorkflowStageTable.id, stageID)).get().pipe(Effect.orDie)
}

function getRun(db: DB, workflowID: string) {
  return db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, workflowID)).get().pipe(Effect.orDie)
}

function requireStage(db: DB, stageID: string) {
  return Effect.gen(function* () {
    const row = yield* getStage(db, stageID)
    if (!row) throw new LifecycleConflict("", stageID)
    return row
  })
}

function requireRun(db: DB, workflowID: string) {
  return Effect.gen(function* () {
    const row = yield* getRun(db, workflowID)
    if (!row) throw new LifecycleConflict(workflowID)
    return row
  })
}

function guardTransition(db: DB, stageID: string, to: string) {
  return Effect.gen(function* () {
    const row = yield* requireStage(db, stageID)
    WorkflowState.assertStageTransition(row.status as never, to as never)
    return row
  })
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
        yield* requireRun(db, event.data.workflowID)
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
        const row = yield* guardTransition(db, data.stageID, "leased")
        if (data.attempt !== row.attempt + 1) {
          throw new LifecycleConflict(data.workflowID, data.stageID)
        }

        // Increment run attempts atomically
        yield* db
          .update(WorkflowRunTable)
          .set({
            usage: sql`json_set(${WorkflowRunTable.usage}, '$.attempts', json_extract(${WorkflowRunTable.usage}, '$.attempts') + 1)`,
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowRunTable.id, data.workflowID))
          .run()
          .pipe(Effect.orDie)

        yield* db
          .update(WorkflowStageTable)
          .set({
            status: "leased",
            attempt: data.attempt,
            lease_owner: data.leaseOwner,
            lease_expires_at: DateTime.toEpochMillis(data.leaseExpiresAt),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowStageTable.id, data.stageID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    // workflow.stage.started
    yield* events.project(WorkflowEvent.Stage.Started, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const row = yield* guardTransition(db, data.stageID, "running")
        if (data.attempt !== row.attempt || data.leaseOwner !== row.lease_owner) {
          throw new LifecycleConflict(data.workflowID, data.stageID)
        }
        yield* db
          .update(WorkflowStageTable)
          .set({
            status: "running",
            time_started: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowStageTable.id, data.stageID))
          .run()
          .pipe(Effect.orDie)

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
        const row = yield* guardTransition(db, data.stageID, "retry_wait")
        if (data.attempt !== row.attempt || data.leaseOwner !== row.lease_owner) {
          throw new LifecycleConflict(data.workflowID, data.stageID)
        }
        yield* db
          .update(WorkflowStageTable)
          .set({
            status: "retry_wait",
            lease_owner: null,
            lease_expires_at: null,
            not_before: DateTime.toEpochMillis(data.notBefore),
            error: data.failure,
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowStageTable.id, data.stageID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    // workflow.stage.succeeded
    yield* events.project(WorkflowEvent.Stage.Succeeded, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const row = yield* guardTransition(db, data.stageID, "succeeded")
        if (data.attempt !== row.attempt || data.leaseOwner !== row.lease_owner) {
          throw new LifecycleConflict(data.workflowID, data.stageID)
        }
        if (row.lease_expires_at && DateTime.toEpochMillis(data.timestamp) > row.lease_expires_at) {
          throw new LifecycleConflict(data.workflowID, data.stageID)
        }
        yield* db
          .update(WorkflowStageTable)
          .set({
            status: "succeeded",
            lease_owner: null,
            lease_expires_at: null,
            checkpoint: data.checkpoint ?? null,
            time_completed: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowStageTable.id, data.stageID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    // workflow.stage.failed
    yield* events.project(WorkflowEvent.Stage.Failed, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const row = yield* guardTransition(db, data.stageID, "failed")
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
            status: "failed",
            lease_owner: null,
            lease_expires_at: null,
            error: data.failure,
            time_completed: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowStageTable.id, data.stageID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    // workflow.artifact.created
    yield* events.project(WorkflowEvent.Artifact.Created, (event) =>
      Effect.gen(function* () {
        const data = event.data
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

    // workflow.cancel.requested
    yield* events.project(WorkflowEvent.CancelRequested, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* db
          .update(WorkflowRunTable)
          .set({
            cancel_requested_at: DateTime.toEpochMillis(data.timestamp),
            version: sql`${WorkflowRunTable.version} + 1`,
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowRunTable.id, data.workflowID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    // workflow.stage.cancelled
    yield* events.project(WorkflowEvent.Stage.Cancelled, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const row = yield* guardTransition(db, data.stageID, "cancelled")
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
        yield* db
          .update(WorkflowRunTable)
          .set({
            status: "succeeded",
            time_completed: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowRunTable.id, data.workflowID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    // workflow.failed — terminal run
    yield* events.project(WorkflowEvent.Failed, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* db
          .update(WorkflowRunTable)
          .set({
            status: "failed",
            time_completed: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowRunTable.id, data.workflowID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    // workflow.cancelled — terminal run
    yield* events.project(WorkflowEvent.Cancelled, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* db
          .update(WorkflowRunTable)
          .set({
            status: "cancelled",
            time_completed: DateTime.toEpochMillis(data.timestamp),
            time_updated: DateTime.toEpochMillis(data.timestamp),
          })
          .where(eq(WorkflowRunTable.id, data.workflowID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "workflow-projector", layer, deps: [EventV2.node, Database.node] })
