export * as WorkflowStore from "./store"

import { and, asc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { WorkflowState } from "./state"
import { WorkflowRunTable, WorkflowStageTable, WorkflowArtifactTable } from "./sql"
import { DateTime } from "effect"

type DB = Database.Interface["db"]

export interface Interface {
  readonly list: (input?: { readonly status?: Workflow.RunStatus; readonly limit?: number }) => Effect.Effect<Workflow.Info[]>
  readonly get: (workflowID: Workflow.ID) => Effect.Effect<Workflow.Detail | undefined>
  readonly stage: (stageID: Workflow.StageID) => Effect.Effect<Workflow.Stage | undefined>
  readonly artifacts: (workflowID: Workflow.ID) => Effect.Effect<Workflow.Artifact[]>
  readonly claimCandidates: (input: { readonly now: number; readonly limit: number }) => Effect.Effect<Workflow.Stage[]>
  readonly renew: (input: {
    readonly stageID: Workflow.StageID
    readonly owner: string
    readonly attempt: number
    readonly now: number
    readonly expiresAt: number
  }) => Effect.Effect<boolean>
  readonly expired: (now: number) => Effect.Effect<Workflow.Stage[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkflowStore") {}

// ── Row mapping helpers ──────────────────────────────────────────────────────

function runRow(row: typeof WorkflowRunTable.$inferSelect): Workflow.Info {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    currentStageID: row.current_stage_id ?? undefined,
    input: row.input,
    budget: row.budget,
    usage: row.usage,
    cancelRequestedAt: row.cancel_requested_at ? DateTime.makeUnsafe(row.cancel_requested_at) : undefined,
    version: row.version,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      completed: row.time_completed ? DateTime.makeUnsafe(row.time_completed) : undefined,
    },
  }
}

function stageRow(row: typeof WorkflowStageTable.$inferSelect): Workflow.Stage {
  return {
    id: row.id,
    workflowID: row.workflow_id,
    type: row.stage_type,
    ordinal: row.ordinal,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    notBefore: row.not_before ? DateTime.makeUnsafe(row.not_before) : undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ? DateTime.makeUnsafe(row.lease_expires_at) : undefined,
    sessionID: row.session_id ?? undefined,
    checkpoint: row.checkpoint ?? undefined,
    recoveryPolicy: row.recovery_policy,
    recoveryAction: row.recovery_action ?? undefined,
    idempotencyKey: row.idempotency_key,
    input: row.input,
    error: row.error ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      started: row.time_started ? DateTime.makeUnsafe(row.time_started) : undefined,
      completed: row.time_completed ? DateTime.makeUnsafe(row.time_completed) : undefined,
    },
  }
}

function artifactRow(row: typeof WorkflowArtifactTable.$inferSelect): Workflow.Artifact {
  return {
    id: row.id,
    workflowID: row.workflow_id,
    stageID: row.stage_id,
    kind: row.kind,
    uri: row.uri,
    mime: row.mime,
    sha256: row.sha256,
    size: row.size,
    metadata: row.metadata,
    timeCreated: DateTime.makeUnsafe(row.time_created),
  }
}

