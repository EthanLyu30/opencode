import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Exit, Layer, Schema } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { DateTime } from "effect"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Event } from "@opencode-ai/schema/event"
import { WorkflowRunTable } from "@opencode-ai/core/workflow/sql"
import { ResponseTable } from "@opencode-ai/core/responses/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { publicHistory } from "../../src/server/routes/instance/httpapi/handlers/sync-history"

const ForgedResponseCreated = Event.define({
  type: "response.created",
  durable: { version: 1, aggregate: "responseID" },
  schema: {
    responseID: Responses.ID,
    workflowID: Workflow.ID,
    context: Schema.Array(Schema.Unknown),
  },
})

const ForgedWorkflowCreated = Event.define({
  type: "workflow.created",
  durable: { version: 1, aggregate: "workflowID" },
  schema: {
    workflowID: Workflow.ID,
    sessionID: Schema.String,
  },
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      Database.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )

  it.instance("does not emit workflow-session events on the legacy global bus", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const info = yield* session.create({})
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ visibility: "workflow" })
        .where(eq(SessionTable.id, info.id))
        .run()
        .pipe(Effect.orDie)

      const received: unknown[] = []
      const listener = (event: {
        payload: { properties?: { sessionID?: string }; syncEvent?: EventV2.SerializedEvent }
      }) => {
        if (event.payload.properties?.sessionID === info.id || event.payload.syncEvent?.aggregateID === info.id) {
          received.push(event)
        }
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      yield* events.publish(SessionNs.Event.Updated, {
        sessionID: info.id,
        info: { ...info, title: "workflow-only-update" },
      })
      yield* events.publish(SessionNs.Event.Diff, { sessionID: info.id, diff: [] })

      expect(received).toEqual([])
    }),
  )

  it.instance("does not emit response members of a hidden Session batch on the legacy global bus", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const info = yield* session.create({})
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ visibility: "workflow" })
        .where(eq(SessionTable.id, info.id))
        .run()
        .pipe(Effect.orDie)

      const responseID = Responses.ID.make("resp_hidden_global_batch")
      const workflowID = Workflow.ID.make("wfl_hidden_global_batch")
      const received: unknown[] = []
      const listener = (event: { payload: { properties?: unknown; syncEvent?: EventV2.SerializedEvent } }) => {
        const encoded = JSON.stringify(event)
        if (encoded.includes(responseID) || encoded.includes("HIDDEN_RECEIPT_SENTINEL")) received.push(event)
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      yield* events.publish(
        ResponseEvent.Created,
        {
          responseID,
          workflowID,
          timestamp: DateTime.makeUnsafe(2_000),
          model: "test",
          background: true,
          store: true,
          requestHash: "hidden-global-batch",
          context: [{ type: "message", content: "HIDDEN_RECEIPT_SENTINEL" }],
          input: [{ type: "message", role: "user", content: "hidden" }],
        },
        {
          related: [
            {
              definition: SessionV1.Event.Updated,
              data: { sessionID: info.id, info },
            },
          ],
        },
      )

      expect(received).toEqual([])
    }),
  )

  it.instance("rejects a forged complete GlobalBus batch that contradicts stored Response ownership", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const publicSession = yield* session.create({})
      const hiddenSession = yield* session.create({})
      const hiddenWorkflowID = Workflow.ID.make("wfl_hidden_authoritative_global")
      const declaredWorkflowID = Workflow.ID.make("wfl_public_declared_global")
      const responseID = Responses.ID.make("resp_hidden_authoritative_global")
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ visibility: "workflow" })
        .where(eq(SessionTable.id, hiddenSession.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(WorkflowRunTable)
        .values([
          {
            id: hiddenWorkflowID,
            type: "visual-build",
            status: "queued",
            input: {},
            budget: {},
            usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
            session_id: hiddenSession.id,
            version: 0,
            time_created: 1,
            time_updated: 1,
          },
          {
            id: declaredWorkflowID,
            type: "visual-build",
            status: "queued",
            input: {},
            budget: {},
            usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
            session_id: publicSession.id,
            version: 0,
            time_created: 1,
            time_updated: 1,
          },
        ])
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
          request_hash: "forged-global-authority",
          output: [],
          created_at: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const received: unknown[] = []
      const listener = (event: { payload: unknown }) => received.push(event)
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      yield* events.publish(
        ForgedResponseCreated,
        {
          responseID,
          workflowID: declaredWorkflowID,
          context: [{ type: "message", content: "FORGED_GLOBAL_RECEIPT" }],
        },
        {
          related: [
            {
              definition: ForgedWorkflowCreated,
              data: { workflowID: declaredWorkflowID, sessionID: publicSession.id },
            },
            {
              definition: SessionV1.Event.Updated,
              data: { sessionID: publicSession.id, info: publicSession },
            },
          ],
        },
      )

      expect(received).toEqual([])
      expect(JSON.stringify(received)).not.toContain("FORGED_GLOBAL_RECEIPT")
    }),
  )

  it.instance("rejects duplicate public-owner Response declarations before a hidden receipt reaches GlobalBus", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const publicSession = yield* session.create({})
      const workflowID = Workflow.ID.make("wfl_duplicate_authoritative_global")
      const responseID = Responses.ID.make("resp_duplicate_authoritative_global")
      const { db } = yield* Database.Service
      yield* db
        .insert(WorkflowRunTable)
        .values({
          id: workflowID,
          type: "visual-build",
          status: "queued",
          input: {},
          budget: {},
          usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
          session_id: publicSession.id,
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
          request_hash: "duplicate-global-authority",
          output: [],
          created_at: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const received: unknown[] = []
      const listener = (event: { payload: unknown }) => received.push(event)
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      yield* events.publish(
        ForgedResponseCreated,
        {
          responseID,
          workflowID,
          context: [{ type: "message", content: "public context" }],
        },
        {
          related: [
            {
              definition: ForgedResponseCreated,
              data: {
                responseID,
                workflowID,
                context: [{ type: "message", content: "HIDDEN_DUPLICATE_GLOBAL_RECEIPT" }],
              },
            },
            {
              definition: ForgedWorkflowCreated,
              data: { workflowID, sessionID: publicSession.id },
            },
            {
              definition: SessionV1.Event.Updated,
              data: { sessionID: publicSession.id, info: publicSession },
            },
          ],
        },
      )

      expect(received).toEqual([])
      expect(JSON.stringify(received)).not.toContain("HIDDEN_DUPLICATE_GLOBAL_RECEIPT")
    }),
  )

  it.instance("suppresses session.created on GlobalBus when its projected Session is absent at notification", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const template = yield* session.create({})
      const missingID = SessionV2.ID.make("ses_missing_created_global")
      const info = { ...template, id: missingID, slug: "missing-created-global" }
      const { db } = yield* Database.Service
      const received: unknown[] = []
      const listener = (event: { payload: unknown }) => {
        if (JSON.stringify(event).includes(missingID)) received.push(event)
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      yield* events.publish(
        SessionV1.Event.Created,
        { sessionID: missingID, info, visibility: "public" },
        {
          commit: () =>
            db.delete(SessionTable).where(eq(SessionTable.id, missingID)).run().pipe(Effect.orDie, Effect.asVoid),
        },
      )

      expect(received).toEqual([])
    }),
  )

  it.instance("rejects a forged public deletion of a workflow Session before live or history emission", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const info = yield* session.create({})
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ visibility: "workflow" })
        .where(eq(SessionTable.id, info.id))
        .run()
        .pipe(Effect.orDie)
      const storedEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      const storedSequences = yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)
      const received: unknown[] = []
      const listener = (event: { payload: unknown }) => {
        if (JSON.stringify(event).includes(info.id)) received.push(event)
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const exit = yield* events
        .publish(SessionV1.Event.Deleted, { sessionID: info.id, info, visibility: "public" })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, info.id)).get().pipe(Effect.orDie),
      ).toMatchObject({ id: info.id, visibility: "workflow" })
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual(storedEvents)
      expect(yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).toEqual(storedSequences)
      expect(received).toEqual([])
      expect(yield* publicHistory(db, {})).toEqual([])
    }),
  )

  it.instance("emits a public Session deletion after its projected row is gone", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const { db } = yield* Database.Service
      const info = yield* session.create({})
      const received = yield* Deferred.make<unknown>()
      const listener = (event: { payload: { type?: string; properties?: { sessionID?: string } } }) => {
        if (event.payload.type === "session.deleted" && event.payload.properties?.sessionID === info.id) {
          Deferred.doneUnsafe(received, Effect.succeed(event))
        }
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const deleted = yield* events.publish(SessionV1.Event.Deleted, {
        sessionID: info.id,
        info,
        visibility: "public",
      })
      expect(deleted.durable?.version).toBe(2)
      expect(yield* awaitDeferred(received, "timed out waiting for public session.deleted")).toBeDefined()
      expect((yield* publicHistory(db, {})).map((event) => event.id)).toEqual([deleted.id])
    }),
  )

  it.instance("emits a legacy public Session deletion after validated v1 replay", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const { db } = yield* Database.Service
      const info = yield* session.create({})
      const eventID = EventV2.ID.make("evt_legacy_public_deletion_global")
      const received = yield* Deferred.make<unknown>()
      const listener = (event: { payload: { type?: string; properties?: { sessionID?: string } } }) => {
        if (event.payload.type === "session.deleted" && event.payload.properties?.sessionID === info.id) {
          Deferred.doneUnsafe(received, Effect.succeed(event))
        }
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      yield* events.replay(
        {
          id: eventID,
          aggregateID: info.id,
          seq: 1,
          type: EventV2.versionedType(SessionV1.Event.DeletedV1.type, 1),
          data: { sessionID: info.id, info: Schema.encodeSync(SessionV1.SessionInfo)(info) },
        },
        { publish: true },
      )

      expect(yield* awaitDeferred(received, "timed out waiting for legacy public session.deleted")).toBeDefined()
      expect((yield* publicHistory(db, {})).map((event) => event.id)).toEqual([eventID])
    }),
  )

  it.instance("suppresses a workflow Session deletion after its projected row is gone", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const info = yield* session.create({})
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ visibility: "workflow" })
        .where(eq(SessionTable.id, info.id))
        .run()
        .pipe(Effect.orDie)
      const received: unknown[] = []
      const listener = (event: { payload: unknown }) => {
        if (JSON.stringify(event).includes(info.id)) received.push(event)
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      yield* events.publish(SessionV1.Event.Deleted, { sessionID: info.id, info, visibility: "workflow" })
      expect(received).toEqual([])
      expect(yield* publicHistory(db, {})).toEqual([])
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})
