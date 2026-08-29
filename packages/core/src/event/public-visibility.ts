export * as PublicEventVisibility from "./public-visibility"

import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Durable } from "@opencode-ai/schema/durable-event-manifest"
import { Effect, Schema } from "effect"
import { eq, inArray } from "drizzle-orm"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { ResponseTable } from "../responses/sql"
import { SessionSchema } from "../session/schema"
import { SessionTable, SessionTombstoneTable } from "../session/sql"
import { WorkflowRunTable } from "../workflow/sql"

type Visibility = SessionSchema.Visibility
type Member = {
  readonly id?: EventV2.ID
  readonly type: string
  readonly data: unknown
  readonly version?: number
  readonly legacy?: boolean
}
export interface SessionTombstoneAuthority {
  readonly visibility: Visibility
  readonly eventID: EventV2.ID
  readonly version: number
  readonly timeDeleted: number
}
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)
const authorityChunkSize = 250

export interface Authority {
  readonly session: (sessionID: SessionSchema.ID) => Effect.Effect<Visibility | undefined>
  readonly tombstone: (sessionID: SessionSchema.ID) => Effect.Effect<SessionTombstoneAuthority | undefined>
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

const definition = (type: string) => Durable.get(type)
const eventType = (type: string) => definition(type)?.type ?? type

function storedMember(row: StoredEvent): Member {
  const durable = definition(row.type)
  return {
    id: row.id,
    type: durable?.type ?? row.type,
    data: row.data,
    ...(durable?.durable ? { version: durable.durable.version } : {}),
    ...(!durable && row.type === "session.deleted" ? { legacy: true } : {}),
  }
}

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
    tombstone: (sessionID) =>
      db
        .select({
          visibility: SessionTombstoneTable.visibility,
          eventID: SessionTombstoneTable.deletion_event_id,
          version: SessionTombstoneTable.deletion_version,
          timeDeleted: SessionTombstoneTable.time_deleted,
        })
        .from(SessionTombstoneTable)
        .where(eq(SessionTombstoneTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
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

function chunks<A>(items: ReadonlyArray<A>, size: number) {
  const output: A[][] = []
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size))
  return output
}

export function preloadDatabaseAuthority(db: Database.Interface["db"], events: ReadonlyArray<StoredEvent>) {
  return Effect.gen(function* () {
    const sessionIDs = new Set<SessionSchema.ID>()
    const workflowIDs = new Set<Workflow.ID>()
    const responseIDs = new Set<Responses.ID>()
    for (const event of events) {
      const data = record(event.data)
      if (Schema.is(SessionSchema.ID)(event.aggregate_id)) sessionIDs.add(event.aggregate_id)
      if (Schema.is(Workflow.ID)(event.aggregate_id)) workflowIDs.add(event.aggregate_id)
      if (Schema.is(Responses.ID)(event.aggregate_id)) responseIDs.add(event.aggregate_id)
      if (Schema.is(SessionSchema.ID)(data?.sessionID)) sessionIDs.add(data.sessionID)
      if (Schema.is(Workflow.ID)(data?.workflowID)) workflowIDs.add(data.workflowID)
      if (Schema.is(Responses.ID)(data?.responseID)) responseIDs.add(data.responseID)
    }

    const responseRows = (yield* Effect.forEach(
      chunks([...responseIDs], authorityChunkSize),
      (ids) =>
        db
          .select({ responseID: ResponseTable.id, workflowID: ResponseTable.workflow_id })
          .from(ResponseTable)
          .where(inArray(ResponseTable.id, ids))
          .all()
          .pipe(Effect.orDie),
      { concurrency: 1 },
    )).flat()
    const responses = new Map(responseRows.map((row) => [row.responseID, row.workflowID] as const))
    for (const row of responseRows) workflowIDs.add(row.workflowID)

    const workflowRows = (yield* Effect.forEach(
      chunks([...workflowIDs], authorityChunkSize),
      (ids) =>
        db
          .select({ workflowID: WorkflowRunTable.id, sessionID: WorkflowRunTable.session_id })
          .from(WorkflowRunTable)
          .where(inArray(WorkflowRunTable.id, ids))
          .all()
          .pipe(Effect.orDie),
      { concurrency: 1 },
    )).flat()
    const workflows = new Map(
      workflowRows.flatMap((row) => (row.sessionID === null ? [] : [[row.workflowID, row.sessionID] as const])),
    )
    for (const row of workflowRows) if (row.sessionID !== null) sessionIDs.add(row.sessionID)

    const sessionRows = (yield* Effect.forEach(
      chunks([...sessionIDs], authorityChunkSize),
      (ids) =>
        db
          .select({ sessionID: SessionTable.id, visibility: SessionTable.visibility })
          .from(SessionTable)
          .where(inArray(SessionTable.id, ids))
          .all()
          .pipe(Effect.orDie),
      { concurrency: 1 },
    )).flat()
    const sessions = new Map(sessionRows.map((row) => [row.sessionID, row.visibility] as const))
    const tombstoneRows = (yield* Effect.forEach(
      chunks([...sessionIDs], authorityChunkSize),
      (ids) =>
        db
          .select({
            sessionID: SessionTombstoneTable.session_id,
            visibility: SessionTombstoneTable.visibility,
            eventID: SessionTombstoneTable.deletion_event_id,
            version: SessionTombstoneTable.deletion_version,
            timeDeleted: SessionTombstoneTable.time_deleted,
          })
          .from(SessionTombstoneTable)
          .where(inArray(SessionTombstoneTable.session_id, ids))
          .all()
          .pipe(Effect.orDie),
      { concurrency: 1 },
    )).flat()
    const tombstones = new Map(tombstoneRows.map(({ sessionID, ...row }) => [sessionID, row] as const))

    return {
      session: (sessionID: SessionSchema.ID) => Effect.succeed(sessions.get(sessionID)),
      tombstone: (sessionID: SessionSchema.ID) => Effect.succeed(tombstones.get(sessionID)),
      workflow: (workflowID: Workflow.ID) => Effect.succeed(workflows.get(workflowID)),
      response: (responseID: Responses.ID) => Effect.succeed(responses.get(responseID)),
    } satisfies Authority
  })
}

export function isPublic(
  event: {
    readonly id?: EventV2.ID
    readonly type?: string
    readonly data?: unknown
    readonly durable?: {
      readonly aggregateID: string
      readonly seq?: number
      readonly version?: number
      readonly batch?: { readonly id: string; readonly index: number; readonly size: number }
      readonly related?: ReadonlyArray<Member>
    }
  },
  authority: Authority,
) {
  return Effect.gen(function* () {
    const batch = event.durable?.batch
    if (batch && batch.size > 1 && event.durable?.related?.length !== batch.size) return false
    const members: ReadonlyArray<Member> = event.durable?.related
      ? event.durable.related.map((member, index) => ({
          ...member,
          ...(batch?.index === index && event.id !== undefined ? { id: event.id } : {}),
          ...(batch?.index === index && event.durable?.version !== undefined ? { version: event.durable.version } : {}),
        }))
      : [{ id: event.id, type: event.type ?? "", data: event.data, version: event.durable?.version }]
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
        visible = valid ? yield* classify(related.map(storedMember), row.aggregate_id, authority) : false
        decisions.set(key, visible)
      }
      if (visible) output.push(row)
    }
    return output
  })
}

