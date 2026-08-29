import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { Event } from "@opencode-ai/schema/event"
import { Session } from "@opencode-ai/schema/session"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { eq, sql } from "drizzle-orm"
import path from "node:path"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location({ directory: AbsolutePath.make("project"), workspaceID: WorkspaceV2.ID.make("wrk_test") }),
  ),
)
const Message = EventV2.define({
  type: "test.message",
  schema: {
    text: Schema.String,
  },
})

const SyncMessage = EventV2.define({
  type: "test.sync",
  durable: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const SyncSent = EventV2.define({
  type: "test.sent",
  durable: {
    version: 1,
    aggregate: "messageID",
  },
  schema: {
    messageID: Schema.String,
    text: Schema.String,
  },
})

const GlobalMessage = EventV2.define({
  type: "test.global",
  schema: {
    text: Schema.String,
  },
})

const VersionedMessage = EventV2.define({
  type: "test.versioned",
  durable: {
    version: 2,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const DurableMessage = SessionV1.Event.MessageRemoved
const durableData = (sessionID: Session.ID, text: string) => ({
  sessionID,
  messageID: SessionV1.MessageID.ascending(`msg_${text}`),
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, Location.node]), [[Location.node, locationLayer]]),
)
const itWithoutLocation = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))

describe("EventV2", () => {
  it.effect("publishes events with the current location", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const fiber = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })
      const received = Array.from(yield* Fiber.join(fiber))

      expect(received).toEqual([event])
      expect(event.type).toBe("test.message")
      expect(event).not.toHaveProperty("version")
      expect(event.data).toEqual({ text: "hello" })
      expect(event.location).toEqual({
        directory: AbsolutePath.make("project"),
        workspaceID: WorkspaceV2.ID.make("wrk_test"),
      })
    }),
  )

  it.effect("inherits the primary routing envelope for atomically related events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const fiber = yield* events.subscribe(SyncSent).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      const primary = yield* events.publish(
        SyncMessage,
        { id: "sync_related_primary", text: "primary" },
        {
          metadata: { source: "responses" },
          related: [
            {
              definition: SyncSent,
              data: { messageID: "sync_related_child", text: "related" },
            },
          ],
        },
      )
      const [related] = Array.from(yield* Fiber.join(fiber))

      expect(related?.location).toEqual(primary.location)
      expect(related?.metadata).toEqual(primary.metadata)
      expect(related?.data).toEqual({ messageID: "sync_related_child", text: "related" })
    }),
  )

  it.effect("preserves related aggregate sequence order during reentrant durable publishes", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const messageID = "sync_reentrant_conversation"
      const fiber = yield* events.subscribe(SyncSent).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      const stop = yield* events.listen((event) => {
        if (event.type !== SyncMessage.type || (event.data as { id?: string }).id !== "sync_reentrant_outer") {
          return Effect.void
        }
        return events
          .publish(
            SyncMessage,
            { id: "sync_reentrant_inner", text: "inner primary" },
            {
              related: [
                {
                  definition: SyncSent,
                  data: { messageID, text: "inner" },
                },
              ],
            },
          )
          .pipe(Effect.asVoid)
      })
      yield* Effect.yieldNow

      yield* events.publish(
        SyncMessage,
        { id: "sync_reentrant_outer", text: "outer primary" },
        {
          related: [
            {
              definition: SyncSent,
              data: { messageID, text: "outer" },
            },
          ],
        },
      )
      yield* stop
      const received = Array.from(yield* Fiber.join(fiber))

      expect(received.map((event) => event.durable?.seq)).toEqual([0, 1])
      expect(received.map((event) => event.data.text)).toEqual(["outer", "inner"])
    }),
  )

  it.effect("does not deadlock when a child fiber publishes during durable notification", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const messageID = "sync_reentrant_child_conversation"
      const fiber = yield* events.subscribe(SyncSent).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      const stop = yield* events.listen((event) => {
        if (event.type !== SyncMessage.type || (event.data as { id?: string }).id !== "sync_reentrant_child_outer") {
          return Effect.void
        }
        return Effect.all(
          [
            events.publish(
              SyncMessage,
              { id: "sync_reentrant_child_inner", text: "inner primary" },
              {
                related: [
                  {
                    definition: SyncSent,
                    data: { messageID, text: "inner" },
                  },
                ],
              },
            ),
          ],
          { concurrency: "unbounded", discard: true },
        )
      })
      yield* Effect.yieldNow

      yield* events
        .publish(
          SyncMessage,
          { id: "sync_reentrant_child_outer", text: "outer primary" },
          {
            related: [
              {
                definition: SyncSent,
                data: { messageID, text: "outer" },
              },
            ],
          },
        )
        .pipe(Effect.timeout("1 second"))
      yield* stop
      const received = Array.from(yield* Fiber.join(fiber).pipe(Effect.timeout("1 second")))

      expect(received.map((event) => event.durable?.seq)).toEqual([0, 1])
      expect(received.map((event) => event.data.text)).toEqual(["outer", "inner"])
    }),
  )

  it.effect("serializes reentrant replay notifications with committed related events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const received = new Array<EventV2.Payload<typeof DurableMessage>>()
      const stopCollecting = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === DurableMessage.type) received.push(event as EventV2.Payload<typeof DurableMessage>)
        }),
      )
      const stop = yield* events.listen((event) => {
        if (event.type !== SyncMessage.type || (event.data as { id?: string }).id !== "sync_reentrant_replay_outer") {
          return Effect.void
        }
        return events.replay(
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 1,
            aggregateID,
            data: durableData(aggregateID, "replayed"),
          },
          { publish: true },
        )
      })

      yield* events
        .publish(
          SyncMessage,
          { id: "sync_reentrant_replay_outer", text: "outer primary" },
          {
            related: [
              {
                definition: DurableMessage,
                data: durableData(aggregateID, "outer"),
              },
            ],
          },
        )
        .pipe(Effect.timeout("1 second"))
      yield* stop
      yield* stopCollecting

      expect(received.map((event) => event.durable?.seq)).toEqual([0, 1])
      expect(received.map((event) => event.data.messageID)).toEqual([
        durableData(aggregateID, "outer").messageID,
        durableData(aggregateID, "replayed").messageID,
      ])
    }),
  )

  itWithoutLocation.effect("omits location when no location is available", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const event = yield* events.publish(GlobalMessage, { text: "hello" })

      expect(event).not.toHaveProperty("location")
      expect(event.type).toBe("test.global")
    }),
  )

  it.effect("publishes definition version", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const event = yield* events.publish(VersionedMessage, { id: "one", text: "hello" })

      expect(event.type).toBe("test.versioned")
      expect(event.durable?.version).toBe(2)
    }),
  )

  it.effect("selects the latest durable definition independent of declaration order", () =>
    Effect.sync(() => {
      const latest = EventV2.define({
        type: "test.out-of-order",
        durable: { version: 2, aggregate: "id" },
        schema: { id: Schema.String },
      })
      const historical = EventV2.define({
        type: "test.out-of-order",
        durable: { version: 1, aggregate: "id" },
        schema: { id: Schema.String },
      })

      expect(Event.latest([latest, historical]).get("test.out-of-order")).toBe(latest)
      expect(Event.latest([historical, latest]).get("test.out-of-order")).toBe(latest)
    }),
  )

  it.effect("publishes to typed and wildcard subscriptions", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const typed = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const wildcard = yield* events.all().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })

      expect(Array.from(yield* Fiber.join(typed))).toEqual([event])
      expect(Array.from(yield* Fiber.join(wildcard))).toEqual([event])
    }),
  )

  it.effect("runs projectors inline", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      const event = yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* events.publish(SyncMessage, { id: "one", text: "after unsubscribe" })

      expect(received[0]).toEqual(event)
      expect(received[1]?.data).toEqual({ id: "one", text: "after unsubscribe" })
    }),
  )

  it.effect("commits local operational state inside a new durable event transaction", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      const aggregateID = EventV2.ID.create()
      yield* events.project(SyncMessage, () => Effect.sync(() => received.push("projector")))

      yield* events.publish(
        SyncMessage,
        { id: aggregateID, text: "hello" },
        { commit: (seq) => Effect.sync(() => received.push(`commit:${seq}`)) },
      )

      expect(received).toEqual(["projector", "commit:0"])
    }),
  )

  it.effect("rolls back the durable event and projector when the local commit fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      yield* db.run("CREATE TABLE IF NOT EXISTS event_commit_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_commit_probe")
      yield* events.project(SyncMessage, () =>
        db.run("INSERT INTO event_commit_probe (value) VALUES ('projected')").pipe(Effect.orDie, Effect.asVoid),
      )

      const exit = yield* events
        .publish(SyncMessage, { id: aggregateID, text: "hello" }, { commit: () => Effect.die("commit failed") })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("commit failed")
      expect(yield* db.all("SELECT value FROM event_commit_probe")).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
    }),
  )

  it.effect("rejects local commit hooks on live-only events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events.publish(Message, { text: "hello" }, { commit: () => Effect.void }).pipe(Effect.exit)

      expect(String(exit)).toContain("Local commit hooks require a durable event")
    }),
  )

  it.effect("runs projectors before publishing to streams", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      const fiber = yield* events.all().pipe(
        Stream.take(1),
        Stream.runForEach(() => Effect.sync(() => received.push("stream"))),
        Effect.forkScoped,
      )
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      yield* Effect.yieldNow
      yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* Fiber.join(fiber)

      expect(received).toEqual([SyncMessage.type, "stream"])
    }),
  )

  it.effect("runs listeners inline after projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.project(SyncMessage, () =>
        Effect.sync(() => {
          received.push("projector")
        }),
      )
      const unsubscribe = yield* events.listen(() =>
        Effect.sync(() => {
          received.push("listener")
        }),
      )

      yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* unsubscribe
      yield* events.publish(SyncMessage, { id: "one", text: "after unsubscribe" })

      expect(received).toEqual(["projector", "listener", "projector"])
    }),
  )

  it.effect("isolates observer defects after durable events commit", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.listen(() => {
        throw new Error("listener defect")
      })
      yield* events.listen((event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      const event = yield* events.publish(SyncMessage, { id: "one", text: "hello" })

      expect(received).toEqual([SyncMessage.type])
      expect(event.durable?.seq).toBeNumber()
    }),
  )

  it.effect("notifies global listeners only after a durable event is committed", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const observed = new Array<{ id: string; seq: number }>()
      yield* events.listen((event) =>
        event.type !== SyncMessage.type
          ? Effect.void
          : db
              .select({ id: EventTable.id, seq: EventTable.seq })
              .from(EventTable)
              .where(eq(EventTable.id, event.id))
              .get()
              .pipe(
                Effect.orDie,
                Effect.tap((row) =>
                  Effect.sync(() => {
                    if (row) observed.push(row)
                  }),
                ),
                Effect.asVoid,
              ),
      )

      const event = yield* events.publish(SyncMessage, { id: aggregateID, text: "committed" })
      if (!event.durable) throw new Error("Expected durable event metadata")

      expect(observed).toEqual([{ id: event.id, seq: event.durable.seq }])
    }),
  )

  it.effect("ends only an overflowing bounded subscriber without blocking other listeners", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const consuming = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const slowStream = yield* EventV2.allBounded(events, 1)
      const fastStream = yield* EventV2.allBounded(events, 8)
      const slow = yield* slowStream.pipe(
        Stream.runForEach(() => Deferred.succeed(consuming, undefined).pipe(Effect.andThen(Deferred.await(release)))),
        Effect.forkScoped,
      )
      const fast = yield* fastStream.pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)

      yield* events.publish(Message, { text: "one" })
      yield* Deferred.await(consuming)
      yield* events.publish(Message, { text: "two" })
      yield* events.publish(Message, { text: "overflow" })
      const last = yield* events.publish(Message, { text: "still delivered" })
      yield* Deferred.succeed(release, undefined)

      const slowExit = yield* Fiber.await(slow)
      expect(Exit.findErrorOption(slowExit).pipe(Option.getOrUndefined)).toBeInstanceOf(EventV2.SubscriberOverflowError)
      expect(Array.from(yield* Fiber.join(fast))).toEqual([
        expect.objectContaining({ data: { text: "one" } }),
        expect.objectContaining({ data: { text: "two" } }),
        expect.objectContaining({ data: { text: "overflow" } }),
        last,
      ])
    }),
  )

  it.effect("preserves observer interruption", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.listen(() => Effect.interrupt)

      const exit = yield* events.publish(SyncMessage, { id: "interrupted", text: "hello" }).pipe(Effect.exit)
      const committed = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, "interrupted"))
        .get()
        .pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBeTrue()
      expect(committed).toBeDefined()
    }),
  )

  it.effect("keeps live-only listener defects fail-fast", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const defect = new Error("listener defect")
      yield* events.listen(() => Effect.die(defect))

      expect(yield* events.publish(Message, { text: "hello" }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("inserts durable event rows on publish", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.type).toBe(EventV2.versionedType(SyncMessage.type, 1))
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("increments durable event seq per aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" })
      yield* events.publish(SyncMessage, { id: aggregateID, text: "second" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
    }),
  )

  it.effect("replays durable aggregate events after a sequence and tails new events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "zero"))
      yield* events.publish(DurableMessage, durableData(aggregateID, "one"))
      const fiber = yield* events
        .durable({ aggregateID, after: 0 })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publish(DurableMessage, durableData(aggregateID, "two"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
        [1, durableData(aggregateID, "one")],
        [2, durableData(aggregateID, "two")],
      ])
    }),
  )

  it.effect("catches durable aggregate events published during replay handoff", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "zero"))
      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)

      yield* events.publish(DurableMessage, durableData(aggregateID, "one"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
        [0, durableData(aggregateID, "zero")],
        [1, durableData(aggregateID, "one")],
      ])
    }),
  )

  it.effect("retains a durable wake committed while historical replay is paused", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>()
      const continueRead = yield* Deferred.make<void>()
      let pause = true
      const eventLayer = EventV2.layerWith({
        beforeAggregateRead: () =>
          pause
            ? Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(continueRead)))
            : Effect.void,
      }).pipe(Layer.provide(LayerNode.compile(Database.node)))

      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const aggregateID = Session.ID.create()
        const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Deferred.await(readStarted)

        pause = false
        yield* events.publish(DurableMessage, durableData(aggregateID, "during handoff"))
        yield* Deferred.succeed(continueRead, undefined)

        expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
          [0, durableData(aggregateID, "during handoff")],
        ])
      }).pipe(Effect.provide(Layer.merge(LayerNode.compile(Database.node), eventLayer)))
    }),
  )

  it.effect("coalesces durable aggregate wakes while draining every committed event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const count = 64
      const fiber = yield* events
        .durable({ aggregateID })
        .pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      for (let index = 0; index < count; index++) {
        yield* events.publish(DurableMessage, durableData(aggregateID, String(index)))
      }

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual(
        Array.from({ length: count }, (_, index) => [index, durableData(aggregateID, String(index))]),
      )
    }),
  )

  it.effect("omits live-only events from durable aggregate streams", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publish(Message, { text: "live only" })
      yield* events.publish(DurableMessage, durableData(aggregateID, "durable"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => event.type)).toEqual([DurableMessage.type])
    }),
  )

  it.effect("uses custom sync aggregate field", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncSent, { messageID: aggregateID, text: "sent" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("replays durable events through projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "hello"),
      })

      expect(received[0]?.type).toBe(DurableMessage.type)
      expect(received[0]?.data).toEqual(durableData(aggregateID, "hello"))
    }),
  )

  it.effect("replay inserts external event rows", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect(
    "replay rejects an envelope aggregate that differs from its payload without mutating the payload aggregate",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const envelopeAggregateID = Session.ID.create()
        const payloadAggregateID = Session.ID.create()
        const received = new Array<EventV2.Payload>()
        yield* events.publish(DurableMessage, durableData(payloadAggregateID, "seed"))
        yield* events.project(DurableMessage, (event) =>
          Effect.sync(() => {
            received.push(event)
          }),
        )

        const exit = yield* events
          .replay({
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 1,
            aggregateID: envelopeAggregateID,
            data: durableData(payloadAggregateID, "replayed"),
          })
          .pipe(Effect.exit)
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, payloadAggregateID))
          .all()
          .pipe(Effect.orDie)
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, payloadAggregateID))
          .get()
          .pipe(Effect.orDie)

        expect(String(exit)).toContain("Aggregate mismatch")
        expect(received).toHaveLength(0)
        expect(rows).toHaveLength(1)
        expect(sequence).toEqual({ seq: 0 })
      }),
  )

  it.effect("replay defects on sequence mismatch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "first"),
      })
      const exit = yield* events
        .replay({
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 5,
          aggregateID,
          data: durableData(aggregateID, "bad"),
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Sequence mismatch")
    }),
  )

  it.effect("replay decodes synchronized transformed values before projection", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const received = new Array<typeof SessionEvent.ContextUpdated.Type>()
      yield* events.project(SessionEvent.ContextUpdated, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SessionEvent.ContextUpdated.type, 1),
        seq: 0,
        aggregateID,
        data: { sessionID: aggregateID, messageID: "msg_context", timestamp: 0, text: "context" },
      })

      expect(received[0]?.data.timestamp).toEqual(DateTime.makeUnsafe(0))
    }),
  )

  it.effect("replay defects on unknown event type", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events
        .replay({
          id: EventV2.ID.create(),
          type: "unknown.event.1",
          seq: 0,
          aggregateID: EventV2.ID.create(),
          data: {},
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Unknown durable event type")
    }),
  )

  it.effect("replayAll validates contiguous aggregate events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const source = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "one"),
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "two"),
        },
      ])

      expect(source).toBe(aggregateID)
    }),
  )

  it.effect("replayAll accepts later chunks after the first batch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      const one = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "one"),
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "two"),
        },
      ])
      const two = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 2,
          aggregateID,
          data: durableData(aggregateID, "three"),
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 3,
          aggregateID,
          data: durableData(aggregateID, "four"),
        },
      ])
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(one).toBe(aggregateID)
      expect(two).toBe(aggregateID)
      expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
    }),
  )

  it.effect("replays one complete durable batch across aggregates and notifies primary before related", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const primaryID = Session.ID.create()
      const relatedID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(primaryID, "batch-primary"), {
        related: [{ definition: DurableMessage, data: durableData(relatedID, "batch-related") }],
      })
      const stored = yield* db.select().from(EventTable).orderBy(EventTable.batch_index).all().pipe(Effect.orDie)
      const serialized = stored.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
        batchID: event.batch_id!,
        batchIndex: event.batch_index!,
        batchSize: event.batch_size!,
      }))
      expect(serialized.map((event) => [event.batchIndex, event.batchSize])).toEqual([
        [0, 2],
        [1, 2],
      ])
      yield* events.remove(primaryID)
      yield* events.remove(relatedID)
      const received: EventV2.Payload[] = []
      const projected: EventV2.Payload[] = []
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      yield* events.project(DurableMessage, (event) => Effect.sync(() => projected.push(event)))

      yield* events.replayBatches(serialized, { publish: true })

      expect(received.map((event) => event.durable?.aggregateID)).toEqual([primaryID, relatedID])
      expect(received.map((event) => event.durable?.batch)).toEqual([
        { id: serialized[0]!.batchID, index: 0, size: 2 },
        { id: serialized[0]!.batchID, index: 1, size: 2 },
      ])
      expect(received.map((event) => event.durable?.related?.length)).toEqual([2, 2])
      expect(projected[0]?.durable?.related).toMatchObject([{ type: DurableMessage.type }])
      expect(projected[1]?.durable?.related).toHaveLength(2)

      yield* events.replayBatches(serialized, { publish: true })
      expect(received.map((event) => event.durable?.aggregateID)).toEqual([primaryID, relatedID])
      expect(projected).toHaveLength(2)
    }),
  )

  it.effect("exact batch replay claims every unowned aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const primaryID = Session.ID.create()
      const relatedID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(primaryID, "claim-primary"), {
        related: [{ definition: DurableMessage, data: durableData(relatedID, "claim-related") }],
      })
      const stored = yield* db.select().from(EventTable).orderBy(EventTable.batch_index).all().pipe(Effect.orDie)
      const serialized = stored.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
        batchID: event.batch_id!,
        batchIndex: event.batch_index!,
        batchSize: event.batch_size!,
      }))

      yield* events.replayBatches(serialized, { ownerID: "owner-exact", strictOwner: true })

      const owners = yield* db
        .select({ aggregateID: EventSequenceTable.aggregate_id, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .all()
        .pipe(Effect.orDie)
      expect(new Map(owners.map((row) => [row.aggregateID, row.ownerID]))).toEqual(
        new Map([
          [primaryID, "owner-exact"],
          [relatedID, "owner-exact"],
        ]),
      )
    }),
  )

  it.effect("strict exact batch replay rejects a conflicting owner", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const primaryID = Session.ID.create()
      const relatedID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(primaryID, "conflict-primary"), {
        related: [{ definition: DurableMessage, data: durableData(relatedID, "conflict-related") }],
      })
      const stored = yield* db.select().from(EventTable).orderBy(EventTable.batch_index).all().pipe(Effect.orDie)
      yield* events.claim(primaryID, "owner-a")
      yield* events.claim(relatedID, "owner-a")

      const error = yield* events
        .replayBatches(
          stored.map((event) => ({
            id: event.id,
            aggregateID: event.aggregate_id,
            seq: event.seq,
            type: event.type,
            data: event.data,
            batchID: event.batch_id!,
            batchIndex: event.batch_index!,
            batchSize: event.batch_size!,
          })),
          { ownerID: "owner-b", strictOwner: true },
        )
        .pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "EventV2.InvalidReplayBatch", reason: "owner_mismatch" })
    }),
  )

  it.effect("allows only one concurrent owner to claim an exact replay batch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateIDs = Array.from({ length: 24 }, () => Session.ID.create())
      yield* events.publish(DurableMessage, durableData(aggregateIDs[0]!, "concurrent-owner-primary"), {
        related: aggregateIDs.slice(1).map((aggregateID, index) => ({
          definition: DurableMessage,
          data: durableData(aggregateID, `concurrent-owner-related-${index}`),
        })),
      })
      const stored = yield* db.select().from(EventTable).orderBy(EventTable.batch_index).all().pipe(Effect.orDie)
      const serialized = stored.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
        batchID: event.batch_id!,
        batchIndex: event.batch_index!,
        batchSize: event.batch_size!,
      }))

      const claims = yield* Effect.all(
        ["owner-concurrent-a", "owner-concurrent-b"].map((ownerID) =>
          events.replayBatches(serialized, { ownerID, strictOwner: true }).pipe(Effect.exit),
        ),
        { concurrency: "unbounded" },
      )
      const owners = yield* db
        .select({ ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .all()
        .pipe(Effect.orDie)

      expect(claims.filter(Exit.isSuccess)).toHaveLength(1)
      expect(new Set(owners.map((row) => row.ownerID)).size).toBe(1)
    }),
  )

  it.effect("rejects incomplete cross-aggregate batches without committing a prefix", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const primaryID = Session.ID.create()
      const relatedID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(primaryID, "incomplete-primary"), {
        related: [{ definition: DurableMessage, data: durableData(relatedID, "incomplete-related") }],
      })
      const stored = yield* db.select().from(EventTable).orderBy(EventTable.batch_index).all().pipe(Effect.orDie)
      yield* events.remove(primaryID)
      yield* events.remove(relatedID)

      const error = yield* events
        .replayBatches([
          {
            id: stored[0]!.id,
            aggregateID: stored[0]!.aggregate_id,
            seq: stored[0]!.seq,
            type: stored[0]!.type,
            data: stored[0]!.data,
            batchID: stored[0]!.batch_id!,
            batchIndex: stored[0]!.batch_index!,
            batchSize: stored[0]!.batch_size!,
          },
        ])
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(EventV2.InvalidReplayBatchError)
      expect(error.reason).toBe("incomplete_batch")
      expect(yield* EventV2.latestSequence(db, primaryID)).toBe(-1)
      expect(yield* EventV2.latestSequence(db, relatedID)).toBe(-1)
    }),
  )

  it.effect("rejects a multi-member batch through single-aggregate replayAll", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const error = yield* events
        .replayAll([
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 0,
            aggregateID,
            data: durableData(aggregateID, "fragment"),
            batchID: "batch_fragment",
            batchIndex: 0,
            batchSize: 2,
          },
        ])
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(EventV2.InvalidReplayBatchError)
      expect(error.reason).toBe("incomplete_batch")
    }),
  )

  it.effect("rejects duplicate batch indices before projection", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const batchID = "batch_duplicate_index"
      const firstID = Session.ID.create()
      const secondID = Session.ID.create()
      const error = yield* events
        .replayBatches([
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 0,
            aggregateID: firstID,
            data: durableData(firstID, "duplicate-first"),
            batchID,
            batchIndex: 0,
            batchSize: 2,
          },
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 0,
            aggregateID: secondID,
            data: durableData(secondID, "duplicate-second"),
            batchID,
            batchIndex: 0,
            batchSize: 2,
          },
        ])
        .pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "EventV2.InvalidReplayBatch", reason: "invalid_batch", batchID })
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("rejects a replay dependency deadlock without writing the future event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const error = yield* events
        .replayBatches([
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 1,
            aggregateID,
            data: durableData(aggregateID, "future"),
            batchID: "batch_future",
            batchIndex: 0,
            batchSize: 1,
          },
        ])
        .pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "EventV2.InvalidReplayBatch", reason: "deadlock" })
      expect(yield* EventV2.latestSequence(db, aggregateID)).toBe(-1)
    }),
  )

  it.effect("plans every batch before a ready prefix can precede a deadlock", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const readyID = Session.ID.create()
      const futureID = Session.ID.create()
      const received = new Array<EventV2.Payload>()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))

      const error = yield* events
        .replayBatches(
          [
            {
              id: EventV2.ID.create(),
              type: EventV2.versionedType(DurableMessage.type, 1),
              seq: 0,
              aggregateID: readyID,
              data: durableData(readyID, "ready-before-deadlock"),
              batchID: "batch_ready_before_deadlock",
              batchIndex: 0,
              batchSize: 1,
            },
            {
              id: EventV2.ID.create(),
              type: EventV2.versionedType(DurableMessage.type, 1),
              seq: 1,
              aggregateID: futureID,
              data: durableData(futureID, "deadlocked-after-ready"),
              batchID: "batch_deadlocked_after_ready",
              batchIndex: 0,
              batchSize: 1,
            },
          ],
          { publish: true },
        )
        .pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "EventV2.InvalidReplayBatch", reason: "deadlock" })
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).toEqual([])
      expect(received).toEqual([])
    }),
  )

  it.effect("rolls back every batch and notification when a later projector fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const firstID = Session.ID.create()
      const failingID = Session.ID.create()
      const received = new Array<EventV2.Payload>()
      yield* db.run("CREATE TABLE event_replay_batch_probe (aggregate_id text NOT NULL)")
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      yield* events.project(DurableMessage, (event) =>
        Effect.gen(function* () {
          yield* db
            .run(sql`INSERT INTO event_replay_batch_probe (aggregate_id) VALUES (${event.data.sessionID})`)
            .pipe(Effect.orDie)
          if (event.data.sessionID === failingID) yield* Effect.die("later replay projector failed")
          return yield* Effect.void
        }),
      )

      const exit = yield* events
        .replayBatches(
          [
            {
              id: EventV2.ID.create(),
              type: EventV2.versionedType(DurableMessage.type, 1),
              seq: 0,
              aggregateID: firstID,
              data: durableData(firstID, "first-projector"),
              batchID: "batch_first_projector",
              batchIndex: 0,
              batchSize: 1,
            },
            {
              id: EventV2.ID.create(),
              type: EventV2.versionedType(DurableMessage.type, 1),
              seq: 0,
              aggregateID: failingID,
              data: durableData(failingID, "failing-projector"),
              batchID: "batch_failing_projector",
              batchIndex: 0,
              batchSize: 1,
            },
          ],
          { publish: true },
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain("later replay projector failed")
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.all("SELECT aggregate_id FROM event_replay_batch_probe")).toEqual([])
      expect(received).toEqual([])
    }),
  )

  it.effect("rejects replay into a partially stored batch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const primaryID = Session.ID.create()
      const relatedID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(primaryID, "partial-primary"), {
        related: [{ definition: DurableMessage, data: durableData(relatedID, "partial-related") }],
      })
      const stored = yield* db.select().from(EventTable).orderBy(EventTable.batch_index).all().pipe(Effect.orDie)
      const serialized = stored.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
        batchID: event.batch_id!,
        batchIndex: event.batch_index!,
        batchSize: event.batch_size!,
      }))
      yield* events.remove(relatedID)

      const error = yield* events.replayBatches(serialized).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "EventV2.InvalidReplayBatch", reason: "partial_batch" })
      expect(yield* EventV2.latestSequence(db, primaryID)).toBe(0)
      expect(yield* EventV2.latestSequence(db, relatedID)).toBe(-1)
    }),
  )

  it.effect("claim fences replay owners", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "seed"))
      yield* events.claim(aggregateID, "owner-a")
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "ignored"),
        },
        { ownerID: "owner-b" },
      )

      expect(received).toHaveLength(0)
    }),
  )

  it.effect("strict owner fences exact replay", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const id = EventV2.ID.create()
      const replayed = {
        id,
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "owned"),
      }
      yield* events.replay(replayed, { ownerID: "owner-a" })

      const exit = yield* events.replay(replayed, { ownerID: "owner-b", strictOwner: true }).pipe(Effect.exit)

      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("exact replay claims an unowned aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const published = yield* events.publish(DurableMessage, durableData(aggregateID, "owned"))
      const replayed = {
        id: published.id,
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: published.durable!.seq,
        aggregateID,
        data: published.data,
        batchID: published.durable!.batch!.id,
        batchIndex: published.durable!.batch!.index,
        batchSize: published.durable!.batch!.size,
      }

      yield* events.replay(replayed, { ownerID: "owner-a", strictOwner: true })
      const row = yield* db
        .select({ ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row?.ownerID).toBe("owner-a")
      const exit = yield* events
        .replay(
          { ...replayed, id: EventV2.ID.create(), seq: 1, data: durableData(aggregateID, "conflict") },
          { ownerID: "owner-b", strictOwner: true },
        )
        .pipe(Effect.exit)
      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("replay with owner claims an unowned sequence", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "owned"),
        },
        { ownerID: "owner-1" },
      )
      const row = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ seq: 0, ownerID: "owner-1" })
    }),
  )

  it.effect("replay claims an existing unowned sequence before fencing a different owner", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "local"))

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "claimed"),
        },
        { ownerID: "owner-1" },
      )
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 2,
          aggregateID,
          data: durableData(aggregateID, "fenced"),
        },
        { ownerID: "owner-2" },
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
      expect(sequence).toEqual({ seq: 1, ownerID: "owner-1" })
    }),
  )

  it.effect("strict replay rejects an owner conflict instead of silently skipping it", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "claimed"),
        },
        { ownerID: "owner-1" },
      )

      const exit = yield* events
        .replay(
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 1,
            aggregateID,
            data: durableData(aggregateID, "conflict"),
          },
          { ownerID: "owner-2", strictOwner: true },
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("publishes accepted replay with its durable sequence and suppresses stale replay", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      const replayed = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      }

      yield* events.replay(replayed, { publish: true })
      yield* events.replay(replayed, { publish: true })

      expect(received).toMatchObject([{ id: replayed.id, durable: { seq: 0, version: 1 }, data: replayed.data }])
    }),
  )

  it.effect("rejects divergent stale replay without publishing it", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      const replayed = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "original"),
      }
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      yield* events.replay(replayed, { publish: true })

      const exit = yield* events
        .replay({ ...replayed, data: durableData(aggregateID, "divergent") }, { publish: true })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay diverged")
      expect(received).toHaveLength(1)
    }),
  )

  it.effect("rejects an event ID reused at another aggregate position", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const id = EventV2.ID.create()
      yield* events.replay({
        id,
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "first"),
      })

      const exit = yield* events
        .replay({
          id,
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "second"),
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain(`Event ${id} already exists`)
    }),
  )

  it.effect("replay from a different owner leaves claimed sequence unchanged", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const received = new Array<EventV2.Payload>()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "first"),
        },
        { ownerID: "owner-1" },
      )
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "ignored"),
        },
        { ownerID: "owner-2", publish: true },
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(sequence).toEqual({ seq: 0, ownerID: "owner-1" })
      expect(received).toHaveLength(0)
    }),
  )

  it.effect("claim updates the event sequence owner", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "claimed" })
      yield* events.claim(aggregateID, "owner-1")
      yield* events.claim(aggregateID, "owner-2")
      const row = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ seq: 0, ownerID: "owner-2" })
    }),
  )

  it.effect("remove clears durable event sequence", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "seed"))
      yield* events.remove(aggregateID)
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      })

      expect(received[0]?.data).toEqual(durableData(aggregateID, "replayed"))
    }),
  )
})

