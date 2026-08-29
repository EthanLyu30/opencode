import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { PublicEventVisibility } from "@opencode-ai/core/event/public-visibility"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable, SessionTombstoneTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

function info(sessionID: SessionV2.ID) {
  return SessionV1.SessionInfo.make({
    id: sessionID,
    slug: "deletion-authority",
    projectID: Project.ID.global,
    directory: "/project",
    title: "Deletion authority",
    version: "test",
    time: { created: 0, updated: 0 },
  })
}

function seed(
  db: Database.Interface["db"],
  sessionID: SessionV2.ID,
  visibility: (typeof SessionTable.$inferInsert)["visibility"],
) {
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "deletion-authority",
        directory: AbsolutePath.make("/project"),
        title: "Deletion authority",
        visibility,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function collectPublic(events: EventV2.Interface, db: Database.Interface["db"], received: EventV2.Payload[]) {
  return events.listen((event) =>
    PublicEventVisibility.isPublic(event, PublicEventVisibility.databaseAuthority(db)).pipe(
      Effect.flatMap((visible) => (visible ? Effect.sync(() => received.push(event)) : Effect.void)),
    ),
  )
}

function publicHistory(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const rows = yield* db.select().from(EventTable).orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie)
    const authority = yield* PublicEventVisibility.preloadDatabaseAuthority(db, rows)
    return yield* PublicEventVisibility.filterHistory(rows, rows, authority)
  })
}

