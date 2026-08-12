export * as ResponsesV2 from "./responses"

import { Cause, Context, DateTime, Deferred, Effect, Layer, Schema } from "effect"
import * as Semaphore from "effect/Semaphore"
import { isDeepStrictEqual } from "node:util"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { ResponsesProjector } from "./responses/projector"
import { ResponsesStore } from "./responses/store"
import { WorkflowSecretGuard } from "./workflow/secret-guard"

export const ID = Responses.ID

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Responses.NotFoundError", {
  responseID: Responses.ID,
}) {}

export class ConversationNotFoundError extends Schema.TaggedErrorClass<ConversationNotFoundError>()(
  "Responses.ConversationNotFoundError",
  { conversationID: Responses.ConversationID },
) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("Responses.ConflictError", {
  resourceID: Schema.String,
  operation: Schema.String,
}) {}

type ServiceError = ConflictError | WorkflowSecretGuard.UnsafePersistenceError

export interface TransientLease {
  readonly await: Effect.Effect<{ readonly resource: Responses.Resource; readonly sequenceNumber: number }>
  readonly release: Effect.Effect<void>
}

type TransientSettlement = {
  readonly status: Extract<Responses.Status, "completed" | "incomplete" | "failed" | "cancelled">
  readonly timestamp: DateTime.Utc
  readonly sequenceNumber?: number
  readonly output?: ReadonlyArray<Responses.ItemPayload>
  readonly error?: Responses.Error
  readonly usage?: Responses.Usage
  readonly requestHash?: string
}

export interface Interface {
  readonly create: (input: Responses.CreateInput) => Effect.Effect<Responses.Resource, ServiceError>
  readonly list: () => Effect.Effect<Responses.Resource[]>
  readonly get: (responseID: Responses.ID) => Effect.Effect<Responses.Resource, NotFoundError>
  readonly findByRequestHash: (requestHash: string) => Effect.Effect<Responses.Resource | undefined>
  readonly activeByWorkflowID: (workflowID: Workflow.ID) => Effect.Effect<Responses.Resource[]>
  readonly inputItems: (responseID: Responses.ID) => Effect.Effect<Responses.ResponseItem[], NotFoundError>
  readonly contextItems: (responseID: Responses.ID) => Effect.Effect<Responses.ItemPayload[], NotFoundError>
  readonly start: (responseID: Responses.ID) => Effect.Effect<Responses.Resource, NotFoundError | ConflictError>
  readonly complete: (input: {
    readonly responseID: Responses.ID
    readonly output: ReadonlyArray<Responses.ItemPayload>
    readonly usage?: Responses.Usage
  }) => Effect.Effect<Responses.Resource, NotFoundError | ServiceError>
  readonly incomplete: (input: {
    readonly responseID: Responses.ID
    readonly output?: ReadonlyArray<Responses.ItemPayload>
    readonly error?: Responses.Error
    readonly usage?: Responses.Usage
  }) => Effect.Effect<Responses.Resource, NotFoundError | ServiceError>
  readonly fail: (input: {
    readonly responseID: Responses.ID
    readonly error: Responses.Error
    readonly usage?: Responses.Usage
  }) => Effect.Effect<Responses.Resource, NotFoundError | ServiceError>
  readonly cancel: (input: {
    readonly responseID: Responses.ID
    readonly error?: Responses.Error
    readonly usage?: Responses.Usage
  }) => Effect.Effect<Responses.Resource, NotFoundError | ServiceError>
  readonly cancelWorkflow: (input: {
    readonly responseID: Responses.ID
    readonly error?: Responses.Error
    readonly usage?: Responses.Usage
  }) => Effect.Effect<Responses.Resource, NotFoundError | ServiceError>
  readonly delete: (responseID: Responses.ID) => Effect.Effect<void, NotFoundError | ConflictError>
  readonly createConversation: (
    input: Responses.ConversationCreateInput,
  ) => Effect.Effect<Responses.Conversation, ServiceError>
  readonly getConversation: (
    conversationID: Responses.ConversationID,
  ) => Effect.Effect<Responses.Conversation, ConversationNotFoundError>
  readonly appendConversationItem: (
    input: Responses.ConversationAppendInput,
  ) => Effect.Effect<Responses.Conversation, ConversationNotFoundError | ServiceError>
  readonly conversationItems: (
    conversationID: Responses.ConversationID,
  ) => Effect.Effect<Responses.ConversationItem[], ConversationNotFoundError>
  readonly deleteConversation: (
    conversationID: Responses.ConversationID,
  ) => Effect.Effect<void, ConversationNotFoundError | ConflictError>
  readonly acquireTransient: (input: {
    readonly requestHash: string
    readonly responseID: Responses.ID
  }) => Effect.Effect<TransientLease>
  readonly registerTransient: (resource: Responses.Resource) => Effect.Effect<void>
  readonly settleTransient: (input: TransientSettlement & { readonly responseID: Responses.ID }) => Effect.Effect<void>
  readonly transientInput: (responseID: Responses.ID) => Effect.Effect<ReadonlyArray<Responses.ItemPayload> | undefined>
  readonly saveTransientContinuation: (
    responseID: Responses.ID,
    continuation: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>
  readonly transientContinuation: (
    responseID: Responses.ID,
  ) => Effect.Effect<Readonly<Record<string, unknown>> | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Responses") {}

function guardSafe(value: unknown) {
  return Effect.try({
    try: () => WorkflowSecretGuard.assertSafe(value),
    catch: (error) =>
      error instanceof WorkflowSecretGuard.UnsafePersistenceError
        ? error
        : new WorkflowSecretGuard.UnsafePersistenceError({
            path: "$",
            message: "Persistence value could not be inspected safely",
          }),
  })
}

function mapConflict<A>(effect: Effect.Effect<A>, resourceID: string, operation: string) {
  return effect.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause)
      if (
        error instanceof ResponsesProjector.LifecycleConflict ||
        error instanceof ResponsesProjector.ConversationConflict
      ) {
        return Effect.fail(new ConflictError({ resourceID, operation }))
      }
      return Effect.failCause(cause)
    }),
  )
}

