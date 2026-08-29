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
import { publicHistory } from "../../src/server/routes/instance/httpapi/handlers/sync-history"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Database.node))

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
      yield* db
        .insert(EventSequenceTable)
        .values([publicID, legacyID, hiddenID].map((aggregate_id) => ({ aggregate_id, seq: 0 })))
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
        ])
        .run()
        .pipe(Effect.orDie)

      const rows = yield* publicHistory(db, {})
      expect(rows.map((row) => row.aggregate_id)).toEqual([publicID, legacyID])
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
})
