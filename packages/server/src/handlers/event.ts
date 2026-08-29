import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"

const subscriberCapacity = 256

export function publicSessionEvent(
  event: { readonly durable?: { readonly aggregateID: string }; readonly data?: unknown },
  sessions: Pick<SessionV2.Interface, "get">,
) {
  const durableID = event.durable?.aggregateID
  const data = typeof event.data === "object" && event.data !== null ? (event.data as Record<string, unknown>) : undefined
  const sessionID =
    durableID !== undefined
      ? Schema.is(SessionV2.ID)(durableID)
        ? durableID
        : undefined
      : Schema.is(SessionV2.ID)(data?.sessionID)
        ? data.sessionID
        : undefined
  if (sessionID === undefined) return Effect.succeed(true)
  return sessions.get(sessionID).pipe(
    Effect.as(true),
    Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)),
  )
}

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(Schema.encodeUnknownSync(OpenCodeEvent)(data)),
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const sessions = yield* SessionV2.Service
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          data: {},
        }
        const output = Stream.unwrap(
          Effect.gen(function* () {
            // Acquiring the bounded stream installs its listener before readiness is observable.
            const live = yield* EventV2.allBounded(events, subscriberCapacity)
            return Stream.make(connected).pipe(
              Stream.concat(live.pipe(Stream.filterEffect((event) => publicSessionEvent(event, sessions)))),
            )
          }),
        ).pipe(Stream.map(eventData), Stream.pipeThroughChannel(Sse.encode()))
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
