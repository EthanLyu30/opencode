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
import { SessionTable } from "@opencode-ai/core/session/sql"
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
        .publish(SessionV1.Event.Deleted, { sessionID, info: info(sessionID), visibility: "public" })
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
        info: info(sessionID),
        visibility: "public",
      })

      expect(deleted.durable?.version).toBe(2)
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(received.map((event) => event.id)).toEqual([deleted.id])
      expect((yield* publicHistory(db)).map((event) => event.id)).toEqual([deleted.id])
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
        info: info(sessionID),
        visibility: "workflow",
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
        .publish(SessionV1.Event.Deleted, { sessionID, info: info(sessionID), visibility: "public" })
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
            type: EventV2.versionedType(SessionV1.Event.Deleted.type, 2),
            data: { sessionID, info: info(sessionID), visibility: "public" },
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
        { sessionID, info: info(sessionID), visibility: "public" },
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
      const data = { sessionID, info: info(sessionID), visibility: "public" as const }
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
          { sessionID, info: info(sessionID), visibility: "public" },
          {
            related: [
              {
                definition: SessionV1.Event.Deleted,
                data: { sessionID, info: info(sessionID), visibility: "workflow" },
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
})
