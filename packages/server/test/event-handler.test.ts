import { describe, expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { PublicEventVisibility } from "@opencode-ai/core/event/public-visibility"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { ResponseTable } from "@opencode-ai/core/responses/sql"
import { AbsolutePath, DateTimeUtcFromMillis } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowRunTable } from "@opencode-ai/core/workflow/sql"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { type ApplicationServiceFactory, createEmbeddedRoutes } from "../src/routes"
import { publicSessionEvent } from "../src/handlers/event"
import { WorkflowRuntimeRecovery } from "../src/workflow/runtime-recovery"

const WorkflowStarted = EventV2.define({
  type: "workflow.started",
  durable: { version: 1, aggregate: "workflowID" },
  schema: { workflowID: WorkflowV2.ID, timestamp: DateTimeUtcFromMillis },
})
const ResponseInProgress = EventV2.define({
  type: "response.in_progress",
  durable: { version: 1, aggregate: "responseID" },
  schema: { responseID: ResponsesV2.ID, timestamp: DateTimeUtcFromMillis },
})

describe("public event route authority", () => {
  test("delivers public Workflow and Response lifecycle events while suppressing hidden owners", async () => {
    const captured: { database?: Database.Interface; events?: EventV2.Interface } = {}
    const routeGraph = createEmbeddedRoutes({ buildApplicationServices: applicationFactory(captured) })
    const web = HttpRouter.toWebHandler(routeGraph.pipe(Layer.provide(HttpServer.layerServices)), {
      disableLogger: true,
    })
    const requestServices = Context.make(
      PermissionSaved.Service,
      PermissionSaved.Service.of({
        list: () => Effect.die("unused"),
        add: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
      }),
    )
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await web.handler(new Request("http://localhost/api/event"), requestServices)
      expect(response.status).toBe(200)
      reader = response.body?.getReader()
      if (!reader) throw new Error("event route did not return a readable body")
      const sse = sseReader(reader)
      expect((await sse.next()).type).toBe("server.connected")

      if (!captured.database || !captured.events) throw new Error("event route did not acquire application authority")
      const { db } = captured.database
      const publicSessionID = SessionV2.ID.make("ses_public_event_route")
      const hiddenSessionID = SessionV2.ID.make("ses_hidden_event_route")
      const publicWorkflowID = WorkflowV2.ID.make("wfl_public_event_route")
      const hiddenWorkflowID = WorkflowV2.ID.make("wfl_hidden_event_route")
      const publicResponseID = ResponsesV2.ID.make("resp_public_event_route")
      const markerResponseID = ResponsesV2.ID.make("resp_marker_event_route")
      const hiddenResponseID = ResponsesV2.ID.make("resp_hidden_event_route")

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* db
            .insert(ProjectTable)
            .values({
              id: ProjectV2.ID.global,
              worktree: AbsolutePath.make("D:/event-route"),
              sandboxes: [],
              time_created: 1,
              time_updated: 1,
            })
            .run()
          yield* db
            .insert(SessionTable)
            .values([
              {
                id: publicSessionID,
                project_id: ProjectV2.ID.global,
                slug: publicSessionID,
                directory: AbsolutePath.make("D:/event-route"),
                title: publicSessionID,
                visibility: "public",
                version: "test",
                time_created: 1,
                time_updated: 1,
              },
              {
                id: hiddenSessionID,
                project_id: ProjectV2.ID.global,
                slug: hiddenSessionID,
                directory: AbsolutePath.make("D:/event-route"),
                title: hiddenSessionID,
                visibility: "workflow",
                version: "test",
                time_created: 1,
                time_updated: 1,
              },
            ])
            .run()
          yield* db
            .insert(WorkflowRunTable)
            .values(
              [
                [publicWorkflowID, publicSessionID],
                [hiddenWorkflowID, hiddenSessionID],
              ].map(([id, sessionID]) => ({
                id: WorkflowV2.ID.make(id),
                type: "visual-build",
                status: "queued" as const,
                input: {},
                budget: {},
                usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
                session_id: SessionV2.ID.make(sessionID),
                version: 0,
                time_created: 1,
                time_updated: 1,
              })),
            )
            .run()
          yield* db
            .insert(ResponseTable)
            .values(
              [
                [publicResponseID, publicWorkflowID],
                [markerResponseID, publicWorkflowID],
                [hiddenResponseID, hiddenWorkflowID],
              ].map(([id, workflowID]) => ({
                id: ResponsesV2.ID.make(id),
                workflow_id: WorkflowV2.ID.make(workflowID),
                model: "test",
                status: "queued" as const,
                background: true,
                store: true,
                request_hash: id,
                output: [],
                created_at: 1,
              })),
            )
            .run()
        }).pipe(Effect.orDie),
      )

      const duplicateRelated = [
        { type: "session.updated", data: { sessionID: publicSessionID } },
        { type: "workflow.created", data: { workflowID: publicWorkflowID, sessionID: publicSessionID } },
        { type: "response.created", data: { responseID: publicResponseID, workflowID: publicWorkflowID } },
        {
          type: "response.created",
          data: {
            responseID: publicResponseID,
            workflowID: publicWorkflowID,
            context: [{ type: "message", content: "HIDDEN_DUPLICATE_ROUTE_RECEIPT" }],
          },
        },
      ]
      expect(
        await Effect.runPromise(
          publicSessionEvent(
            {
              type: duplicateRelated[3].type,
              data: duplicateRelated[3].data,
              durable: {
                aggregateID: publicResponseID,
                batch: { id: "evt_duplicate_event_route", index: 3, size: duplicateRelated.length },
                related: duplicateRelated,
              },
            },
            PublicEventVisibility.databaseAuthority(db),
          ),
        ),
      ).toBe(false)

      await Effect.runPromise(
        captured.events.publish(WorkflowStarted, {
          workflowID: publicWorkflowID,
          timestamp: DateTime.makeUnsafe(2),
        }),
      )
      expect((await sse.next()).type).toBe("workflow.started")

      await Effect.runPromise(
        captured.events.publish(ResponseInProgress, {
          responseID: publicResponseID,
          timestamp: DateTime.makeUnsafe(3),
        }),
      )
      expect((await sse.next()).type).toBe("response.in_progress")

      await Effect.runPromise(
        captured.events.publish(WorkflowStarted, {
          workflowID: hiddenWorkflowID,
          timestamp: DateTime.makeUnsafe(4),
        }),
      )
      await Effect.runPromise(
        captured.events.publish(ResponseInProgress, {
          responseID: hiddenResponseID,
          timestamp: DateTime.makeUnsafe(5),
        }),
      )
      await Effect.runPromise(
        captured.events.publish(ResponseInProgress, {
          responseID: markerResponseID,
          timestamp: DateTime.makeUnsafe(6),
        }),
      )
      const marker = await sse.next()
      expect(marker.type).toBe("response.in_progress")
      expect(marker.data.responseID).toBe(markerResponseID)
    } finally {
      await reader?.cancel()
      await web.dispose()
    }
  }, 30_000)
})

