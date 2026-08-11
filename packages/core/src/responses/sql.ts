export * as ResponsesSql from "./sql"

import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Responses } from "@opencode-ai/schema/responses"
import type { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRunTable } from "../workflow/sql"

export const ConversationTable = sqliteTable("conversation", {
  id: text().$type<Responses.ConversationID>().primaryKey(),
  metadata: text({ mode: "json" }).$type<Responses.Conversation["metadata"]>().notNull(),
  created_at: integer().notNull(),
  deleted_at: integer(),
})

export const ResponseTable = sqliteTable(
  "response",
  {
    id: text().$type<Responses.ID>().primaryKey(),
    workflow_id: text()
      .$type<Workflow.ID>()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    model: text().notNull(),
    status: text().$type<Responses.Status>().notNull(),
    background: integer({ mode: "boolean" }).notNull(),
    store: integer({ mode: "boolean" }).notNull(),
    previous_response_id: text().$type<Responses.ID>(),
    conversation_id: text().$type<Responses.ConversationID>(),
    request_hash: text().notNull(),
    output: text({ mode: "json" }).$type<Responses.ItemPayload[]>().notNull(),
    error: text({ mode: "json" }).$type<Responses.Error>(),
    usage: text({ mode: "json" }).$type<Responses.Usage>(),
    created_at: integer().notNull(),
    completed_at: integer(),
    deleted_at: integer(),
  },
  (table) => [
    uniqueIndex("response_request_hash_idx").on(table.request_hash),
    index("response_workflow_idx").on(table.workflow_id),
    index("response_previous_idx").on(table.previous_response_id),
    index("response_conversation_idx").on(table.conversation_id),
    index("response_status_created_idx").on(table.status, table.created_at),
  ],
)

export const ResponseItemTable = sqliteTable(
  "response_item",
  {
    response_id: text()
      .$type<Responses.ID>()
      .notNull()
      .references(() => ResponseTable.id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    kind: text().$type<Responses.ItemKind>().notNull(),
    payload: text({ mode: "json" }).$type<Responses.ItemPayload>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.response_id, table.ordinal] }),
    index("response_item_response_kind_ordinal_idx").on(table.response_id, table.kind, table.ordinal),
  ],
)

export const ConversationItemTable = sqliteTable(
  "conversation_item",
  {
    conversation_id: text()
      .$type<Responses.ConversationID>()
      .notNull()
      .references(() => ConversationTable.id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    response_id: text().$type<Responses.ID>(),
    payload: text({ mode: "json" }).$type<Responses.ItemPayload>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversation_id, table.ordinal] }),
    index("conversation_item_response_idx").on(table.response_id),
  ],
)
