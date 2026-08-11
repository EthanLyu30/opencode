import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { ResponsesProjector } from "@opencode-ai/core/responses/projector"
import { ResponsesStore } from "@opencode-ai/core/responses/store"
import { ConversationTable, ResponseItemTable, ResponseTable } from "@opencode-ai/core/responses/sql"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Responses } from "@opencode-ai/schema/responses"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Workflow } from "@opencode-ai/schema/workflow"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      WorkflowProjector.node,
      ResponsesProjector.node,
      ResponsesStore.node,
      ResponsesV2.node,
    ]),
  ),
)

const workflowID = Workflow.ID.make("wfl_responses_store")
const stageID = Workflow.StageID.make("wfs_responses_store")

function createWorkflow(events: EventV2.Interface) {
  return events.publish(WorkflowEvent.Created, {
    workflowID,
    timestamp: DateTime.makeUnsafe(1_000),
    type: "responses",
    input: {},
    budget: {},
    stages: [
      {
        id: stageID,
        type: "respond",
        ordinal: 0,
        maxAttempts: 1,
        recoveryPolicy: "restart_safe",
        idempotencyKey: "responses/store",
        input: {},
      },
    ],
  })
}

function createInput(responseID: Responses.ID, store = true): Responses.CreateInput {
  return {
    id: responseID,
    workflowID,
    model: "deepseek-v4-flash",
    background: false,
    store,
    requestHash: `hash:${responseID}`,
    input: [{ type: "message", role: "user", content: "hello" }],
  }
}

