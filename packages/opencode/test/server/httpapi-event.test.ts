import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { createRoutes } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, makeHttpApiLayer, requestInDirectory } from "./httpapi-layer"

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})
const SessionBody = Schema.Struct({ id: Schema.String })
const AdmissionBody = Schema.Struct({
  data: Schema.Struct({
    workflow: Schema.Struct({ id: Schema.String, sessionID: Schema.String }),
    response: Schema.Struct({ id: Schema.String }),
  }),
})

type EventReader = {
  readonly chunks: Queue.Dequeue<Uint8Array>
  readonly decoder: TextDecoder
  buffer: string
}

const readEvent = (reader: EventReader) =>
  Effect.gen(function* () {
    while (true) {
      const boundary = reader.buffer.indexOf("\n\n")
      if (boundary >= 0) {
        const frame = reader.buffer.slice(0, boundary)
        reader.buffer = reader.buffer.slice(boundary + 2)
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6)
        if (data !== undefined) return Schema.decodeUnknownSync(EventData)(JSON.parse(data))
        continue
      }
      const value = yield* Queue.take(reader.chunks).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("timed out waiting for event")),
        }),
      )
      reader.buffer += reader.decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n")
    }
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader: { chunks: reader, decoder: new TextDecoder(), buffer: "" } satisfies EventReader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)
const noWorkflowExecution = makeGlobalNode({
  service: WorkflowExecution.Service,
  layer: WorkflowExecution.noopLayer,
  deps: [],
})
const admissionIt = testEffect(makeHttpApiLayer(createRoutes(undefined, { workflowExecution: noWorkflowExecution })))

describe("event HttpApi", () => {
  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.headers["cache-control"]).toBe("no-cache, no-transform")
        expect(response.headers["x-accel-buffering"]).toBe("no")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: false, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Queue.take(reader.chunks).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: false, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "session.created" })
      }),
    { git: false, config: { formatter: false, lsp: false } },
  )

  admissionIt.instance(
    "hides a complete workflow Session batch without reordering ordinary public events",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const before = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(before.status).toBe(200)
        const beforeBody = Schema.decodeUnknownSync(SessionBody)(yield* before.json)
        expect(yield* readEvent(reader)).toMatchObject({
          type: "session.created",
          properties: { sessionID: beforeBody.id },
        })

        const admitted = yield* requestInDirectory("/api/workflow/visual-build", directory, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "legacy-event-hidden-admission" },
          body: JSON.stringify({
            prompt: "HIDDEN_VISUAL_BUILD_RECEIPT_SENTINEL",
            budget: { maxAttempts: 2, maxTokens: 2_000, maxTurns: 4, maxToolCalls: 8 },
            visual: { maxRevisions: 1, maxTokens: 1_000, maxTurns: 2, maxToolCalls: 4 },
            preview: { kind: "static", entrypoint: "index.html" },
            delivery: "background",
          }),
        })
        expect(admitted.status).toBe(200)
        const admission = Schema.decodeUnknownSync(AdmissionBody)(yield* admitted.json)

        const after = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(after.status).toBe(200)
        const afterBody = Schema.decodeUnknownSync(SessionBody)(yield* after.json)
        const observed: Array<Schema.Schema.Type<typeof EventData>> = []
        while (observed.length < 512) {
          const event = yield* readEvent(reader)
          observed.push(event)
          if (event.type === "session.created" && event.properties.sessionID === afterBody.id) break
        }
        expect(observed.at(-1)).toMatchObject({
          type: "session.created",
          properties: { sessionID: afterBody.id },
        })
        const serialized = JSON.stringify(observed)
        expect(serialized).not.toContain("HIDDEN_VISUAL_BUILD_RECEIPT_SENTINEL")
        expect(serialized).not.toContain(admission.data.workflow.id)
        expect(serialized).not.toContain(admission.data.workflow.sessionID)
        expect(serialized).not.toContain(admission.data.response.id)
      }),
    {
      git: false,
      config: { formatter: false, lsp: false },
      init: (directory) => Effect.promise(() => fs.writeFile(path.join(directory, "index.html"), "ready")),
    },
    20_000,
  )
})