test("exact replay revalidates an owner claimed after preflight but before its transaction", async () => {
  await using temporary = await tmpdir()
  const databasePath = path.join(temporary.path, "event-replay-owner-race.sqlite")
  const markerPath = path.join(temporary.path, "owner-claimed")
  const replayLayer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]), [
    [Database.node, Database.layerFromPath(databasePath)],
  ])

  await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "owner-race"))
      const stored = yield* db.select().from(EventTable).get().pipe(Effect.orDie)
      if (!stored) return yield* Effect.die("Expected a stored event")
      const script = [
        'import { Database } from "bun:sqlite"',
        "const db = new Database(process.env.REPLAY_DB_PATH!)",
        'db.exec("PRAGMA busy_timeout = 5000")',
        'db.exec("BEGIN IMMEDIATE")',
        'db.query("update event_sequence set owner_id = ? where aggregate_id = ?").run("owner-race-b", process.env.REPLAY_AGGREGATE_ID!)',
        'await Bun.write(process.env.REPLAY_MARKER_PATH!, "ready")',
        "await Bun.sleep(300)",
        'db.exec("COMMIT")',
        "db.close()",
      ].join("\n")
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: temporary.path,
        env: {
          ...process.env,
          REPLAY_DB_PATH: databasePath,
          REPLAY_AGGREGATE_ID: aggregateID,
          REPLAY_MARKER_PATH: markerPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      while (!(yield* Effect.promise(() => Bun.file(markerPath).exists()))) yield* Effect.sleep(5)

      const replay = yield* events
        .replayBatches(
          [
            {
              id: stored.id,
              aggregateID: stored.aggregate_id,
              seq: stored.seq,
              type: stored.type,
              data: stored.data,
              batchID: stored.batch_id!,
              batchIndex: stored.batch_index!,
              batchSize: stored.batch_size!,
            },
          ],
          { ownerID: "owner-race-a", strictOwner: true },
        )
        .pipe(Effect.exit)
      const exitCode = yield* Effect.promise(() => child.exited)
      const stderr = yield* Effect.promise(() => new Response(child.stderr).text())
      if (exitCode !== 0) return yield* Effect.die(`Owner race worker failed: ${stderr}`)

      expect(Exit.isFailure(replay)).toBe(true)
      expect(
        yield* db
          .select({ ownerID: EventSequenceTable.owner_id })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ ownerID: "owner-race-b" })
    }).pipe(Effect.provide(replayLayer), Effect.scoped),
  )
}, 5_000)
