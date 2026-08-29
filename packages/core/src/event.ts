export * as EventV2 from "./event"

import { Cause, Context, Deferred, Effect, Exit, Layer, Option, PubSub, Queue, Schema, Stream } from "effect"
import { Event } from "@opencode-ai/schema/event"
import type { Data, Definition, Payload } from "@opencode-ai/schema/event"
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm"
import { Database } from "./database/database"
import { EventSequenceTable, EventTable } from "./event/sql"
import { Location } from "./location"
import { makeGlobalNode } from "./effect/app-node"
import { isDeepStrictEqual } from "node:util"
import { Durable } from "@opencode-ai/schema/durable-event-manifest"

export const ID = Event.ID
export type ID = import("@opencode-ai/schema/event").ID
export type { Data, Definition, Payload } from "@opencode-ai/schema/event"

export type Subscriber<D extends Definition = Definition> = (event: Payload<D>) => Effect.Effect<void>
export type Unsubscribe = Effect.Effect<void>

export const latestSequence = Effect.fn("EventV2.latestSequence")(function* (
  db: Database.Interface["db"],
  aggregateID: string,
) {
  const row = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
    .get()
    .pipe(Effect.orDie)
  return row?.seq ?? -1
})

export type SerializedEvent = {
  readonly id: ID
  readonly type: string
  readonly seq: number
  readonly aggregateID: string
  readonly data: Record<string, unknown>
  readonly batchID?: string
  readonly batchIndex?: number
  readonly batchSize?: number
}

type DurableBatch = {
  readonly id: string
  readonly index: number
  readonly size: number
}

export class InvalidDurableEventError extends Schema.TaggedErrorClass<InvalidDurableEventError>()(
  "EventV2.InvalidDurableEvent",
  {
    type: Schema.String,
    message: Schema.String,
  },
) {}