function applicationFactory(captured: { database?: Database.Interface; events?: EventV2.Interface }) {
  const databaseNode = makeGlobalNode({
    service: Database.Service,
    layer: Database.layerFromPath(":memory:"),
    deps: [],
  })
  const cleanupNode = makeGlobalNode({
    name: ToolOutputStore.cleanupNode.name,
    layer: Layer.empty,
    deps: [],
  })
  const recoveryNode = makeGlobalNode({
    service: WorkflowRuntimeRecovery.Service,
    layer: Layer.succeed(
      WorkflowRuntimeRecovery.Service,
      WorkflowRuntimeRecovery.Service.of({ healthy: true, recovered: 0, skipped: 0, ready: true }),
    ),
    deps: [],
  })
  return ((services, replacements) =>
    AppNodeBuilder.build(services, [
      ...replacements,
      [Database.node, databaseNode],
      [ToolOutputStore.cleanupNode, cleanupNode],
      [WorkflowRuntimeRecovery.node, recoveryNode],
    ]).pipe(
      Layer.tap((services) =>
        Effect.sync(() => {
          captured.database = Context.get(services, Database.Service)
          captured.events = Context.get(services, EventV2.Service)
        }),
      ),
    )) satisfies ApplicationServiceFactory
}

function sseReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const payload = Schema.Struct({ type: Schema.String, data: Schema.Record(Schema.String, Schema.Unknown) })
  const decode = Schema.decodeUnknownSync(payload)
  const decoder = new TextDecoder()
  let buffer = ""
  return {
    async next() {
      while (true) {
        const boundary = buffer.indexOf("\n\n")
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data:"))
            ?.slice(5)
            .trim()
          if (data) return decode(JSON.parse(data))
          continue
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out reading SSE event")), 5_000)),
        ])
        if (chunk.done) throw new Error("event stream ended before the expected event")
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n")
      }
    },
  }
}
