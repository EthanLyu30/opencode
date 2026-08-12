export * as ResponsesStore from "./store"

import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Context, DateTime, Effect, Layer } from "effect"
import { Responses } from "@opencode-ai/schema/responses"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { ConversationItemTable, ConversationTable, ResponseItemTable, ResponseTable } from "./sql"

export interface Interface {
  readonly list: () => Effect.Effect<Responses.Resource[]>
  readonly get: (responseID: Responses.ID, includeDeleted?: boolean) => Effect.Effect<Responses.Resource | undefined>
  readonly request: (requestHash: string) => Effect.Effect<Responses.Resource | undefined>
  readonly activeByWorkflowID: (workflowID: Workflow.ID) => Effect.Effect<Responses.Resource[]>
  readonly items: (responseID: Responses.ID, kind?: Responses.ItemKind) => Effect.Effect<Responses.ResponseItem[]>
  readonly conversation: (
    conversationID: Responses.ConversationID,
    includeDeleted?: boolean,
  ) => Effect.Effect<Responses.Conversation | undefined>
  readonly conversationItems: (conversationID: Responses.ConversationID) => Effect.Effect<Responses.ConversationItem[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ResponsesStore") {}

function responseRow(row: typeof ResponseTable.$inferSelect): Responses.Resource {
  return {
    id: row.id,
    workflowID: row.workflow_id,
    model: row.model,
    status: row.status,
    background: row.background,
    store: row.store,
    previousResponseID: row.previous_response_id ?? undefined,
    conversationID: row.conversation_id ?? undefined,
    requestHash: row.request_hash,
    output: row.output,
    error: row.error ?? undefined,
    usage: row.usage ?? undefined,
    createdAt: DateTime.makeUnsafe(row.created_at),
    completedAt: row.completed_at === null ? undefined : DateTime.makeUnsafe(row.completed_at),
    deletedAt: row.deleted_at === null ? undefined : DateTime.makeUnsafe(row.deleted_at),
  }
}

function conversationRow(row: typeof ConversationTable.$inferSelect): Responses.Conversation {
  return {
    id: row.id,
    metadata: row.metadata,
    createdAt: DateTime.makeUnsafe(row.created_at),
    deletedAt: row.deleted_at === null ? undefined : DateTime.makeUnsafe(row.deleted_at),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    return Service.of({
      list: Effect.fn("ResponsesStore.list")(function* () {
        const rows = yield* db
          .select()
          .from(ResponseTable)
          .where(isNull(ResponseTable.deleted_at))
          .orderBy(asc(ResponseTable.created_at), asc(ResponseTable.id))
          .all()
          .pipe(Effect.orDie)
        return rows.map(responseRow)
      }),

      get: Effect.fn("ResponsesStore.get")(function* (responseID, includeDeleted) {
        const row = yield* db
          .select()
          .from(ResponseTable)
          .where(
            includeDeleted
              ? eq(ResponseTable.id, responseID)
              : and(eq(ResponseTable.id, responseID), isNull(ResponseTable.deleted_at)),
          )
          .get()
          .pipe(Effect.orDie)
        return row ? responseRow(row) : undefined
      }),

      request: Effect.fn("ResponsesStore.request")(function* (requestHash) {
        const row = yield* db
          .select()
          .from(ResponseTable)
          .where(eq(ResponseTable.request_hash, requestHash))
          .get()
          .pipe(Effect.orDie)
        return row ? responseRow(row) : undefined
      }),

      activeByWorkflowID: Effect.fn("ResponsesStore.activeByWorkflowID")(function* (workflowID) {
        const rows = yield* db
          .select()
          .from(ResponseTable)
          .where(
            and(
              eq(ResponseTable.workflow_id, workflowID),
              isNull(ResponseTable.deleted_at),
              inArray(ResponseTable.status, ["queued", "in_progress"]),
            ),
          )
          .orderBy(asc(ResponseTable.created_at), asc(ResponseTable.id))
          .all()
          .pipe(Effect.orDie)
        return rows.map(responseRow)
      }),

      items: Effect.fn("ResponsesStore.items")(function* (responseID, kind) {
        const rows = yield* db
          .select()
          .from(ResponseItemTable)
          .where(
            kind
              ? and(eq(ResponseItemTable.response_id, responseID), eq(ResponseItemTable.kind, kind))
              : eq(ResponseItemTable.response_id, responseID),
          )
          .orderBy(asc(ResponseItemTable.ordinal))
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => ({
          responseID: row.response_id,
          ordinal: row.ordinal,
          kind: row.kind,
          payload: row.payload,
        }))
      }),

      conversation: Effect.fn("ResponsesStore.conversation")(function* (conversationID, includeDeleted) {
        const row = yield* db
          .select()
          .from(ConversationTable)
          .where(
            includeDeleted
              ? eq(ConversationTable.id, conversationID)
              : and(eq(ConversationTable.id, conversationID), isNull(ConversationTable.deleted_at)),
          )
          .get()
          .pipe(Effect.orDie)
        return row ? conversationRow(row) : undefined
      }),

      conversationItems: Effect.fn("ResponsesStore.conversationItems")(function* (conversationID) {
        const rows = yield* db
          .select()
          .from(ConversationItemTable)
          .where(eq(ConversationItemTable.conversation_id, conversationID))
          .orderBy(asc(ConversationItemTable.ordinal))
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => ({
          conversationID: row.conversation_id,
          ordinal: row.ordinal,
          responseID: row.response_id ?? undefined,
          payload: row.payload,
        }))
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