export class InvalidReplayBatchError extends Schema.TaggedErrorClass<InvalidReplayBatchError>()(
  "EventV2.InvalidReplayBatch",
  {
    reason: Schema.Literals([
      "incomplete_batch",
      "invalid_batch",
      "duplicate_event",
      "partial_batch",
      "divergent_batch",
      "deadlock",
      "owner_mismatch",
    ]),
    batchID: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

const decodeSerializedEvent = (event: SerializedEvent): Payload => {
  const definition = Durable.get(event.type)
  if (!definition?.durable) {
    throw new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` })
  }
  return {
    id: event.id,
    type: definition.type,
    durable: {
      aggregateID: event.aggregateID,
      seq: event.seq,
      version: definition.durable.version,
      ...(event.batchID === undefined
        ? {}
        : { batch: { id: event.batchID, index: event.batchIndex!, size: event.batchSize! } }),
    },
    data: Schema.decodeUnknownSync(definition.data)(event.data),
  }
}

function serializedBatch(event: SerializedEvent): DurableBatch | undefined {
  const fields = [event.batchID, event.batchIndex, event.batchSize]
  if (fields.every((field) => field === undefined)) return undefined
  if (fields.some((field) => field === undefined)) {
    throw new InvalidReplayBatchError({
      reason: "invalid_batch",
      batchID: event.batchID,
      message: `Event ${event.id} has partial batch metadata`,
    })
  }
  if (
    event.batchID === "" ||
    !Number.isInteger(event.batchIndex) ||
    !Number.isInteger(event.batchSize) ||
    event.batchIndex! < 0 ||
    event.batchSize! < 1 ||
    event.batchIndex! >= event.batchSize!
  ) {
    throw new InvalidReplayBatchError({
      reason: "invalid_batch",
      batchID: event.batchID,
      message: `Event ${event.id} has invalid batch metadata`,
    })
  }
  return { id: event.batchID!, index: event.batchIndex!, size: event.batchSize! }
}

function replayBatchError(reason: InvalidReplayBatchError["reason"], message: string, batchID?: string) {
  return new InvalidReplayBatchError({ reason, message, ...(batchID === undefined ? {} : { batchID }) })
}

function terminalCompactionError(type: string, message: string): never {
  throw new InvalidDurableEventError({ type, message })
}

function decodeReplayBatches(events: ReadonlyArray<SerializedEvent>) {
  const ids = new Set<string>()
  const positions = new Set<string>()
  const groups = new Map<
    string,
    Array<{ readonly event: SerializedEvent; readonly payload: Payload; readonly batch?: DurableBatch }>
  >()
  for (const event of events) {
    if (ids.has(event.id)) throw replayBatchError("duplicate_event", `Duplicate event ID ${event.id}`)
    ids.add(event.id)
    const position = `${event.aggregateID}\0${event.seq}`
    if (positions.has(position)) {
      throw replayBatchError(
        "duplicate_event",
        `Duplicate aggregate position ${event.aggregateID} sequence ${event.seq}`,
      )
    }
    positions.add(position)
    const batch = serializedBatch(event)
    const payload = decodeSerializedEvent(event)
    const groupID = batch?.id ?? event.id
    const group = groups.get(groupID) ?? []
    group.push({ event, payload, ...(batch === undefined ? {} : { batch }) })
    groups.set(groupID, group)
  }
  return Array.from(groups, ([id, members]) => {
    const declared = members[0]?.batch?.size ?? 1
    if (members.some((member) => (member.batch?.size ?? 1) !== declared)) {
      throw replayBatchError("invalid_batch", `Batch ${id} declares inconsistent sizes`, id)
    }
    const indices = members.map((member) => member.batch?.index ?? 0)
    if (new Set(indices).size !== indices.length) {
      throw replayBatchError("invalid_batch", `Batch ${id} contains a duplicate index`, id)
    }
    if (members.length !== declared) {
      throw replayBatchError("incomplete_batch", `Batch ${id} is incomplete`, id)
    }
    const ordered = [...members].sort((left, right) => (left.batch?.index ?? 0) - (right.batch?.index ?? 0))
    if (
      ordered.some(
        (member, index) =>
          member.batch !== undefined &&
          (member.batch.id !== id || member.batch.size !== declared || member.batch.index !== index),
      )
    ) {
      throw replayBatchError("incomplete_batch", `Batch ${id} is misindexed`, id)
    }
    return { id, members: ordered }
  })
}

export const readAggregate = Effect.fn("EventV2.readAggregate")(function* <A>(
  db: Database.Interface["db"],
  input: {
    readonly aggregateID: string
    readonly after?: number
    readonly limit: number
    readonly manifest: {
      readonly definitions: ReadonlyMap<string, Definition>
      readonly schema: Schema.Decoder<A, never>
    }
  },
) {
  const after = input.after ?? -1
  const rows = yield* db
    .select()
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, input.aggregateID),
        gt(EventTable.seq, after),
        inArray(EventTable.type, Array.from(input.manifest.definitions.keys())),
      ),
    )
    .orderBy(asc(EventTable.seq))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  const page = rows.slice(0, input.limit)
  const decode = Schema.decodeUnknownSync(input.manifest.schema)
  const events = page.map((event) =>
    decode({
      id: event.id,
      type: input.manifest.definitions.get(event.type)?.type ?? event.type,
      durable: {
        aggregateID: event.aggregate_id,
        seq: event.seq,
        version: input.manifest.definitions.get(event.type)?.durable?.version,
        ...(event.batch_id === null
          ? {}
          : { batch: { id: event.batch_id, index: event.batch_index!, size: event.batch_size! } }),
      },
      data: event.data,
    }),
  )
  return {
    events,
    hasMore: rows.length > input.limit,
  }
})

export class SubscriberOverflowError extends Schema.TaggedErrorClass<SubscriberOverflowError>()(
  "EventV2.SubscriberOverflow",
  { capacity: Schema.Int },
) {}

export const define = Event.define
export const versionedType = Event.versionedType

export interface PublishOptions {
  readonly id?: ID
  readonly metadata?: Record<string, unknown>
  readonly location?: Location.Ref
  /** Local operational projection committed atomically with a new durable event. Not replayed or serialized. */
  readonly commit?: (seq: number) => Effect.Effect<void>
  /** Additional durable events committed and projected atomically with the primary event. */
  readonly related?: ReadonlyArray<{
    readonly definition: Definition
    readonly data: unknown
    readonly id?: ID
  }>
}

type RelatedInput = NonNullable<PublishOptions["related"]>[number] & {
  readonly replay?: {
    readonly seq: number
    readonly aggregateID: string
    readonly ownerID?: string
    readonly strictOwner?: boolean
  }
}

export interface Interface {
  readonly publish: <D extends Definition>(
    definition: D,
    data: Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Payload<D>>
  readonly subscribe: <D extends Definition>(definition: D) => Stream.Stream<Payload<D>>
  readonly all: () => Stream.Stream<Payload>
  readonly durable: (input: { readonly aggregateID: string; readonly after?: number }) => Stream.Stream<Payload>
  /** @deprecated Use `all()` and consume the returned stream. */
  readonly listen: (listener: Subscriber) => Effect.Effect<Unsubscribe>
  readonly project: <D extends Definition>(definition: D, projector: Subscriber<D>) => Effect.Effect<void>
  readonly replay: (
    event: SerializedEvent,
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<void>
  readonly replayAll: (
    events: SerializedEvent[],
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<string | undefined, InvalidReplayBatchError>
  readonly replayBatches: (
    events: SerializedEvent[],
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<void, InvalidReplayBatchError>
  readonly latestSequence: (aggregateID: string) => Effect.Effect<number>
  readonly compactTerminal: <D extends Definition>(definition: D, event: Payload<D>) => Effect.Effect<void>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Event") {}

const InNotificationDrain = Context.Reference<boolean>("@opencode/Event/InNotificationDrain", {
  defaultValue: () => false,
})

export const allBounded = (events: Interface, capacity: number) =>
  Effect.gen(function* () {
    const queue = yield* Queue.dropping<Payload, SubscriberOverflowError>(capacity)
    const unsubscribe = yield* events.listen((event) =>
      Queue.offer(queue, event).pipe(
        Effect.flatMap((accepted) =>
          accepted ? Effect.void : Queue.fail(queue, new SubscriberOverflowError({ capacity })).pipe(Effect.asVoid),
        ),
      ),
    )
    yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid))
    return Stream.fromQueue(queue)
  })

export interface LayerOptions {
  readonly beforeAggregateRead?: (aggregateID: string) => Effect.Effect<void>
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const pubsub = {
        all: yield* PubSub.unbounded<Payload>(),
        durable: new Map<string, Set<PubSub.PubSub<void>>>(),
        typed: new Map<string, PubSub.PubSub<Payload>>(),
      }
      const projectors = new Map<string, Subscriber[]>()
      const notificationQueue = new Array<{
        readonly events: Payload[]
        readonly done: Deferred.Deferred<Exit.Exit<void>>
      }>()
      let notificationDraining = false
      // TODO: Bind durable projectors to exact type+version before supporting incompatible historical payloads.
      const listeners = new Array<Subscriber>()
      const { db } = yield* Database.Service

      const getOrCreate = (definition: Definition) =>
        Effect.gen(function* () {
          const existing = pubsub.typed.get(definition.type)
          if (existing) return existing
          const created = yield* PubSub.unbounded<Payload>()
          pubsub.typed.set(definition.type, created)
          return created
        })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* PubSub.shutdown(pubsub.all)
          yield* Effect.forEach(
            pubsub.durable.values(),
            (pubsubs) => Effect.forEach(pubsubs, PubSub.shutdown, { discard: true }),
            { discard: true },
          )
          yield* Effect.forEach(pubsub.typed.values(), PubSub.shutdown, { discard: true })
        }),
      )

      function commitRelatedEvent(
        input: RelatedInput,
        envelope: Pick<Payload, "type" | "data" | "location" | "metadata">,
        related: ReadonlyArray<RelatedInput>,
        batch: DurableBatch,
      ) {
        return Effect.gen(function* () {
          const definition = input.definition
          const durable = definition.durable
          if (!durable) {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: definition.type,
                message: "Related events must be durable",
              }),
            )
          }
          const data = input.data as Record<string, unknown>
          const aggregateID = data[durable.aggregate]
          if (typeof aggregateID !== "string") {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: definition.type,
                message: `Expected string aggregate field ${durable.aggregate}`,
              }),
            )
          }
          if (input.replay && input.replay.aggregateID !== aggregateID) {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: definition.type,
                message: `Aggregate mismatch: expected ${input.replay.aggregateID}, got ${aggregateID}`,
              }),
            )
          }
          const row = yield* db
            .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
            .get()
            .pipe(Effect.orDie)
          const seq = (row?.seq ?? -1) + 1
          if (input.replay?.strictOwner && row?.ownerID && row.ownerID !== input.replay.ownerID) {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: definition.type,
                message: `Replay owner mismatch for aggregate ${aggregateID}: expected ${row.ownerID}, got ${input.replay.ownerID ?? "none"}`,
              }),
            )
          }
          if (input.replay && row?.ownerID && row.ownerID !== input.replay.ownerID) {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: definition.type,
                message: `Replay owner mismatch for aggregate ${aggregateID}: expected ${row.ownerID}, got ${input.replay.ownerID ?? "none"}`,
              }),
            )
          }
          if (input.replay && input.replay.seq !== seq) {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: definition.type,
                message: `Sequence mismatch for aggregate ${aggregateID}: expected ${seq}, got ${input.replay.seq}`,
              }),
            )
          }
          const id = input.id ?? ID.create()
          const stored = yield* db
            .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
            .from(EventTable)
            .where(eq(EventTable.id, id))
            .get()
            .pipe(Effect.orDie)
          if (stored) {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: definition.type,
                message: `Event ${id} already exists at aggregate ${stored.aggregateID} sequence ${stored.seq}`,
              }),
            )
          }
          const encoded = Schema.encodeUnknownSync(definition.data)(input.data) as Record<string, unknown>
          const event = {
            id,
            type: definition.type,
            data: input.data,
            ...(envelope.location ? { location: envelope.location } : {}),
            ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
            durable: {
              aggregateID,
              seq,
              version: durable.version,
              ...(input.replay ? { replay: true } : {}),
              related: [
                { type: envelope.type, data: envelope.data },
                ...related.map((item) => ({ type: item.definition.type, data: item.data })),
              ],
              batch,
            },
          } as Payload
          for (const projector of projectors.get(definition.type) ?? []) {
            yield* projector(event)
          }
          yield* db
            .insert(EventSequenceTable)
            .values([{ aggregate_id: aggregateID, seq, owner_id: input.replay?.ownerID }])
            .onConflictDoUpdate({
              target: EventSequenceTable.aggregate_id,
              set: {
                seq,
                ...(input.replay?.ownerID && row?.ownerID == null ? { owner_id: input.replay.ownerID } : {}),
              },
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(EventTable)
            .values([
              {
                id,
                aggregate_id: aggregateID,
                seq,
                batch_id: batch.id,
                batch_index: batch.index,
                batch_size: batch.size,
                type: versionedType(definition.type, durable.version),
                data: encoded,
              },
            ])
            .run()
            .pipe(Effect.orDie)
          return event
        })
      }

      function commitDurableEvent(
        definition: Definition,
        event: Payload,
        input?: {
          readonly seq: number
          readonly aggregateID: string
          readonly ownerID?: string
          readonly strictOwner?: boolean
        },
        commit?: (seq: number) => Effect.Effect<void>,
        related?: ReadonlyArray<RelatedInput>,
        batch?: DurableBatch,
        withinTransaction = false,
      ) {
        return Effect.gen(function* () {
          const durable = definition?.durable
          if (durable) {
            const aggregateID = (event.data as Record<string, unknown>)[durable.aggregate]
            if (typeof aggregateID !== "string") {
              yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `Expected string aggregate field ${durable.aggregate}`,
                }),
              )
            } else {
              if (input && input.aggregateID !== aggregateID) {
                yield* Effect.die(
                  new InvalidDurableEventError({
                    type: event.type,
                    message: `Aggregate mismatch: expected ${input.aggregateID}, got ${aggregateID}`,
                  }),
                )
              }
              const list = projectors.get(event.type) ?? []
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const operation = Effect.gen(function* () {
                    const row = yield* db
                      .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
                      .from(EventSequenceTable)
                      .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                      .get()
                      .pipe(Effect.orDie)
                    const latest = row?.seq ?? -1
                    const encoded = Schema.encodeUnknownSync(definition.data)(event.data) as Record<string, unknown>
                    if (input?.strictOwner && row?.ownerID && row.ownerID !== input.ownerID) {
                      yield* Effect.die(
                        new InvalidDurableEventError({
                          type: event.type,
                          message: `Replay owner mismatch for aggregate ${aggregateID}: expected ${row.ownerID}, got ${input.ownerID ?? "none"}`,
                        }),
                      )
                    }
                    if (input && input.seq <= latest) {
                      const stored = yield* db
                        .select()
                        .from(EventTable)
                        .where(and(eq(EventTable.aggregate_id, aggregateID), eq(EventTable.seq, input.seq)))
                        .get()
                        .pipe(Effect.orDie)
                      if (
                        stored?.id === event.id &&
                        stored.type === versionedType(definition.type, durable.version) &&
                        isDeepStrictEqual(stored.data, encoded) &&
                        stored.batch_id === (batch?.id ?? null) &&
                        stored.batch_index === (batch?.index ?? null) &&
                        stored.batch_size === (batch?.size ?? null)
                      ) {
                        if (input.ownerID && row?.ownerID == null) {
                          yield* db
                            .update(EventSequenceTable)
                            .set({ owner_id: input.ownerID })
                            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                            .run()
                            .pipe(Effect.orDie)
                        }
                        return
                      }
                      yield* Effect.die(
                        new InvalidDurableEventError({
                          type: event.type,
                          message: `Replay diverged at aggregate ${aggregateID} sequence ${input.seq}`,
                        }),
                      )
                    }
                    if (input && row?.ownerID && row.ownerID !== input.ownerID) {
                      return
                    }
                    const seq = input?.seq ?? latest + 1
                    if (input && seq !== latest + 1) {
                      yield* Effect.die(
                        new InvalidDurableEventError({
                          type: event.type,
                          message: `Sequence mismatch for aggregate ${aggregateID}: expected ${latest + 1}, got ${seq}`,
                        }),
                      )
                    }
                    const stored = yield* db
                      .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
                      .from(EventTable)
                      .where(eq(EventTable.id, event.id))
                      .get()
                      .pipe(Effect.orDie)
                    if (stored)
                      yield* Effect.die(
                        new InvalidDurableEventError({
                          type: event.type,
                          message: `Event ${event.id} already exists at aggregate ${stored.aggregateID} sequence ${stored.seq}`,
                        }),
                      )
                    const committed = {
                      ...event,
                      durable: {
                        aggregateID,
                        seq,
                        version: durable.version,
                        ...(input ? { replay: true } : {}),
                        ...(related?.length
                          ? {
                              related: related.map((item) => ({
                                type: item.definition.type,
                                data: item.data,
                              })),
                            }
                          : {}),
                        ...(batch ? { batch } : {}),
                      },
                    } as Payload
                    for (const projector of list) {
                      yield* projector(committed)
                    }
                    if (commit) yield* commit(seq)
                    yield* db
                      .insert(EventSequenceTable)
                      .values([{ aggregate_id: aggregateID, seq, owner_id: input?.ownerID }])
                      .onConflictDoUpdate({
                        target: EventSequenceTable.aggregate_id,
                        set: {
                          seq,
                          ...(input?.ownerID && row?.ownerID == null ? { owner_id: input.ownerID } : {}),
                        },
                      })
                      .run()
                      .pipe(Effect.orDie)
                    yield* db
                      .insert(EventTable)
                      .values([
                        {
                          id: event.id,
                          aggregate_id: aggregateID,
                          seq,
                          batch_id: batch?.id,
                          batch_index: batch?.index,
                          batch_size: batch?.size,
                          type: versionedType(definition.type, durable.version),
                          data: encoded,
                        },
                      ])
                      .run()
                      .pipe(Effect.orDie)
                    const relatedBatch = related ?? []
                    const relatedEvents = yield* Effect.forEach(relatedBatch, (item, index) =>
                      commitRelatedEvent(item, event, relatedBatch, {
                        id: batch?.id ?? event.id,
                        index: index + 1,
                        size: batch?.size ?? relatedBatch.length + 1,
                      }),
                    )
                    return { aggregateID, seq, relatedEvents }
                  })
                  const committed = withinTransaction
                    ? yield* operation
                    : yield* db.transaction(() => operation, { behavior: "immediate" }).pipe(Effect.orDie)
                  if (committed && !withinTransaction) {
                    const aggregates = new Set([
                      committed.aggregateID,
                      ...committed.relatedEvents.map((event) => event.durable!.aggregateID),
                    ])
                    yield* Effect.forEach(aggregates, (aggregate) =>
                      Effect.forEach(pubsub.durable.get(aggregate) ?? [], (wake) => PubSub.publish(wake, undefined), {
                        discard: true,
                      }),
                    )
                  }
                  return committed
                }),
              )
            }
          }
        })
      }

      function publishEvent<D extends Definition>(definition: D, event: Payload<D>, options?: PublishOptions) {
        return Effect.gen(function* () {
          if (!definition?.durable && (options?.commit || options?.related?.length))
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: "Local commit hooks require a durable event",
              }),
            )
          if (definition?.durable) {
            const batch = { id: event.id, index: 0, size: (options?.related?.length ?? 0) + 1 }
            const committed = yield* commitDurableEvent(
              definition,
              event as Payload,
              undefined,
              options?.commit,
              options?.related,
              batch,
            )
            if (committed) {
              event = {
                ...event,
                durable: {
                  aggregateID: committed.aggregateID,
                  seq: committed.seq,
                  version: definition.durable.version,
                  batch,
                  ...(options?.related?.length
                    ? {
                        related: [
                          { type: event.type, data: event.data },
                          ...options.related.map((item) => ({ type: item.definition.type, data: item.data })),
                        ],
                      }
                    : {}),
                },
              }
              yield* notifyCommitted([event as Payload, ...committed.relatedEvents])
              return event
            }
          }
          yield* notify(event as Payload, false)
          return event
        })
      }

      const observe = (event: Payload, observer: (event: Payload) => Effect.Effect<void>) =>
        Effect.suspend(() => observer(event)).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logError("Event listener failed", { eventID: event.id, eventType: event.type, cause }),
          ),
        )

      function notify(event: Payload, isolateListeners: boolean) {
        return Effect.gen(function* () {
          yield* Effect.forEach(
            listeners,
            (listener) => (isolateListeners ? observe(event, listener) : listener(event)),
            { discard: true },
          )
          const typed = pubsub.typed.get(event.type)
          if (typed) yield* PubSub.publish(typed, event)
          yield* PubSub.publish(pubsub.all, event)
        })
      }

      function notifyCommitted(events: Payload[]) {
        return Effect.gen(function* () {
          const done = yield* Deferred.make<Exit.Exit<void>>()
          const inNotificationDrain = yield* InNotificationDrain
          notificationQueue.push({ events, done })
          if (notificationDraining) {
            if (inNotificationDrain) return
            const result = yield* Deferred.await(done)
            if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
            return
          }
          notificationDraining = true
          return yield* Effect.gen(function* () {
            while (notificationQueue.length > 0) {
              const current = notificationQueue.shift()!
              const result = yield* Effect.forEach(current.events, (event) => notify(event, true), {
                discard: true,
              }).pipe(Effect.exit)
              yield* Deferred.succeed(current.done, result)
              if (Exit.isFailure(result)) {
                const pending = notificationQueue.splice(0)
                yield* Effect.forEach(pending, (item) => Deferred.succeed(item.done, result), { discard: true })
                return yield* Effect.failCause(result.cause)
              }
            }
          }).pipe(
            Effect.provideService(InNotificationDrain, true),
            Effect.ensuring(Effect.sync(() => void (notificationDraining = false))),
          )
        })
      }

      function publish<D extends Definition>(definition: D, data: Data<D>, options?: PublishOptions) {
        return Effect.gen(function* () {
          const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
          const location =
            options?.location ??
            (serviceLocation
              ? { directory: serviceLocation.directory, workspaceID: serviceLocation.workspaceID }
              : undefined)
          return yield* publishEvent(
            definition,
            {
              id: options?.id ?? ID.create(),
              ...(options?.metadata ? { metadata: options.metadata } : {}),
              type: definition.type,
              ...(location ? { location } : {}),
              data,
            } as Payload<D>,
            options,
          )
        })
      }

      function replay(
        event: SerializedEvent,
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const batch = yield* Effect.try({
            try: () => serializedBatch(event),
            catch: (error) =>
              error instanceof InvalidReplayBatchError
                ? error
                : replayBatchError("invalid_batch", `Event ${event.id} has invalid batch metadata`),
          })
          if (batch && batch.size > 1) {
            return yield* Effect.fail(
              replayBatchError("incomplete_batch", `Batch ${batch.id} requires replayBatches`, batch.id),
            )
          }
          const definition = Durable.get(event.type)
          if (!definition?.durable) {
            yield* Effect.die(
              new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` }),
            )
          } else {
            const payload = {
              id: event.id,
              type: definition.type,
              data: Schema.decodeUnknownSync(definition.data)(event.data),
            } as Payload
            const committed = yield* commitDurableEvent(
              definition,
              payload,
              {
                seq: event.seq,
                aggregateID: event.aggregateID,
                ownerID: options?.ownerID,
                strictOwner: options?.strictOwner,
              },
              undefined,
              undefined,
              batch,
            )
            if (committed && options?.publish) {
              yield* notifyCommitted([
                {
                  ...payload,
                  durable: {
                    aggregateID: committed.aggregateID,
                    seq: committed.seq,
                    version: definition.durable.version,
                    replay: true,
                    ...(batch ? { batch } : {}),
                  },
                },
              ])
            }
          }
        }).pipe(Effect.orDie)
      }

      function replayBatches(
        input: SerializedEvent[],
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const batches = yield* Effect.try({
            try: () => decodeReplayBatches(input),
            catch: (error) =>
              error instanceof InvalidReplayBatchError
                ? error
                : replayBatchError("invalid_batch", "Replay batch validation failed"),
          })
          const exact = [] as typeof batches
          const pending = [] as typeof batches
          for (const batch of batches) {
            let exactMembers = 0
            for (const member of batch.members) {
              const storedID = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.id, member.event.id))
                .get()
                .pipe(Effect.orDie)
              const storedPosition = yield* db
                .select()
                .from(EventTable)
                .where(and(eq(EventTable.aggregate_id, member.event.aggregateID), eq(EventTable.seq, member.event.seq)))
                .get()
                .pipe(Effect.orDie)
              const matches =
                storedID?.id === member.event.id &&
                storedPosition?.id === member.event.id &&
                storedID.aggregate_id === member.event.aggregateID &&
                storedID.seq === member.event.seq &&
                storedID.type === member.event.type &&
                isDeepStrictEqual(storedID.data, member.event.data) &&
                storedID.batch_id === (member.batch?.id ?? null) &&
                storedID.batch_index === (member.batch?.index ?? null) &&
                storedID.batch_size === (member.batch?.size ?? null)
              if (matches) {
                exactMembers++
                continue
              }
              if (storedID || storedPosition) {
                return yield* Effect.fail(
                  replayBatchError("divergent_batch", `Batch ${batch.id} diverges from stored history`, batch.id),
                )
              }
            }
            if (exactMembers === batch.members.length) {
              exact.push(batch)
              continue
            }
            if (exactMembers > 0) {
              return yield* Effect.fail(
                replayBatchError("partial_batch", `Batch ${batch.id} is only partially stored`, batch.id),
              )
            }
            pending.push(batch)
          }

          const aggregateIDs = Array.from(
            new Set(batches.flatMap((batch) => batch.members.map((member) => member.event.aggregateID))),
          )
          const states = new Map(
            yield* Effect.forEach(aggregateIDs, (aggregateID) =>
              db
                .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                .get()
                .pipe(
                  Effect.orDie,
                  Effect.map((row) => [aggregateID, row] as const),
                ),
            ),
          )
          const replayOwnerID = options?.ownerID
          const claims = new Set<string>()
          for (const batch of exact) {
            for (const aggregateID of new Set(batch.members.map((member) => member.event.aggregateID))) {
              const row = states.get(aggregateID)
              if (options?.strictOwner && row?.ownerID && row.ownerID !== replayOwnerID) {
                return yield* Effect.fail(
                  replayBatchError("owner_mismatch", `Replay owner mismatch for aggregate ${aggregateID}`, batch.id),
                )
              }
              if (replayOwnerID && row?.ownerID == null) claims.add(aggregateID)
            }
          }
          for (const batch of pending) {
            for (const aggregateID of new Set(batch.members.map((member) => member.event.aggregateID))) {
              const row = states.get(aggregateID)
              if (row?.ownerID && row.ownerID !== replayOwnerID) {
                return yield* Effect.fail(
                  replayBatchError("owner_mismatch", `Replay owner mismatch for aggregate ${aggregateID}`, batch.id),
                )
              }
            }
          }

          const planned = [] as typeof batches
          const waiting = [...pending]
          const sequences = new Map(
            aggregateIDs.map((aggregateID) => [aggregateID, states.get(aggregateID)?.seq ?? -1]),
          )
          while (waiting.length > 0) {
            let readyIndex = -1
            for (const [index, batch] of waiting.entries()) {
              const byAggregate = Map.groupBy(batch.members, (member) => member.event.aggregateID)
              let ready = true
              for (const [aggregateID, members] of byAggregate) {
                const memberSequences = members.map((member) => member.event.seq).sort((left, right) => left - right)
                if (
                  memberSequences[0] !== (sequences.get(aggregateID) ?? -1) + 1 ||
                  memberSequences.some((sequence, memberIndex) => sequence !== memberSequences[0]! + memberIndex)
                ) {
                  ready = false
                  break
                }
              }
              if (!ready) continue
              for (const [aggregateID, members] of byAggregate) {
                sequences.set(aggregateID, Math.max(...members.map((member) => member.event.seq)))
              }
              planned.push(batch)
              readyIndex = index
              break
            }
            if (readyIndex < 0) {
              return yield* Effect.fail(
                replayBatchError("deadlock", "Replay batches cannot satisfy their aggregate sequence prerequisites"),
              )
            }
            waiting.splice(readyIndex, 1)
          }

          const committed = yield* db
            .transaction(
              () =>
                Effect.gen(function* () {
                  if (claims.size > 0 && replayOwnerID === undefined) {
                    return yield* Effect.die("Replay owner claim lost its owner ID")
                  }
                  for (const aggregateID of claims) {
                    const claimed = yield* db
                      .update(EventSequenceTable)
                      .set({ owner_id: replayOwnerID })
                      .where(and(eq(EventSequenceTable.aggregate_id, aggregateID), isNull(EventSequenceTable.owner_id)))
                      .returning({ aggregateID: EventSequenceTable.aggregate_id })
                      .get()
                      .pipe(Effect.orDie)
                    if (claimed) continue
                    const current = yield* db
                      .select({ ownerID: EventSequenceTable.owner_id })
                      .from(EventSequenceTable)
                      .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                      .get()
                      .pipe(Effect.orDie)
                    if (current?.ownerID === replayOwnerID) continue
                    return yield* Effect.fail(
                      replayBatchError("owner_mismatch", `Replay owner mismatch for aggregate ${aggregateID}`),
                    )
                  }
                  return yield* Effect.forEach(planned, (batch) =>
                    Effect.gen(function* () {
                      const [primary, ...relatedMembers] = batch.members
                      const definition = Durable.get(primary!.event.type)
                      if (!definition?.durable) {
                        return yield* Effect.fail(
                          replayBatchError(
                            "invalid_batch",
                            `Unknown durable event type ${primary!.event.type}`,
                            batch.id,
                          ),
                        )
                      }
                      const related = relatedMembers.map((member) => ({
                        definition: Durable.get(member.event.type)!,
                        data: member.payload.data,
                        id: member.event.id,
                        replay: {
                          seq: member.event.seq,
                          aggregateID: member.event.aggregateID,
                          ownerID: options?.ownerID,
                          strictOwner: options?.strictOwner,
                        },
                      }))
                      const result = yield* commitDurableEvent(
                        definition,
                        primary!.payload,
                        {
                          seq: primary!.event.seq,
                          aggregateID: primary!.event.aggregateID,
                          ownerID: options?.ownerID,
                          strictOwner: options?.strictOwner,
                        },
                        undefined,
                        related,
                        primary!.batch,
                        true,
                      )
                      if (!result) {
                        return yield* Effect.fail(
                          replayBatchError("owner_mismatch", `Batch ${batch.id} was fenced by its owner`, batch.id),
                        )
                      }
                      return { batch, definition, primary: primary!, result }
                    }),
                  )
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.catchTag("SqlError", Effect.die))

          const committedAggregates = new Set(
            committed.flatMap((entry) => [
              entry.result.aggregateID,
              ...entry.result.relatedEvents.map((event) => event.durable!.aggregateID),
            ]),
          )
          yield* Effect.forEach(committedAggregates, (aggregateID) =>
            Effect.forEach(pubsub.durable.get(aggregateID) ?? [], (wake) => PubSub.publish(wake, undefined), {
              discard: true,
            }),
          )
          if (options?.publish) {
            yield* Effect.forEach(
              committed,
              (entry) =>
                notifyCommitted([
                  {
                    ...entry.primary.payload,
                    durable: {
                      aggregateID: entry.result.aggregateID,
                      seq: entry.result.seq,
                      version: entry.definition.durable!.version,
                      replay: true,
                      ...(entry.primary.batch ? { batch: entry.primary.batch } : {}),
                      related: entry.batch.members.map((member) => ({
                        type: member.payload.type,
                        data: member.payload.data,
                      })),
                    },
                  },
                  ...entry.result.relatedEvents,
                ]),
              { discard: true },
            )
          }
          return yield* Effect.void
        })
      }

      function replayAll(
        events: SerializedEvent[],
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          for (const event of events) {
            const batch = yield* Effect.try({
              try: () => serializedBatch(event),
              catch: (error) =>
                error instanceof InvalidReplayBatchError
                  ? error
                  : replayBatchError("invalid_batch", `Event ${event.id} has invalid batch metadata`),
            })
            if (batch && batch.size > 1) {
              return yield* Effect.fail(
                replayBatchError("incomplete_batch", `Batch ${batch.id} requires replayBatches`, batch.id),
              )
            }
          }
          const source = events[0]?.aggregateID
          if (!source) return undefined
          if (events.some((event) => event.aggregateID !== source)) {
            yield* Effect.die(
              new InvalidDurableEventError({
                type: events[0]?.type ?? "unknown",
                message: "Replay events must belong to the same aggregate",
              }),
            )
          }
          const start = events[0]?.seq ?? 0
          for (const [index, event] of events.entries()) {
            const seq = start + index
            if (event.seq !== seq) {
              yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `Replay sequence mismatch at index ${index}: expected ${seq}, got ${event.seq}`,
                }),
              )
            }
          }
          yield* replayBatches(events, options)
          return source
        })
      }

      function remove(aggregateID: string) {
        return db
          .transaction(() =>
            Effect.gen(function* () {
              yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
              yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
            }),
          )
          .pipe(Effect.orDie)
      }

      function compactTerminal<D extends Definition>(definition: D, event: Payload<D>) {
        return Effect.gen(function* () {
          const durable = definition.durable
          if (
            !durable ||
            !event.durable ||
            event.type !== definition.type ||
            event.durable.version !== durable.version
          ) {
            terminalCompactionError(definition.type, "Terminal compaction requires an exact committed durable event")
          }
          const aggregateID: unknown =
            typeof event.data === "object" && event.data !== null
              ? Reflect.get(event.data, durable.aggregate)
              : undefined
          if (typeof aggregateID !== "string" || aggregateID !== event.durable.aggregateID) {
            terminalCompactionError(definition.type, "Terminal compaction aggregate authority does not match")
          }
          const encoded = Schema.encodeUnknownSync(definition.data)(event.data)
          yield* db
            .transaction(
              () =>
                Effect.gen(function* () {
                  const retained = yield* db
                    .select()
                    .from(EventTable)
                    .where(eq(EventTable.id, event.id))
                    .get()
                    .pipe(Effect.orDie)
                  const batch = event.durable!.batch
                  if (
                    !retained ||
                    retained.aggregate_id !== aggregateID ||
                    retained.seq !== event.durable!.seq ||
                    retained.type !== versionedType(definition.type, durable.version) ||
                    !isDeepStrictEqual(retained.data, encoded) ||
                    retained.batch_id !== (batch?.id ?? null) ||
                    retained.batch_index !== (batch?.index ?? null) ||
                    retained.batch_size !== (batch?.size ?? null)
                  ) {
                    terminalCompactionError(definition.type, "Terminal compaction event does not match durable history")
                  }
                  const sequence = yield* db
                    .select({ seq: EventSequenceTable.seq })
                    .from(EventSequenceTable)
                    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                    .get()
                    .pipe(Effect.orDie)
                  if (sequence?.seq !== retained.seq) {
                    terminalCompactionError(definition.type, "Terminal compaction event is not the aggregate terminus")
                  }
                  if (
                    retained.batch_id !== null &&
                    (retained.batch_id !== retained.id || retained.batch_index !== 0 || retained.batch_size !== 1)
                  ) {
                    terminalCompactionError(
                      definition.type,
                      "Terminal compaction event must be a standalone complete batch",
                    )
                  }
                  yield* db
                    .delete(EventTable)
                    .where(
                      and(
                        eq(EventTable.aggregate_id, aggregateID),
                        lt(EventTable.seq, retained.seq),
                        isNull(EventTable.batch_id),
                      ),
                    )
                    .run()
                    .pipe(Effect.orDie)
                  while (true) {
                    const prior = yield* db
                      .select({ batchID: EventTable.batch_id })
                      .from(EventTable)
                      .where(
                        and(
                          eq(EventTable.aggregate_id, aggregateID),
                          lt(EventTable.seq, retained.seq),
                          isNotNull(EventTable.batch_id),
                        ),
                      )
                      .limit(250)
                      .all()
                      .pipe(Effect.orDie)
                    const batchIDs = [...new Set(prior.flatMap((row) => (row.batchID === null ? [] : [row.batchID])))]
                    if (batchIDs.length === 0) break
                    const summaries = yield* db
                      .select({
                        batchID: EventTable.batch_id,
                        rows: sql<number>`count(*)`,
                        indexes: sql<number>`count(${EventTable.batch_index})`,
                        distinctIndexes: sql<number>`count(distinct ${EventTable.batch_index})`,
                        sizes: sql<number>`count(${EventTable.batch_size})`,
                        minIndex: sql<number | null>`min(${EventTable.batch_index})`,
                        maxIndex: sql<number | null>`max(${EventTable.batch_index})`,
                        minSize: sql<number | null>`min(${EventTable.batch_size})`,
                        maxSize: sql<number | null>`max(${EventTable.batch_size})`,
                      })
                      .from(EventTable)
                      .where(inArray(EventTable.batch_id, batchIDs))
                      .groupBy(EventTable.batch_id)
                      .all()
                      .pipe(Effect.orDie)
                    const byBatch = new Map(summaries.map((summary) => [summary.batchID, summary] as const))
                    for (const batchID of batchIDs) {
                      const summary = byBatch.get(batchID)
                      if (
                        !summary ||
                        summary.rows < 1 ||
                        summary.indexes !== summary.rows ||
                        summary.distinctIndexes !== summary.rows ||
                        summary.sizes !== summary.rows ||
                        summary.minIndex !== 0 ||
                        summary.maxIndex !== summary.rows - 1 ||
                        summary.minSize !== summary.rows ||
                        summary.maxSize !== summary.rows
                      ) {
                        terminalCompactionError(
                          definition.type,
                          `Terminal compaction found incomplete batch ${batchID}`,
                        )
                      }
                    }
                    yield* db.delete(EventTable).where(inArray(EventTable.batch_id, batchIDs)).run().pipe(Effect.orDie)
                  }
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
        })
      }

      function claim(aggregateID: string, ownerID: string) {
        return db
          .update(EventSequenceTable)
          .set({ owner_id: ownerID })
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .run()
          .pipe(Effect.orDie)
      }

      const subscribe = <D extends Definition>(definition: D): Stream.Stream<Payload<D>> =>
        Stream.unwrap(getOrCreate(definition).pipe(Effect.map((pubsub) => Stream.fromPubSub(pubsub)))).pipe(
          Stream.map((event) => event as Payload<D>),
        )

      const streamAll = (): Stream.Stream<Payload> => Stream.fromPubSub(pubsub.all)

      const readAfter = (aggregateID: string, after: number) =>
        (options?.beforeAggregateRead?.(aggregateID) ?? Effect.void).pipe(
          Effect.andThen(
            db
              .select()
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, aggregateID), gt(EventTable.seq, after)))
              .orderBy(asc(EventTable.seq))
              .all(),
          ),
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((event) =>
              decodeSerializedEvent({
                id: event.id,
                aggregateID: event.aggregate_id,
                seq: event.seq,
                type: event.type,
                data: event.data,
                ...(event.batch_id === null
                  ? {}
                  : { batchID: event.batch_id, batchIndex: event.batch_index!, batchSize: event.batch_size! }),
              }),
            ),
          ),
        )

      const subscribeDurable = (aggregateID: string) =>
        Effect.gen(function* () {
          const wake = yield* PubSub.sliding<void>(1)
          const subscription = yield* PubSub.subscribe(wake)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const wakes = pubsub.durable.get(aggregateID) ?? new Set()
              wakes.add(wake)
              pubsub.durable.set(aggregateID, wakes)
            }),
            () =>
              Effect.sync(() => {
                const wakes = pubsub.durable.get(aggregateID)
                wakes?.delete(wake)
                if (wakes?.size === 0) pubsub.durable.delete(aggregateID)
              }).pipe(Effect.andThen(PubSub.shutdown(wake))),
          )
          return subscription
        })

      const durable = (input: { readonly aggregateID: string; readonly after?: number }): Stream.Stream<Payload> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const wakes = yield* subscribeDurable(input.aggregateID)
            let sequence = input.after ?? -1
            const read = Effect.suspend(() => readAfter(input.aggregateID, sequence)).pipe(
              Effect.tap((events) =>
                Effect.sync(() => {
                  sequence = events.at(-1)?.durable?.seq ?? sequence
                }),
              ),
            )
            const historical = yield* read
            const live = Stream.fromSubscription(wakes).pipe(
              Stream.mapEffect(() => read),
              Stream.flattenIterable,
            )
            return Stream.concat(Stream.fromIterable(historical), live)
          }),
        )

      const listen = (listener: Subscriber): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          listeners.push(listener)
          return Effect.sync(() => {
            const index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          })
        })

      const project = <D extends Definition>(definition: D, projector: Subscriber<D>): Effect.Effect<void> =>
        Effect.sync(() => {
          const list = projectors.get(definition.type) ?? []
          list.push((event) => projector(event as Payload<D>))
          projectors.set(definition.type, list)
        })

      return Service.of({
        publish,
        subscribe,
        all: streamAll,
        durable,
        listen,
        project,
        replay,
        replayAll,
        replayBatches,
        latestSequence: (aggregateID) => latestSequence(db, aggregateID),
        compactTerminal,
        remove,
        claim,
      })
    }),
  )

const layer = layerWith()
export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Database.node] })
