export * as WorkflowStore from "./store"

import { and, asc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm"
import { Cause, Context, DateTime, Effect, Layer, Option } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { WorkflowProjector } from "./projector"
import { WorkflowState } from "./state"
import { WorkflowRunTable, WorkflowStageTable, WorkflowArtifactTable } from "./sql"

export interface Interface {
  readonly list: (input?: {
    readonly status?: Workflow.RunStatus
    readonly limit?: number
  }) => Effect.Effect<Workflow.Info[]>
  readonly get: (workflowID: Workflow.ID) => Effect.Effect<Workflow.Detail | undefined>
  readonly stage: (stageID: Workflow.StageID) => Effect.Effect<Workflow.Stage | undefined>
  readonly artifacts: (workflowID: Workflow.ID) => Effect.Effect<Workflow.Artifact[]>
  readonly claimCandidates: (input: { readonly now: number; readonly limit: number }) => Effect.Effect<Workflow.Stage[]>
  readonly claim: (input: {
    readonly owner: string
    readonly now: number
    readonly leaseDurationMs: number
  }) => Effect.Effect<Option.Option<Workflow.Stage>>
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
    cancelRequestedAt: row.cancel_requested_at === null ? undefined : DateTime.makeUnsafe(row.cancel_requested_at),
    version: row.version,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      completed: row.time_completed === null ? undefined : DateTime.makeUnsafe(row.time_completed),
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
    notBefore: row.not_before === null ? undefined : DateTime.makeUnsafe(row.not_before),
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at === null ? undefined : DateTime.makeUnsafe(row.lease_expires_at),
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
      started: row.time_started === null ? undefined : DateTime.makeUnsafe(row.time_started),
      completed: row.time_completed === null ? undefined : DateTime.makeUnsafe(row.time_completed),
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
    const service = Service.of({
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
                and(eq(WorkflowStageTable.status, "retry_wait"), lte(WorkflowStageTable.not_before, input.now)),
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
          if (
            WorkflowState.previousStagesComplete(
              allStages.map((s) => ({ ordinal: s.ordinal, status: s.status })),
              stage,
            )
          ) {
            candidates.push(stage)
          }
        }
        return candidates
      }),

      claim: Effect.fn("WorkflowStore.claim")(function* (input) {
        if (!input.owner.trim() || input.leaseDurationMs <= 0) return Option.none()
        const candidates = yield* service.claimCandidates({ now: input.now, limit: 20 })
        for (const candidate of candidates) {
          const committed = yield* events
            .publish(WorkflowEvent.Stage.Leased, {
              workflowID: candidate.workflowID,
              stageID: candidate.id,
              timestamp: DateTime.makeUnsafe(input.now),
              attempt: candidate.attempt + 1,
              leaseOwner: input.owner,
              leaseExpiresAt: DateTime.makeUnsafe(input.now + input.leaseDurationMs),
            })
            .pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Cause.squash(cause) instanceof WorkflowProjector.LifecycleConflict
                  ? Effect.succeed(false)
                  : Effect.failCause(cause),
              ),
            )
          if (!committed) continue
          const stage = yield* service.stage(candidate.id)
          if (!stage)
            return yield* Effect.die(new WorkflowProjector.LifecycleConflict(candidate.workflowID, candidate.id))
          return Option.some(stage)
        }
        return Option.none()
      }),

      renew: Effect.fn("WorkflowStore.renew")(function* (input) {
        const rows = yield* db
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
          .returning({ id: WorkflowStageTable.id })
          .all()
          .pipe(Effect.orDie)
        return rows.length === 1
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
    return service
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, WorkflowProjector.node],
})
