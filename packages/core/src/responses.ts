export * as ResponsesV2 from "./responses"

import { Cause, Context, DateTime, Effect, Layer, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Responses } from "@opencode-ai/schema/responses"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { ResponsesProjector } from "./responses/projector"
import { ResponsesStore } from "./responses/store"
import { WorkflowSecretGuard } from "./workflow/secret-guard"

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

export interface Interface {
  readonly create: (input: Responses.CreateInput) => Effect.Effect<Responses.Resource, ServiceError>
  readonly list: () => Effect.Effect<Responses.Resource[]>
  readonly get: (responseID: Responses.ID) => Effect.Effect<Responses.Resource, NotFoundError>
  readonly findByRequestHash: (requestHash: string) => Effect.Effect<Responses.Resource | undefined>
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
    ) {
      return Effect.gen(function* () {
        yield* guardSafe(input)
        const resource = yield* requireResponse(input.responseID)
        const timestamp = yield* DateTime.now
        const value = terminal(resource, status, timestamp, input)
        const persistPayload = resource.store
        const related =
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
        const publishOptions = related.length > 0 ? { related } : undefined
        if (status === "completed") {
          yield* mapConflict(
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
          yield* mapConflict(
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
          yield* mapConflict(
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
          yield* mapConflict(
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
              context,
              input: input.input,
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
        if (reconciled) return reconciled
        return admitted
      }),

      list: () => store.list(),

      get: Effect.fn("Responses.get")(function* (responseID) {
        return yield* requireResponse(responseID)
      }),

      findByRequestHash: Effect.fn("Responses.findByRequestHash")(function* (requestHash) {
        return yield* store.request(requestHash)
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
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [EventV2.node, ResponsesProjector.node, ResponsesStore.node],
})
