export * as PublicEventVisibility from "./public-visibility"

import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Durable } from "@opencode-ai/schema/durable-event-manifest"
import { Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { ResponseTable } from "../responses/sql"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { WorkflowRunTable } from "../workflow/sql"

type Visibility = SessionSchema.Visibility
type Member = { readonly type: string; readonly data: unknown }
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

export interface Authority {
  readonly session: (sessionID: SessionSchema.ID) => Effect.Effect<Visibility | undefined>
  readonly workflow: (workflowID: Workflow.ID) => Effect.Effect<SessionSchema.ID | undefined>
  readonly response: (responseID: Responses.ID) => Effect.Effect<Workflow.ID | undefined>
}

export interface StoredEvent {
  readonly id: EventV2.ID
  readonly aggregate_id: string
  readonly seq: number
  readonly type: string
  readonly data: Record<string, unknown>
  readonly batch_id: string | null
  readonly batch_index: number | null
  readonly batch_size: number | null
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  Schema.is(UnknownRecord)(value) ? value : undefined

const eventType = (type: string) => Durable.get(type)?.type ?? type

export function databaseAuthority(db: Database.Interface["db"]): Authority {
  return {
    session: (sessionID) =>
      db
        .select({ visibility: SessionTable.visibility })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.visibility),
        ),
    workflow: (workflowID) =>
      db
        .select({ sessionID: WorkflowRunTable.session_id })
        .from(WorkflowRunTable)
        .where(eq(WorkflowRunTable.id, workflowID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.sessionID ?? undefined),
        ),
    response: (responseID) =>
      db
        .select({ workflowID: ResponseTable.workflow_id })
        .from(ResponseTable)
        .where(eq(ResponseTable.id, responseID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.workflowID),
        ),
  }
}

export function isPublic(
  event: {
    readonly type?: string
    readonly data?: unknown
    readonly durable?: {
      readonly aggregateID: string
      readonly batch?: { readonly id: string; readonly index: number; readonly size: number }
      readonly related?: ReadonlyArray<Member>
    }
  },
  authority: Authority,
) {
  return Effect.gen(function* () {
    const batch = event.durable?.batch
    if (batch && batch.size > 1 && event.durable?.related?.length !== batch.size) return false
    const members: ReadonlyArray<Member> = event.durable?.related ?? [{ type: event.type ?? "", data: event.data }]
    return yield* classify(members, event.durable?.aggregateID, authority)
  })
}

export function filterHistory(
  candidates: ReadonlyArray<StoredEvent>,
  completeHistory: ReadonlyArray<StoredEvent>,
  authority: Authority,
) {
  return Effect.gen(function* () {
    const batches = Map.groupBy(
      completeHistory.filter((row) => row.batch_id !== null),
      (row) => row.batch_id!,
    )
    const decisions = new Map<string, boolean>()
    const output: StoredEvent[] = []
    for (const row of candidates) {
      const key = row.batch_id ?? row.id
      let visible = decisions.get(key)
      if (visible === undefined) {
        const related = row.batch_id === null ? [row] : (batches.get(row.batch_id) ?? [])
        const expected = row.batch_size ?? 1
        const valid =
          row.batch_id === null ||
          (related.length === expected &&
            related.every(
              (member) =>
                member.batch_id === row.batch_id &&
                member.batch_size === expected &&
                member.batch_index !== null &&
                member.batch_index >= 0 &&
                member.batch_index < expected,
            ) &&
            new Set(related.map((member) => member.batch_index)).size === expected)
        visible = valid
          ? yield* classify(
              related.map((member) => ({ type: eventType(member.type), data: member.data })),
              row.aggregate_id,
              authority,
            )
          : false
        decisions.set(key, visible)
      }
      if (visible) output.push(row)
    }
    return output
  })
}

