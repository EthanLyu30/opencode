import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { ResponseTable } from "@opencode-ai/core/responses/sql"
import { WorkflowRunTable } from "@opencode-ai/core/workflow/sql"
import { publicHistory } from "../../src/server/routes/instance/httpapi/handlers/sync-history"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Database.node))

interface QueryObservation {
  readonly method: "all" | "get"
  readonly rows: number
}

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion */
function observeQueries<A extends object>(target: A, observations: QueryObservation[]): A {
  return new Proxy(target, {
    get(current, key) {
      const value = Reflect.get(current, key, current)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, current, args)
        if (key === "all" || key === "get") {
          return (result as Effect.Effect<unknown>).pipe(
            Effect.tap((value) =>
              Effect.sync(() =>
                observations.push({
                  method: key,
                  rows: Array.isArray(value) ? value.length : value === undefined ? 0 : 1,
                }),
              ),
            ),
          )
        }
        return typeof result === "object" && result !== null ? observeQueries(result, observations) : result
      }
    },
  })
}
/* oxlint-enable typescript-eslint/no-unsafe-type-assertion */

function chunk<A>(items: ReadonlyArray<A>, size: number) {
  const output: A[][] = []
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size))
  return output
}

describe("public sync history", () => {
  it.effect("fails closed for a hidden related batch when the fence map is empty or partial", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_hidden_history")
      const responseID = Responses.ID.make("resp_hidden_history")
      const workflowID = Workflow.ID.make("wfl_hidden_history")
      yield* db
        .insert(ProjectTable)
        .values({
          id: ProjectV2.ID.global,
          worktree: AbsolutePath.make("D:/history"),
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "hidden-history",
          directory: AbsolutePath.make("D:/history"),
          title: "hidden history",
          visibility: "workflow",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventSequenceTable)
        .values([
          { aggregate_id: sessionID, seq: 0 },
          { aggregate_id: responseID, seq: 0 },
          { aggregate_id: workflowID, seq: 0 },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values([
          {
            id: EventV2.ID.make("evt_hidden_history_response"),
            aggregate_id: responseID,
            seq: 0,
            batch_id: "evt_hidden_history_batch",
            batch_index: 0,
            batch_size: 3,
            type: "response.created.1",
            data: {
              responseID,
              workflowID,
              context: [{ type: "message", content: "HIDDEN_HISTORY_RECEIPT" }],
            },
          },
          {
            id: EventV2.ID.make("evt_hidden_history_workflow"),
            aggregate_id: workflowID,
            seq: 0,
            batch_id: "evt_hidden_history_batch",
            batch_index: 1,
            batch_size: 3,
            type: "workflow.created.1",
            data: { workflowID, sessionID },
          },
          {
            id: EventV2.ID.make("evt_hidden_history_session"),
            aggregate_id: sessionID,
            seq: 0,
            batch_id: "evt_hidden_history_batch",
            batch_index: 2,
            batch_size: 3,
            type: "session.updated.1",
            data: { sessionID },
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const rows = yield* publicHistory(db, {})
      expect(rows).toEqual([])
      expect(JSON.stringify(rows)).not.toContain("HIDDEN_HISTORY_RECEIPT")
      expect(yield* publicHistory(db, { [sessionID]: 0 })).toEqual([])
    }),
  )

  it.effect("keeps public and legacy deletion tombstones while suppressing hidden deletion tombstones", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const publicID = SessionV2.ID.make("ses_public_deletion_history")
      const legacyID = SessionV2.ID.make("ses_legacy_deletion_history")
      const hiddenID = SessionV2.ID.make("ses_hidden_deletion_history")
      const invalidCurrentID = SessionV2.ID.make("ses_invalid_current_deletion_history")
      const unversionedID = SessionV2.ID.make("ses_unversioned_deletion_history")
      yield* db
        .insert(EventSequenceTable)
        .values(
          [publicID, legacyID, hiddenID, invalidCurrentID, unversionedID].map((aggregate_id) => ({
            aggregate_id,
            seq: 0,
          })),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values([
          {
            id: EventV2.ID.make("evt_public_deletion_history"),
            aggregate_id: publicID,
            seq: 0,
            type: "session.deleted.1",
            data: { sessionID: publicID, info: {}, visibility: "public" },
          },
          {
            id: EventV2.ID.make("evt_legacy_deletion_history"),
            aggregate_id: legacyID,
            seq: 0,
            type: "session.deleted.1",
            data: { sessionID: legacyID, info: {} },
          },
          {
            id: EventV2.ID.make("evt_hidden_deletion_history"),
            aggregate_id: hiddenID,
            seq: 0,
            type: "session.deleted.1",
            data: { sessionID: hiddenID, info: {}, visibility: "workflow" },
          },
          {
            id: EventV2.ID.make("evt_invalid_current_deletion_history"),
            aggregate_id: invalidCurrentID,
            seq: 0,
            type: "session.deleted.2",
            data: { sessionID: invalidCurrentID, info: {} },
          },
          {
            id: EventV2.ID.make("evt_unversioned_deletion_history"),
            aggregate_id: unversionedID,
            seq: 0,
            type: "session.deleted",
            data: { sessionID: unversionedID, info: {} },
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const rows = yield* publicHistory(db, {})
      expect(rows.map((row) => row.aggregate_id)).toEqual([publicID, legacyID, unversionedID])
    }),
  )

  it.effect("suppresses incomplete unknown workflow batches instead of treating missing authority as public", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const responseID = Responses.ID.make("resp_incomplete_history")
      yield* db.insert(EventSequenceTable).values({ aggregate_id: responseID, seq: 0 }).run().pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: EventV2.ID.make("evt_incomplete_history"),
          aggregate_id: responseID,
          seq: 0,
          batch_id: "evt_incomplete_history_batch",
          batch_index: 0,
          batch_size: 2,
          type: "response.created.1",
          data: { responseID, workflowID: "wfl_unknown_history" },
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* publicHistory(db, {})).toEqual([])
    }),
  )

  it.effect("rejects a forged complete history batch that contradicts stored Response ownership", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const publicID = SessionV2.ID.make("ses_public_forged_history")
      const hiddenID = SessionV2.ID.make("ses_hidden_forged_history")
      const declaredWorkflowID = Workflow.ID.make("wfl_public_forged_history")
      const hiddenWorkflowID = Workflow.ID.make("wfl_hidden_forged_history")
      const responseID = Responses.ID.make("resp_hidden_forged_history")
      yield* db
        .insert(ProjectTable)
        .values({
          id: ProjectV2.ID.global,
          worktree: AbsolutePath.make("D:/forged-history"),
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values(
          [
            [publicID, "public"],
            [hiddenID, "workflow"],
          ].map(([id, visibility]) => ({
            id: SessionV2.ID.make(id!),
            project_id: ProjectV2.ID.global,
            slug: id!,
            directory: AbsolutePath.make("D:/forged-history"),
            title: id!,
            visibility: visibility as "public" | "workflow",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(WorkflowRunTable)
        .values(
          [
            [declaredWorkflowID, publicID],
            [hiddenWorkflowID, hiddenID],
          ].map(([id, session_id]) => ({
            id: Workflow.ID.make(id!),
            type: "visual-build",
            status: "queued" as const,
            input: {},
            budget: {},
            usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
            session_id: SessionV2.ID.make(session_id!),
            version: 0,
            time_created: 1,
            time_updated: 1,
          })),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ResponseTable)
        .values({
          id: responseID,
          workflow_id: hiddenWorkflowID,
          model: "test",
          status: "queued",
          background: true,
          store: true,
          request_hash: "forged-history-authority",
          output: [],
          created_at: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventSequenceTable)
        .values([
          { aggregate_id: responseID, seq: 0 },
          { aggregate_id: declaredWorkflowID, seq: 0 },
          { aggregate_id: publicID, seq: 0 },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values([
          {
            id: EventV2.ID.make("evt_forged_history_response"),
            aggregate_id: responseID,
            seq: 0,
            batch_id: "evt_forged_history_batch",
            batch_index: 0,
            batch_size: 3,
            type: "response.created.1",
            data: {
              responseID,
              workflowID: declaredWorkflowID,
              context: [{ type: "message", content: "FORGED_HISTORY_RECEIPT" }],
            },
          },
          {
            id: EventV2.ID.make("evt_forged_history_workflow"),
            aggregate_id: declaredWorkflowID,
            seq: 0,
            batch_id: "evt_forged_history_batch",
            batch_index: 1,
            batch_size: 3,
            type: "workflow.created.1",
            data: { workflowID: declaredWorkflowID, sessionID: publicID },
          },
          {
            id: EventV2.ID.make("evt_forged_history_session"),
            aggregate_id: publicID,
            seq: 0,
            batch_id: "evt_forged_history_batch",
            batch_index: 2,
            batch_size: 3,
            type: "session.updated.1",
            data: { sessionID: publicID },
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const rows = yield* publicHistory(db, {})
      expect(rows).toEqual([])
      expect(JSON.stringify(rows)).not.toContain("FORGED_HISTORY_RECEIPT")
    }),
  )

  it.effect("rejects duplicate Workflow ownership declarations even when every Session is public", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const first = SessionV2.ID.make("ses_duplicate_history_first")
      const second = SessionV2.ID.make("ses_duplicate_history_second")
      const workflowID = Workflow.ID.make("wfl_duplicate_history")
      yield* db
        .insert(ProjectTable)
        .values({
          id: ProjectV2.ID.global,
          worktree: AbsolutePath.make("D:/duplicate-history"),
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values(
          [first, second].map((id) => ({
            id,
            project_id: ProjectV2.ID.global,
            slug: id,
            directory: AbsolutePath.make("D:/duplicate-history"),
            title: id,
            visibility: "public" as const,
            version: "test",
            time_created: 1,
            time_updated: 1,
          })),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(WorkflowRunTable)
        .values({
          id: workflowID,
          type: "visual-build",
          status: "queued",
          input: {},
          budget: {},
          usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
          session_id: first,
          version: 0,
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventSequenceTable)
        .values([
          { aggregate_id: workflowID, seq: 1 },
          { aggregate_id: first, seq: 0 },
          { aggregate_id: second, seq: 0 },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values([
          {
            id: EventV2.ID.make("evt_duplicate_history_workflow_second"),
            aggregate_id: workflowID,
            seq: 0,
            batch_id: "evt_duplicate_history_batch",
            batch_index: 0,
            batch_size: 4,
            type: "workflow.created.1",
            data: { workflowID, sessionID: second },
          },
          {
            id: EventV2.ID.make("evt_duplicate_history_session_second"),
            aggregate_id: second,
            seq: 0,
            batch_id: "evt_duplicate_history_batch",
            batch_index: 1,
            batch_size: 4,
            type: "session.created.1",
            data: { sessionID: second, visibility: "public" },
          },
          {
            id: EventV2.ID.make("evt_duplicate_history_session_first"),
            aggregate_id: first,
            seq: 0,
            batch_id: "evt_duplicate_history_batch",
            batch_index: 2,
            batch_size: 4,
            type: "session.created.1",
            data: { sessionID: first, visibility: "public" },
          },
          {
            id: EventV2.ID.make("evt_duplicate_history_workflow_first"),
            aggregate_id: workflowID,
            seq: 1,
            batch_id: "evt_duplicate_history_batch",
            batch_index: 3,
            batch_size: 4,
            type: "workflow.created.1",
            data: { workflowID, sessionID: first },
          },
        ])
        .run()
        .pipe(Effect.orDie)

      expect(yield* publicHistory(db, {})).toEqual([])
    }),
  )

  it.effect("rejects duplicate same-owner Response declarations with divergent receipt context", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_duplicate_response_history")
      const workflowID = Workflow.ID.make("wfl_duplicate_response_history")
      const responseID = Responses.ID.make("resp_duplicate_response_history")
      yield* db
        .insert(ProjectTable)
        .values({
          id: ProjectV2.ID.global,
          worktree: AbsolutePath.make("D:/duplicate-response-history"),
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: sessionID,
          directory: AbsolutePath.make("D:/duplicate-response-history"),
          title: sessionID,
          visibility: "public",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(WorkflowRunTable)
        .values({
          id: workflowID,
          type: "visual-build",
          status: "queued",
          input: {},
          budget: {},
          usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
          session_id: sessionID,
          version: 0,
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ResponseTable)
        .values({
          id: responseID,
          workflow_id: workflowID,
          model: "test",
          status: "queued",
          background: true,
          store: true,
          request_hash: "duplicate-response-history",
          output: [],
          created_at: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventSequenceTable)
        .values([
          { aggregate_id: responseID, seq: 1 },
          { aggregate_id: workflowID, seq: 0 },
          { aggregate_id: sessionID, seq: 0 },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values([
          {
            id: EventV2.ID.make("evt_duplicate_response_history_public"),
            aggregate_id: responseID,
            seq: 0,
            batch_id: "evt_duplicate_response_history_batch",
            batch_index: 0,
            batch_size: 4,
            type: "response.created.1",
            data: { responseID, workflowID, context: [{ type: "message", content: "public" }] },
          },
          {
            id: EventV2.ID.make("evt_duplicate_response_history_hidden"),
            aggregate_id: responseID,
            seq: 1,
            batch_id: "evt_duplicate_response_history_batch",
            batch_index: 1,
            batch_size: 4,
            type: "response.created.1",
            data: {
              responseID,
              workflowID,
              context: [{ type: "message", content: "HIDDEN_DUPLICATE_HISTORY_RECEIPT" }],
            },
          },
          {
            id: EventV2.ID.make("evt_duplicate_response_history_workflow"),
            aggregate_id: workflowID,
            seq: 0,
            batch_id: "evt_duplicate_response_history_batch",
            batch_index: 2,
            batch_size: 4,
            type: "workflow.created.1",
            data: { workflowID, sessionID },
          },
          {
            id: EventV2.ID.make("evt_duplicate_response_history_session"),
            aggregate_id: sessionID,
            seq: 0,
            batch_id: "evt_duplicate_response_history_batch",
            batch_index: 3,
            batch_size: 4,
            type: "session.updated.1",
            data: { sessionID },
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const rows = yield* publicHistory(db, {})
      expect(rows).toEqual([])
      expect(JSON.stringify(rows)).not.toContain("HIDDEN_DUPLICATE_HISTORY_RECEIPT")
    }),
  )

  it.effect("suppresses session.created history when no authoritative Session row exists", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_missing_created_history")
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 0 }).run().pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: EventV2.ID.make("evt_missing_created_history"),
          aggregate_id: sessionID,
          seq: 0,
          type: "session.created.1",
          data: { sessionID, info: {}, visibility: "public" },
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* publicHistory(db, {})).toEqual([])
    }),
  )

  it.effect("does not issue a second history query when the fence leaves zero candidates", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(EventSequenceTable).values({ aggregate_id: "unrelated", seq: 0 }).run().pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: EventV2.ID.make("evt_zero_candidate_history"),
          aggregate_id: "unrelated",
          seq: 0,
          type: "server.test.1",
          data: {},
        })
        .run()
        .pipe(Effect.orDie)
      const observations: QueryObservation[] = []
      const instrumented = observeQueries(db, observations)

      expect(yield* publicHistory(instrumented, { unrelated: 0 })).toEqual([])
      expect(observations).toEqual([{ method: "all", rows: 0 }])
    }),
  )

  it.effect("bulk-loads authority for 1050 owned Response batches without point-query N+1", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const candidateCount = 1_050
      const unrelatedCount = 5_000
      yield* db
        .insert(ProjectTable)
        .values({
          id: ProjectV2.ID.global,
          worktree: AbsolutePath.make("D:/bulk-authority-history"),
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      const sessionIDs = Array.from({ length: candidateCount }, (_, index) =>
        SessionV2.ID.make(`ses_bulk_authority_history_${index}`),
      )
      const workflowIDs = Array.from({ length: candidateCount }, (_, index) =>
        Workflow.ID.make(`wfl_bulk_authority_history_${index}`),
      )
      const responseIDs = Array.from({ length: candidateCount }, (_, index) =>
        Responses.ID.make(`resp_bulk_authority_history_${index}`),
      )
      yield* Effect.forEach(
        chunk(
          sessionIDs.map((id) => ({
            id,
            project_id: ProjectV2.ID.global,
            slug: id,
            directory: AbsolutePath.make("D:/bulk-authority-history"),
            title: id,
            visibility: "public" as const,
            version: "test",
            time_created: 1,
            time_updated: 1,
          })),
          100,
        ),
        (rows) => db.insert(SessionTable).values(rows).run().pipe(Effect.orDie),
        { discard: true },
      )
      yield* Effect.forEach(
        chunk(
          workflowIDs.map((id, index) => ({
            id,
            type: "visual-build",
            status: "queued" as const,
            input: {},
            budget: {},
            usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
            session_id: sessionIDs[index],
            version: 0,
            time_created: 1,
            time_updated: 1,
          })),
          100,
        ),
        (rows) => db.insert(WorkflowRunTable).values(rows).run().pipe(Effect.orDie),
        { discard: true },
      )
      yield* Effect.forEach(
        chunk(
          responseIDs.map((id, index) => ({
            id,
            workflow_id: workflowIDs[index],
            model: "test",
            status: "queued" as const,
            background: true,
            store: true,
            request_hash: `bulk-authority-history-${index}`,
            output: [],
            created_at: 1,
          })),
          100,
        ),
        (rows) => db.insert(ResponseTable).values(rows).run().pipe(Effect.orDie),
        { discard: true },
      )
      yield* db
        .insert(EventSequenceTable)
        .values([
          ...responseIDs.map((aggregate_id, seq) => ({ aggregate_id, seq })),
          { aggregate_id: "unrelated_history", seq: unrelatedCount - 1 },
        ])
        .run()
        .pipe(Effect.orDie)
      const candidates = Array.from({ length: candidateCount }, (_, index) => ({
        id: EventV2.ID.make(`evt_candidate_history_${index}`),
        aggregate_id: responseIDs[index],
        seq: index,
        batch_id: `evt_candidate_history_batch_${index}`,
        batch_index: 0,
        batch_size: 1,
        type: "response.in_progress.1",
        data: { responseID: responseIDs[index], timestamp: 1 },
      }))
      const unrelated = Array.from({ length: unrelatedCount }, (_, index) => ({
        id: EventV2.ID.make(`evt_unrelated_history_${index}`),
        aggregate_id: "unrelated_history",
        seq: index,
        type: "server.test.1",
        data: {},
      }))
      yield* Effect.forEach(
        chunk([...candidates, ...unrelated], 100),
        (rows) => db.insert(EventTable).values(rows).run().pipe(Effect.orDie),
        { discard: true },
      )
      const observations: QueryObservation[] = []
      const instrumented = observeQueries(db, observations)

      const rows = yield* publicHistory(instrumented, { unrelated_history: unrelatedCount - 1 })
      expect(rows).toHaveLength(candidateCount)
      expect(rows.map((row) => row.id)).toEqual(candidates.map((row) => row.id))
      expect(observations.filter((observation) => observation.method === "get")).toEqual([])
      expect(observations).toHaveLength(21)
      expect(observations.reduce((total, observation) => total + observation.rows, 0)).toBe(candidateCount * 5)
    }),
  )
})