describe("Session deletion projection authority", () => {
  it.effect("rejects a current public tombstone for a workflow-hidden Session atomically", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_forged_public")
      const received: EventV2.Payload[] = []
      yield* seed(db, sessionID, "workflow")
      yield* collectPublic(events, db, received)

      const exit = yield* events
        .publish(SessionV1.Event.Deleted, {
          sessionID,
          visibility: "public",
          timeDeleted: 100,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({ id: sessionID, visibility: "workflow" })
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).toEqual([])
      expect(received).toEqual([])
      expect(yield* publicHistory(db)).toEqual([])
    }),
  )

  it.effect("persists and exposes a validated current public deletion", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_current_public")
      const received: EventV2.Payload[] = []
      yield* seed(db, sessionID, "public")
      yield* collectPublic(events, db, received)

      const deleted = yield* events.publish(SessionV1.Event.Deleted, {
        sessionID,
        visibility: "public",
        timeDeleted: 101,
      })

      expect(deleted.durable?.version).toBe(3)
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(received.map((event) => event.id)).toEqual([deleted.id])
      expect((yield* publicHistory(db)).map((event) => event.id)).toEqual([deleted.id])
      expect(
        yield* db
          .select()
          .from(SessionTombstoneTable)
          .where(eq(SessionTombstoneTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        session_id: sessionID,
        visibility: "public",
        deletion_event_id: deleted.id,
        deletion_version: 3,
        time_deleted: 101,
      })
    }),
  )

  it.effect("persists but suppresses a validated workflow deletion", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_current_workflow")
      const received: EventV2.Payload[] = []
      yield* seed(db, sessionID, "workflow")
      yield* collectPublic(events, db, received)

      yield* events.publish(SessionV1.Event.Deleted, {
        sessionID,
        visibility: "workflow",
        timeDeleted: 102,
      })

      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toHaveLength(1)
      expect(received).toEqual([])
      expect(yield* publicHistory(db)).toEqual([])
    }),
  )

  it.effect("deletes and exposes an existing public Session through legacy v1 replay", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_legacy_public")
      const eventID = EventV2.ID.make("evt_delete_legacy_public")
      const received: EventV2.Payload[] = []
      yield* seed(db, sessionID, "public")
      yield* collectPublic(events, db, received)

      yield* events.replay(
        {
          id: eventID,
          aggregateID: sessionID,
          seq: 0,
          type: EventV2.versionedType(SessionV1.Event.DeletedV1.type, 1),
          data: { sessionID, info: info(sessionID) },
        },
        { publish: true },
      )

      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(received.map((event) => event.id)).toEqual([eventID])
      expect((yield* publicHistory(db)).map((event) => event.id)).toEqual([eventID])
    }),
  )

  it.effect("replays a strict v2 workflow deletion into exact terminal authority", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_v2_workflow")
      const eventID = EventV2.ID.make("evt_delete_v2_workflow")
      yield* seed(db, sessionID, "workflow")

      yield* events.replay({
        id: eventID,
        aggregateID: sessionID,
        seq: 0,
        type: EventV2.versionedType(SessionV1.Event.DeletedV2.type, 2),
        data: { sessionID, info: info(sessionID), visibility: "workflow" },
      })

      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(
        yield* db
          .select()
          .from(SessionTombstoneTable)
          .where(eq(SessionTombstoneTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        session_id: sessionID,
        visibility: "workflow",
        deletion_event_id: eventID,
        deletion_version: 2,
        time_deleted: 0,
      })
      expect(yield* publicHistory(db)).toEqual([])
    }),
  )

  it.effect("rejects legacy visibility omission for a workflow-hidden Session", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_legacy_hidden")
      yield* seed(db, sessionID, "workflow")

      const exit = yield* events
        .replay(
          {
            id: EventV2.ID.make("evt_delete_legacy_hidden"),
            aggregateID: sessionID,
            seq: 0,
            type: EventV2.versionedType(SessionV1.Event.DeletedV1.type, 1),
            data: { sessionID, info: info(sessionID) },
          },
          { publish: true },
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({ id: sessionID, visibility: "workflow" })
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("rejects a direct deletion when no projected Session exists", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_missing_direct")

      const exit = yield* events
        .publish(SessionV1.Event.Deleted, {
          sessionID,
          visibility: "public",
          timeDeleted: 103,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("rejects a new replayed tombstone when no projected Session exists", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_missing_replay")

      const exit = yield* events
        .replay(
          {
            id: EventV2.ID.make("evt_delete_missing_replay"),
            aggregateID: sessionID,
            seq: 0,
            type: EventV2.versionedType(SessionV1.Event.Deleted.type, 3),
            data: { sessionID, visibility: "public", timeDeleted: 104 },
          },
          { publish: true },
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("accepts an exact replay of an already-validated deletion without republishing it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_exact_replay")
      const eventID = EventV2.ID.make("evt_delete_exact_replay")
      const received: EventV2.Payload[] = []
      yield* seed(db, sessionID, "public")
      yield* events.listen((event) => Effect.sync(() => received.push(event)))

      yield* events.publish(
        SessionV1.Event.Deleted,
        { sessionID, visibility: "public", timeDeleted: 105 },
        { id: eventID },
      )
      const stored = yield* db.select().from(EventTable).where(eq(EventTable.id, eventID)).get().pipe(Effect.orDie)
      if (!stored) return yield* Effect.die("Validated deletion event was not stored")

      yield* events.replay(
        {
          id: stored.id,
          aggregateID: stored.aggregate_id,
          seq: stored.seq,
          type: stored.type,
          data: stored.data,
          batchID: stored.batch_id ?? undefined,
          batchIndex: stored.batch_index ?? undefined,
          batchSize: stored.batch_size ?? undefined,
        },
        { publish: true },
      )

      expect(received.map((event) => event.id)).toEqual([eventID])
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([stored])
      expect(yield* EventV2.latestSequence(db, sessionID)).toBe(0)
      return yield* Effect.void
    }),
  )

  it.effect("rejects duplicate deletion authority in one batch atomically", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_duplicate_batch")
      const data = { sessionID, visibility: "public" as const, timeDeleted: 106 }
      yield* seed(db, sessionID, "public")

      const exit = yield* events
        .publish(SessionV1.Event.Deleted, data, {
          related: [{ definition: SessionV1.Event.Deleted, data }],
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({ id: sessionID, visibility: "public" })
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("rejects contradictory deletion authority in one batch atomically", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_contradictory_batch")
      yield* seed(db, sessionID, "public")

      const exit = yield* events
        .publish(
          SessionV1.Event.Deleted,
          { sessionID, visibility: "public", timeDeleted: 107 },
          {
            related: [
              {
                definition: SessionV1.Event.Deleted,
                data: { sessionID, visibility: "workflow", timeDeleted: 107 },
              },
            ],
          },
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({ id: sessionID, visibility: "public" })
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("permanently reserves a deleted Session ID against a later creation event", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_then_create")
      const deletionID = EventV2.ID.make("evt_delete_then_create_deleted")
      yield* seed(db, sessionID, "workflow")

      yield* events.publish(
        SessionV1.Event.Deleted,
        { sessionID, visibility: "workflow", timeDeleted: 200 },
        { id: deletionID },
      )
      const exit = yield* events
        .publish(SessionV1.Event.Created, {
          sessionID,
          info: info(sessionID),
          visibility: "public",
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* db.select().from(EventTable).all().pipe(Effect.orDie)).map((row) => row.id)).toEqual([deletionID])
      expect(yield* EventV2.latestSequence(db, sessionID)).toBe(0)
    }),
  )

  it.effect("serializes concurrent creation and deletion with deletion terminal", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_create_concurrent")
      yield* seed(db, sessionID, "public")

      const [deleted, created] = yield* Effect.all(
        [
          events
            .publish(SessionV1.Event.Deleted, {
              sessionID,
              visibility: "public",
              timeDeleted: 200,
            })
            .pipe(Effect.exit),
          events
            .publish(SessionV1.Event.Created, {
              sessionID,
              info: info(sessionID),
              visibility: "public",
            })
            .pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )

      expect(deleted._tag).toBe("Success")
      expect(created._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(
        yield* db
          .select()
          .from(SessionTombstoneTable)
          .where(eq(SessionTombstoneTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ session_id: sessionID, visibility: "public", deletion_version: 3 })
      expect(yield* EventV2.latestSequence(db, sessionID)).toBe(0)
    }),
  )

  it.effect("rejects delete then create members in one batch without deleting the live Session", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_create_batch")
      yield* seed(db, sessionID, "public")

      const exit = yield* events
        .publish(
          SessionV1.Event.Deleted,
          { sessionID, visibility: "public", timeDeleted: 201 },
          {
            related: [
              {
                definition: SessionV1.Event.Created,
                data: { sessionID, info: info(sessionID), visibility: "public" },
              },
            ],
          },
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({ id: sessionID, visibility: "public" })
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("rolls back sequential replay when deletion is followed by resurrection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_create_replay")
      yield* seed(db, sessionID, "public")

      const exit = yield* events
        .replayAll([
          {
            id: EventV2.ID.make("evt_delete_create_replay_deleted"),
            aggregateID: sessionID,
            seq: 0,
            type: EventV2.versionedType(SessionV1.Event.Deleted.type, 3),
            data: { sessionID, visibility: "public", timeDeleted: 202 },
          },
          {
            id: EventV2.ID.make("evt_delete_create_replay_created"),
            aggregateID: sessionID,
            seq: 1,
            type: EventV2.versionedType(SessionV1.Event.Created.type, 1),
            data: { sessionID, info: info(sessionID), visibility: "public" },
          },
        ])
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({ id: sessionID, visibility: "public" })
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("requires exact persisted tombstone identity to expose a deleted Session", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_delete_exact_visibility")
      yield* seed(db, sessionID, "public")
      const deleted = yield* events.publish(
        SessionV1.Event.Deleted,
        { sessionID, visibility: "public", timeDeleted: 203 },
        { id: EventV2.ID.make("evt_delete_exact_visibility") },
      )
      const authority = PublicEventVisibility.databaseAuthority(db)

      expect(yield* PublicEventVisibility.isPublic(deleted, authority)).toBe(true)
      expect(
        yield* PublicEventVisibility.isPublic(
          { ...deleted, id: EventV2.ID.make("evt_delete_forged_visibility") },
          authority,
        ),
      ).toBe(false)
      expect(
        yield* PublicEventVisibility.isPublic({ ...deleted, durable: { ...deleted.durable!, version: 2 } }, authority),
      ).toBe(false)
    }),
  )

  it.effect("suppresses a deletion payload when no durable tombstone authority exists", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_delete_no_tombstone")

      expect(
        yield* PublicEventVisibility.isPublic(
          {
            id: EventV2.ID.make("evt_delete_no_tombstone"),
            type: SessionV1.Event.Deleted.type,
            data: { sessionID, visibility: "public", timeDeleted: 204 },
            durable: { aggregateID: sessionID, seq: 0, version: 3 },
          },
          PublicEventVisibility.databaseAuthority(db),
        ),
      ).toBe(false)
    }),
  )
})