function classify(members: ReadonlyArray<Member>, aggregateID: string | undefined, authority: Authority) {
  const declarations = new Map<string, number>()
  for (const member of members) {
    const type = eventType(member.type)
    const data = record(member.data)
    const sessionID = data?.sessionID
    const workflowID = data?.workflowID
    const responseID = data?.responseID
    const key =
      (type === "session.created" || type === "session.deleted") && Schema.is(SessionSchema.ID)(sessionID)
        ? `session\0${sessionID}`
        : type === "workflow.created" && Schema.is(Workflow.ID)(workflowID)
          ? `workflow\0${workflowID}`
          : type === "response.created" && Schema.is(Responses.ID)(responseID)
            ? `response\0${responseID}`
            : undefined
    if (key !== undefined) declarations.set(key, (declarations.get(key) ?? 0) + 1)
  }
  if ([...declarations.values()].some((count) => count > 1)) return Effect.succeed(false)

  return Effect.gen(function* () {
    const sessions = new Set<SessionSchema.ID>()
    const workflows = new Set<Workflow.ID>()
    const responses = new Set<Responses.ID>()
    const workflowSessions = new Map<Workflow.ID, Set<SessionSchema.ID>>()
    const responseWorkflows = new Map<Responses.ID, Set<Workflow.ID>>()
    const explicit = new Map<SessionSchema.ID, Set<Visibility>>()
    const deletions = new Map<SessionSchema.ID, SessionTombstoneAuthority>()
    let owned = false
    let invalid = false

    const addExplicit = (sessionID: SessionSchema.ID, visibility: Visibility) => {
      const values = explicit.get(sessionID) ?? new Set<Visibility>()
      values.add(visibility)
      explicit.set(sessionID, values)
    }

    const addWorkflowSession = (workflowID: Workflow.ID, sessionID: SessionSchema.ID) => {
      const values = workflowSessions.get(workflowID) ?? new Set<SessionSchema.ID>()
      values.add(sessionID)
      workflowSessions.set(workflowID, values)
    }

    const addResponseWorkflow = (responseID: Responses.ID, workflowID: Workflow.ID) => {
      const values = responseWorkflows.get(responseID) ?? new Set<Workflow.ID>()
      values.add(workflowID)
      responseWorkflows.set(responseID, values)
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
        } else {
          const visibility =
            data?.visibility === "public" || data?.visibility === "workflow"
              ? data.visibility
              : type === "session.created" || member.version === 1 || member.legacy === true
                ? "public"
                : undefined
          if (visibility) addExplicit(sessionID, visibility)
          else invalid = true
          if (type === "session.deleted") {
            const version = member.version ?? (member.legacy === true ? 1 : undefined)
            const legacyInfo = record(data?.info)
            const legacyTime = record(legacyInfo?.time)?.updated
            const timeDeleted = version === 3 ? data?.timeDeleted : legacyTime
            if (
              member.id === undefined ||
              visibility === undefined ||
              (version !== 1 && version !== 2 && version !== 3) ||
              typeof timeDeleted !== "number" ||
              !Number.isSafeInteger(timeDeleted) ||
              timeDeleted < 0
            ) {
              invalid = true
            } else {
              deletions.set(sessionID, { visibility, eventID: member.id, version, timeDeleted })
            }
          }
        }
      }
      if (type === "workflow.created" && Schema.is(Workflow.ID)(workflowID)) {
        if (Schema.is(SessionSchema.ID)(sessionID)) addWorkflowSession(workflowID, sessionID)
        else invalid = true
      }
      if (type === "response.created" && Schema.is(Responses.ID)(responseID)) {
        if (Schema.is(Workflow.ID)(workflowID)) addResponseWorkflow(responseID, workflowID)
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
      const authoritative = yield* authority.response(responseID)
      if (!authoritative) return false
      const declared = responseWorkflows.get(responseID)
      if (declared && (declared.size !== 1 || !declared.has(authoritative))) return false
      workflows.add(authoritative)
    }
    for (const workflowID of workflows) {
      const authoritative = yield* authority.workflow(workflowID)
      if (!authoritative) return false
      const declared = workflowSessions.get(workflowID)
      if (declared && (declared.size !== 1 || !declared.has(authoritative))) return false
      sessions.add(authoritative)
    }

    const visibilities = new Set<Visibility>()
    for (const sessionID of sessions) {
      const declared = explicit.get(sessionID)
      const projected = yield* authority.session(sessionID)
      const deletion = deletions.get(sessionID)
      if (deletion) {
        if (projected !== undefined) return false
        const tombstone = yield* authority.tombstone(sessionID)
        if (
          !tombstone ||
          tombstone.visibility !== deletion.visibility ||
          tombstone.eventID !== deletion.eventID ||
          tombstone.version !== deletion.version ||
          tombstone.timeDeleted !== deletion.timeDeleted
        ) {
          return false
        }
        visibilities.add(tombstone.visibility)
        continue
      }
      if (projected === undefined) {
        return false
      }
      if (declared && (declared.size !== 1 || !declared.has(projected))) return false
      visibilities.add(projected)
    }
    return visibilities.size === 1 && visibilities.has("public")
  })
}