// ── Layer ─────────────────────────────────────────────────────────────────────

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    return Service.of({
      list: Effect.fn("WorkflowStore.list")(function* (input) {
        const status = input?.status
        const limit = input?.limit ?? 50
        const rows = yield* db
          .select()
          .from(WorkflowRunTable)
          .where(status ? eq(WorkflowRunTable.status, status) : undefined)
          .orderBy(asc(WorkflowRunTable.time_created))
          .limit(limit)
          .all()
          .pipe(Effect.orDie)
        return rows.map(runRow)
      }),

      get: Effect.fn("WorkflowStore.get")(function* (workflowID) {
        const run = yield* db
          .select()
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, workflowID))
          .get()
          .pipe(Effect.orDie)
        if (!run) return undefined

        const stages = yield* db
          .select()
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.workflow_id, workflowID))
          .orderBy(asc(WorkflowStageTable.ordinal))
          .all()
          .pipe(Effect.orDie)

        const artifacts = yield* db
          .select()
          .from(WorkflowArtifactTable)
          .where(eq(WorkflowArtifactTable.workflow_id, workflowID))
          .orderBy(asc(WorkflowArtifactTable.time_created))
          .all()
          .pipe(Effect.orDie)

        return {
          run: runRow(run),
          stages: stages.map(stageRow),
          artifacts: artifacts.map(artifactRow),
        }
      }),

      stage: Effect.fn("WorkflowStore.stage")(function* (stageID) {
        const row = yield* db
          .select()
          .from(WorkflowStageTable)
          .where(eq(WorkflowStageTable.id, stageID))
          .get()
          .pipe(Effect.orDie)
        return row ? stageRow(row) : undefined
      }),

      artifacts: Effect.fn("WorkflowStore.artifacts")(function* (workflowID) {
        const rows = yield* db
          .select()
          .from(WorkflowArtifactTable)
          .where(eq(WorkflowArtifactTable.workflow_id, workflowID))
          .orderBy(asc(WorkflowArtifactTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(artifactRow)
      }),

      claimCandidates: Effect.fn("WorkflowStore.claimCandidates")(function* (input) {
        // Select stages whose status is pending or retry_wait with not_before in the past,
        // and whose workflow is queued or running and not cancelled
        const rows = yield* db
          .select({
            stage: WorkflowStageTable,
            run: { status: WorkflowRunTable.status, cancel_requested_at: WorkflowRunTable.cancel_requested_at },
          })
          .from(WorkflowStageTable)
          .innerJoin(WorkflowRunTable, eq(WorkflowStageTable.workflow_id, WorkflowRunTable.id))
          .where(
            and(
              or(
                eq(WorkflowStageTable.status, "pending"),
                and(eq(WorkflowStageTable.status, "retry_wait"), lte(WorkflowStageTable.not_before!, input.now)),
              ),
              inArray(WorkflowRunTable.status, ["queued", "running"]),
              isNull(WorkflowRunTable.cancel_requested_at),
            ),
          )
          .orderBy(asc(WorkflowStageTable.ordinal))
          .limit(input.limit)
          .all()
          .pipe(Effect.orDie)

        // Filter out stages whose previous stages are not complete
        const candidates: Workflow.Stage[] = []
        for (const row of rows) {
          // Get all stages for this workflow to check ordering
          const allStages = yield* db
            .select()
            .from(WorkflowStageTable)
            .where(eq(WorkflowStageTable.workflow_id, row.stage.workflow_id))
            .orderBy(asc(WorkflowStageTable.ordinal))
            .all()
            .pipe(Effect.orDie)

          const stage = stageRow(row.stage)
          if (WorkflowState.previousStagesComplete(allStages.map((s) => ({ ordinal: s.ordinal, status: s.status })), stage)) {
            candidates.push(stage)
          }
        }
        return candidates
      }),

      renew: Effect.fn("WorkflowStore.renew")(function* (input) {
        const result = yield* db
          .update(WorkflowStageTable)
          .set({ lease_expires_at: input.expiresAt, time_updated: input.now })
          .where(
            and(
              eq(WorkflowStageTable.id, input.stageID),
              eq(WorkflowStageTable.lease_owner, input.owner),
              eq(WorkflowStageTable.attempt, input.attempt),
              inArray(WorkflowStageTable.status, ["leased", "running"]),
              gte(WorkflowStageTable.lease_expires_at, input.now),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        return result.rowsAffected === 1
      }),

      expired: Effect.fn("WorkflowStore.expired")(function* (now) {
        const rows = yield* db
          .select()
          .from(WorkflowStageTable)
          .where(
            and(
              inArray(WorkflowStageTable.status, ["leased", "running"]),
              lt(WorkflowStageTable.lease_expires_at, now),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        return rows.map(stageRow)
      }),
    })
  }),
)

export const node = makeGlobalNode({ name: "workflow-store", service: Service, layer, deps: [Database.node] })
