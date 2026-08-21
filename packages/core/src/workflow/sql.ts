export * as WorkflowSql from "./sql"

import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { absoluteColumn } from "../database/path"
import { Timestamps } from "../database/schema.sql"
import type { Agent } from "@opencode-ai/schema/agent"
import type { Session } from "@opencode-ai/schema/session"
import type { Workflow } from "@opencode-ai/schema/workflow"
import type { Workspace } from "@opencode-ai/schema/workspace"
import type { SessionSchema } from "../session/schema"

export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().$type<Workflow.ID>().primaryKey(),
    type: text().notNull(),
    status: text().$type<Workflow.RunStatus>().notNull(),
    current_stage_id: text().$type<Workflow.StageID>(),
    input: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    budget: text({ mode: "json" }).$type<Workflow.Budget>().notNull(),
    usage: text({ mode: "json" }).$type<Workflow.Usage>().notNull(),
    directory: absoluteColumn(),
    workspace_id: text().$type<Workspace.ID>(),
    session_id: text().$type<Session.ID>(),
    agent: text().$type<Agent.ID>(),
    budget_notified: integer().notNull().default(0),
    cancel_requested_at: integer(),
    time_completed: integer(),
    version: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [index("workflow_run_status_updated_idx").on(table.status, table.time_updated)],
)

export const WorkflowStageTable = sqliteTable(
  "workflow_stage",
  {
    id: text().$type<Workflow.StageID>().primaryKey(),
    workflow_id: text()
      .$type<Workflow.ID>()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    stage_type: text().notNull(),
    ordinal: integer().notNull(),
    status: text().$type<Workflow.StageStatus>().notNull(),
    attempt: integer().notNull().default(0),
    max_attempts: integer().notNull(),
    not_before: integer(),
    lease_owner: text(),
    lease_expires_at: integer(),
    session_id: text().$type<SessionSchema.ID>(),
    checkpoint: text({ mode: "json" }).$type<Record<string, unknown>>(),
    recovery_policy: text().$type<Workflow.RecoveryPolicy>().notNull(),
    recovery_action: text().$type<Workflow.RecoveryAction>(),
    idempotency_key: text().notNull(),
    input: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    error: text({ mode: "json" }).$type<Workflow.Failure>(),
    time_started: integer(),
    time_completed: integer(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("workflow_stage_workflow_ordinal_idx").on(table.workflow_id, table.ordinal),
    uniqueIndex("workflow_stage_workflow_idempotency_idx").on(table.workflow_id, table.idempotency_key),
    index("workflow_stage_claim_idx").on(table.status, table.not_before, table.lease_expires_at, table.ordinal),
    index("workflow_stage_workflow_status_idx").on(table.workflow_id, table.status, table.ordinal),
  ],
)

export const WorkflowArtifactTable = sqliteTable(
  "workflow_artifact",
  {
    id: text().$type<Workflow.ArtifactID>().primaryKey(),
    workflow_id: text()
      .$type<Workflow.ID>()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    stage_id: text()
      .$type<Workflow.StageID>()
      .notNull()
      .references(() => WorkflowStageTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    uri: text().notNull(),
    mime: text().notNull(),
    sha256: text().notNull(),
    size: integer().notNull(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("workflow_artifact_stage_kind_sha_idx").on(table.stage_id, table.kind, table.sha256),
    index("workflow_artifact_workflow_created_idx").on(table.workflow_id, table.time_created),
  ],
)