function terminal(
  resource: Responses.Resource,
  status: Extract<Responses.Status, "completed" | "incomplete" | "failed" | "cancelled">,
  timestamp: DateTime.Utc,
  input: {
    readonly output?: ReadonlyArray<Responses.ItemPayload>
    readonly error?: Responses.Error
    readonly usage?: Responses.Usage
  },
): Responses.Resource {
  return {
    ...resource,
    status,
    output: [...(input.output ?? [])],
    error: input.error,
    usage: input.usage,
    completedAt: timestamp,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const store = yield* ResponsesStore.Service
    const transient = new Map<
      string,
      {
        readonly requestHash: string
        readonly responseIDs: Set<Responses.ID>
        resource?: Responses.Resource
        settlement?: TransientSettlement & { readonly sequenceNumber: number }
        readonly deferred: Deferred.Deferred<{
          readonly resource: Responses.Resource
          readonly sequenceNumber: number
        }>
        refs: number
      }
    >()
    type TransientEntry = typeof transient extends Map<string, infer A> ? A : never
    type TransientPrivate = {
      readonly requestHash: string
      input: ReadonlyArray<Responses.ItemPayload>
      responseID?: Responses.ID
      continuation?: Readonly<Record<string, unknown>>
    }
    const transientPrivate = new Map<string, TransientPrivate>()
    const transientByResponseID = new Map<Responses.ID, Set<TransientEntry>>()
    const transientLock = yield* Semaphore.make(1)

    const bindTransientID = (responseID: Responses.ID, entry: TransientEntry) => {
      const owners = transientByResponseID.get(responseID) ?? new Set<TransientEntry>()
      owners.add(entry)
      transientByResponseID.set(responseID, owners)
    }

    const unbindTransient = (entry: TransientEntry) => {
      for (const responseID of entry.responseIDs) {
        const owners = transientByResponseID.get(responseID)
        if (!owners) continue
        owners.delete(entry)
        if (owners.size === 0) transientByResponseID.delete(responseID)
      }
    }

    const acquireTransient = Effect.fn("Responses.acquireTransient")(function* (input: {
      readonly requestHash: string
      readonly responseID: Responses.ID
    }) {
      const pending = yield* transientLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = transient.get(input.requestHash)
          if (existing) {
            existing.refs++
            existing.responseIDs.add(input.responseID)
            bindTransientID(input.responseID, existing)
            return existing
          }
          const created: TransientEntry = {
            requestHash: input.requestHash,
            responseIDs: new Set([input.responseID]),
            deferred: yield* Deferred.make<{
              readonly resource: Responses.Resource
              readonly sequenceNumber: number
            }>(),
            refs: 1,
          }
          transient.set(input.requestHash, created)
          bindTransientID(input.responseID, created)
          return created
        }),
      )
      let released = false
      return {
        await: Deferred.await(pending.deferred),
        release: transientLock.withPermits(1)(
          Effect.sync(() => {
            if (released) return
            released = true
            if (transient.get(input.requestHash) !== pending) return
            pending.refs--
            if (pending.refs !== 0) return
            transient.delete(input.requestHash)
            unbindTransient(pending)
            if (!pending.resource) transientPrivate.delete(input.requestHash)
          }),
        ),
      } satisfies TransientLease
    })

    const registerTransient = Effect.fn("Responses.registerTransient")(function* (resource: Responses.Resource) {
      if (resource.store) return
      yield* transientLock.withPermits(1)(
        Effect.gen(function* () {
          const pending = transient.get(resource.requestHash)
          if (!pending) return
          pending.responseIDs.add(resource.id)
          bindTransientID(resource.id, pending)
          pending.resource = resource
          const privateState = transientPrivate.get(resource.requestHash)
          if (privateState) privateState.responseID = resource.id
          if (!pending.settlement) return
          transient.delete(resource.requestHash)
          unbindTransient(pending)
          transientPrivate.delete(resource.requestHash)
          yield* Deferred.succeed(pending.deferred, {
            resource: terminal(resource, pending.settlement.status, pending.settlement.timestamp, pending.settlement),
            sequenceNumber: pending.settlement.sequenceNumber,
          })
        }),
      )
    })

    const settleTransient = Effect.fn("Responses.settleTransient")(function* (
      input: TransientSettlement & { readonly responseID: Responses.ID },
    ) {
      yield* Effect.uninterruptible(
        transientLock.withPermits(1)(
          Effect.gen(function* () {
            const owners = transientByResponseID.get(input.responseID)
            const requestOwner = input.requestHash ? transient.get(input.requestHash) : undefined
            const pending =
              requestOwner?.responseIDs.has(input.responseID) === true
                ? requestOwner
                : owners
                  ? (Array.from(owners).find((entry) => entry.resource?.id === input.responseID) ??
                    (owners.size === 1 ? owners.values().next().value : undefined))
                  : undefined
            if (!pending) {
              if (input.requestHash) transientPrivate.delete(input.requestHash)
              return
            }
            const sequenceNumber = input.sequenceNumber ?? (yield* events.latestSequence(input.responseID))
            if (!pending.resource) {
              pending.settlement = { ...input, sequenceNumber }
              return
            }
            transient.delete(pending.requestHash)
            unbindTransient(pending)
            transientPrivate.delete(pending.requestHash)
            yield* Deferred.succeed(pending.deferred, {
              resource: terminal(pending.resource, input.status, input.timestamp, input),
              sequenceNumber,
            })
          }),
        ),
      )
    })

    const privateForResponse = (responseID: Responses.ID) =>
      Array.from(transientPrivate.values()).find((state) => state.responseID === responseID)

    const transientInput = Effect.fn("Responses.transientInput")((responseID: Responses.ID) =>
      transientLock.withPermits(1)(
        Effect.sync(() => {
          const state = privateForResponse(responseID)
          return state ? [...state.input] : undefined
        }),
      ),
    )

    const saveTransientContinuation = Effect.fn("Responses.saveTransientContinuation")(
      (responseID: Responses.ID, continuation: Readonly<Record<string, unknown>>) =>
        transientLock.withPermits(1)(
          Effect.sync(() => {
            const state = privateForResponse(responseID)
            if (state) state.continuation = continuation
          }),
        ),
    )

    const transientContinuation = Effect.fn("Responses.transientContinuation")((responseID: Responses.ID) =>
      transientLock.withPermits(1)(Effect.sync(() => privateForResponse(responseID)?.continuation)),
    )

    function requireResponse(responseID: Responses.ID) {
      return Effect.gen(function* () {
        const resource = yield* store.get(responseID)
        if (!resource) return yield* new NotFoundError({ responseID })
        return resource
      })
    }

    function requireConversation(conversationID: Responses.ConversationID) {
      return Effect.gen(function* () {
        const conversation = yield* store.conversation(conversationID)
        if (!conversation) return yield* new ConversationNotFoundError({ conversationID })
        return conversation
      })
    }

    function matchesCreate(existing: Responses.Resource, input: Responses.CreateInput) {
      return Effect.gen(function* () {
        if (
          existing.workflowID !== input.workflowID ||
          existing.model !== input.model ||
          existing.background !== input.background ||
          existing.store !== input.store ||
          existing.previousResponseID !== input.previousResponseID ||
          existing.conversationID !== input.conversationID
        ) {
          return false
        }
        if (!existing.store) {
          const state = transientPrivate.get(existing.requestHash)
          return state !== undefined && isDeepStrictEqual(state.input, input.input)
        }
        const items = yield* store.items(existing.id, "input")
        return isDeepStrictEqual(
          items.map((item) => item.payload),
          input.input,
        )
      })
    }

    function collectContext(responseID: Responses.ID): Effect.Effect<Responses.ItemPayload[], NotFoundError> {
      return Effect.gen(function* () {
        yield* requireResponse(responseID)
        const current = yield* store.items(responseID)
        return current.filter((item) => item.kind === "context" || item.kind === "input").map((item) => item.payload)
      })
    }

    function settle(
      status: Extract<Responses.Status, "completed" | "incomplete" | "failed" | "cancelled">,
      input: {
        readonly responseID: Responses.ID
        readonly output?: ReadonlyArray<Responses.ItemPayload>
        readonly error?: Responses.Error
        readonly usage?: Responses.Usage
      },
      cancelWorkflow = false,
    ) {
      return Effect.gen(function* () {
        yield* guardSafe(input)
        const resource = yield* requireResponse(input.responseID)
        const timestamp = yield* DateTime.now
        const value = terminal(resource, status, timestamp, input)
        const persistPayload = resource.store
        const conversationRelated =
          resource.store && resource.conversationID
            ? (input.output ?? []).map((payload) => ({
                definition: ResponseEvent.Conversation.ItemAdded,
                data: {
                  conversationID: resource.conversationID!,
                  timestamp,
                  responseID: input.responseID,
                  payload,
                },
              }))
            : []
        const related = [
          ...conversationRelated,
          ...(cancelWorkflow
            ? [
                {
                  definition: WorkflowEvent.CancelRequested,
                  data: { workflowID: resource.workflowID, timestamp },
                },
              ]
            : []),
        ]
        const publishOptions = related.length > 0 ? { related } : undefined
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            let terminalEvent: EventV2.Payload | undefined
            if (status === "completed") {
              terminalEvent = yield* mapConflict(
                events.publish(
                  ResponseEvent.Completed,
                  {
                    responseID: input.responseID,
                    timestamp,
                    output: persistPayload ? [...(input.output ?? [])] : undefined,
                    usage: persistPayload ? input.usage : undefined,
                  },
                  publishOptions,
                ),
                input.responseID,
                status,
              )
            }
            if (status === "incomplete") {
              terminalEvent = yield* mapConflict(
                events.publish(
                  ResponseEvent.Incomplete,
                  {
                    responseID: input.responseID,
                    timestamp,
                    output: persistPayload && input.output ? [...input.output] : undefined,
                    error: persistPayload ? input.error : undefined,
                    usage: persistPayload ? input.usage : undefined,
                  },
                  publishOptions,
                ),
                input.responseID,
                status,
              )
            }
            if (status === "failed") {
              terminalEvent = yield* mapConflict(
                events.publish(
                  ResponseEvent.Failed,
                  {
                    responseID: input.responseID,
                    timestamp,
                    error: persistPayload ? input.error : undefined,
                    usage: persistPayload ? input.usage : undefined,
                  },
                  publishOptions,
                ),
                input.responseID,
                status,
              )
            }
            if (status === "cancelled") {
              terminalEvent = yield* mapConflict(
                events.publish(
                  ResponseEvent.Cancelled,
                  {
                    responseID: input.responseID,
                    timestamp,
                    error: persistPayload ? input.error : undefined,
                    usage: persistPayload ? input.usage : undefined,
                  },
                  publishOptions,
                ),
                input.responseID,
                status,
              )
            }
            const sequenceNumber = terminalEvent?.durable?.seq
            if (sequenceNumber === undefined) yield* Effect.die("Terminal Response event was not durable")
            yield* settleTransient({ ...input, status, timestamp, sequenceNumber, requestHash: resource.requestHash })
          }),
        )
        return (yield* store.get(input.responseID)) ?? value
      })
    }

    return Service.of({
      create: Effect.fn("Responses.create")(function* (input) {
        yield* guardSafe(input)
        const responseID = input.id ?? Responses.ID.create()
        if (
          (input.previousResponseID && input.conversationID) ||
          (!input.store && (input.conversationID || input.background))
        ) {
          return yield* new ConflictError({ resourceID: responseID, operation: "create" })
        }
        const request = yield* store.request(input.requestHash)
        if (request) {
          if (request.deletedAt || !(yield* matchesCreate(request, input))) {
            return yield* new ConflictError({ resourceID: responseID, operation: "create" })
          }
          return request
        }
        if (input.id && (yield* store.get(input.id, true))) {
          return yield* new ConflictError({ resourceID: responseID, operation: "create" })
        }
        let context: Responses.ItemPayload[] = []
        if (input.previousResponseID) {
          const parent = yield* store.get(input.previousResponseID)
          if (!parent || !parent.store || parent.status !== "completed") {
            return yield* new ConflictError({ resourceID: responseID, operation: "create" })
          }
          context = (yield* store.items(input.previousResponseID)).map((item) => item.payload)
        }
        if (input.conversationID) {
          const conversation = yield* store.conversation(input.conversationID)
          if (!conversation) return yield* new ConflictError({ resourceID: responseID, operation: "create" })
          context = (yield* store.conversationItems(input.conversationID)).map((item) => item.payload)
        }
        if (!input.store) {
          const accepted = yield* transientLock.withPermits(1)(
            Effect.sync(() => {
              const existing = transientPrivate.get(input.requestHash)
              if (existing && !isDeepStrictEqual(existing.input, input.input)) return false
              if (!existing) {
                transientPrivate.set(input.requestHash, {
                  requestHash: input.requestHash,
                  input: [...input.input],
                  responseID,
                })
              }
              return true
            }),
          )
          if (!accepted) return yield* new ConflictError({ resourceID: responseID, operation: "create" })
        }
        const timestamp = yield* DateTime.now
        const admitted: Responses.Resource = {
          id: responseID,
          workflowID: input.workflowID,
          model: input.model,
          status: "queued",
          background: input.background,
          store: input.store,
          previousResponseID: input.previousResponseID,
          conversationID: input.conversationID,
          requestHash: input.requestHash,
          output: [],
          createdAt: timestamp,
        }
        const reconciled = yield* mapConflict(
          events.publish(
            ResponseEvent.Created,
            {
              responseID,
              workflowID: input.workflowID,
              timestamp,
              model: input.model,
              background: input.background,
              store: input.store,
              previousResponseID: input.previousResponseID,
              conversationID: input.conversationID,
              requestHash: input.requestHash,
              context: input.store ? context : [],
              input: input.store ? input.input : [{ type: "redacted" }],
            },
            {
              related: input.conversationID
                ? input.input.map((payload) => ({
                    definition: ResponseEvent.Conversation.ItemAdded,
                    data: {
                      conversationID: input.conversationID!,
                      timestamp,
                      responseID,
                      payload,
                    },
                  }))
                : undefined,
            },
          ),
          responseID,
          "create",
        ).pipe(
          Effect.as(undefined as Responses.Resource | undefined),
          Effect.catchTag("Responses.ConflictError", (error) =>
            store.request(input.requestHash).pipe(
              Effect.flatMap((winner) => {
                if (!winner || winner.deletedAt) return Effect.fail(error)
                return matchesCreate(winner, input).pipe(
                  Effect.flatMap((matches) => (matches ? Effect.succeed(winner) : Effect.fail(error))),
                )
              }),
            ),
          ),
        )
        if (reconciled) {
          const state = transientPrivate.get(input.requestHash)
          if (state) state.responseID = reconciled.id
          return reconciled
        }
        return admitted
      }),

      list: () => store.list(),

      get: Effect.fn("Responses.get")(function* (responseID) {
        return yield* requireResponse(responseID)
      }),

      findByRequestHash: Effect.fn("Responses.findByRequestHash")(function* (requestHash) {
        return yield* store.request(requestHash)
      }),

      activeByWorkflowID: Effect.fn("Responses.activeByWorkflowID")(function* (workflowID) {
        return yield* store.activeByWorkflowID(workflowID)
      }),

      inputItems: Effect.fn("Responses.inputItems")(function* (responseID) {
        yield* requireResponse(responseID)
        return yield* store.items(responseID, "input")
      }),

      contextItems: Effect.fn("Responses.contextItems")(function* (responseID) {
        return yield* collectContext(responseID)
      }),

      start: Effect.fn("Responses.start")(function* (responseID) {
        const resource = yield* requireResponse(responseID)
        const timestamp = yield* DateTime.now
        yield* mapConflict(events.publish(ResponseEvent.InProgress, { responseID, timestamp }), responseID, "start")
        return { ...resource, status: "in_progress" }
      }),

      complete: Effect.fn("Responses.complete")(function* (input) {
        return yield* settle("completed", input)
      }),

      incomplete: Effect.fn("Responses.incomplete")(function* (input) {
        return yield* settle("incomplete", input)
      }),

      fail: Effect.fn("Responses.fail")(function* (input) {
        return yield* settle("failed", input)
      }),

      cancel: Effect.fn("Responses.cancel")(function* (input) {
        return yield* settle("cancelled", input)
      }),

      cancelWorkflow: Effect.fn("Responses.cancelWorkflow")(function* (input) {
        return yield* settle("cancelled", input, true)
      }),

      delete: Effect.fn("Responses.delete")(function* (responseID) {
        yield* requireResponse(responseID)
        const timestamp = yield* DateTime.now
        yield* mapConflict(events.publish(ResponseEvent.Deleted, { responseID, timestamp }), responseID, "delete")
      }),

      createConversation: Effect.fn("Responses.createConversation")(function* (input) {
        yield* guardSafe(input)
        const conversationID = input.id ?? Responses.ConversationID.create()
        const existing = yield* store.conversation(conversationID, true)
        if (existing) {
          if (!existing.deletedAt && isDeepStrictEqual(existing.metadata, input.metadata)) return existing
          return yield* new ConflictError({ resourceID: conversationID, operation: "createConversation" })
        }
        const timestamp = yield* DateTime.now
        const created: Responses.Conversation = {
          id: conversationID,
          metadata: input.metadata,
          createdAt: timestamp,
        }
        yield* mapConflict(
          events.publish(ResponseEvent.Conversation.Created, {
            conversationID,
            timestamp,
            metadata: input.metadata,
          }),
          conversationID,
          "createConversation",
        )
        return created
      }),

      getConversation: Effect.fn("Responses.getConversation")(function* (conversationID) {
        return yield* requireConversation(conversationID)
      }),

      appendConversationItem: Effect.fn("Responses.appendConversationItem")(function* (input) {
        yield* guardSafe(input)
        const conversation = yield* requireConversation(input.conversationID)
        const timestamp = yield* DateTime.now
        yield* mapConflict(
          events.publish(ResponseEvent.Conversation.ItemAdded, {
            conversationID: input.conversationID,
            timestamp,
            responseID: input.responseID,
            payload: input.payload,
          }),
          input.conversationID,
          "appendConversationItem",
        )
        return conversation
      }),

      conversationItems: Effect.fn("Responses.conversationItems")(function* (conversationID) {
        yield* requireConversation(conversationID)
        return yield* store.conversationItems(conversationID)
      }),

      deleteConversation: Effect.fn("Responses.deleteConversation")(function* (conversationID) {
        yield* requireConversation(conversationID)
        const timestamp = yield* DateTime.now
        yield* mapConflict(
          events.publish(ResponseEvent.Conversation.Deleted, { conversationID, timestamp }),
          conversationID,
          "deleteConversation",
        )
      }),
      acquireTransient,
      registerTransient,
      settleTransient,
      transientInput,
      saveTransientContinuation,
      transientContinuation,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [EventV2.node, ResponsesProjector.node, ResponsesStore.node],
})
