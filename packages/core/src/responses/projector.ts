export * as ResponsesProjector from "./projector"

import { and, asc, eq, inArray, isNull, max } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { isDeepStrictEqual } from "node:util"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Responses } from "@opencode-ai/schema/responses"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { WorkflowRunTable, WorkflowStageTable } from "../workflow/sql"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { ConversationItemTable, ConversationTable, ResponseItemTable, ResponseTable } from "./sql"

type DB = Database.Interface["db"]

export class LifecycleConflict extends Error {
  constructor(readonly responseID: Responses.ID) {
    super(`Response lifecycle conflict: ${responseID}`)
  }
}

export class ConversationConflict extends Error {
  constructor(readonly conversationID: Responses.ConversationID) {
    super(`Conversation lifecycle conflict: ${conversationID}`)
  }
}

function getResponse(db: DB, responseID: Responses.ID) {
  return db.select().from(ResponseTable).where(eq(ResponseTable.id, responseID)).get().pipe(Effect.orDie)
}

function requireResponse(db: DB, responseID: Responses.ID) {
  return Effect.gen(function* () {
    const row = yield* getResponse(db, responseID)
    if (!row || row.deleted_at !== null) throw new LifecycleConflict(responseID)
    return row
  })
}

function requireConversation(db: DB, conversationID: Responses.ConversationID) {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(ConversationTable)
      .where(eq(ConversationTable.id, conversationID))
      .get()
      .pipe(Effect.orDie)
    if (!row || row.deleted_at !== null) throw new ConversationConflict(conversationID)
    return row
  })
}

function appendResponseItems(
  db: DB,
  responseID: Responses.ID,
  kind: Responses.ItemKind,
  payloads: ReadonlyArray<Responses.ItemPayload>,
) {
  return Effect.gen(function* () {
    if (payloads.length === 0) return
    const last = yield* db
      .select({ ordinal: max(ResponseItemTable.ordinal) })
      .from(ResponseItemTable)
      .where(eq(ResponseItemTable.response_id, responseID))
      .get()
      .pipe(Effect.orDie)
    const start = (last?.ordinal ?? -1) + 1
    yield* db
      .insert(ResponseItemTable)
      .values(payloads.map((payload, index) => ({ response_id: responseID, ordinal: start + index, kind, payload })))
      .run()
      .pipe(Effect.orDie)
  })
}