function classify(members: ReadonlyArray<Member>, aggregateID: string | undefined, authority: Authority) {
  return Effect.gen(function* () {
    const sessions = new Set<SessionSchema.ID>()
    const workflows = new Set<Workflow.ID>()
    const responses = new Set<Responses.ID>()
    const workflowSessions = new Map<Workflow.ID, SessionSchema.ID>()
    const responseWorkflows = new Map<Responses.ID, Workflow.ID>()
    const explicit = new Map<SessionSchema.ID, Set<Visibility>>()
    let owned = false
    let invalid = false

    const addExplicit = (sessionID: SessionSchema.ID, visibility: Visibility) => {
      const values = explicit.get(sessionID) ?? new Set<Visibility>()
      values.add(visibility)
      explicit.set(sessionID, values)
    }

    for (const member of members) {
      const type = eventType(member.type)
      const data = record(member.data)
      const sessionID = data?.sessionID
      const workflowID = data?.workflowID
      const responseID = data?.responseID
      const sessionOwned = type.startsWith("session.") || Schema.is(SessionSchema.ID)(sessionID)
      const workflowOwned = type.startsWith("workflow.") || Schema.is(Workflow.ID)(workflowID)
      const responseOwned = type.startsWith("response.") || Schema.is(Responses.ID)(responseID)
      owned ||= sessionOwned || workflowOwned || responseOwned

      if (sessionOwned && !Schema.is(SessionSchema.ID)(sessionID)) invalid = true
      if (workflowOwned && !Schema.is(Workflow.ID)(workflowID)) invalid = true
      if (responseOwned && !Schema.is(Responses.ID)(responseID)) invalid = true
      if (Schema.is(SessionSchema.ID)(sessionID)) sessions.add(sessionID)
      if (Schema.is(Workflow.ID)(workflowID)) workflows.add(workflowID)
      if (Schema.is(Responses.ID)(responseID)) responses.add(responseID)

      if (type === "session.created" || type === "session.deleted") {
        if (!Schema.is(SessionSchema.ID)(sessionID)) {
          invalid = true
        } else if (data?.visibility === "public" || data?.visibility === "workflow") {
          addExplicit(sessionID, data.visibility)
        } else {
          // Visibility predates legacy Session events. Missing authority on those two
          // historical shapes is compatible only as public.
          addExplicit(sessionID, "public")
        }
      }
      if (type === "workflow.created" && Schema.is(Workflow.ID)(workflowID)) {
        if (Schema.is(SessionSchema.ID)(sessionID)) workflowSessions.set(workflowID, sessionID)
        else invalid = true
      }
      if (type === "response.created" && Schema.is(Responses.ID)(responseID)) {
        if (Schema.is(Workflow.ID)(workflowID)) responseWorkflows.set(responseID, workflowID)
        else invalid = true
      }
    }

    if (aggregateID !== undefined) {
      if (Schema.is(SessionSchema.ID)(aggregateID)) {
        owned = true
        sessions.add(aggregateID)
      } else if (Schema.is(Workflow.ID)(aggregateID)) {
        owned = true
        workflows.add(aggregateID)
      } else if (Schema.is(Responses.ID)(aggregateID)) {
        owned = true
        responses.add(aggregateID)
      }
    }
    if (!owned) return true
    if (invalid) return false

    for (const responseID of responses) {
      const workflowID = responseWorkflows.get(responseID) ?? (yield* authority.response(responseID))
      if (!workflowID) return false
      workflows.add(workflowID)
    }
    for (const workflowID of workflows) {
      const sessionID = workflowSessions.get(workflowID) ?? (yield* authority.workflow(workflowID))
      if (!sessionID) return false
      sessions.add(sessionID)
    }

    const visibilities = new Set<Visibility>()
    for (const sessionID of sessions) {
      const declared = explicit.get(sessionID)
      if (declared) {
        const projected = yield* authority.session(sessionID)
        if (projected !== undefined && !declared.has(projected)) return false
        for (const visibility of declared) visibilities.add(visibility)
        continue
      }
      const visibility = yield* authority.session(sessionID)
      if (!visibility) return false
      visibilities.add(visibility)
    }
    return visibilities.size === 1 && visibilities.has("public")
  })
}
