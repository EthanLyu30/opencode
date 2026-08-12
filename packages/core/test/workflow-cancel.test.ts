import { describe, expect } from "bun:test"
import path from "node:path"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { ResponsesProjector } from "@opencode-ai/core/responses/projector"
import { ResponsesStore } from "@opencode-ai/core/responses/store"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Responses } from "@opencode-ai/schema/responses"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, LLMClient, Tool, ToolRuntime } from "@opencode-ai/llm"
import { eq } from "drizzle-orm"
import * as DeepSeek from "../../llm/src/providers/deepseek"
import { dynamicResponse } from "../../llm/test/lib/http"
import { tmpdir } from "./fixture/tmpdir"
import { it, testEffect } from "./lib/effect"

const projectorIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([EventV2.node, WorkflowV2.node, WorkflowStore.node])),
)

const workerOptions: WorkflowExecutionLocal.Options = {
  ownerID: "worker-cancel-restart",
  leaseDurationMs: 5_000,
  heartbeatIntervalMs: 1_000,
  pollIntervalMs: 5,
  concurrency: 1,
}

const restartExecutorCalls = { value: 0 }
const restartExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: () =>
      Effect.sync(() => {
        restartExecutorCalls.value += 1
        return { usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 } }
      }),
  }),
)

const createInput = (suffix: string): Workflow.CreateInput => ({
  id: Workflow.ID.make(`wfl_${suffix}`),
  type: "development",
  input: { brief: `Build ${suffix}` },
  budget: { maxAttempts: 3 },
  stages: [
    {
      id: Workflow.StageID.make(`wfs_${suffix}`),
      type: "design",
      ordinal: 0,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe",
      idempotencyKey: `${suffix}/design`,
      input: {},
    },
  ],
})