function appendConversationItems(
  db: DB,
  conversationID: Responses.ConversationID,
  payloads: ReadonlyArray<Responses.ItemPayload>,
  responseID?: Responses.ID,
) {
  return Effect.gen(function* () {
    if (payloads.length === 0) return
    yield* requireConversation(db, conversationID)
    const last = yield* db
      .select({ ordinal: max(ConversationItemTable.ordinal) })
      .from(ConversationItemTable)
      .where(eq(ConversationItemTable.conversation_id, conversationID))
      .get()
      .pipe(Effect.orDie)
    const start = (last?.ordinal ?? -1) + 1
    yield* db
      .insert(ConversationItemTable)
      .values(
        payloads.map((payload, index) => ({
          conversation_id: conversationID,
          ordinal: start + index,
          response_id: responseID,
          payload,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

function hasConversationItems(
  related: ReadonlyArray<{ readonly type: string; readonly data: unknown }> | undefined,
  conversationID: Responses.ConversationID,
  responseID: Responses.ID,
  payloads: ReadonlyArray<Responses.ItemPayload>,
) {
  const items = (related ?? []).filter((item) => item.type === ResponseEvent.Conversation.ItemAdded.type)
  return (
    items.length === payloads.length &&
    items.every((item, index) => {
      if (typeof item.data !== "object" || item.data === null) return false
      const data = item.data as Record<string, unknown>
      return (
        data.conversationID === conversationID &&
        data.responseID === responseID &&
        isDeepStrictEqual(data.payload, payloads[index])
      )
    })
  )
}

function settle(
  db: DB,
  status: Extract<Responses.Status, "completed" | "incomplete" | "failed" | "cancelled">,
  data: {
    readonly responseID: Responses.ID
    readonly timestamp: DateTime.Utc
    readonly output?: ReadonlyArray<Responses.ItemPayload>
    readonly error?: Responses.Error
    readonly usage?: Responses.Usage
  },
  replay: boolean,
  related?: ReadonlyArray<{ readonly type: string; readonly data: unknown }>,
) {
  return Effect.gen(function* () {
    const row = yield* requireResponse(db, data.responseID)
    const workflowID = settlementWorkflowID(related)
    if (!replay && workflowID !== undefined && row.workflow_id !== workflowID) {
      throw new LifecycleConflict(data.responseID)
    }
    if (row.status !== "queued" && row.status !== "in_progress") throw new LifecycleConflict(data.responseID)
    const output = [...(data.output ?? [])]
    if (
      !replay &&
      row.store &&
      row.conversation_id &&
      !hasConversationItems(related, row.conversation_id, data.responseID, output)
    ) {
      throw new ConversationConflict(row.conversation_id)
    }
    if (!row.store) {
      if (data.output !== undefined || data.error !== undefined || data.usage !== undefined) {
        throw new LifecycleConflict(data.responseID)
      }
      yield* db
        .delete(ResponseItemTable)
        .where(eq(ResponseItemTable.response_id, data.responseID))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .delete(ConversationItemTable)
        .where(eq(ConversationItemTable.response_id, data.responseID))
        .run()
        .pipe(Effect.orDie)
      const updated = yield* db
        .update(ResponseTable)
        .set({
          status,
          output: [],
          error: null,
          usage: null,
          completed_at: DateTime.toEpochMillis(data.timestamp),
          deleted_at: DateTime.toEpochMillis(data.timestamp),
        })
        .where(
          and(
            eq(ResponseTable.id, data.responseID),
            isNull(ResponseTable.deleted_at),
            inArray(ResponseTable.status, ["queued", "in_progress"]),
          ),
        )
        .returning({ id: ResponseTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!updated) throw new LifecycleConflict(data.responseID)
      return
    }
    if (status === "completed" && data.output === undefined) throw new LifecycleConflict(data.responseID)
    if (status === "failed" && data.error === undefined) throw new LifecycleConflict(data.responseID)
    yield* appendResponseItems(db, data.responseID, "output", output)
    const updated = yield* db
      .update(ResponseTable)
      .set({
        status,
        output,
        error: data.error ?? null,
        usage: data.usage ?? null,
        completed_at: DateTime.toEpochMillis(data.timestamp),
      })
      .where(
        and(
          eq(ResponseTable.id, data.responseID),
          isNull(ResponseTable.deleted_at),
          inArray(ResponseTable.status, ["queued", "in_progress"]),
        ),
      )
      .returning({ id: ResponseTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!updated) throw new LifecycleConflict(data.responseID)
  })
}

function settlementWorkflowID(related: ReadonlyArray<{ readonly type: string; readonly data: unknown }> | undefined) {
  const workflowTypes: ReadonlyArray<string> = [
    WorkflowEvent.Stage.Succeeded.type,
    WorkflowEvent.Stage.Failed.type,
    WorkflowEvent.CancelRequested.type,
    WorkflowEvent.Succeeded.type,
    WorkflowEvent.Failed.type,
    WorkflowEvent.Cancelled.type,
  ]
  const workflow = (related ?? []).find((item) => workflowTypes.includes(item.type))
  if (typeof workflow?.data !== "object" || workflow.data === null) return undefined
  const workflowID = (workflow.data as Record<string, unknown>).workflowID
  return typeof workflowID === "string" ? workflowID : undefined
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    const db = database.db

    yield* events.project(ResponseEvent.Created, (event) =>
      Effect.gen(function* () {
        const data = event.data
        if (
          (data.previousResponseID && data.conversationID) ||
          (!data.store && (data.conversationID || data.background))
        ) {
          throw new LifecycleConflict(data.responseID)
        }
        if (!data.store && (data.context.length !== 0 || !isDeepStrictEqual(data.input, [{ type: "redacted" }]))) {
          throw new LifecycleConflict(data.responseID)
        }
        if (!data.previousResponseID && !data.conversationID && data.context.length > 0) {
          throw new LifecycleConflict(data.responseID)
        }
        if (!event.durable?.replay && data.previousResponseID) {
          const parent = yield* getResponse(db, data.previousResponseID)
          const parentContext = (yield* db
            .select({ payload: ResponseItemTable.payload })
            .from(ResponseItemTable)
            .where(eq(ResponseItemTable.response_id, data.previousResponseID))
            .orderBy(asc(ResponseItemTable.ordinal))
            .all()
            .pipe(Effect.orDie)).map((item) => item.payload)
          if (
            !parent ||
            !parent.store ||
            parent.deleted_at !== null ||
            parent.status !== "completed" ||
            !isDeepStrictEqual(parentContext, data.context)
          ) {
            throw new LifecycleConflict(data.responseID)
          }
        }
        if (!event.durable?.replay && data.conversationID) {
          yield* requireConversation(db, data.conversationID)
          const conversationContext = (yield* db
            .select({ payload: ConversationItemTable.payload })
            .from(ConversationItemTable)
            .where(eq(ConversationItemTable.conversation_id, data.conversationID))
            .orderBy(asc(ConversationItemTable.ordinal))
            .all()
            .pipe(Effect.orDie)).map((item) => item.payload)
          if (!isDeepStrictEqual(conversationContext, data.context)) {
            throw new ConversationConflict(data.conversationID)
          }
          if (!hasConversationItems(event.durable?.related, data.conversationID, data.responseID, data.input)) {
            throw new ConversationConflict(data.conversationID)
          }
        }
        const workflow = yield* db
          .select({
            id: WorkflowRunTable.id,
            status: WorkflowRunTable.status,
            cancelRequestedAt: WorkflowRunTable.cancel_requested_at,
          })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, data.workflowID))
          .get()
          .pipe(Effect.orDie)
        if (
          !workflow ||
          workflow.cancelRequestedAt !== null ||
          workflow.status === "succeeded" ||
          workflow.status === "failed" ||
          workflow.status === "cancelled"
        ) {
          throw new LifecycleConflict(data.responseID)
        }
        if (!event.durable?.replay) {
          const deliver = yield* db
            .select({ input: WorkflowStageTable.input })
            .from(WorkflowStageTable)
            .where(
              and(eq(WorkflowStageTable.workflow_id, data.workflowID), eq(WorkflowStageTable.stage_type, "deliver")),
            )
            .all()
            .pipe(Effect.orDie)
          const matching = deliver.filter(({ input }) =>
            input.responseID === undefined
              ? input.responseBinding === "workflow"
              : input.responseBinding === undefined && input.responseID === data.responseID,
          )
          if (matching.length !== 1) throw new LifecycleConflict(data.responseID)
          if (matching[0]!.input.responseID === undefined) {
            const active = yield* db
              .select({ id: ResponseTable.id })
              .from(ResponseTable)
              .where(
                and(
                  eq(ResponseTable.workflow_id, data.workflowID),
                  isNull(ResponseTable.deleted_at),
                  inArray(ResponseTable.status, ["queued", "in_progress"]),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (active) throw new LifecycleConflict(data.responseID)
          }
        }
        if (yield* getResponse(db, data.responseID)) throw new LifecycleConflict(data.responseID)
        const request = yield* db
          .select({ id: ResponseTable.id })
          .from(ResponseTable)
          .where(eq(ResponseTable.request_hash, data.requestHash))
          .get()
          .pipe(Effect.orDie)
        if (request) throw new LifecycleConflict(data.responseID)
        yield* db
          .insert(ResponseTable)
          .values({
            id: data.responseID,
            workflow_id: data.workflowID,
            model: data.model,
            status: "queued",
            background: data.background,
            store: data.store,
            previous_response_id: data.previousResponseID,
            conversation_id: data.conversationID,
            request_hash: data.requestHash,
            output: [],
            created_at: DateTime.toEpochMillis(data.timestamp),
          })
          .run()
          .pipe(Effect.orDie)
        yield* appendResponseItems(db, data.responseID, "context", data.context)
        yield* appendResponseItems(db, data.responseID, "input", data.input)
      }),
    )

    yield* events.project(ResponseEvent.InProgress, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const row = yield* requireResponse(db, data.responseID)
        if (row.status !== "queued") throw new LifecycleConflict(data.responseID)
        const updated = yield* db
          .update(ResponseTable)
          .set({ status: "in_progress" })
          .where(
            and(
              eq(ResponseTable.id, data.responseID),
              eq(ResponseTable.status, "queued"),
              isNull(ResponseTable.deleted_at),
            ),
          )
          .returning({ id: ResponseTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.responseID)
      }),
    )

    yield* events.project(ResponseEvent.Completed, (event) =>
      settle(db, "completed", event.data, event.durable?.replay === true, event.durable?.related),
    )
    yield* events.project(ResponseEvent.Incomplete, (event) =>
      settle(db, "incomplete", event.data, event.durable?.replay === true, event.durable?.related),
    )
    yield* events.project(ResponseEvent.Failed, (event) =>
      settle(db, "failed", event.data, event.durable?.replay === true, event.durable?.related),
    )
    yield* events.project(ResponseEvent.Cancelled, (event) =>
      settle(db, "cancelled", event.data, event.durable?.replay === true, event.durable?.related),
    )

    yield* events.project(ResponseEvent.Deleted, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const row = yield* requireResponse(db, data.responseID)
        if (!row.store || row.status === "queued" || row.status === "in_progress") {
          throw new LifecycleConflict(data.responseID)
        }
        yield* db
          .delete(ResponseItemTable)
          .where(eq(ResponseItemTable.response_id, data.responseID))
          .run()
          .pipe(Effect.orDie)
        const updated = yield* db
          .update(ResponseTable)
          .set({ output: [], error: null, usage: null, deleted_at: DateTime.toEpochMillis(data.timestamp) })
          .where(and(eq(ResponseTable.id, data.responseID), isNull(ResponseTable.deleted_at)))
          .returning({ id: ResponseTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new LifecycleConflict(data.responseID)
      }),
    )

    yield* events.project(ResponseEvent.Conversation.Created, (event) =>
      Effect.gen(function* () {
        const data = event.data
        const existing = yield* db
          .select({ id: ConversationTable.id })
          .from(ConversationTable)
          .where(eq(ConversationTable.id, data.conversationID))
          .get()
          .pipe(Effect.orDie)
        if (existing) throw new ConversationConflict(data.conversationID)
        yield* db
          .insert(ConversationTable)
          .values({
            id: data.conversationID,
            metadata: data.metadata,
            created_at: DateTime.toEpochMillis(data.timestamp),
          })
          .run()
          .pipe(Effect.orDie)
      }),
    )

    yield* events.project(ResponseEvent.Conversation.ItemAdded, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* requireConversation(db, data.conversationID)
        if (data.responseID && !event.durable?.replay) {
          const response = yield* requireResponse(db, data.responseID)
          if (!response.store || response.conversation_id !== data.conversationID) {
            throw new ConversationConflict(data.conversationID)
          }
        }
        yield* appendConversationItems(db, data.conversationID, [data.payload], data.responseID)
      }),
    )

    yield* events.project(ResponseEvent.Conversation.Deleted, (event) =>
      Effect.gen(function* () {
        const data = event.data
        yield* requireConversation(db, data.conversationID)
        if (!event.durable?.replay) {
          const active = yield* db
            .select({ id: ResponseTable.id })
            .from(ResponseTable)
            .where(
              and(
                eq(ResponseTable.conversation_id, data.conversationID),
                isNull(ResponseTable.deleted_at),
                inArray(ResponseTable.status, ["queued", "in_progress"]),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (active) throw new ConversationConflict(data.conversationID)
        }
        yield* db
          .delete(ConversationItemTable)
          .where(eq(ConversationItemTable.conversation_id, data.conversationID))
          .run()
          .pipe(Effect.orDie)
        const updated = yield* db
          .update(ConversationTable)
          .set({ deleted_at: DateTime.toEpochMillis(data.timestamp) })
          .where(and(eq(ConversationTable.id, data.conversationID), isNull(ConversationTable.deleted_at)))
          .returning({ id: ConversationTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) throw new ConversationConflict(data.conversationID)
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "responses-projector", layer, deps: [EventV2.node, Database.node] })