describe("ResponsesStore and ResponsesV2", () => {
  it.effect("admits an idempotent request hash once and exposes ordered items", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const store = yield* ResponsesStore.Service
      const responseID = Responses.ID.make("resp_idempotent")
      yield* createWorkflow(events)

      const first = yield* responses.create(createInput(responseID))
      const retried = yield* responses.create({
        ...createInput(Responses.ID.make("resp_retry_alias")),
        requestHash: `hash:${responseID}`,
      })
      expect(first.id).toBe(responseID)
      expect(retried.id).toBe(responseID)
      expect((yield* store.list()).map((item) => item.id)).toEqual([responseID])
      expect(yield* responses.inputItems(responseID)).toMatchObject([
        { ordinal: 0, kind: "input", payload: { role: "user", content: "hello" } },
      ])
    }),
  )

  it.effect("reconciles concurrent retries with one request hash", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const store = yield* ResponsesStore.Service
      const responseID = Responses.ID.make("resp_concurrent_first")
      const requestHash = "hash:concurrent"
      yield* createWorkflow(events)

      const admitted = yield* Effect.all(
        [
          responses.create({ ...createInput(responseID), requestHash }),
          responses.create({ ...createInput(Responses.ID.make("resp_concurrent_second")), requestHash }),
        ],
        { concurrency: "unbounded" },
      )
      expect(new Set(admitted.map((item) => item.id)).size).toBe(1)
      expect((yield* store.list()).map((item) => item.requestHash)).toEqual([requestHash])
    }),
  )

  it.effect("returns linearized snapshots when a listener immediately advances or deletes resources", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const createID = Responses.ID.make("resp_linearized_create")
      const startID = Responses.ID.make("resp_linearized_start")
      const conversationID = Responses.ConversationID.make("conv_linearized_create")
      yield* createWorkflow(events)

      const stopCreateListener = yield* events.listen((event) => {
        if (
          event.type !== ResponseEvent.Created.type ||
          (event.data as { responseID?: Responses.ID }).responseID !== createID
        ) {
          return Effect.void
        }
        return responses.start(createID).pipe(
          Effect.flatMap(() => responses.complete({ responseID: createID, output: [] })),
          Effect.asVoid,
          Effect.orDie,
        )
      })
      const admitted = yield* responses.create(createInput(createID, false))
      yield* stopCreateListener
      expect(admitted).toMatchObject({ id: createID, status: "queued", store: false })
      expect(Exit.isFailure(yield* responses.get(createID).pipe(Effect.exit))).toBe(true)

      yield* responses.create(createInput(startID))
      const stopStartListener = yield* events.listen((event) => {
        if (
          event.type !== ResponseEvent.InProgress.type ||
          (event.data as { responseID?: Responses.ID }).responseID !== startID
        ) {
          return Effect.void
        }
        return responses.complete({ responseID: startID, output: [] }).pipe(Effect.asVoid, Effect.orDie)
      })
      const started = yield* responses.start(startID)
      yield* stopStartListener
      expect(started).toMatchObject({ id: startID, status: "in_progress" })
      expect(yield* responses.get(startID)).toMatchObject({ status: "completed" })

      const stopConversationListener = yield* events.listen((event) => {
        if (
          event.type !== ResponseEvent.Conversation.Created.type ||
          (event.data as { conversationID?: Responses.ConversationID }).conversationID !== conversationID
        ) {
          return Effect.void
        }
        return responses.deleteConversation(conversationID).pipe(Effect.orDie)
      })
      const conversation = yield* responses.createConversation({ id: conversationID, metadata: { purpose: "race" } })
      yield* stopConversationListener
      expect(conversation).toMatchObject({ id: conversationID, metadata: { purpose: "race" } })
      expect(Exit.isFailure(yield* responses.getConversation(conversationID).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.effect("cleans store:false terminal state and rejects it as a later parent", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const database = yield* Database.Service
      const parentID = Responses.ID.make("resp_transient_parent")
      const childID = Responses.ID.make("resp_transient_child")
      yield* createWorkflow(events)
      yield* responses.create(createInput(parentID, false))
      yield* responses.start(parentID)
      const terminal = yield* responses.complete({
        responseID: parentID,
        output: [{ type: "message", role: "assistant", content: "ephemeral" }],
        usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      })

      expect(terminal.status).toBe("completed")
      expect(terminal.output).toEqual([{ type: "message", role: "assistant", content: "ephemeral" }])
      expect(Exit.isFailure(yield* responses.get(parentID).pipe(Effect.exit))).toBe(true)
      expect(
        yield* database.db
          .select({
            output: ResponseTable.output,
            error: ResponseTable.error,
            usage: ResponseTable.usage,
            deletedAt: ResponseTable.deleted_at,
          })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, parentID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ output: [], error: null, usage: null, deletedAt: expect.any(Number) })
      expect(
        yield* database.db
          .select({ ordinal: ResponseItemTable.ordinal })
          .from(ResponseItemTable)
          .where(eq(ResponseItemTable.response_id, parentID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      const durable = yield* database.db
        .select({ id: EventTable.id, seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, parentID))
        .orderBy(EventTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect(durable.map((event) => event.type)).toEqual([
        "response.created.1",
        "response.in_progress.1",
        "response.completed.1",
      ])
      expect(durable[0]?.data).toMatchObject({
        responseID: parentID,
        store: false,
        input: [{ type: "redacted" }],
      })
      expect(JSON.stringify(durable)).not.toContain("hello")
      expect(JSON.stringify(durable)).not.toContain("ephemeral")
      expect(durable[2]?.data).toEqual({ responseID: parentID, timestamp: expect.any(Number) })
      expect(yield* responses.findByRequestHash(`hash:${parentID}`)).toMatchObject({
        id: parentID,
        store: false,
        deletedAt: expect.anything(),
      })
      expect(
        Exit.isFailure(
          yield* responses
            .create({
              ...createInput(childID),
              previousResponseID: parentID,
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const retryID = Responses.ID.make("resp_transient_retry")
      expect(
        Exit.isFailure(
          yield* responses
            .create({ ...createInput(retryID, false), requestHash: `hash:${parentID}` })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, retryID)).toBe(-1)

      const serialized = durable.map((event) => ({
        id: event.id,
        aggregateID: parentID,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))
      yield* database.db.delete(ResponseTable).where(eq(ResponseTable.id, parentID)).run().pipe(Effect.orDie)
      yield* events.remove(parentID)
      yield* events.replayAll(serialized)
      expect(Exit.isFailure(yield* responses.get(parentID).pipe(Effect.exit))).toBe(true)
      expect(yield* responses.findByRequestHash(`hash:${parentID}`)).toMatchObject({
        id: parentID,
        status: "completed",
        store: false,
        deletedAt: expect.anything(),
      })
    }),
  )

  it.effect("rejects store:false with a conversation before persisting response input", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const database = yield* Database.Service
      const conversationID = Responses.ConversationID.make("conv_transient_rejected")
      const responseID = Responses.ID.make("resp_transient_rejected")
      yield* createWorkflow(events)
      yield* responses.createConversation({ id: conversationID, metadata: {} })

      expect(
        Exit.isFailure(
          yield* responses.create({ ...createInput(responseID, false), conversationID }).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(-1)
      expect(yield* responses.conversationItems(conversationID)).toEqual([])

      yield* responses.create(createInput(responseID, false))
      expect(
        Exit.isFailure(
          yield* responses
            .appendConversationItem({
              conversationID,
              responseID,
              payload: { type: "message", content: "must remain transient" },
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* responses.conversationItems(conversationID)).toEqual([])
      yield* responses.cancel({ responseID })

      const backgroundID = Responses.ID.make("resp_transient_background")
      expect(
        Exit.isFailure(
          yield* responses.create({ ...createInput(backgroundID, false), background: true }).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, backgroundID)).toBe(-1)
    }),
  )

  it.effect("rejects missing and deleted parents without committing child events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const database = yield* Database.Service
      const parentID = Responses.ID.make("resp_deleted_parent")
      const childID = Responses.ID.make("resp_deleted_child")
      yield* createWorkflow(events)
      yield* responses.create(createInput(parentID))
      yield* responses.complete({ responseID: parentID, output: [] })
      yield* responses.delete(parentID)

      const deleted = yield* responses
        .create({ ...createInput(childID), previousResponseID: parentID })
        .pipe(Effect.exit)
      expect(Exit.isFailure(deleted)).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, childID)).toBe(-1)

      const missingID = Responses.ID.make("resp_missing_child")
      const missing = yield* responses
        .create({
          ...createInput(missingID),
          previousResponseID: Responses.ID.make("resp_missing_parent"),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, missingID)).toBe(-1)
    }),
  )

  it.effect("reconstructs a stored parent chain without caller replay", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const parentID = Responses.ID.make("resp_chain_parent")
      const childID = Responses.ID.make("resp_chain_child")
      yield* createWorkflow(events)
      yield* responses.create(createInput(parentID))
      yield* responses.start(parentID)
      yield* responses.complete({
        responseID: parentID,
        output: [{ type: "message", role: "assistant", content: "parent answer" }],
      })
      yield* responses.create({
        ...createInput(childID),
        requestHash: `hash:${childID}`,
        previousResponseID: parentID,
        input: [{ type: "message", role: "user", content: "follow up" }],
      })

      expect((yield* responses.contextItems(childID)).map((item) => item.content)).toEqual([
        "hello",
        "parent answer",
        "follow up",
      ])
    }),
  )

  it.effect("keeps an admitted child context after its parent is deleted", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const database = yield* Database.Service
      const parentID = Responses.ID.make("resp_snapshot_parent")
      const childID = Responses.ID.make("resp_snapshot_child")
      yield* createWorkflow(events)
      yield* responses.create(createInput(parentID))
      yield* responses.complete({
        responseID: parentID,
        output: [{ type: "message", role: "assistant", content: "parent answer" }],
      })
      yield* responses.create({
        ...createInput(childID),
        previousResponseID: parentID,
        input: [{ type: "message", role: "user", content: "follow up" }],
      })

      yield* responses.delete(parentID)

      expect((yield* responses.contextItems(childID)).map((item) => item.content)).toEqual([
        "hello",
        "parent answer",
        "follow up",
      ])
      yield* responses.start(childID)
      expect((yield* responses.complete({ responseID: childID, output: [] })).status).toBe("completed")

      const durable = yield* database.db
        .select({ id: EventTable.id, seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, childID))
        .orderBy(EventTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect((durable[0]?.data.context as Responses.ItemPayload[]).map((item) => item.content)).toEqual([
        "hello",
        "parent answer",
      ])
      yield* database.db.delete(ResponseTable).where(eq(ResponseTable.id, childID)).run().pipe(Effect.orDie)
      yield* events.remove(childID)
      yield* events.replayAll(
        durable.map((event) => ({
          id: event.id,
          aggregateID: childID,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )
      expect((yield* responses.contextItems(childID)).map((item) => item.content)).toEqual([
        "hello",
        "parent answer",
        "follow up",
      ])
    }),
  )

  it.effect("persists conversation items in stable order and links response items", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const database = yield* Database.Service
      const conversationID = Responses.ConversationID.make("conv_ordered")
      const responseID = Responses.ID.make("resp_conversation")
      yield* createWorkflow(events)
      yield* responses.createConversation({ id: conversationID, metadata: { purpose: "design" } })
      yield* responses.appendConversationItem({ conversationID, payload: { type: "message", content: "first" } })
      yield* responses.appendConversationItem({ conversationID, payload: { type: "message", content: "second" } })
      yield* responses.create({ ...createInput(responseID), conversationID })
      yield* responses.appendConversationItem({ conversationID, payload: { type: "message", content: "later" } })
      const admitted = yield* database.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, responseID))
        .get()
        .pipe(Effect.orDie)
      expect((admitted?.data.context as Responses.ItemPayload[]).map((item) => item.content)).toEqual([
        "first",
        "second",
      ])
      expect((yield* responses.contextItems(responseID)).map((item) => item.content)).toEqual([
        "first",
        "second",
        "hello",
      ])
      yield* responses.complete({
        responseID,
        output: [{ type: "message", role: "assistant", content: "reply" }],
      })

      const items = yield* responses.conversationItems(conversationID)
      expect(items.map((item) => item.ordinal)).toEqual([0, 1, 2, 3, 4])
      expect(items.map((item) => item.responseID)).toEqual([undefined, undefined, responseID, undefined, responseID])
      expect(items.map((item) => item.payload.content)).toEqual(["first", "second", "hello", "later", "reply"])

      const durable = yield* database.db
        .select({ id: EventTable.id, seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, conversationID))
        .orderBy(EventTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect(durable.map((event) => event.type)).toEqual([
        "conversation.created.1",
        "conversation.item.added.1",
        "conversation.item.added.1",
        "conversation.item.added.1",
        "conversation.item.added.1",
        "conversation.item.added.1",
      ])
      yield* database.db
        .delete(ConversationTable)
        .where(eq(ConversationTable.id, conversationID))
        .run()
        .pipe(Effect.orDie)
      yield* events.remove(conversationID)
      yield* events.replayAll(
        durable.map((event) => ({
          id: event.id,
          aggregateID: conversationID,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )
      const replayed = yield* responses.conversationItems(conversationID)
      expect(replayed.map((item) => item.ordinal)).toEqual([0, 1, 2, 3, 4])
      expect(replayed.map((item) => item.payload.content)).toEqual(["first", "second", "hello", "later", "reply"])

      yield* responses.deleteConversation(conversationID)
      const deletedDurable = yield* database.db
        .select({ id: EventTable.id, seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, conversationID))
        .orderBy(EventTable.seq)
        .all()
        .pipe(Effect.orDie)
      yield* database.db
        .update(ResponseTable)
        .set({ status: "queued" })
        .where(eq(ResponseTable.id, responseID))
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .delete(ConversationTable)
        .where(eq(ConversationTable.id, conversationID))
        .run()
        .pipe(Effect.orDie)
      yield* events.remove(conversationID)
      yield* events.replayAll(
        deletedDurable.map((event) => ({
          id: event.id,
          aggregateID: conversationID,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )
      expect(Exit.isFailure(yield* responses.getConversation(conversationID).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.effect("snapshots a conversation-backed parent without interleaved conversation items", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const conversationID = Responses.ConversationID.make("conv_parent_snapshot")
      const parentID = Responses.ID.make("resp_conversation_parent")
      const childID = Responses.ID.make("resp_conversation_child")
      yield* createWorkflow(events)
      yield* responses.createConversation({ id: conversationID, metadata: {} })
      yield* responses.appendConversationItem({ conversationID, payload: { type: "message", content: "before" } })
      yield* responses.create({ ...createInput(parentID), conversationID })
      yield* responses.appendConversationItem({
        conversationID,
        payload: { type: "message", content: "unrelated" },
      })
      yield* responses.complete({
        responseID: parentID,
        output: [{ type: "message", role: "assistant", content: "parent answer" }],
      })
      yield* responses.create({
        ...createInput(childID),
        previousResponseID: parentID,
        input: [{ type: "message", role: "user", content: "follow up" }],
      })

      expect((yield* responses.contextItems(childID)).map((item) => item.content)).toEqual([
        "before",
        "hello",
        "parent answer",
        "follow up",
      ])
    }),
  )

  it.effect("returns stable conversation resources from concurrent appends", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const conversationID = Responses.ConversationID.make("conv_concurrent_appends")
      yield* createWorkflow(events)
      yield* responses.createConversation({ id: conversationID, metadata: {} })

      const returned = yield* Effect.all(
        [
          responses.appendConversationItem({ conversationID, payload: { type: "message", content: "a" } }),
          responses.appendConversationItem({ conversationID, payload: { type: "message", content: "b" } }),
        ],
        { concurrency: "unbounded" },
      )

      expect(returned.map((item) => item.id)).toEqual([conversationID, conversationID])
      const items = yield* responses.conversationItems(conversationID)
      expect(items.map((item) => item.ordinal)).toEqual([0, 1])
      expect(new Set(items.map((item) => item.payload.content))).toEqual(new Set(["a", "b"]))
    }),
  )

  it.effect("rejects deleting a conversation with an active response", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const database = yield* Database.Service
      const conversationID = Responses.ConversationID.make("conv_active_response")
      const responseID = Responses.ID.make("resp_active_conversation")
      yield* createWorkflow(events)
      yield* responses.createConversation({ id: conversationID, metadata: {} })
      yield* responses.create({ ...createInput(responseID), conversationID })
      const sequence = yield* EventV2.latestSequence(database.db, conversationID)

      expect(Exit.isFailure(yield* responses.deleteConversation(conversationID).pipe(Effect.exit))).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, conversationID)).toBe(sequence)
      yield* responses.start(responseID)
      yield* responses.complete({ responseID, output: [] })
      yield* responses.deleteConversation(conversationID)
      expect(Exit.isFailure(yield* responses.getConversation(conversationID).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.effect("rejects combining previous_response_id with conversation", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responses = yield* ResponsesV2.Service
      const parentID = Responses.ID.make("resp_context_parent")
      const conversationID = Responses.ConversationID.make("conv_context")
      yield* createWorkflow(events)
      yield* responses.create(createInput(parentID))
      yield* responses.complete({ responseID: parentID, output: [] })
      yield* responses.createConversation({ id: conversationID, metadata: {} })

      expect(
        Exit.isFailure(
          yield* responses
            .create({
              ...createInput(Responses.ID.make("resp_context_conflict")),
              previousResponseID: parentID,
              conversationID,
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )
})