describe("Workflow cancellation", () => {
  projectorIt.effect("rejects artifact and success projection after durable cancellation wins the race", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const input = createInput("cancel_fence")
      yield* workflow.create(input)
      const now = DateTime.toEpochMillis(yield* DateTime.now)
      const claimed = Option.getOrThrow(
        yield* store.claim({ owner: "worker-cancel-fence", now, leaseDurationMs: 5_000 }),
      )
      yield* events.publish(WorkflowEvent.Stage.Started, {
        workflowID: input.id!,
        stageID: input.stages[0].id!,
        timestamp: DateTime.makeUnsafe(now),
        attempt: claimed.attempt,
        leaseOwner: "worker-cancel-fence",
      })
      yield* workflow.cancel(input.id!)

      const artifact = yield* events
        .publish(WorkflowEvent.Artifact.Created, {
          workflowID: input.id!,
          stageID: input.stages[0].id!,
          timestamp: DateTime.makeUnsafe(now + 1),
          artifact: Workflow.Artifact.make({
            id: Workflow.ArtifactID.make("wfa_cancel_fence"),
            workflowID: input.id!,
            stageID: input.stages[0].id!,
            kind: "result",
            uri: "artifact://cancel/result.json",
            mime: "application/json",
            sha256: "c".repeat(64),
            size: 2,
            metadata: {},
            timeCreated: DateTime.makeUnsafe(now + 1),
          }),
        })
        .pipe(Effect.exit)
      const success = yield* events
        .publish(WorkflowEvent.Stage.Succeeded, {
          workflowID: input.id!,
          stageID: input.stages[0].id!,
          timestamp: DateTime.makeUnsafe(now + 2),
          attempt: claimed.attempt,
          leaseOwner: "worker-cancel-fence",
          usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 },
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(artifact)).toBe(true)
      expect(Exit.isFailure(success)).toBe(true)
      const detail = yield* workflow.get(input.id!)
      expect(detail.artifacts).toEqual([])
      expect(detail.stages[0].status).toBe("running")
    }),
  )

  it.live(
    "finishes a persisted cancel request after restart without invoking the executor",
    () =>
      Effect.gen(function* () {
        restartExecutorCalls.value = 0
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const database = Database.layerFromPath(path.join(tmp.path, "workflow-cancel.sqlite"))
        const requestLayer = AppNodeBuilder.build(
          LayerNode.group([Database.node, WorkflowV2.node, WorkflowStore.node]),
          [[Database.node, database]],
        )

        const first = createInput("cancel_restart")
        const input: Workflow.CreateInput = {
          ...first,
          stages: [
            first.stages[0],
            {
              id: Workflow.StageID.make("wfs_cancel_restart_build"),
              type: "build",
              ordinal: 1,
              maxAttempts: 3,
              recoveryPolicy: "restart_safe",
              idempotencyKey: "cancel_restart/build",
              input: {},
            },
          ],
        }
        yield* Effect.gen(function* () {
          const workflow = yield* WorkflowV2.Service
          yield* workflow.create(input)
          yield* workflow.cancel(input.id!)
          const detail = yield* workflow.get(input.id!)
          expect(detail.run.cancelRequestedAt).toBeDefined()
          const history = yield* workflow.history({ workflowID: input.id!, limit: 20 })
          expect(history.events.filter((event) => event.type === "workflow.cancel.requested")).toHaveLength(1)
        }).pipe(Effect.provide(requestLayer), Effect.scoped)

        const restartLayer = AppNodeBuilder.build(
          LayerNode.group([
            Database.node,
            WorkflowV2.node,
            WorkflowStore.node,
            WorkflowExecutor.node,
            WorkflowExecution.node,
          ]),
          [
            [Database.node, database],
            [WorkflowExecutor.node, restartExecutor],
            [WorkflowExecution.node, WorkflowExecutionLocal.nodeWith(workerOptions)],
          ],
        )

        yield* Effect.gen(function* () {
          const workflow = yield* WorkflowV2.Service
          const completed = yield* workflow.events({ workflowID: input.id! }).pipe(
            Stream.filter((event) => event.type === "workflow.cancelled"),
            Stream.runHead,
            Effect.timeout("2 seconds"),
          )
          expect(Option.isSome(completed)).toBe(true)

          const detail = yield* workflow.get(input.id!)
          expect(detail.run.status).toBe("cancelled")
          expect(detail.stages.map((stage) => stage.status)).toEqual(["cancelled", "cancelled"])
          expect(restartExecutorCalls.value).toBe(0)

          yield* workflow.cancel(input.id!)
          const history = yield* workflow.history({ workflowID: input.id!, limit: 20 })
          expect(history.events.filter((event) => event.type === "workflow.cancel.requested")).toHaveLength(1)
          expect(history.events.filter((event) => event.type === "workflow.stage.cancelled")).toHaveLength(2)
          expect(history.events.filter((event) => event.type === "workflow.cancelled")).toHaveLength(1)
        }).pipe(Effect.provide(restartLayer), Effect.scoped)
      }),
    5_000,
  )

  it.live(
    "rejects an external native tool result that arrives after a logical execution-runtime restart",
    () =>
      Effect.gen(function* () {
        restartExecutorCalls.value = 0
        const toolStarted = yield* Deferred.make<void>()
        const toolRelease = yield* Deferred.make<void>()
        const toolSettled = yield* Deferred.make<void>()
        const requestedUrls: string[] = []
        const rawEvents = yield* Effect.promise(() =>
          Bun.file(new URL("../../llm/test/fixtures/deepseek-responses/tool-stream.json", import.meta.url)).json(),
        )
        const providerEvents = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
        )(rawEvents).pipe(Effect.orDie)
        const sse = providerEvents
          .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
          .join("")
        const transport = dynamicResponse(({ request, respond }) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
            requestedUrls.push(web.url)
            return respond(sse, { headers: { "content-type": "text/event-stream" } })
          }),
        )
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const database = Database.layerFromPath(path.join(tmp.path, "workflow-external-tool-restart.sqlite"))
        const base = createInput("external_tool_restart_fence")
        const responseID = Responses.ID.make("resp_external_tool_restart_fence")
        const input: Workflow.CreateInput = {
          ...base,
          stages: [{ ...base.stages[0], type: "deliver", input: { responseID } }],
        }
        const ownerAExecutor = Layer.succeed(
          WorkflowExecutor.Service,
          WorkflowExecutor.Service.of({
            execute: () =>
              Effect.gen(function* () {
                const model = DeepSeek.configure({
                  baseURL: "https://api.deepseek.test",
                  apiKey: "offline-fixture",
                }).responses("deepseek-v4-flash")
                const provider = yield* LLMClient.generate(
                  LLM.request({ model, prompt: "Use the recorded read_file call." }),
                ).pipe(
                  Effect.provide(transport),
                  Effect.mapError((error) => ({
                    failure: { category: "transient" as const, code: "provider_failure", message: error.message },
                    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
                  })),
                )
                const calls = provider.events.filter(
                  (event) => event.type === "tool-call" && event.name === "read_file",
                )
                if (calls.length !== 1)
                  return yield* Effect.die(`expected one recorded read_file call, got ${calls.length}`)
                const call = calls[0]
                if (!call || call.type !== "tool-call") return yield* Effect.die("recorded read_file call missing")
                const delayed = Tool.make({
                  description: "Delayed external read",
                  parameters: Schema.Struct({ path: Schema.String }),
                  success: Schema.Struct({ output: Schema.String }),
                  execute: ({ path }) =>
                    Effect.uninterruptible(
                      Deferred.succeed(toolStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(toolRelease)),
                        Effect.as({ output: `stale:${path}` }),
                      ),
                    ),
                })
                const settlement = yield* ToolRuntime.dispatch({ read_file: delayed }, call)
                yield* Deferred.succeed(toolSettled, undefined)
                const body = JSON.stringify({ output: settlement.output, nextProviderTurn: "STALE_NEXT_TURN_SENTINEL" })
                return {
                  usage: { tokens: 333, turns: 1, toolCalls: 1, attempts: 0 },
                  artifacts: [
                    {
                      kind: "tool-output",
                      uri: `artifact://${input.id!}/stale-tool.json`,
                      mime: "application/json",
                      sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
                      size: body.length,
                      metadata: { output: settlement.output, nextProviderTurn: "STALE_NEXT_TURN_SENTINEL" },
                    },
                  ],
                }
              }),
          }),
        )
        const ownerA = AppNodeBuilder.build(
          LayerNode.group([
            Database.node,
            EventV2.node,
            WorkflowV2.node,
            WorkflowStore.node,
            ResponsesProjector.node,
            ResponsesStore.node,
            ResponsesV2.node,
            WorkflowExecutor.node,
            WorkflowExecution.node,
          ]),
          [
            [Database.node, database],
            [WorkflowExecutor.node, ownerAExecutor],
            [WorkflowExecution.node, WorkflowExecutionLocal.nodeWith({ ...workerOptions, ownerID: "owner-A" })],
          ],
        )
        const ownerAFiber = yield* Effect.gen(function* () {
          const workflow = yield* WorkflowV2.Service
          const responses = yield* ResponsesV2.Service
          const execution = yield* WorkflowExecution.Service
          yield* workflow.create(input)
          yield* responses.create({
            id: responseID,
            workflowID: input.id!,
            model: "deepseek-v4-flash",
            background: false,
            store: true,
            requestHash: `sha256:${responseID}`,
            input: [{ type: "message", role: "user", content: "run the delayed tool" }],
          })
          yield* execution.wake
          return yield* Effect.never
        }).pipe(Effect.provide(ownerA), Effect.scoped, Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(toolStarted).pipe(Effect.timeout("2 seconds"))
        expect(requestedUrls).toEqual(["https://api.deepseek.test/responses"])

        const cancelAdmission = AppNodeBuilder.build(
          LayerNode.group([
            Database.node,
            EventV2.node,
            WorkflowProjector.node,
            WorkflowStore.node,
            ResponsesProjector.node,
            ResponsesStore.node,
            ResponsesV2.node,
          ]),
          [[Database.node, database]],
        )
        yield* Effect.gen(function* () {
          const responses = yield* ResponsesV2.Service
          const store = yield* WorkflowStore.Service
          yield* responses.cancelWorkflow({ responseID })
          expect((yield* store.get(input.id!))?.run.cancelRequestedAt).toBeDefined()
        }).pipe(Effect.provide(cancelAdmission), Effect.scoped)

        const ownerB = AppNodeBuilder.build(
          LayerNode.group([
            Database.node,
            EventV2.node,
            WorkflowV2.node,
            WorkflowStore.node,
            ResponsesProjector.node,
            ResponsesStore.node,
            ResponsesV2.node,
            WorkflowExecutor.node,
            WorkflowExecution.node,
          ]),
          [
            [Database.node, database],
            [WorkflowExecutor.node, restartExecutor],
            [WorkflowExecution.node, WorkflowExecutionLocal.nodeWith({ ...workerOptions, ownerID: "owner-B" })],
          ],
        )
        yield* Effect.gen(function* () {
          const workflow = yield* WorkflowV2.Service
          const cancelled = yield* workflow.events({ workflowID: input.id! }).pipe(
            Stream.filter((event) => event.type === "workflow.cancelled"),
            Stream.runHead,
            Effect.timeout("2 seconds"),
          )
          expect(Option.isSome(cancelled)).toBe(true)
        }).pipe(Effect.provide(ownerB), Effect.scoped)

        yield* Deferred.succeed(toolRelease, undefined)
        yield* Deferred.await(toolSettled).pipe(Effect.timeout("2 seconds"))
        yield* Effect.sleep(50)

        const requestLayer = AppNodeBuilder.build(
          LayerNode.group([
            Database.node,
            EventV2.node,
            WorkflowV2.node,
            WorkflowStore.node,
            ResponsesProjector.node,
            ResponsesStore.node,
            ResponsesV2.node,
          ]),
          [
            [Database.node, database],
            [WorkflowExecution.node, WorkflowExecution.noopLayer],
          ],
        )
        yield* Effect.gen(function* () {
          const workflow = yield* WorkflowV2.Service
          const responses = yield* ResponsesV2.Service
          const database = yield* Database.Service
          const detail = yield* workflow.get(input.id!)
          const history = yield* workflow.history({ workflowID: input.id!, limit: 100 })
          const response = yield* responses.get(responseID)
          expect(restartExecutorCalls.value).toBe(0)
          expect(detail.run.status).toBe("cancelled")
          expect(detail.run.usage).toEqual({ tokens: 0, turns: 0, toolCalls: 0, attempts: 1 })
          expect(detail.artifacts).toEqual([])
          expect(response.status).toBe("cancelled")
          expect(history.events.filter((event) => event.type === "workflow.cancelled")).toHaveLength(1)
          expect(history.events.filter((event) => event.type === "workflow.cancel.requested")).toHaveLength(1)
          expect(history.events.map((event) => event.type)).not.toContain("workflow.stage.succeeded")
          expect(
            yield* database.db
              .select({ type: EventTable.type })
              .from(EventTable)
              .where(eq(EventTable.aggregate_id, responseID))
              .orderBy(EventTable.seq)
              .all()
              .pipe(Effect.orDie),
          ).toEqual([
            { type: EventV2.versionedType(ResponseEvent.Created.type, ResponseEvent.Created.durable!.version) },
            { type: EventV2.versionedType(ResponseEvent.Cancelled.type, ResponseEvent.Cancelled.durable!.version) },
          ])
          expect(JSON.stringify(history)).not.toContain("STALE_NEXT_TURN_SENTINEL")
        }).pipe(Effect.provide(requestLayer), Effect.scoped)
        yield* Fiber.interrupt(ownerAFiber)
      }),
    10_000,
  )
})
