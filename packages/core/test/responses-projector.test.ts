import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ResponsesProjector } from "@opencode-ai/core/responses/projector"
import { ConversationItemTable, ResponseItemTable, ResponseTable } from "@opencode-ai/core/responses/sql"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Responses } from "@opencode-ai/schema/responses"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Workflow } from "@opencode-ai/schema/workflow"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, WorkflowProjector.node, ResponsesProjector.node])),
)

const workflowID = Workflow.ID.make("wfl_responses_projector")
const stageID = Workflow.StageID.make("wfs_responses_projector")

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
        idempotencyKey: "responses/projector",
        input: {},
      },
    ],
  })
}

function created(responseID: Responses.ID, overrides?: Partial<(typeof ResponseEvent.Created.Type)["data"]>) {
  const value: (typeof ResponseEvent.Created.Type)["data"] = {
    responseID,
    workflowID,
    timestamp: DateTime.makeUnsafe(2_000),
    model: "deepseek-v4-flash",
    background: false,
    store: true,
    requestHash: `hash:${responseID}`,
    context: [],
    input: [{ type: "message", role: "user", content: "hello" }],
    ...overrides,
  }
  return value
}

describe("ResponsesProjector", () => {
  it.effect("projects lifecycle state and ordered input/output items", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_projected")
      yield* createWorkflow(events)
      yield* events.publish(ResponseEvent.Created, created(responseID))
      yield* events.publish(ResponseEvent.InProgress, {
        responseID,
        timestamp: DateTime.makeUnsafe(3_000),
      })
      yield* events.publish(ResponseEvent.Completed, {
        responseID,
        timestamp: DateTime.makeUnsafe(4_000),
        output: [
          { type: "reasoning", summary: "plan" },
          { type: "message", role: "assistant", content: "done" },
        ],
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      })

      expect(
        yield* database.db
          .select({
            status: ResponseTable.status,
            output: ResponseTable.output,
            completedAt: ResponseTable.completed_at,
          })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        status: "completed",
        output: [
          { type: "reasoning", summary: "plan" },
          { type: "message", role: "assistant", content: "done" },
        ],
        completedAt: 4_000,
      })
      expect(
        yield* database.db
          .select({ ordinal: ResponseItemTable.ordinal, kind: ResponseItemTable.kind })
          .from(ResponseItemTable)
          .where(eq(ResponseItemTable.response_id, responseID))
          .orderBy(ResponseItemTable.ordinal)
          .all()
          .pipe(Effect.orDie),
      ).toEqual([
        { ordinal: 0, kind: "input" },
        { ordinal: 1, kind: "output" },
        { ordinal: 2, kind: "output" },
      ])
    }),
  )

  it.effect("projects incomplete, failed, cancelled, and deleted terminals", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      yield* createWorkflow(events)
      const cases = [
        {
          id: Responses.ID.make("resp_incomplete"),
          definition: ResponseEvent.Incomplete,
          terminal: {
            output: [{ type: "message", content: "partial" }],
            error: { code: "max_output_tokens", message: "limit reached" },
          },
          status: "incomplete",
        },
        {
          id: Responses.ID.make("resp_failed"),
          definition: ResponseEvent.Failed,
          terminal: { error: { code: "provider_error", message: "upstream failed" } },
          status: "failed",
        },
        {
          id: Responses.ID.make("resp_cancelled"),
          definition: ResponseEvent.Cancelled,
          terminal: { error: { code: "cancelled", message: "cancelled by user" } },
          status: "cancelled",
        },
      ] as const

      for (const item of cases) {
        yield* events.publish(ResponseEvent.Created, created(item.id))
        yield* events.publish(item.definition, {
          responseID: item.id,
          timestamp: DateTime.makeUnsafe(5_000),
          ...item.terminal,
        })
      }
      yield* events.publish(ResponseEvent.Deleted, {
        responseID: cases[0].id,
        timestamp: DateTime.makeUnsafe(6_000),
      })

      expect(
        yield* database.db
          .select({ id: ResponseTable.id, status: ResponseTable.status, deletedAt: ResponseTable.deleted_at })
          .from(ResponseTable)
          .orderBy(ResponseTable.id)
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map((row) => ({ ...row, id: String(row.id) }))),
          ),
      ).toEqual([
        { id: "resp_cancelled", status: "cancelled", deletedAt: null },
        { id: "resp_failed", status: "failed", deletedAt: null },
        { id: "resp_incomplete", status: "incomplete", deletedAt: 6_000 },
      ])
    }),
  )

  it.effect("rolls back both the response projection and durable event when workflow linkage fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_missing_workflow")
      const failed = yield* events
        .publish(ResponseEvent.Created, created(responseID, { workflowID: Workflow.ID.make("wfl_missing_workflow") }))
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(-1)
      expect(
        yield* database.db
          .select({ id: ResponseTable.id })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()

      const backgroundID = Responses.ID.make("resp_transient_background_projector")
      expect(
        Exit.isFailure(
          yield* events
            .publish(ResponseEvent.Created, created(backgroundID, { store: false, background: true }))
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, backgroundID)).toBe(-1)
    }),
  )

  it.effect("rolls back a response when an atomically related conversation event fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_related_rollback")
      const conversationID = Responses.ConversationID.make("conv_related_missing")
      yield* createWorkflow(events)

      const failed = yield* events
        .publish(ResponseEvent.Created, created(responseID), {
          related: [
            {
              definition: ResponseEvent.Conversation.ItemAdded,
              data: {
                conversationID,
                timestamp: DateTime.makeUnsafe(2_000),
                responseID,
                payload: { type: "message", content: "must roll back" },
              },
            },
          ],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(-1)
      expect(yield* EventV2.latestSequence(database.db, conversationID)).toBe(-1)
      expect(
        yield* database.db
          .select({ id: ResponseTable.id })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.effect("requires matching related conversation events for live response input and output", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const conversationID = Responses.ConversationID.make("conv_related_contract")
      const rejectedID = Responses.ID.make("resp_related_input_missing")
      const responseID = Responses.ID.make("resp_related_contract")
      yield* createWorkflow(events)
      yield* events.publish(ResponseEvent.Conversation.Created, {
        conversationID,
        timestamp: DateTime.makeUnsafe(2_000),
        metadata: {},
      })

      expect(
        Exit.isFailure(
          yield* events.publish(ResponseEvent.Created, created(rejectedID, { conversationID })).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, rejectedID)).toBe(-1)

      const input = created(responseID, { conversationID })
      yield* events.publish(ResponseEvent.Created, input, {
        related: input.input.map((payload) => ({
          definition: ResponseEvent.Conversation.ItemAdded,
          data: {
            conversationID,
            timestamp: input.timestamp,
            responseID,
            payload,
          },
        })),
      })
      expect(
        Exit.isFailure(
          yield* events
            .publish(ResponseEvent.Completed, {
              responseID,
              timestamp: DateTime.makeUnsafe(3_000),
              output: [{ type: "message", content: "missing related output" }],
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(0)
      expect(
        yield* database.db
          .select({ payload: ConversationItemTable.payload })
          .from(ConversationItemTable)
          .where(eq(ConversationItemTable.conversation_id, conversationID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ payload: { type: "message", role: "user", content: "hello" } }])
    }),
  )

  it.effect("rejects a live previous-response event with a fabricated context snapshot", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_fabricated_parent")
      yield* createWorkflow(events)

      const failed = yield* events
        .publish(
          ResponseEvent.Created,
          created(responseID, {
            previousResponseID: Responses.ID.make("resp_missing_parent_for_event"),
            context: [{ type: "message", content: "fabricated" }],
          }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(-1)
    }),
  )

  it.effect("rejects payload-bearing terminal events for store:false without losing recoverable state", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_transient_redaction")
      yield* createWorkflow(events)
      yield* events.publish(ResponseEvent.Created, created(responseID, { store: false }))

      const failed = yield* events
        .publish(ResponseEvent.Completed, {
          responseID,
          timestamp: DateTime.makeUnsafe(3_000),
          output: [{ type: "message", content: "must not persist" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(0)
      expect(
        yield* database.db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, responseID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ type: "response.created.1" }])
      expect(
        yield* database.db
          .select({ status: ResponseTable.status })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "queued" })
    }),
  )

  it.effect("requires complete terminal payloads for stored responses", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const completedID = Responses.ID.make("resp_stored_completed_contract")
      const failedID = Responses.ID.make("resp_stored_failed_contract")
      yield* createWorkflow(events)
      yield* events.publish(ResponseEvent.Created, created(completedID))
      yield* events.publish(ResponseEvent.Created, created(failedID))

      expect(
        Exit.isFailure(
          yield* events
            .publish(ResponseEvent.Completed, {
              responseID: completedID,
              timestamp: DateTime.makeUnsafe(3_000),
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* events
            .publish(ResponseEvent.Failed, {
              responseID: failedID,
              timestamp: DateTime.makeUnsafe(3_000),
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, completedID)).toBe(0)
      expect(yield* EventV2.latestSequence(database.db, failedID)).toBe(0)
    }),
  )

  it.effect("rejects direct store:false conversation events atomically", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const conversationID = Responses.ConversationID.make("conv_transient_projector")
      const responseID = Responses.ID.make("resp_transient_projector")
      yield* createWorkflow(events)
      yield* events.publish(ResponseEvent.Conversation.Created, {
        conversationID,
        timestamp: DateTime.makeUnsafe(2_000),
        metadata: {},
      })

      expect(
        Exit.isFailure(
          yield* events
            .publish(
              ResponseEvent.Created,
              created(responseID, {
                store: false,
                conversationID,
              }),
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(-1)
      expect(
        yield* database.db
          .select({ id: ResponseTable.id })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )
})
