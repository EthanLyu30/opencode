import { afterAll, expect, test } from "bun:test"
import { Database as SqliteDatabase } from "bun:sqlite"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { LLMError, LLMEvent, LLMResponse, RateLimitReason } from "../../llm/src"
import { LLMClient, type LLMClientService } from "../../llm/src/route"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { ResponsesProjector } from "@opencode-ai/core/responses/projector"
import { ResponsesStore } from "@opencode-ai/core/responses/store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Tool as CoreTool } from "@opencode-ai/core/tool/tool"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowModelExecution } from "@opencode-ai/core/workflow/execution/model"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { ResponseEvent } from "../../schema/src/response-event"
import { WorkflowEvent } from "../../schema/src/workflow-event"
import { Integration } from "../../schema/src/integration"
import { Responses, Workflow } from "../src"
import {
  deepSeekSSE,
  fixture,
  runtimeLayer,
  seedPair,
  waitTerminal,
  waitWorkflowStatus,
} from "./lib/native-responses-runtime"

const workerPath = fileURLToPath(new URL("./responses-crash-worker.ts", import.meta.url))
const nativeFetch = globalThis.fetch
type FetchHandler = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
let embeddedProviderFetch: FetchHandler | undefined
globalThis.fetch = Object.assign(
  (...args: Parameters<typeof fetch>) => (embeddedProviderFetch ?? nativeFetch)(...args),
  { preconnect: nativeFetch.preconnect },
)
afterAll(() => {
  globalThis.fetch = nativeFetch
})

const durableType = (definition: { readonly type: string; readonly durable?: { readonly version: number } }) => {
  if (!definition.durable) throw new Error(`Expected durable event definition: ${definition.type}`)
  return EventV2.versionedType(definition.type, definition.durable.version)
}

const responseTerminalTypes = [
  ResponseEvent.Completed,
  ResponseEvent.Incomplete,
  ResponseEvent.Failed,
  ResponseEvent.Cancelled,
].map(durableType)
const workflowTerminalTypes = [WorkflowEvent.Succeeded, WorkflowEvent.Failed, WorkflowEvent.Cancelled].map(durableType)
const workflowStageTerminalTypes = [
  WorkflowEvent.Stage.Succeeded,
  WorkflowEvent.Stage.Failed,
  WorkflowEvent.Stage.Cancelled,
].map(durableType)

const durableEventCount = (sqlite: SqliteDatabase, aggregateID: string, types: ReadonlyArray<string>) => {
  const row = sqlite
    .query(
      `select count(*) as count from event where aggregate_id = ? and type in (${types.map(() => "?").join(", ")})`,
    )
    .get(aggregateID, ...types)
  if (!row || typeof row !== "object" || !("count" in row) || typeof row.count !== "number")
    throw new Error("Expected a durable event count row")
  return { count: row.count }
}

const stageAttempt = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ attempt: Schema.Number })))

const durableStageAttempts = (sqlite: SqliteDatabase, workflowID: Workflow.ID) =>
  sqlite
    .query("select data from event where aggregate_id = ? and type = ? order by seq")
    .all(workflowID, durableType(WorkflowEvent.Stage.Started))
    .map((row) => {
      if (!row || typeof row !== "object" || !("data" in row) || typeof row.data !== "string")
        throw new Error("Expected a durable stage-started row")
      return stageAttempt(row.data).attempt
    })

async function removeTestDirectory(directory: string, retries = 30): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    if (retries === 0 || !error || typeof error !== "object" || !("code" in error) || error.code !== "EBUSY") {
      throw error
    }
    Bun.gc(true)
    await Bun.sleep(100)
    await removeTestDirectory(directory, retries - 1)
  }
}

const withDatabase = async (
  name: string,
  run: (input: { directory: string; databasePath: string }) => Promise<void>,
) => {
  const directory = await mkdtemp(path.join(tmpdir(), `opencode-responses-conformance-${name}-`))
  const databasePath = path.join(directory, "opencode.sqlite")
  const previous = Flag.OPENCODE_DB
  Flag.OPENCODE_DB = databasePath
  try {
    await run({ directory, databasePath })
  } finally {
    Flag.OPENCODE_DB = previous
    await removeTestDirectory(directory)
  }
}

const decodeSqlJson = (rows: unknown[], columns: ReadonlyArray<string>) =>
  (rows as Array<Record<string, unknown>>).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        columns.includes(key) && typeof value === "string" ? JSON.parse(value) : value,
      ]),
    ),
  )

const responseProjectionSnapshot = (database: SqliteDatabase) => ({
  responses: decodeSqlJson(database.query("select * from response order by id").all(), ["output", "error", "usage"]),
  responseItems: decodeSqlJson(database.query("select * from response_item order by response_id, ordinal").all(), [
    "payload",
  ]),
  workflows: decodeSqlJson(database.query("select * from workflow_run order by id").all(), [
    "input",
    "budget",
    "usage",
  ]),
  stages: decodeSqlJson(database.query("select * from workflow_stage order by workflow_id, ordinal").all(), [
    "checkpoint",
    "input",
    "error",
  ]),
  artifacts: decodeSqlJson(database.query("select * from workflow_artifact order by workflow_id, id").all(), [
    "metadata",
  ]),
})

const serializedEventSnapshot = (database: SqliteDatabase): EventV2.SerializedEvent[] =>
  (
    database
      .query("select id, aggregate_id, seq, type, data, batch_id, batch_index, batch_size from event order by rowid")
      .all() as Array<{
      id: string
      aggregate_id: string
      seq: number
      type: string
      data: string
      batch_id: string | null
      batch_index: number | null
      batch_size: number | null
    }>
  ).map((row) => ({
    id: EventV2.ID.make(row.id),
    aggregateID: row.aggregate_id,
    seq: row.seq,
    type: row.type,
    data: JSON.parse(row.data) as Record<string, unknown>,
    ...(row.batch_id === null
      ? {}
      : { batchID: row.batch_id, batchIndex: row.batch_index!, batchSize: row.batch_size! }),
  }))

const workflowInput = (workflowID: Workflow.ID): Workflow.CreateInput => ({
  id: workflowID,
  type: "responses-conformance",
  input: {},
  budget: { maxAttempts: 1 },
  stages: [
    {
      id: Workflow.StageID.make(`wfs_${workflowID.slice(4)}`),
      type: "deliver",
      ordinal: 0,
      maxAttempts: 1,
      recoveryPolicy: "restart_safe",
      idempotencyKey: `responses/${workflowID}`,
      input: { responseBinding: "workflow" },
    },
  ],
})

const coreLayer = (databasePath: string) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      WorkflowProjector.node,
      ResponsesProjector.node,
      ResponsesStore.node,
      ResponsesV2.node,
    ]),
    [[Database.node, Database.layerFromPath(databasePath)]],
  )

const credentialLayer = (databasePath: string) =>
  AppNodeBuilder.build(LayerNode.group([Database.node, Credential.node]), [
    [Database.node, Database.layerFromPath(databasePath)],
  ])

const roleWorkflowInput = (
  workflowID: Workflow.ID,
  responseID?: Responses.ID,
  deliverMaxAttempts = 1,
): Workflow.CreateInput => ({
  id: workflowID,
  type: "responses-production-bridge",
  input: {},
  budget: { maxAttempts: 5 + deliverMaxAttempts },
  stages: [
    roleStage(workflowID, "design", 0),
    roleStage(workflowID, "decompose", 1),
    roleStage(workflowID, "implement", 2),
    roleStage(workflowID, "test", 3),
    roleStage(workflowID, "visual_review", 4),
    roleStage(workflowID, "deliver", 5, responseID, responseID === undefined, deliverMaxAttempts),
  ],
})

const roleStage = (
  workflowID: Workflow.ID,
  role: "design" | "decompose" | "implement" | "test" | "visual_review" | "deliver",
  ordinal: number,
  responseID?: Responses.ID,
  workflowBinding = false,
  maxAttempts = 1,
): Workflow.StageInput => ({
  id: Workflow.StageID.make(`wfs_${role}_${workflowID.slice(4)}`),
  type: role,
  ordinal,
  maxAttempts,
  recoveryPolicy: "restart_safe",
  idempotencyKey: `responses/${workflowID}/${role}`,
  input: responseID === undefined ? (workflowBinding ? { responseBinding: "workflow" } : {}) : { responseID },
})

const roleOutcome = (role: string) =>
  JSON.stringify({
    schemaVersion: 1,
    role,
    verdict: role === "deliver" ? "complete" : role === "test" || role === "visual_review" ? "pass" : "ready",
    revision: 0,
  })

const llmTextResponse = (text: string) => {
  const response = LLMResponse.fromEvents([
    LLMEvent.textStart({ id: "text_0" }),
    LLMEvent.textDelta({ id: "text_0", text }),
    LLMEvent.textEnd({ id: "text_0" }),
    LLMEvent.finish({ reason: "stop", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }),
  ])
  if (!response) throw new Error("Expected a complete text response")
  return response
}

const llmToolResponse = () => {
  const response = LLMResponse.fromEvents([
    LLMEvent.toolCall({ id: "call_checkpoint_read", name: "read_file", input: { path: "fixture.txt" } }),
    LLMEvent.finish({ reason: "tool-calls", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }),
  ])
  if (!response) throw new Error("Expected a complete tool response")
  return response
}

const llmIncompleteResponse = () => {
  const response = LLMResponse.fromEvents([
    LLMEvent.textStart({ id: "text_incomplete" }),
    LLMEvent.textDelta({ id: "text_incomplete", text: roleOutcome("deliver") }),
    LLMEvent.textEnd({ id: "text_incomplete" }),
    LLMEvent.finish({ reason: "unknown", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } }),
  ])
  if (!response) throw new Error("Expected an incomplete text response")
  return response
}

const continuationWorkerLayer = (databasePath: string, ownerID: string, clientLayer: Layer.Layer<LLMClientService>) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      WorkflowProjector.node,
      WorkflowStore.node,
      WorkflowV2.node,
      ResponsesProjector.node,
      ResponsesStore.node,
      ResponsesV2.node,
      Credential.node,
      ApplicationTools.node,
      WorkflowModelExecution.node,
      WorkflowExecutor.node,
      WorkflowExecution.node,
    ]),
    [
      [Database.node, Database.layerFromPath(databasePath)],
      [llmClient, clientLayer],
      [
        WorkflowExecution.node,
        WorkflowExecutionLocal.nodeWith({
          ownerID,
          leaseDurationMs: 150,
          heartbeatIntervalMs: 10_000,
          pollIntervalMs: 5,
          concurrency: 1,
        }),
      ],
    ],
  )

const kimiRoleSSE = (role: string) =>
  [
    { id: `chatcmpl_${role}`, choices: [{ delta: { content: roleOutcome(role) }, finish_reason: null }], usage: null },
    { id: `chatcmpl_${role}`, choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
    {
      id: `chatcmpl_${role}`,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("") + "data: [DONE]\n\n"

const deepSeekRoleSSE = (role: string) =>
  deepSeekSSE([
    { type: "response.created", sequence_number: 0, response: { id: `resp_provider_${role}` } },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      item: { type: "message", id: `message_${role}`, status: "in_progress" },
    },
    { type: "response.content_part.added", sequence_number: 2, item_id: `message_${role}` },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: `message_${role}`,
      delta: roleOutcome(role),
    },
    { type: "response.output_text.done", sequence_number: 4, item_id: `message_${role}` },
    { type: "response.content_part.done", sequence_number: 5, item_id: `message_${role}` },
    {
      type: "response.output_item.done",
      sequence_number: 6,
      item: { type: "message", id: `message_${role}`, status: "completed" },
    },
    {
      type: "response.completed",
      sequence_number: 7,
      response: { id: `resp_provider_${role}`, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    },
  ])

const deepSeekHostedSearchRoleSSE = (role: string) =>
  deepSeekSSE([
    { type: "response.created", sequence_number: 0, response: { id: `resp_provider_${role}_hosted` } },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      item: { type: "web_search_call", id: "search_production_1", status: "in_progress" },
    },
    { type: "response.web_search_call.in_progress", sequence_number: 2, item_id: "search_production_1" },
    { type: "response.web_search_call.searching", sequence_number: 3, item_id: "search_production_1" },
    { type: "response.web_search_call.completed", sequence_number: 4, item_id: "search_production_1" },
    {
      type: "response.output_item.done",
      sequence_number: 5,
      item: {
        type: "web_search_call",
        id: "search_production_1",
        status: "completed",
        action: { type: "search", query: "Task20 hosted replay" },
        results: [{ title: "Recorded result", url: "https://example.test/recorded" }],
      },
    },
    {
      type: "response.output_item.added",
      sequence_number: 6,
      item: { type: "web_search_call", id: "search_production_failed", status: "in_progress" },
    },
    {
      type: "response.output_item.done",
      sequence_number: 7,
      item: {
        type: "web_search_call",
        id: "search_production_failed",
        status: "failed",
        action: { type: "search", query: "Task20 failed hosted replay" },
        error: { code: "search_unavailable", message: "offline hosted fixture" },
      },
    },
    {
      type: "response.output_item.added",
      sequence_number: 8,
      item: { type: "message", id: `message_${role}_hosted`, status: "in_progress" },
    },
    { type: "response.content_part.added", sequence_number: 9, item_id: `message_${role}_hosted` },
    {
      type: "response.output_text.delta",
      sequence_number: 10,
      item_id: `message_${role}_hosted`,
      delta: roleOutcome(role),
    },
    { type: "response.output_text.done", sequence_number: 11, item_id: `message_${role}_hosted` },
    { type: "response.content_part.done", sequence_number: 12, item_id: `message_${role}_hosted` },
    {
      type: "response.output_item.done",
      sequence_number: 13,
      item: { type: "message", id: `message_${role}_hosted`, status: "completed" },
    },
    {
      type: "response.completed",
      sequence_number: 14,
      response: { id: `resp_provider_${role}_hosted`, usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 } },
    },
  ])

const deepSeekIncompleteRoleSSE = (role: string, reason: "max_output_tokens" | "content_filter") =>
  deepSeekSSE([
    { type: "response.created", sequence_number: 0, response: { id: `resp_provider_${role}_incomplete` } },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      item: { type: "message", id: `message_${role}_incomplete`, status: "in_progress" },
    },
    { type: "response.content_part.added", sequence_number: 2, item_id: `message_${role}_incomplete` },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: `message_${role}_incomplete`,
      delta: roleOutcome(role),
    },
    { type: "response.output_text.done", sequence_number: 4, item_id: `message_${role}_incomplete` },
    { type: "response.content_part.done", sequence_number: 5, item_id: `message_${role}_incomplete` },
    {
      type: "response.output_item.done",
      sequence_number: 6,
      item: { type: "message", id: `message_${role}_incomplete`, status: "incomplete" },
    },
    {
      type: "response.incomplete",
      sequence_number: 7,
      response: {
        id: `resp_provider_${role}_incomplete`,
        incomplete_details: { reason },
        usage: { input_tokens: 13, output_tokens: 7, total_tokens: 20 },
      },
    },
  ])

const deepSeekUnknownIncompleteRoleSSE = (role: string) =>
  deepSeekSSE([
    { type: "response.created", sequence_number: 0, response: { id: `resp_provider_${role}_incomplete_unknown` } },
    {
      type: "response.output_item.done",
      sequence_number: 1,
      item: {
        type: "function_call",
        id: "fc_incomplete_partial",
        call_id: "call_incomplete_partial",
        name: "read_file",
        arguments: '{"path":"partial.md"}',
        status: "completed",
      },
    },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      item: { type: "message", id: `message_${role}_incomplete_unknown`, status: "in_progress" },
    },
    { type: "response.content_part.added", sequence_number: 3, item_id: `message_${role}_incomplete_unknown` },
    {
      type: "response.output_text.delta",
      sequence_number: 4,
      item_id: `message_${role}_incomplete_unknown`,
      delta: roleOutcome(role),
    },
    { type: "response.output_text.done", sequence_number: 5, item_id: `message_${role}_incomplete_unknown` },
    { type: "response.content_part.done", sequence_number: 6, item_id: `message_${role}_incomplete_unknown` },
    {
      type: "response.output_item.done",
      sequence_number: 7,
      item: { type: "message", id: `message_${role}_incomplete_unknown`, status: "incomplete" },
    },
    {
      type: "response.incomplete",
      sequence_number: 8,
      response: {
        id: `resp_provider_${role}_incomplete_unknown`,
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      },
    },
  ])

const deepSeekFailedRoleSSE = () =>
  deepSeekSSE([
    { type: "response.created", sequence_number: 0, response: { id: "resp_provider_failed_usage" } },
    {
      type: "response.failed",
      sequence_number: 1,
      response: {
        id: "resp_provider_failed_usage",
        error: { code: "server_error", message: "TASK20_PROVIDER_BODY_MUST_NOT_PERSIST" },
        usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
      },
    },
  ])

const deepSeekDelayedToolSSE = (input?: { readonly callID?: string; readonly path?: string }) => {
  const callID = input?.callID ?? "call_delayed_tool"
  const path = input?.path ?? "README.md"
  const itemID = `function_item_${callID}`
  return deepSeekSSE([
    { type: "response.created", sequence_number: 0, response: { id: "resp_provider_delayed_tool" } },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      item: {
        type: "function_call",
        id: itemID,
        call_id: callID,
        name: "read_file",
        arguments: "",
      },
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 2,
      item_id: itemID,
      arguments: JSON.stringify({ path }),
    },
    {
      type: "response.output_item.done",
      sequence_number: 3,
      item: {
        type: "function_call",
        id: itemID,
        call_id: callID,
        name: "read_file",
      },
    },
    {
      type: "response.completed",
      sequence_number: 4,
      response: {
        id: "resp_provider_delayed_tool",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ])
}

test("transient JSON and SSE waiters survive terminal-before-register without leaking payloads", async () => {
  await withDatabase("transient-registry", async ({ databasePath }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const responses = yield* ResponsesV2.Service
        const events = yield* EventV2.Service
        const createWorkflow = (workflowID: Workflow.ID, responseID: Responses.ID) => {
          const input = roleWorkflowInput(workflowID, responseID)
          return events.publish(WorkflowEvent.Created, {
            workflowID,
            timestamp: DateTime.makeUnsafe(0),
            type: input.type,
            input: input.input,
            budget: input.budget,
            stages: input.stages.map((stage) => ({ ...stage, id: stage.id! })) as [Workflow.Stage, ...Workflow.Stage[]],
          })
        }
        const responseID = Responses.ID.make(`resp_transient_registry_${crypto.randomUUID()}`)
        const workflowID = Workflow.ID.make(`wfl_transient_registry_${crypto.randomUUID()}`)
        const transientRequestHash = `sha256:transient-registry:${crypto.randomUUID()}`
        const json = yield* responses.acquireTransient({ requestHash: transientRequestHash, responseID })
        yield* createWorkflow(workflowID, responseID)
        const admitted = yield* responses.create({
          id: responseID,
          workflowID,
          model: "deepseek-v4-flash",
          background: false,
          store: false,
          requestHash: transientRequestHash,
          input: [{ type: "message", role: "user", content: "terminal before await" }],
        })
        const sse = yield* responses.acquireTransient({ requestHash: transientRequestHash, responseID })
        yield* responses.settleTransient({
          responseID,
          status: "completed",
          timestamp: yield* DateTime.now,
          sequenceNumber: 2,
          output: [{ type: "message", role: "assistant", content: "shared terminal" }],
        })
        yield* responses.registerTransient(admitted)
        expect((yield* json.await).resource.output).toEqual([
          { type: "message", role: "assistant", content: "shared terminal" },
        ])
        expect((yield* sse.await).resource.status).toBe("completed")
        yield* json.release
        yield* sse.release

        const disconnectedID = Responses.ID.make(`resp_transient_disconnect_${crypto.randomUUID()}`)
        const disconnectedWorkflowID = Workflow.ID.make(`wfl_transient_disconnect_${crypto.randomUUID()}`)
        const disconnectedRequestHash = `sha256:transient-disconnect:${crypto.randomUUID()}`
        const disconnected = yield* responses.acquireTransient({
          requestHash: disconnectedRequestHash,
          responseID: disconnectedID,
        })
        yield* createWorkflow(disconnectedWorkflowID, disconnectedID)
        const disconnectedResource = yield* responses.create({
          id: disconnectedID,
          workflowID: disconnectedWorkflowID,
          model: "deepseek-v4-flash",
          background: false,
          store: false,
          requestHash: disconnectedRequestHash,
          input: [{ type: "message", role: "user", content: "disconnect" }],
        })
        yield* responses.registerTransient(disconnectedResource)
        yield* disconnected.release
        yield* responses.settleTransient({
          responseID: disconnectedID,
          status: "completed",
          timestamp: yield* DateTime.now,
          sequenceNumber: 2,
          output: [{ type: "message", role: "assistant", content: "must be dropped" }],
        })
        const late = yield* responses.acquireTransient({
          requestHash: disconnectedRequestHash,
          responseID: disconnectedID,
        })
        yield* responses.registerTransient(disconnectedResource)
        expect(Option.isNone(yield* late.await.pipe(Effect.timeoutOption("10 millis")))).toBe(true)
        yield* late.release

        const requestHash = `sha256:transient-concurrent:${crypto.randomUUID()}`
        const winnerID = Responses.ID.make(`resp_transient_concurrent_winner_${crypto.randomUUID()}`)
        const loserID = Responses.ID.make(`resp_transient_concurrent_loser_${crypto.randomUUID()}`)
        const concurrentWorkflowID = Workflow.ID.make(`wfl_transient_concurrent_${crypto.randomUUID()}`)
        const concurrentInput = roleWorkflowInput(concurrentWorkflowID)
        yield* events.publish(WorkflowEvent.Created, {
          workflowID: concurrentWorkflowID,
          timestamp: DateTime.makeUnsafe(0),
          type: concurrentInput.type,
          input: concurrentInput.input,
          budget: concurrentInput.budget,
          stages: concurrentInput.stages.map((stage) => ({ ...stage, id: stage.id! })) as [
            Workflow.Stage,
            ...Workflow.Stage[],
          ],
        })
        const jsonConcurrent = yield* responses.acquireTransient({ requestHash, responseID: winnerID })
        const sseConcurrent = yield* responses.acquireTransient({ requestHash, responseID: loserID })
        const winner = yield* responses.create({
          id: winnerID,
          workflowID: concurrentWorkflowID,
          model: "deepseek-v4-flash",
          background: false,
          store: false,
          requestHash,
          input: [{ type: "message", role: "user", content: "concurrent request" }],
        })
        yield* responses.registerTransient(winner)
        const reconciled = yield* responses.create({
          id: loserID,
          workflowID: concurrentWorkflowID,
          model: "deepseek-v4-flash",
          background: false,
          store: false,
          requestHash,
          input: [{ type: "message", role: "user", content: "concurrent request" }],
        })
        expect(reconciled.id).toBe(winnerID)
        yield* responses.complete({
          responseID: winnerID,
          output: [{ type: "message", role: "assistant", content: "shared concurrent terminal" }],
          usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        })
        yield* responses.registerTransient(reconciled)
        const jsonTerminal = yield* jsonConcurrent.await.pipe(Effect.timeoutOption("50 millis"))
        const sseTerminal = yield* sseConcurrent.await.pipe(Effect.timeoutOption("50 millis"))
        expect(Option.getOrThrow(jsonTerminal).resource).toMatchObject({
          id: winnerID,
          status: "completed",
          output: [{ type: "message", role: "assistant", content: "shared concurrent terminal" }],
          usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        })
        expect(Option.getOrThrow(sseTerminal).resource.id).toBe(winnerID)
        yield* jsonConcurrent.release
        yield* sseConcurrent.release
        const afterTerminal = yield* responses.acquireTransient({ requestHash, responseID: winnerID })
        yield* responses.registerTransient(reconciled)
        expect(Option.isNone(yield* afterTerminal.await.pipe(Effect.timeoutOption("10 millis")))).toBe(true)
        yield* afterTerminal.release

        const aliasID = Responses.ID.make(`resp_transient_alias_owner_${crypto.randomUUID()}`)
        const aliasWorkflowID = Workflow.ID.make(`wfl_transient_alias_owner_${crypto.randomUUID()}`)
        const ownerHash = `sha256:transient-alias-owner:${crypto.randomUUID()}`
        const poisonHash = `sha256:transient-alias-poison:${crypto.randomUUID()}`
        yield* createWorkflow(aliasWorkflowID, aliasID)
        const ownerLease = yield* responses.acquireTransient({ requestHash: ownerHash, responseID: aliasID })
        const ownerResource = yield* responses.create({
          id: aliasID,
          workflowID: aliasWorkflowID,
          model: "deepseek-v4-flash",
          background: false,
          store: false,
          requestHash: ownerHash,
          input: [{ type: "message", role: "user", content: "legitimate owner" }],
        })
        const poisonLease = yield* responses.acquireTransient({ requestHash: poisonHash, responseID: aliasID })
        yield* responses.complete({
          responseID: aliasID,
          output: [{ type: "message", role: "assistant", content: "owner terminal" }],
        })
        yield* responses.registerTransient(ownerResource)
        expect(
          Option.getOrThrow(yield* ownerLease.await.pipe(Effect.timeoutOption("50 millis"))).resource.output,
        ).toEqual([{ type: "message", role: "assistant", content: "owner terminal" }])
        expect(Option.isNone(yield* poisonLease.await.pipe(Effect.timeoutOption("10 millis")))).toBe(true)
        yield* ownerLease.release
        yield* poisonLease.release

        const interruptID = Responses.ID.make(`resp_transient_interrupt_${crypto.randomUUID()}`)
        const interruptWorkflowID = Workflow.ID.make(`wfl_transient_interrupt_${crypto.randomUUID()}`)
        const interruptHash = `sha256:transient-interrupt:${crypto.randomUUID()}`
        yield* createWorkflow(interruptWorkflowID, interruptID)
        const interruptLease = yield* responses.acquireTransient({
          requestHash: interruptHash,
          responseID: interruptID,
        })
        const interruptResource = yield* responses.create({
          id: interruptID,
          workflowID: interruptWorkflowID,
          model: "deepseek-v4-flash",
          background: false,
          store: false,
          requestHash: interruptHash,
          input: [{ type: "message", role: "user", content: "commit then interrupt" }],
        })
        yield* responses.registerTransient(interruptResource)
        const committed = yield* Deferred.make<void>()
        const releaseCommitListener = yield* Deferred.make<void>()
        const stop = yield* events.listen((event) =>
          event.type === ResponseEvent.Completed.type &&
          (event.data as { responseID?: Responses.ID }).responseID === interruptID
            ? Deferred.succeed(committed, undefined).pipe(Effect.andThen(Deferred.await(releaseCommitListener)))
            : Effect.void,
        )
        const completion = yield* responses
          .complete({
            responseID: interruptID,
            output: [{ type: "message", role: "assistant", content: "uninterruptible handoff" }],
          })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(committed)
        yield* Fiber.interrupt(completion).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.succeed(releaseCommitListener, undefined)
        expect(
          Option.getOrThrow(yield* interruptLease.await.pipe(Effect.timeoutOption("50 millis"))).resource,
        ).toMatchObject({
          id: interruptID,
          status: "completed",
          output: [{ type: "message", role: "assistant", content: "uninterruptible handoff" }],
        })
        yield* stop
        yield* interruptLease.release
      }).pipe(Effect.provide(coreLayer(databasePath)), Effect.scoped),
    )
  })
})

test("concurrent foreground store:false JSON and SSE retries share one terminal handoff", async () => {
  await withDatabase("transient-http-concurrent", async ({ databasePath }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: "offline-deepseek" },
        })
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-kimi" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )

    const roles = ["design", "decompose", "implement", "test", "visual_review", "deliver"] as const
    let requestNumber = 0
    embeddedProviderFetch = async () => {
      const role = roles[requestNumber++]
      if (!role) throw new Error("Concurrent transient retry executed the provider more than once")
      const body =
        role === "design" || role === "decompose" || role === "visual_review"
          ? kimiRoleSSE(role)
          : deepSeekRoleSSE(role)
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }

    const workflowID = Workflow.ID.make(`wfl_transient_http_concurrent_${crypto.randomUUID()}`)
    const jsonCandidate = Responses.ID.make(`resp_transient_json_candidate_${crypto.randomUUID()}`)
    const sseCandidate = Responses.ID.make(`resp_transient_sse_candidate_${crypto.randomUUID()}`)
    const requestHash = `sha256:transient-http-concurrent:${crypto.randomUUID()}`
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { OpenCode } = yield* Effect.promise(() => import("../src"))
            const opencode = yield* OpenCode.create()
            yield* opencode.workflows.create(roleWorkflowInput(workflowID))
            const [json, sse] = yield* Effect.all(
              [
                opencode.responses.create({
                  id: jsonCandidate,
                  workflowID,
                  model: "deepseek-v4-pro",
                  background: false,
                  store: false,
                  stream: false,
                  requestHash,
                  input: [{ type: "message", role: "user", content: "shared transient retry" }],
                }),
                opencode.responses.create({
                  id: sseCandidate,
                  workflowID,
                  model: "deepseek-v4-pro",
                  background: false,
                  store: false,
                  stream: true,
                  requestHash,
                  input: [{ type: "message", role: "user", content: "shared transient retry" }],
                }),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.timeout("5 seconds"))
            if (Stream.isStream(json)) return yield* Effect.die("Expected JSON, received SSE")
            if (!Stream.isStream(sse)) return yield* Effect.die("Expected SSE, received JSON")
            const streamed = Array.from(yield* sse.pipe(Stream.runCollect, Effect.timeout("5 seconds")))
            const terminal = streamed.at(-1)
            expect(json).toMatchObject({
              status: "completed",
              output: [{ type: "message", role: "assistant", content: roleOutcome("deliver") }],
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            })
            expect(terminal).toMatchObject({
              type: "response.completed",
              data: {
                responseID: json.id,
                output: json.output,
                usage: json.usage,
              },
            })
            expect(yield* opencode.responses.get({ responseID: json.id }).pipe(Effect.flip)).toMatchObject({
              _tag: "ResponseNotFoundError",
            })
          }),
        ),
      )
    } finally {
      embeddedProviderFetch = undefined
    }
    expect(requestNumber).toBe(6)
  })
}, 15_000)

test("production embedded runtime executes Responses context through exact credentialed provider routes", async () => {
  await withDatabase("production-bridge", async ({ databasePath }) => {
    const authSentinel = "TASK20_OUTBOUND_CREDENTIAL_SENTINEL"
    const transientToolSentinel = "TASK20_STORE_FALSE_TOOL_RESULT_SENTINEL"
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: authSentinel },
        })
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: authSentinel },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )

    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = []
    const roles = ["design", "decompose", "implement", "test", "visual_review", "deliver-tool", "deliver"] as const
    let requestIndex = 0
    embeddedProviderFetch = async (input, init) => {
      const web = new Request(input, init)
      const body = await web.json()
      const transient = requestIndex >= roles.length
      const role = roles[requestIndex++ % roles.length]
      if (!role) throw new Error("Unexpected provider request")
      requests.push({ url: web.url, authorization: web.headers.get("authorization"), body })
      const response =
        role === "deliver-tool"
          ? transient
            ? deepSeekDelayedToolSSE({ callID: "call_transient_tool", path: "transient-sentinel.txt" })
            : deepSeekDelayedToolSSE()
          : role === "design" || role === "decompose" || role === "visual_review"
            ? kimiRoleSSE(role)
            : deepSeekRoleSSE(role)
      return new Response(response, { headers: { "content-type": "text/event-stream" } })
    }

    const workflowID = Workflow.ID.make(`wfl_production_bridge_${crypto.randomUUID()}`)
    const parentWorkflowID = Workflow.ID.make(`wfl_production_parent_${crypto.randomUUID()}`)
    const parentID = Responses.ID.make(`resp_production_parent_${crypto.randomUUID()}`)
    const unsupportedParentWorkflowID = Workflow.ID.make(`wfl_production_unsupported_parent_${crypto.randomUUID()}`)
    const unsupportedParentID = Responses.ID.make(`resp_production_unsupported_parent_${crypto.randomUUID()}`)
    const captured: string[] = []
    let replayEvents: EventV2.SerializedEvent[] = []
    let sourceProjection: ReturnType<typeof responseProjectionSnapshot> | undefined
    const requestHash = `sha256:production-bridge:${crypto.randomUUID()}`
    const previousError = console.error
    console.error = (...values) => captured.push(values.map(String).join(" "))
    let responseID: Responses.ID | undefined
    try {
      responseID = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.gen(function* () {
              const events = yield* EventV2.Service
              const responses = yield* ResponsesV2.Service
              const parentWorkflow = workflowInput(parentWorkflowID)
              const [parentStage, ...parentStages] = parentWorkflow.stages
              yield* events.publish(WorkflowEvent.Created, {
                workflowID: parentWorkflowID,
                timestamp: yield* DateTime.now,
                type: parentWorkflow.type,
                input: parentWorkflow.input,
                budget: parentWorkflow.budget,
                stages: [
                  { ...parentStage, id: parentStage.id! },
                  ...parentStages.map((stage) => ({ ...stage, id: stage.id! })),
                ],
              })
              yield* responses.create({
                id: parentID,
                workflowID: parentWorkflowID,
                model: "deepseek-v4-flash",
                background: false,
                store: true,
                requestHash: `sha256:${parentID}`,
                input: [{ type: "message", role: "user", content: "parent input" }],
              })
              yield* responses.complete({
                responseID: parentID,
                output: [
                  {
                    type: "function_call",
                    call_id: "call_parent_context",
                    name: "read_file",
                    arguments: JSON.stringify({ path: "parent-context.md" }),
                  },
                  {
                    type: "function_call_output",
                    call_id: "call_parent_context",
                    output: JSON.stringify({ output: "parent tool output" }),
                  },
                  { type: "message", role: "assistant", content: "parent output" },
                ],
              })
              const unsupportedParentWorkflow = workflowInput(unsupportedParentWorkflowID)
              const [unsupportedParentStage, ...unsupportedParentStages] = unsupportedParentWorkflow.stages
              yield* events.publish(WorkflowEvent.Created, {
                workflowID: unsupportedParentWorkflowID,
                timestamp: yield* DateTime.now,
                type: unsupportedParentWorkflow.type,
                input: unsupportedParentWorkflow.input,
                budget: unsupportedParentWorkflow.budget,
                stages: [
                  { ...unsupportedParentStage, id: unsupportedParentStage.id! },
                  ...unsupportedParentStages.map((stage) => ({ ...stage, id: stage.id! })),
                ],
              })
              yield* responses.create({
                id: unsupportedParentID,
                workflowID: unsupportedParentWorkflowID,
                model: "deepseek-v4-flash",
                background: false,
                store: true,
                requestHash: `sha256:${unsupportedParentID}`,
                input: [{ type: "message", role: "user", content: "unsupported parent input" }],
              })
              yield* responses.complete({
                responseID: unsupportedParentID,
                output: [{ type: "reasoning", summary: "must not be silently replayed" }],
              })
            }).pipe(Effect.provide(coreLayer(databasePath)), Effect.scoped)
            const { OpenCode } = yield* Effect.promise(() => import("../src"))
            const opencode = yield* OpenCode.create()
            const { Tool } = yield* Effect.promise(() => import("../src"))
            yield* opencode.tools.register({
              read_file: Tool.make({
                description: "Read an offline file fixture",
                input: Schema.Struct({ path: Schema.String }),
                output: Schema.Struct({ output: Schema.String }),
                execute: ({ path }) =>
                  Effect.succeed({
                    output: path === "transient-sentinel.txt" ? transientToolSentinel : `offline:${path}`,
                  }),
              }),
            })
            yield* opencode.workflows.create(roleWorkflowInput(workflowID))
            const admitted = yield* opencode.responses.create({
              workflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: true,
              previous_response_id: parentID,
              requestHash,
              input: [{ type: "message", role: "user", content: "continue only" }],
            })
            if (Stream.isStream(admitted)) return yield* Effect.die("Expected JSON, received SSE")

            let workflow = yield* opencode.workflows.get({ workflowID })
            while (
              workflow.run.status !== "succeeded" &&
              workflow.run.status !== "failed" &&
              workflow.run.status !== "waiting_approval" &&
              workflow.run.status !== "cancelled"
            ) {
              yield* Effect.sleep(10)
              workflow = yield* opencode.workflows.get({ workflowID })
            }
            const response = yield* opencode.responses.get({ responseID: admitted.id })
            expect(workflow.run.status).toBe("succeeded")
            expect(response).toMatchObject({
              status: "completed",
              output: [
                { type: "function_call", name: "read_file" },
                { type: "function_call_output" },
                { type: "message", role: "assistant", content: roleOutcome("deliver") },
              ],
            })
            expect(workflow.artifacts.filter((artifact) => artifact.kind === "tool-continuation")).toHaveLength(1)
            const transientWorkflowID = Workflow.ID.make(`wfl_production_transient_${crypto.randomUUID()}`)
            yield* opencode.workflows.create(roleWorkflowInput(transientWorkflowID))
            const transient = yield* opencode.responses.create({
              workflowID: transientWorkflowID,
              model: "deepseek-v4-flash",
              background: false,
              store: false,
              requestHash: `sha256:transient:${crypto.randomUUID()}`,
              input: [{ type: "message", role: "user", content: "exercise transient tool continuation" }],
            })
            if (Stream.isStream(transient)) return yield* Effect.die("Expected JSON, received SSE")
            expect(transient).toMatchObject({
              status: "completed",
              store: false,
              output: [
                { type: "function_call", call_id: "call_transient_tool" },
                { type: "function_call_output" },
                { type: "message", role: "assistant" },
              ],
            })
            expect(JSON.stringify(transient.output)).toContain(transientToolSentinel)
            const noTransientRetrieval = yield* opencode.responses.get({ responseID: transient.id }).pipe(Effect.flip)
            expect(noTransientRetrieval._tag).toBe("ResponseNotFoundError")
            const unsupportedChildWorkflowID = Workflow.ID.make(
              `wfl_production_unsupported_child_${crypto.randomUUID()}`,
            )
            yield* opencode.workflows.create(roleWorkflowInput(unsupportedChildWorkflowID))
            const unsupported = yield* opencode.responses.create({
              workflowID: unsupportedChildWorkflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: true,
              previous_response_id: unsupportedParentID,
              requestHash: `sha256:unsupported:${crypto.randomUUID()}`,
              input: [{ type: "message", role: "user", content: "do not replace unsupported context" }],
            })
            if (Stream.isStream(unsupported)) return yield* Effect.die("Expected JSON, received SSE")
            expect(unsupported).toMatchObject({
              status: "failed",
              error: { code: "unsupported_response_context" },
            })
            return admitted.id
          }),
        ),
      )
    } finally {
      console.error = previousError
      embeddedProviderFetch = undefined
    }

    if (responseID === undefined) throw new Error("Generated production Response ID is missing")
    const productionURLs = [
      "https://api.moonshot.cn/v1/chat/completions",
      "https://api.moonshot.cn/v1/chat/completions",
      "https://api.deepseek.com/responses",
      "https://api.deepseek.com/responses",
      "https://api.moonshot.cn/v1/chat/completions",
      "https://api.deepseek.com/responses",
      "https://api.deepseek.com/responses",
    ]
    expect(requests.map((request) => request.url)).toEqual([
      ...productionURLs,
      ...productionURLs,
      ...productionURLs.slice(0, 5),
    ])
    const productionModels = [
      "kimi-k3",
      "kimi-k3",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "kimi-k3",
      "deepseek-v4-pro",
      "deepseek-v4-pro",
    ]
    expect(
      requests.map((request) =>
        typeof request.body === "object" && request.body !== null && "model" in request.body
          ? request.body.model
          : undefined,
      ),
    ).toEqual([
      ...productionModels,
      ...productionModels.slice(0, 5),
      "deepseek-v4-flash",
      "deepseek-v4-flash",
      ...productionModels.slice(0, 5),
    ])
    expect(requests.map((request) => request.authorization)).toEqual(
      Array.from({ length: 19 }, () => `Bearer ${authSentinel}`),
    )
    const deliver = requests[6]?.body
    expect(JSON.stringify(deliver)).toContain("parent input")
    expect(JSON.stringify(deliver)).toContain("call_parent_context")
    expect(JSON.stringify(deliver)).toContain("parent-context.md")
    expect(JSON.stringify(deliver)).toContain("parent tool output")
    expect(JSON.stringify(deliver)).toContain("parent output")
    expect(JSON.stringify(deliver)).toContain("continue only")
    expect(JSON.stringify(deliver)).toContain("call_delayed_tool")
    expect(JSON.stringify(deliver)).toContain("offline:README.md")
    expect(
      requests.map((request) => JSON.stringify(request.body).match(/"name":"read_file"/)?.[0] ?? "missing"),
    ).toEqual(Array.from({ length: 19 }, () => '"name":"read_file"'))
    expect(JSON.stringify(requests.map((request) => request.body))).not.toContain(authSentinel)
    expect(JSON.stringify(captured)).not.toContain(authSentinel)

    expect(responseID).toStartWith("resp_")
    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      replayEvents = serializedEventSnapshot(sqlite)
      const durable = JSON.stringify({
        events: sqlite.query("select type, data from event").all(),
        responses: sqlite.query("select * from response").all(),
        responseItems: sqlite.query("select * from response_item").all(),
        workflows: sqlite.query("select * from workflow_run").all(),
        stages: sqlite.query("select * from workflow_stage").all(),
        artifacts: sqlite.query("select * from workflow_artifact").all(),
        captured,
      })
      expect(durable).not.toContain(authSentinel)
      expect(durable).not.toContain(transientToolSentinel)
      expect(durable).toContain("workflow.model.continuation.transient")
      sourceProjection = responseProjectionSnapshot(sqlite)
    } finally {
      sqlite.close()
    }
    await withDatabase("production-bridge-replay", async ({ databasePath: replayPath }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventV2.Service
          yield* events.replayBatches(replayEvents)
        }).pipe(Effect.provide(coreLayer(replayPath)), Effect.scoped),
      )
      const replay = new SqliteDatabase(replayPath, { readonly: true })
      try {
        const rebuilt = JSON.stringify({
          events: replay.query("select type, data from event").all(),
          stages: replay.query("select checkpoint from workflow_stage").all(),
          artifacts: replay.query("select kind, metadata from workflow_artifact").all(),
        })
        expect(rebuilt).not.toContain(transientToolSentinel)
        expect(rebuilt).toContain("workflow.model.continuation.transient")
        expect(responseProjectionSnapshot(replay)).toEqual(sourceProjection)
      } finally {
        replay.close()
      }
    })
  })
}, 20_000)

test("production tool continuation survives a crash into incomplete without re-executing or double-counting", async () => {
  await withDatabase("production-continuation-restart", async ({ databasePath }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: "offline-deepseek" },
        })
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-kimi" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )

    const workflowID = Workflow.ID.make(`wfl_continuation_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_continuation_${crypto.randomUUID()}`)
    const roles = ["design", "decompose", "implement", "test", "visual_review", "deliver"] as const
    let initialRequests = 0
    let ownerAContinuationRequests = 0
    let ownerBContinuationRequests = 0
    let ownerCContinuationRequests = 0
    let toolExecutions = 0

    const ownerAClient = Layer.succeed(
      LLMClient.Service,
      LLMClient.Service.of({
        prepare: () => Effect.die("unused"),
        stream: () => Stream.die("unused"),
        generate: (request) => {
          const serialized = JSON.stringify(request.messages)
          if (serialized.includes('"type":"tool-result"')) {
            // Model request preparation has begun, but the recorded transport
            // has not dispatched yet. Closing owner A's scope at the durable
            // checkpoint simulates a process crash in this exact window.
            return Effect.sleep("10 seconds").pipe(
              Effect.tap(() => Effect.sync(() => ownerAContinuationRequests++)),
              Effect.andThen(Effect.never),
            )
          }
          const role = roles[initialRequests++]
          if (!role) return Effect.die("Unexpected initial provider request")
          return Effect.succeed(role === "deliver" ? llmToolResponse() : llmTextResponse(roleOutcome(role)))
        },
      }),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* ApplicationTools.Service
          const workflow = yield* WorkflowV2.Service
          const responses = yield* ResponsesV2.Service
          const execution = yield* WorkflowExecution.Service
          yield* tools.register({
            read_file: CoreTool.make({
              description: "Read a durable continuation fixture",
              input: Schema.Struct({ path: Schema.String }),
              output: Schema.Struct({ output: Schema.String }),
              execute: ({ path }) =>
                Effect.sync(() => {
                  toolExecutions++
                  return { output: `durable:${path}` }
                }),
            }),
          })
          yield* workflow.create(roleWorkflowInput(workflowID, undefined, 3))
          yield* responses.create({
            id: responseID,
            workflowID,
            model: "deepseek-v4-pro",
            background: false,
            store: true,
            requestHash: `sha256:${responseID}`,
            input: [{ type: "message", role: "user", content: "resume after tool" }],
          })
          yield* execution.wake
          const checkpoint = yield* workflow.events({ workflowID }).pipe(
            Stream.filter((event) => {
              if (event.type !== "workflow.stage.checkpointed") return false
              const activeTurn = event.data.checkpoint.activeTurn
              const results =
                typeof activeTurn === "object" && activeTurn !== null && "results" in activeTurn
                  ? activeTurn.results
                  : undefined
              return (
                Array.isArray(results) &&
                results.length === 1 &&
                !(typeof activeTurn === "object" && activeTurn !== null && "pendingCallID" in activeTurn)
              )
            }),
            Stream.runHead,
            Effect.timeout("5 seconds"),
          )
          expect(Option.isSome(checkpoint)).toBe(true)
        }),
      ).pipe(Effect.provide(continuationWorkerLayer(databasePath, "owner-A", ownerAClient))),
    )

    // Owner A's scope is gone. Let its fenced lease expire before owner B
    // performs normal restart-safe recovery against the same SQLite file.
    await Bun.sleep(225)

    const ownerBClient = Layer.succeed(
      LLMClient.Service,
      LLMClient.Service.of({
        prepare: () => Effect.die("unused"),
        stream: () => Stream.die("unused"),
        generate: (request) => {
          ownerBContinuationRequests++
          const serialized = JSON.stringify(request.messages)
          if (!serialized.includes("call_checkpoint_read") || !serialized.includes("durable:fixture.txt")) {
            return Effect.die("Restart did not replay the durable tool continuation")
          }
          return Effect.fail(
            new LLMError({
              module: "workflow-continuation-fixture",
              method: "generate",
              reason: new RateLimitReason({ message: "retry the restored continuation", retryAfterMs: 100 }),
            }),
          )
        },
      }),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* ApplicationTools.Service
          const workflow = yield* WorkflowV2.Service
          yield* tools.register({
            read_file: CoreTool.make({
              description: "Read a durable continuation fixture",
              input: Schema.Struct({ path: Schema.String }),
              output: Schema.Struct({ output: Schema.String }),
              execute: ({ path }) =>
                Effect.sync(() => {
                  toolExecutions++
                  return { output: `duplicate:${path}` }
                }),
            }),
          })
          const retry = yield* workflow.events({ workflowID }).pipe(
            Stream.filter(
              (event) => event.type === "workflow.stage.retry_scheduled" && event.data.failure.code === "rate_limit",
            ),
            Stream.runHead,
            Effect.timeout("5 seconds"),
          )
          expect(Option.isSome(retry)).toBe(true)
        }),
      ).pipe(Effect.provide(continuationWorkerLayer(databasePath, "owner-B", ownerBClient))),
    )

    await Bun.sleep(225)

    const ownerCClient = Layer.succeed(
      LLMClient.Service,
      LLMClient.Service.of({
        prepare: () => Effect.die("unused"),
        stream: () => Stream.die("unused"),
        generate: (request) => {
          ownerCContinuationRequests++
          const serialized = JSON.stringify(request.messages)
          if (!serialized.includes("call_checkpoint_read") || !serialized.includes("durable:fixture.txt")) {
            return Effect.die("Retry did not replay the durable tool continuation")
          }
          return Effect.succeed(llmIncompleteResponse())
        },
      }),
    )

    const settled = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workflow = yield* WorkflowV2.Service
          const responses = yield* ResponsesV2.Service
          const terminal = yield* workflow.events({ workflowID }).pipe(
            Stream.filter((event) => event.type === "workflow.succeeded" || event.type === "workflow.failed"),
            Stream.runHead,
            Effect.timeout("5 seconds"),
          )
          expect(Option.isSome(terminal)).toBe(true)
          return {
            workflow: yield* workflow.get(workflowID),
            response: yield* responses.get(responseID),
          }
        }),
      ).pipe(Effect.provide(continuationWorkerLayer(databasePath, "owner-C", ownerCClient))),
    )

    const deliverStage = settled.workflow.stages.find((stage) => stage.type === "deliver")
    if (!deliverStage) throw new Error("Expected the recovered deliver stage")
    expect(settled.workflow.run.status).toBe("failed")
    expect(deliverStage).toMatchObject({
      status: "failed",
      attempt: 3,
      error: { code: "provider_output_incomplete" },
    })
    expect(settled.workflow.run.usage).toEqual({ tokens: 42, turns: 7, toolCalls: 1, attempts: 8 })
    expect(settled.response).toMatchObject({
      status: "incomplete",
      error: { code: "provider_incomplete" },
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      output: [
        { type: "function_call", call_id: "call_checkpoint_read" },
        { type: "function_call_output", call_id: "call_checkpoint_read" },
        { type: "message", role: "assistant", content: roleOutcome("deliver") },
      ],
    })
    expect(toolExecutions).toBe(1)
    expect(initialRequests).toBe(6)
    expect(ownerAContinuationRequests).toBe(0)
    expect(ownerBContinuationRequests).toBe(1)
    expect(ownerCContinuationRequests).toBe(1)
    expect(settled.workflow.artifacts.filter((artifact) => artifact.kind === "tool-continuation")).toHaveLength(0)

    const staleOwner = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const timestamp = yield* DateTime.now
        const checkpoint = yield* events
          .publish(WorkflowEvent.Stage.Checkpointed, {
            workflowID,
            stageID: deliverStage.id,
            timestamp,
            attempt: 1,
            leaseOwner: "owner-A",
            checkpoint: { stale: true },
          })
          .pipe(Effect.exit)
        const settlement = yield* events
          .publish(WorkflowEvent.Stage.Succeeded, {
            workflowID,
            stageID: deliverStage.id,
            timestamp,
            attempt: 1,
            leaseOwner: "owner-A",
            usage: { tokens: 999, turns: 999, toolCalls: 999, attempts: 0 },
          })
          .pipe(Effect.exit)
        return { checkpoint, settlement }
      }).pipe(Effect.provide(coreLayer(databasePath)), Effect.scoped),
    )
    expect(staleOwner.checkpoint._tag).toBe("Failure")
    expect(staleOwner.settlement._tag).toBe("Failure")

    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      expect(durableStageAttempts(sqlite, workflowID).slice(-3)).toEqual([1, 2, 3])
      const retryUsage = sqlite
        .query("select data from event where aggregate_id = ? and type = ? order by seq")
        .all(workflowID, durableType(WorkflowEvent.Stage.RetryScheduled))
        .map((row) => {
          if (!row || typeof row !== "object" || !("data" in row) || typeof row.data !== "string") return undefined
          return JSON.parse(row.data) as { failure?: { code?: string }; usage?: unknown }
        })
        .find((data) => data?.failure?.code === "rate_limit")?.usage
      expect(retryUsage).toEqual({ tokens: 0, turns: 0, toolCalls: 0, attempts: 0 })
      expect(durableEventCount(sqlite, workflowID, [durableType(WorkflowEvent.Stage.Checkpointed)]).count).toBe(2)
      expect(durableEventCount(sqlite, workflowID, workflowTerminalTypes).count).toBe(1)
      expect(
        sqlite
          .query(
            "select count(*) as count from event where aggregate_id = ? and type = ? and json_extract(data, '$.stageID') = ?",
          )
          .get(workflowID, durableType(WorkflowEvent.Stage.Failed), deliverStage.id),
      ).toEqual({ count: 1 })
    } finally {
      sqlite.close()
    }
  })
}, 20_000)

test("production tool pending intent survives a pre-result crash without re-executing the side effect", async () => {
  await withDatabase("production-tool-pending-crash", async ({ databasePath }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: "offline-deepseek" },
        })
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-kimi" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )

    const workflowID = Workflow.ID.make(`wfl_tool_pending_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_tool_pending_${crypto.randomUUID()}`)
    const roles = ["design", "decompose", "implement", "test", "visual_review", "deliver"] as const
    const toolStarted = await Effect.runPromise(Deferred.make<void>())
    let initialRequests = 0
    let recoveryRequests = 0
    let toolExecutions = 0
    const ownerAClient = Layer.succeed(
      LLMClient.Service,
      LLMClient.Service.of({
        prepare: () => Effect.die("unused"),
        stream: () => Stream.die("unused"),
        generate: () => {
          const role = roles[initialRequests++]
          if (!role) return Effect.die("Unexpected owner-A provider request")
          return Effect.succeed(role === "deliver" ? llmToolResponse() : llmTextResponse(roleOutcome(role)))
        },
      }),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* ApplicationTools.Service
          const workflow = yield* WorkflowV2.Service
          const responses = yield* ResponsesV2.Service
          const execution = yield* WorkflowExecution.Service
          yield* tools.register({
            read_file: CoreTool.make({
              description: "Block after the production side effect and before its result checkpoint",
              input: Schema.Struct({ path: Schema.String }),
              output: Schema.Struct({ output: Schema.String }),
              execute: ({ path }) =>
                Effect.sync(() => {
                  toolExecutions++
                  return { output: `ambiguous:${path}` }
                }).pipe(
                  Effect.tap(() => Deferred.succeed(toolStarted, undefined)),
                  Effect.andThen(Effect.never),
                ),
            }),
          })
          yield* workflow.create(roleWorkflowInput(workflowID, undefined, 3))
          yield* responses.create({
            id: responseID,
            workflowID,
            model: "deepseek-v4-pro",
            background: false,
            store: true,
            requestHash: `sha256:${responseID}`,
            input: [{ type: "message", role: "user", content: "do not duplicate the local side effect" }],
          })
          yield* execution.wake
          yield* Deferred.await(toolStarted).pipe(Effect.timeout("5 seconds"))
        }),
      ).pipe(Effect.provide(continuationWorkerLayer(databasePath, "pending-owner-A", ownerAClient))),
    )

    await Bun.sleep(225)
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const deepseek = (yield* credentials.all()).find((credential) => credential.integrationID === "deepseek")
        if (!deepseek) return yield* Effect.die("Expected the DeepSeek credential used by owner A")
        yield* credentials.remove(deepseek.id)
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )
    const ownerBClient = Layer.succeed(
      LLMClient.Service,
      LLMClient.Service.of({
        prepare: () => Effect.die("unused"),
        stream: () => Stream.die("unused"),
        generate: (request) => {
          recoveryRequests++
          return Effect.succeed(
            JSON.stringify(request.messages).includes('"type":"tool-result"')
              ? llmTextResponse(roleOutcome("deliver"))
              : llmToolResponse(),
          )
        },
      }),
    )

    const recovered = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* ApplicationTools.Service
          const workflow = yield* WorkflowV2.Service
          yield* tools.register({
            read_file: CoreTool.make({
              description: "A recovery tool that must remain fenced",
              input: Schema.Struct({ path: Schema.String }),
              output: Schema.Struct({ output: Schema.String }),
              execute: ({ path }) =>
                Effect.sync(() => {
                  toolExecutions++
                  return { output: `duplicate:${path}` }
                }),
            }),
          })
          for (let index = 0; index < 300; index++) {
            const detail = yield* workflow.get(workflowID)
            if (detail.run.status === "waiting_approval" || detail.run.status === "succeeded") return detail
            yield* Effect.sleep(10)
          }
          return yield* Effect.die("Timed out waiting for pending-tool recovery")
        }),
      ).pipe(Effect.provide(continuationWorkerLayer(databasePath, "pending-owner-B", ownerBClient))),
    )

    const deliver = recovered.stages.find((stage) => stage.type === "deliver")
    expect(recovered.run.status).toBe("waiting_approval")
    expect(deliver).toMatchObject({
      status: "waiting_approval",
      attempt: 2,
      error: { category: "ambiguous", code: "tool_execution_ambiguous" },
      checkpoint: {
        kind: "workflow.model.continuation",
        activeTurn: { pendingCallID: "call_checkpoint_read", results: [] },
      },
    })
    expect(toolExecutions).toBe(1)
    expect(initialRequests).toBe(6)
    expect(recoveryRequests).toBe(0)

    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: "offline-deepseek-recovery" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )

    const terminal = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* ApplicationTools.Service
          const workflow = yield* WorkflowV2.Service
          const responses = yield* ResponsesV2.Service
          const execution = yield* WorkflowExecution.Service
          yield* tools.register({
            read_file: CoreTool.make({
              description: "Explicitly authorized recovery replay",
              input: Schema.Struct({ path: Schema.String }),
              output: Schema.Struct({ output: Schema.String }),
              execute: ({ path }) =>
                Effect.sync(() => {
                  toolExecutions++
                  return { output: `authorized:${path}` }
                }),
            }),
          })
          yield* workflow.resolveRecovery({ workflowID, stageID: deliver!.id, action: "retry" })
          yield* execution.wake
          for (let index = 0; index < 300; index++) {
            const detail = yield* workflow.get(workflowID)
            if (detail.run.status === "succeeded") {
              return { detail, response: yield* responses.get(responseID) }
            }
            if (detail.run.status === "waiting_approval") {
              return yield* Effect.die("Authorized retry returned to ambiguous approval without executing")
            }
            yield* Effect.sleep(10)
          }
          return yield* Effect.die("Timed out waiting for authorized tool recovery")
        }),
      ).pipe(Effect.provide(continuationWorkerLayer(databasePath, "pending-owner-C", ownerBClient))),
    )
    expect(terminal.detail.run.status).toBe("succeeded")
    expect(terminal.detail.run.usage.toolCalls).toBe(2)
    expect(terminal.response.status).toBe("completed")
    expect(toolExecutions).toBe(2)
    expect(recoveryRequests).toBe(1)
  })
}, 20_000)

test("HTTP cancellation atomically cancels a Response and fences a late production tool result", async () => {
  await withDatabase("http-cancel-tool-fence", async ({ databasePath }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: "offline-fixture" },
        })
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-fixture" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )

    let markToolStarted!: () => void
    const toolStarted = new Promise<void>((resolve) => (markToolStarted = resolve))
    let releaseTool!: () => void
    const toolRelease = new Promise<void>((resolve) => (releaseTool = resolve))
    let markToolSettled!: () => void
    const toolSettled = new Promise<void>((resolve) => (markToolSettled = resolve))
    let toolHasSettled = false
    const providerBodies: unknown[] = []
    const roles = ["design", "decompose", "implement", "test", "visual_review", "deliver"] as const
    let providerRequest = 0
    embeddedProviderFetch = async (input, init) => {
      const web = new Request(input, init)
      providerBodies.push(await web.json())
      const role = roles[providerRequest++]
      if (!role) throw new Error("Cancellation attempted an unexpected provider continuation")
      const body =
        role === "deliver"
          ? deepSeekDelayedToolSSE()
          : role === "design" || role === "decompose" || role === "visual_review"
            ? kimiRoleSSE(role)
            : deepSeekRoleSSE(role)
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }

    const workflowID = Workflow.ID.make(`wfl_http_cancel_tool_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_http_cancel_tool_${crypto.randomUUID()}`)
    const resultSentinel = "TASK20_LATE_PRODUCTION_TOOL_RESULT_DO_NOT_STORE"
    let cancellationHistory: EventV2.SerializedEvent[] = []
    let cancellationProjection: ReturnType<typeof responseProjectionSnapshot> | undefined
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { OpenCode, Tool } = yield* Effect.promise(() => import("../src"))
            const opencode = yield* OpenCode.create()
            yield* opencode.tools.register({
              read_file: Tool.make({
                description: "Delayed production read",
                input: Schema.Struct({ path: Schema.String }),
                output: Schema.Struct({ output: Schema.String }),
                execute: ({ path }) =>
                  Effect.uninterruptible(
                    Effect.promise(async () => {
                      markToolStarted()
                      await toolRelease
                      toolHasSettled = true
                      markToolSettled()
                      return { output: `${resultSentinel}:${path}` }
                    }),
                  ),
              }),
            })
            yield* opencode.workflows.create(roleWorkflowInput(workflowID, responseID))
            yield* opencode.responses.create({
              id: responseID,
              workflowID,
              model: "deepseek-v4-pro",
              background: true,
              store: true,
              requestHash: `sha256:${responseID}`,
              input: [{ type: "message", role: "user", content: "run the delayed read" }],
            })

            yield* Effect.promise(() => toolStarted).pipe(
              Effect.timeout("2 seconds"),
              Effect.catchTag("TimeoutError", () =>
                opencode.workflows.get({ workflowID }).pipe(
                  Effect.flatMap((workflow) =>
                    Effect.die(
                      `Tool did not start: ${JSON.stringify({
                        status: workflow.run.status,
                        stages: workflow.stages.map((stage) => ({ status: stage.status, error: stage.error })),
                        providerBodies,
                      })}`,
                    ),
                  ),
                ),
              ),
            )
            expect(JSON.stringify(providerBodies.at(-1))).toContain("read_file")
            const cancelled = yield* opencode.responses.cancel({ responseID }).pipe(Effect.timeout("500 millis"))
            expect(cancelled.status).toBe("cancelled")
            expect(toolHasSettled).toBe(false)
            expect((yield* opencode.responses.get({ responseID })).status).toBe("cancelled")
            releaseTool()
            yield* Effect.promise(() => toolSettled).pipe(Effect.timeout("2 seconds"))

            let workflow = yield* opencode.workflows.get({ workflowID })
            while (workflow.run.status !== "cancelled") {
              yield* Effect.sleep(10)
              workflow = yield* opencode.workflows.get({ workflowID })
            }
            const deliverStage = workflow.stages.find((stage) => stage.type === "deliver")
            expect(deliverStage).toBeDefined()
            expect(workflow.artifacts.filter((artifact) => artifact.stageID === deliverStage?.id)).toEqual([])
            expect(workflow.artifacts.map((artifact) => artifact.kind)).not.toContain("tool-continuation")
            expect((yield* opencode.responses.get({ responseID })).status).toBe("cancelled")
          }),
        ),
      )
    } finally {
      releaseTool()
      embeddedProviderFetch = undefined
    }

    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      const responseEvents = sqlite
        .query("select type from event where aggregate_id = ? order by seq")
        .all(responseID)
        .map((row) => (row as { type: string }).type)
      const workflowEvents = sqlite
        .query("select type from event where aggregate_id = ? order by seq")
        .all(workflowID)
        .map((row) => (row as { type: string }).type)
      expect(responseEvents).toEqual([
        durableType(ResponseEvent.Created),
        durableType(ResponseEvent.InProgress),
        durableType(ResponseEvent.Cancelled),
      ])
      expect(workflowEvents.filter((type) => type === durableType(WorkflowEvent.CancelRequested))).toHaveLength(1)
      expect(workflowEvents.filter((type) => workflowStageTerminalTypes.includes(type))).toEqual([
        ...Array.from({ length: 5 }, () => durableType(WorkflowEvent.Stage.Succeeded)),
        durableType(WorkflowEvent.Stage.Cancelled),
      ])
      expect(workflowEvents.filter((type) => workflowTerminalTypes.includes(type))).toEqual([
        durableType(WorkflowEvent.Cancelled),
      ])
      expect(providerBodies).toHaveLength(6)
      expect(
        JSON.stringify({
          events: sqlite.query("select type, data from event").all(),
          responses: sqlite.query("select * from response").all(),
          workflows: sqlite.query("select * from workflow_run").all(),
          stages: sqlite.query("select * from workflow_stage").all(),
          artifacts: sqlite.query("select * from workflow_artifact").all(),
        }),
      ).not.toContain(resultSentinel)
      cancellationHistory = serializedEventSnapshot(sqlite)
      cancellationProjection = responseProjectionSnapshot(sqlite)
    } finally {
      sqlite.close()
    }
    await withDatabase("http-cancel-tool-fence-replay", async ({ databasePath: replayPath }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventV2.Service
          yield* events.replayBatches(cancellationHistory)
        }).pipe(Effect.provide(coreLayer(replayPath)), Effect.scoped),
      )
      const replay = new SqliteDatabase(replayPath, { readonly: true })
      try {
        expect(responseProjectionSnapshot(replay)).toEqual(cancellationProjection)
        expect(
          JSON.stringify({
            events: replay.query("select type, data from event").all(),
            projection: responseProjectionSnapshot(replay),
          }),
        ).not.toContain(resultSentinel)
      } finally {
        replay.close()
      }
    })
  })
}, 20_000)

test("concurrent HTTP retries with one request hash admit one response for one workflow", async () => {
  await withDatabase("http-idempotency", async ({ databasePath }) => {
    const { OpenCode } = await import("../src")
    const workflowID = Workflow.ID.make(`wfl_http_idempotency_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_http_idempotency_${crypto.randomUUID()}`)
    const requestHash = `sha256:http-idempotency:${crypto.randomUUID()}`
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-fixture" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )
    let markProviderStarted!: () => void
    const providerStarted = new Promise<void>((resolve) => (markProviderStarted = resolve))
    let releaseProvider!: () => void
    const providerRelease = new Promise<void>((resolve) => (releaseProvider = resolve))
    const providerRequests: string[] = []
    embeddedProviderFetch = async (input, init) => {
      const web = new Request(input, init)
      providerRequests.push(web.url)
      markProviderStarted()
      await providerRelease
      return new Response(
        [
          {
            id: "chatcmpl_idempotency",
            choices: [{ delta: { content: "invalid role outcome" }, finish_reason: null }],
          },
          { id: "chatcmpl_idempotency", choices: [{ delta: {}, finish_reason: "stop" }] },
          {
            id: "chatcmpl_idempotency",
            choices: [],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    let responses: Responses.Resource[]
    try {
      responses = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const opencode = yield* OpenCode.create()
            yield* opencode.workflows.create({
              id: workflowID,
              type: "responses-http-idempotency",
              input: {},
              budget: { maxAttempts: 1 },
              stages: [
                {
                  type: "design",
                  ordinal: 0,
                  maxAttempts: 1,
                  recoveryPolicy: "restart_safe",
                  idempotencyKey: `responses/${workflowID}/design`,
                  input: {},
                },
                {
                  type: "deliver",
                  ordinal: 1,
                  maxAttempts: 1,
                  recoveryPolicy: "restart_safe",
                  idempotencyKey: `responses/${workflowID}/deliver`,
                  input: { responseID },
                },
              ],
            })
            yield* Effect.promise(() => providerStarted).pipe(Effect.timeout("2 seconds"))
            const results = yield* Effect.all(
              Array.from({ length: 2 }, () =>
                opencode.responses.create({
                  id: responseID,
                  workflowID,
                  model: "deepseek-v4-pro",
                  background: true,
                  store: true,
                  requestHash,
                  input: [{ type: "message", role: "user", content: "retry the same request" }],
                }),
              ),
              { concurrency: "unbounded" },
            )
            const admitted = yield* Effect.forEach(results, (response) =>
              Stream.isStream(response) ? Effect.die("Expected JSON, received SSE") : Effect.succeed(response),
            )
            releaseProvider()
            let workflow = yield* opencode.workflows.get({ workflowID })
            for (let index = 0; index < 200 && workflow.run.status !== "failed"; index++) {
              yield* Effect.sleep(10)
              workflow = yield* opencode.workflows.get({ workflowID })
            }
            if (workflow.run.status !== "failed") {
              return yield* Effect.die(`Expected failed workflow, received ${workflow.run.status}`)
            }
            return admitted
          }),
        ),
      )
    } finally {
      embeddedProviderFetch = undefined
    }

    expect(responses[0]?.id).toBe(responses[1]?.id)
    expect(responses.map((response) => response.workflowID)).toEqual([workflowID, workflowID])
    expect(providerRequests).toEqual(["https://api.moonshot.cn/v1/chat/completions"])
    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      expect(sqlite.query("select count(*) as count from response where request_hash = ?").get(requestHash)).toEqual({
        count: 1,
      })
      expect(sqlite.query("select count(*) as count from workflow_run where id = ?").get(workflowID)).toEqual({
        count: 1,
      })
      expect(durableEventCount(sqlite, responseID, [durableType(ResponseEvent.Created)])).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, workflowID, [durableType(WorkflowEvent.Stage.Leased)])).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, workflowID, [durableType(WorkflowEvent.Stage.Started)])).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, workflowID, workflowStageTerminalTypes)).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, workflowID, workflowTerminalTypes)).toEqual({ count: 1 })
    } finally {
      sqlite.close()
    }
  })
}, 10_000)

test("foreground JSON POST waits for and returns the complete terminal Response", async () => {
  await withDatabase("foreground-post-json", async ({ databasePath }) => {
    const workflowID = Workflow.ID.make(`wfl_foreground_post_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_foreground_post_${crypto.randomUUID()}`)
    const unrelatedResponseID = Responses.ID.make(`resp_unrelated_deliver_${crypto.randomUUID()}`)
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: "offline-deepseek" },
        })
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-kimi" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )
    const roles = ["design", "decompose", "implement", "test", "visual_review", "deliver"] as const
    let request = 0
    embeddedProviderFetch = async () => {
      const role = roles[request++]
      if (!role) throw new Error("Foreground POST attempted an unexpected provider request")
      const body =
        role === "design" || role === "decompose" || role === "visual_review"
          ? kimiRoleSSE(role)
          : deepSeekRoleSSE(role)
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { OpenCode } = yield* Effect.promise(() => import("../src"))
            const opencode = yield* OpenCode.create()
            const workflowInput = roleWorkflowInput(workflowID, responseID)
            yield* opencode.workflows.create({
              ...workflowInput,
              budget: { maxAttempts: 7 },
              stages: [
                ...workflowInput.stages,
                {
                  ...roleStage(workflowID, "deliver", 6, unrelatedResponseID),
                  id: Workflow.StageID.make(`wfs_unrelated_${workflowID.slice(4)}`),
                  idempotencyKey: `responses/${workflowID}/deliver-unrelated`,
                },
              ],
            })
            const created = yield* opencode.responses.create({
              id: responseID,
              workflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: true,
              stream: false,
              requestHash: `sha256:${responseID}`,
              input: [{ type: "message", role: "user", content: "wait for terminal JSON" }],
            })
            if (Stream.isStream(created)) return yield* Effect.die("Expected JSON, received SSE")
            expect(created).toMatchObject({
              id: responseID,
              status: "completed",
              output: [{ type: "message", role: "assistant" }],
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            })
            expect(request).toBe(6)
          }),
        ),
      )
    } finally {
      embeddedProviderFetch = undefined
    }
  })
}, 15_000)

test("foreground streaming POST returns one semantic SSE lifecycle ending at the terminal event", async () => {
  await withDatabase("foreground-post-sse", async ({ databasePath }) => {
    const workflowID = Workflow.ID.make(`wfl_foreground_sse_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_foreground_sse_${crypto.randomUUID()}`)
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: "offline-deepseek" },
        })
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-kimi" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )
    const roles = ["design", "decompose", "implement", "test", "visual_review", "deliver"] as const
    let request = 0
    embeddedProviderFetch = async () => {
      const role = roles[request++]
      if (!role) throw new Error("Streaming POST attempted an unexpected provider request")
      const body =
        role === "design" || role === "decompose" || role === "visual_review"
          ? kimiRoleSSE(role)
          : deepSeekRoleSSE(role)
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { OpenCode } = yield* Effect.promise(() => import("../src"))
            const opencode = yield* OpenCode.create()
            yield* opencode.workflows.create(roleWorkflowInput(workflowID))
            const created = yield* opencode.responses.create({
              id: responseID,
              workflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: true,
              stream: true,
              requestHash: `sha256:${responseID}`,
              input: [{ type: "message", role: "user", content: "stream one lifecycle" }],
            })
            if (!Stream.isStream(created)) return yield* Effect.die("Expected SSE, received JSON")
            const streamed = Array.from(yield* created.pipe(Stream.runCollect))
            expect(streamed.map((event) => [event.type, event.sequenceNumber])).toEqual([
              ["response.created", 0],
              ["response.in_progress", 1],
              ["response.completed", 2],
            ])
            expect(
              streamed.filter(
                (event) =>
                  event.type === "response.completed" ||
                  event.type === "response.incomplete" ||
                  event.type === "response.failed" ||
                  event.type === "response.cancelled",
              ),
            ).toHaveLength(1)
            expect(request).toBe(6)
          }),
        ),
      )
    } finally {
      embeddedProviderFetch = undefined
    }
  })
}, 15_000)

test("foreground store:false POST returns its terminal payload once without enabling later retrieval", async () => {
  await withDatabase("foreground-post-transient", async ({ databasePath }) => {
    const workflowID = Workflow.ID.make(`wfl_foreground_transient_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_foreground_transient_${crypto.randomUUID()}`)
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: "offline-deepseek" },
        })
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-kimi" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )
    const roles = ["design", "decompose", "implement", "test", "visual_review", "deliver"] as const
    let request = 0
    embeddedProviderFetch = async () => {
      const role = roles[request++]
      if (!role) throw new Error("Transient POST attempted an unexpected provider request")
      const body =
        role === "design" || role === "decompose" || role === "visual_review"
          ? kimiRoleSSE(role)
          : deepSeekRoleSSE(role)
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { OpenCode } = yield* Effect.promise(() => import("../src"))
            const opencode = yield* OpenCode.create()
            yield* opencode.workflows.create(roleWorkflowInput(workflowID))
            const input = {
              id: responseID,
              workflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: false,
              stream: false,
              requestHash: `sha256:${responseID}`,
              input: [{ type: "message", role: "user", content: "return once, do not persist" }],
            } as const
            const createdResponses = yield* Effect.all(
              [opencode.responses.create(input), opencode.responses.create(input)],
              { concurrency: "unbounded" },
            )
            if (createdResponses.some(Stream.isStream)) {
              return yield* Effect.die("Expected transient JSON, received SSE")
            }
            const [created, duplicate] = createdResponses
            expect(created).toMatchObject({
              id: responseID,
              status: "completed",
              store: false,
              output: [{ type: "message", role: "assistant" }],
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            })
            expect(duplicate).toEqual(created)
            expect((yield* opencode.responses.get({ responseID }).pipe(Effect.flip))._tag).toBe("ResponseNotFoundError")
            expect((yield* opencode.responses.inputItems({ responseID }).pipe(Effect.flip))._tag).toBe(
              "ResponseNotFoundError",
            )
            expect(request).toBe(6)
          }),
        ),
      )
    } finally {
      embeddedProviderFetch = undefined
    }
  })
}, 15_000)

test("foreground store:false streaming POST returns the transient terminal payload without durable retrieval", async () => {
  await withDatabase("foreground-post-transient-sse", async ({ databasePath }) => {
    const workflowID = Workflow.ID.make(`wfl_foreground_transient_sse_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_foreground_transient_sse_${crypto.randomUUID()}`)
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: "offline-deepseek" },
        })
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-kimi" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )
    const roles = ["design", "decompose", "implement", "test", "visual_review", "deliver"] as const
    let request = 0
    embeddedProviderFetch = async () => {
      const role = roles[request++]
      if (!role) throw new Error("Transient streaming POST attempted an unexpected provider request")
      const body =
        role === "design" || role === "decompose" || role === "visual_review"
          ? kimiRoleSSE(role)
          : deepSeekRoleSSE(role)
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { OpenCode } = yield* Effect.promise(() => import("../src"))
            const opencode = yield* OpenCode.create()
            yield* opencode.workflows.create(roleWorkflowInput(workflowID))
            const created = yield* opencode.responses.create({
              id: responseID,
              workflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: false,
              stream: true,
              requestHash: `sha256:${responseID}`,
              input: [{ type: "message", role: "user", content: "stream once, do not persist" }],
            })
            if (!Stream.isStream(created)) return yield* Effect.die("Expected transient SSE, received JSON")
            const streamed = Array.from(yield* created.pipe(Stream.runCollect))
            expect(streamed.map((event) => [event.type, event.sequenceNumber])).toEqual([
              ["response.created", 0],
              ["response.in_progress", 1],
              ["response.completed", 2],
            ])
            expect(streamed.at(-1)).toMatchObject({
              type: "response.completed",
              data: {
                responseID,
                output: [{ type: "message", role: "assistant" }],
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              },
            })
            expect((yield* opencode.responses.get({ responseID }).pipe(Effect.flip))._tag).toBe("ResponseNotFoundError")
            expect(request).toBe(6)
          }),
        ),
      )
    } finally {
      embeddedProviderFetch = undefined
    }
  })
}, 15_000)

test("a pre-deliver provider failure atomically fails the bound foreground Response after one execution", async () => {
  await withDatabase("foreground-pre-deliver-failure", async ({ databasePath }) => {
    const workflowID = Workflow.ID.make(`wfl_pre_deliver_failure_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_pre_deliver_failure_${crypto.randomUUID()}`)
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-kimi" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )
    let executions = 0
    embeddedProviderFetch = async () => {
      executions++
      return new Response(
        [
          { id: "chatcmpl_invalid", choices: [{ delta: { content: "not a role outcome" }, finish_reason: null }] },
          { id: "chatcmpl_invalid", choices: [{ delta: {}, finish_reason: "stop" }] },
          { id: "chatcmpl_invalid", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    }

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { OpenCode } = yield* Effect.promise(() => import("../src"))
            const opencode = yield* OpenCode.create()
            yield* opencode.workflows.create(roleWorkflowInput(workflowID))
            const failed = yield* opencode.responses.create({
              id: responseID,
              workflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: true,
              stream: false,
              requestHash: `sha256:${responseID}`,
              input: [{ type: "message", role: "user", content: "fail before deliver" }],
            })
            if (Stream.isStream(failed)) return yield* Effect.die("Expected JSON, received SSE")
            expect(failed).toMatchObject({ id: responseID, status: "failed" })
            expect((yield* opencode.workflows.get({ workflowID })).run.status).toBe("failed")

            const transientWorkflowID = Workflow.ID.make(`wfl_pre_deliver_transient_${crypto.randomUUID()}`)
            const transientResponseID = Responses.ID.make(`resp_pre_deliver_transient_${crypto.randomUUID()}`)
            yield* opencode.workflows.create(roleWorkflowInput(transientWorkflowID))
            const transient = yield* opencode.responses.create({
              id: transientResponseID,
              workflowID: transientWorkflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: false,
              stream: true,
              requestHash: `sha256:${transientResponseID}`,
              input: [{ type: "message", role: "user", content: "fail before response start" }],
            })
            if (!Stream.isStream(transient)) return yield* Effect.die("Expected SSE, received JSON")
            const streamed = Array.from(yield* transient.pipe(Stream.runCollect))
            expect(streamed.map((event) => [event.type, event.sequenceNumber])).toEqual([
              ["response.created", 0],
              ["response.failed", 1],
            ])
            expect(
              streamed.filter(
                (event) =>
                  event.type === "response.completed" ||
                  event.type === "response.incomplete" ||
                  event.type === "response.failed" ||
                  event.type === "response.cancelled",
              ),
            ).toHaveLength(1)
            expect((yield* opencode.responses.get({ responseID: transientResponseID }).pipe(Effect.flip))._tag).toBe(
              "ResponseNotFoundError",
            )
            expect(executions).toBe(2)
          }),
        ),
      )
    } finally {
      embeddedProviderFetch = undefined
    }
  })
}, 15_000)

test("production hosted web search persists to output and conversation and replays through previous_response_id", async () => {
  await withDatabase("hosted-search-production", async ({ databasePath }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: "offline-deepseek" },
        })
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-kimi" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )

    const roles = ["design", "decompose", "implement", "test", "visual_review", "deliver"] as const
    const requests: unknown[] = []
    let requestNumber = 0
    embeddedProviderFetch = async (input, init) => {
      const web = new Request(input, init)
      requests.push(await web.json())
      const role = roles[requestNumber % roles.length]
      const workflowNumber = Math.floor(requestNumber++ / roles.length)
      if (!role) throw new Error("Unexpected hosted-search provider request")
      const body =
        role === "deliver" && workflowNumber === 0
          ? deepSeekHostedSearchRoleSSE(role)
          : role === "design" || role === "decompose" || role === "visual_review"
            ? kimiRoleSSE(role)
            : deepSeekRoleSSE(role)
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }

    const parentWorkflowID = Workflow.ID.make(`wfl_hosted_parent_${crypto.randomUUID()}`)
    const parentID = Responses.ID.make(`resp_hosted_parent_${crypto.randomUUID()}`)
    const childWorkflowID = Workflow.ID.make(`wfl_hosted_child_${crypto.randomUUID()}`)
    const childID = Responses.ID.make(`resp_hosted_child_${crypto.randomUUID()}`)
    const conversationID = Responses.ConversationID.make(`conv_hosted_${crypto.randomUUID()}`)
    let history: EventV2.SerializedEvent[] = []
    let sourceProjection: ReturnType<typeof responseProjectionSnapshot> | undefined
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { OpenCode } = yield* Effect.promise(() => import("../src"))
            const opencode = yield* OpenCode.create()
            yield* opencode.conversations.create({ id: conversationID, metadata: {} })
            yield* opencode.workflows.create(roleWorkflowInput(parentWorkflowID))
            const parent = yield* opencode.responses.create({
              id: parentID,
              workflowID: parentWorkflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: true,
              stream: false,
              conversation: conversationID,
              requestHash: `sha256:${parentID}`,
              input: [{ type: "message", role: "user", content: "perform hosted search" }],
            })
            if (Stream.isStream(parent)) return yield* Effect.die("Expected JSON, received SSE")
            expect(parent).toMatchObject({
              status: "completed",
              output: [
                {
                  type: "web_search_call",
                  id: "search_production_1",
                  status: "completed",
                  action: { type: "search", query: "Task20 hosted replay" },
                  results: [{ title: "Recorded result", url: "https://example.test/recorded" }],
                },
                {
                  type: "web_search_call",
                  id: "search_production_failed",
                  status: "failed",
                  action: { type: "search", query: "Task20 failed hosted replay" },
                  error: { code: "search_unavailable", message: "offline hosted fixture" },
                },
                { type: "message", role: "assistant" },
              ],
            })
            const conversation = yield* opencode.conversations.items({ conversationID })
            expect(conversation.map((item) => item.payload).filter((item) => item.type === "web_search_call")).toEqual([
              parent.output[0],
              parent.output[1],
            ])

            yield* opencode.workflows.create(roleWorkflowInput(childWorkflowID))
            const child = yield* opencode.responses.create({
              id: childID,
              workflowID: childWorkflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: true,
              stream: false,
              previous_response_id: parentID,
              requestHash: `sha256:${childID}`,
              input: [{ type: "message", role: "user", content: "continue after hosted search" }],
            })
            if (Stream.isStream(child)) return yield* Effect.die("Expected JSON, received SSE")
            expect(child.status).toBe("completed")
          }),
        ),
      )
    } finally {
      embeddedProviderFetch = undefined
    }

    expect(requests).toHaveLength(12)
    const replayInput = (requests[11] as { input: Array<Record<string, unknown>> }).input.filter(
      (item) => item.type === "web_search_call",
    )
    expect(replayInput).toEqual([
      {
        type: "web_search_call",
        id: "search_production_1",
        status: "completed",
        action: { type: "search", query: "Task20 hosted replay" },
        results: [{ title: "Recorded result", url: "https://example.test/recorded" }],
      },
      {
        type: "web_search_call",
        id: "search_production_failed",
        status: "failed",
        action: { type: "search", query: "Task20 failed hosted replay" },
        error: { code: "search_unavailable", message: "offline hosted fixture" },
      },
    ])

    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      history = serializedEventSnapshot(sqlite)
      sourceProjection = responseProjectionSnapshot(sqlite)
    } finally {
      sqlite.close()
    }
    await withDatabase("hosted-search-production-replay", async ({ databasePath: replayPath }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventV2.Service
          yield* events.replayBatches(history)
        }).pipe(Effect.provide(coreLayer(replayPath)), Effect.scoped),
      )
      const replay = new SqliteDatabase(replayPath, { readonly: true })
      try {
        expect(responseProjectionSnapshot(replay)).toEqual(sourceProjection)
      } finally {
        replay.close()
      }
    })
  })
}, 20_000)

test("all native incomplete terminals settle JSON and SSE as replayable partial Responses", async () => {
  await withDatabase("native-incomplete-production", async ({ databasePath }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: "offline-deepseek" },
        })
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-kimi" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )

    const requestPlan = [
      "design",
      "decompose",
      "implement",
      "test",
      "visual_review",
      "deliver-length",
      "design",
      "decompose",
      "implement",
      "test",
      "visual_review",
      "deliver-content-filter",
      "design",
      "decompose",
      "implement",
      "test",
      "visual_review",
      "deliver-tool",
      "deliver-unknown",
    ] as const
    const reasons = ["max_output_tokens", "content_filter"] as const
    let requestNumber = 0
    embeddedProviderFetch = async () => {
      const step = requestPlan[requestNumber++]
      if (!step) throw new Error("Unexpected incomplete provider request")
      const role = step.startsWith("deliver-") ? "deliver" : step
      const body =
        step === "deliver-tool"
          ? deepSeekDelayedToolSSE({ callID: "call_incomplete_checkpoint", path: "checkpoint.md" })
          : step === "deliver-unknown"
            ? deepSeekUnknownIncompleteRoleSSE(role)
            : step === "deliver-length" || step === "deliver-content-filter"
              ? deepSeekIncompleteRoleSSE(role, reasons[step === "deliver-length" ? 0 : 1])
              : role === "design" || role === "decompose" || role === "visual_review"
                ? kimiRoleSSE(role)
                : deepSeekRoleSSE(role)
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }

    const jsonWorkflowID = Workflow.ID.make(`wfl_incomplete_json_${crypto.randomUUID()}`)
    const jsonID = Responses.ID.make(`resp_incomplete_json_${crypto.randomUUID()}`)
    const sseWorkflowID = Workflow.ID.make(`wfl_incomplete_sse_${crypto.randomUUID()}`)
    const sseID = Responses.ID.make(`resp_incomplete_sse_${crypto.randomUUID()}`)
    const unknownWorkflowID = Workflow.ID.make(`wfl_incomplete_unknown_${crypto.randomUUID()}`)
    const unknownID = Responses.ID.make(`resp_incomplete_unknown_${crypto.randomUUID()}`)
    const unknownConversationID = Responses.ConversationID.make(`conv_incomplete_unknown_${crypto.randomUUID()}`)
    let localToolExecutions = 0
    let history: EventV2.SerializedEvent[] = []
    let sourceProjection: ReturnType<typeof responseProjectionSnapshot> | undefined
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { OpenCode } = yield* Effect.promise(() => import("../src"))
            const { Tool } = yield* Effect.promise(() => import("../src"))
            const opencode = yield* OpenCode.create()
            yield* opencode.tools.register({
              read_file: Tool.make({
                description: "Must not execute a partial native function call",
                input: Schema.Struct({ path: Schema.String }),
                output: Schema.Struct({ output: Schema.String }),
                execute: ({ path }) =>
                  Effect.sync(() => {
                    localToolExecutions++
                    return { output: `checkpoint:${path}` }
                  }),
              }),
            })

            yield* opencode.workflows.create(roleWorkflowInput(jsonWorkflowID))
            const json = yield* opencode.responses.create({
              id: jsonID,
              workflowID: jsonWorkflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: true,
              stream: false,
              requestHash: `sha256:${jsonID}`,
              input: [{ type: "message", role: "user", content: "reach max output tokens" }],
            })
            if (Stream.isStream(json)) return yield* Effect.die("Expected JSON, received SSE")
            expect(json).toMatchObject({
              status: "incomplete",
              error: { code: "max_output_tokens", type: "incomplete" },
              output: [{ type: "message", role: "assistant", content: roleOutcome("deliver") }],
              usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 },
            })
            const jsonWorkflow = yield* opencode.workflows.get({ workflowID: jsonWorkflowID })
            expect(jsonWorkflow.run).toMatchObject({
              status: "failed",
              usage: { tokens: 95, turns: 6, toolCalls: 0, attempts: 6 },
            })
            expect(jsonWorkflow.stages.find((stage) => stage.type === "deliver")?.error).toMatchObject({
              code: "provider_output_incomplete",
            })

            yield* opencode.workflows.create(roleWorkflowInput(sseWorkflowID))
            const sse = yield* opencode.responses.create({
              id: sseID,
              workflowID: sseWorkflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: true,
              stream: true,
              requestHash: `sha256:${sseID}`,
              input: [{ type: "message", role: "user", content: "trigger content filter" }],
            })
            if (!Stream.isStream(sse)) return yield* Effect.die("Expected SSE, received JSON")
            const streamed = Array.from(yield* sse.pipe(Stream.runCollect))
            expect(streamed.map((event) => event.type)).toEqual([
              "response.created",
              "response.in_progress",
              "response.incomplete",
            ])
            expect(streamed.at(-1)?.data).toMatchObject({
              error: { code: "content_filter", type: "incomplete" },
              output: [{ type: "message", role: "assistant", content: roleOutcome("deliver") }],
              usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 },
            })
            expect(yield* opencode.responses.get({ responseID: sseID })).toMatchObject({
              status: "incomplete",
              error: { code: "content_filter" },
              usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 },
            })
            expect((yield* opencode.workflows.get({ workflowID: sseWorkflowID })).run.status).toBe("failed")

            yield* opencode.conversations.create({ id: unknownConversationID, metadata: {} })
            yield* opencode.workflows.create(roleWorkflowInput(unknownWorkflowID))
            const unknown = yield* opencode.responses.create({
              id: unknownID,
              workflowID: unknownWorkflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: true,
              stream: false,
              conversation: unknownConversationID,
              requestHash: `sha256:${unknownID}`,
              input: [{ type: "message", role: "user", content: "preserve partial call without executing" }],
            })
            if (Stream.isStream(unknown)) return yield* Effect.die("Expected JSON, received SSE")
            expect(unknown).toMatchObject({
              status: "incomplete",
              error: { code: "provider_incomplete", type: "incomplete" },
              output: [
                {
                  type: "function_call",
                  call_id: "call_incomplete_checkpoint",
                  name: "read_file",
                  arguments: '{"path":"checkpoint.md"}',
                },
                {
                  type: "function_call_output",
                  call_id: "call_incomplete_checkpoint",
                  output: '{"type":"json","value":{"output":"checkpoint:checkpoint.md"}}',
                },
                {
                  type: "function_call",
                  call_id: "call_incomplete_partial",
                  name: "read_file",
                  arguments: '{"path":"partial.md"}',
                },
                { type: "message", role: "assistant", content: roleOutcome("deliver") },
              ],
              usage: { inputTokens: 18, outputTokens: 8, totalTokens: 26 },
            })
            expect(localToolExecutions).toBe(1)
            expect(
              (yield* opencode.conversations.items({ conversationID: unknownConversationID })).map(
                (item) => item.payload,
              ),
            ).toEqual([
              { type: "message", role: "user", content: "preserve partial call without executing" },
              ...unknown.output,
            ])
            expect(yield* opencode.workflows.get({ workflowID: unknownWorkflowID })).toMatchObject({
              run: { status: "failed", usage: { tokens: 101, turns: 7, toolCalls: 1, attempts: 6 } },
            })
          }),
        ),
      )
    } finally {
      embeddedProviderFetch = undefined
    }

    expect(requestNumber).toBe(19)
    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      for (const [workflowID, responseID] of [
        [jsonWorkflowID, jsonID],
        [sseWorkflowID, sseID],
        [unknownWorkflowID, unknownID],
      ] as const) {
        const responseBatch = sqlite
          .query("select batch_id from event where aggregate_id = ? and type = ?")
          .get(responseID, durableType(ResponseEvent.Incomplete)) as { batch_id: string }
        const workflowBatch = sqlite
          .query("select batch_id from event where aggregate_id = ? and type = ?")
          .get(workflowID, durableType(WorkflowEvent.Failed)) as { batch_id: string }
        expect(responseBatch.batch_id).toBe(workflowBatch.batch_id)
      }
      history = serializedEventSnapshot(sqlite)
      sourceProjection = responseProjectionSnapshot(sqlite)
    } finally {
      sqlite.close()
    }
    await withDatabase("native-incomplete-production-replay", async ({ databasePath: replayPath }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventV2.Service
          yield* events.replayBatches(history)
        }).pipe(Effect.provide(coreLayer(replayPath)), Effect.scoped),
      )
      const replay = new SqliteDatabase(replayPath, { readonly: true })
      try {
        expect(responseProjectionSnapshot(replay)).toEqual(sourceProjection)
      } finally {
        replay.close()
      }
    })
  })
}, 20_000)

test("native response.failed usage settles Workflow and Response once without persisting the provider body", async () => {
  await withDatabase("native-failed-usage-production", async ({ databasePath }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("deepseek"),
          value: { type: "key", key: "offline-deepseek" },
        })
        yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: { type: "key", key: "offline-kimi" },
        })
      }).pipe(Effect.provide(credentialLayer(databasePath)), Effect.scoped),
    )

    const steps = [
      "design",
      "decompose",
      "implement",
      "test",
      "visual_review",
      "deliver-tool",
      "deliver-failed",
    ] as const
    let requestNumber = 0
    embeddedProviderFetch = async () => {
      const step = steps[requestNumber++]
      if (!step) throw new Error("Unexpected failed-usage provider request")
      const role = step.startsWith("deliver-") ? "deliver" : step
      const body =
        step === "deliver-tool"
          ? deepSeekDelayedToolSSE({ callID: "call_failed_checkpoint", path: "failed-checkpoint.md" })
          : step === "deliver-failed"
            ? deepSeekFailedRoleSSE()
            : role === "design" || role === "decompose" || role === "visual_review"
              ? kimiRoleSSE(role)
              : deepSeekRoleSSE(role)
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }

    const workflowID = Workflow.ID.make(`wfl_failed_usage_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_failed_usage_${crypto.randomUUID()}`)
    let toolExecutions = 0
    let history: EventV2.SerializedEvent[] = []
    let sourceProjection: ReturnType<typeof responseProjectionSnapshot> | undefined
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { OpenCode, Tool } = yield* Effect.promise(() => import("../src"))
            const opencode = yield* OpenCode.create()
            yield* opencode.tools.register({
              read_file: Tool.make({
                description: "Checkpoint before a native failed terminal",
                input: Schema.Struct({ path: Schema.String }),
                output: Schema.Struct({ output: Schema.String }),
                execute: ({ path }) =>
                  Effect.sync(() => {
                    toolExecutions++
                    return { output: `checkpoint:${path}` }
                  }),
              }),
            })
            yield* opencode.workflows.create(roleWorkflowInput(workflowID))
            const stream = yield* opencode.responses.create({
              id: responseID,
              workflowID,
              model: "deepseek-v4-pro",
              background: false,
              store: true,
              stream: true,
              requestHash: `sha256:${responseID}`,
              input: [{ type: "message", role: "user", content: "record failed terminal usage" }],
            })
            if (!Stream.isStream(stream)) return yield* Effect.die("Expected SSE, received JSON")
            const streamed = Array.from(yield* stream.pipe(Stream.runCollect))
            expect(streamed.map((event) => event.type)).toEqual([
              "response.created",
              "response.in_progress",
              "response.failed",
            ])
            expect(streamed.at(-1)?.data).toMatchObject({
              error: {
                code: "provider_response_failed",
                type: "unknown",
                message: "Provider Responses execution failed",
              },
              usage: { inputTokens: 19, outputTokens: 7, totalTokens: 26 },
            })
            expect(yield* opencode.responses.get({ responseID })).toMatchObject({
              status: "failed",
              output: [],
              usage: { inputTokens: 19, outputTokens: 7, totalTokens: 26 },
            })
            expect(toolExecutions).toBe(1)
            const workflow = yield* opencode.workflows.get({ workflowID })
            expect(workflow.run).toMatchObject({
              status: "failed",
              usage: { tokens: 101, turns: 7, toolCalls: 1, attempts: 6 },
            })
            expect(workflow.stages.find((stage) => stage.type === "deliver")?.error).toMatchObject({
              category: "unknown",
              code: "provider_response_failed",
              message: "Provider Responses execution failed",
            })
          }),
        ),
      )
    } finally {
      embeddedProviderFetch = undefined
    }

    expect(requestNumber).toBe(7)
    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      const durable = JSON.stringify({
        events: sqlite.query("select type, data from event order by rowid").all(),
        responses: sqlite.query("select * from response").all(),
        workflows: sqlite.query("select * from workflow_run").all(),
        stages: sqlite.query("select * from workflow_stage").all(),
      })
      expect(durable).not.toContain("TASK20_PROVIDER_BODY_MUST_NOT_PERSIST")
      expect(
        sqlite
          .query("select count(*) as count from event where aggregate_id = ? and type = ?")
          .get(responseID, durableType(ResponseEvent.Failed)),
      ).toEqual({ count: 1 })
      expect(
        sqlite
          .query("select count(*) as count from event where aggregate_id = ? and type = ?")
          .get(workflowID, durableType(WorkflowEvent.Failed)),
      ).toEqual({ count: 1 })
      history = serializedEventSnapshot(sqlite)
      sourceProjection = responseProjectionSnapshot(sqlite)
    } finally {
      sqlite.close()
    }
    await withDatabase("native-failed-usage-production-replay", async ({ databasePath: replayPath }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventV2.Service
          yield* events.replayBatches(history)
        }).pipe(Effect.provide(coreLayer(replayPath)), Effect.scoped),
      )
      const replay = new SqliteDatabase(replayPath, { readonly: true })
      try {
        expect(responseProjectionSnapshot(replay)).toEqual(sourceProjection)
      } finally {
        replay.close()
      }
    })
  })
}, 20_000)

test("foreground and background execute the same native provider to an equivalent decoded terminal resource", async () => {
  await withDatabase("terminal", async ({ databasePath }) => {
    const events = await fixture("text-stream")
    const requests: Array<{ url: string; model?: string }> = []
    const foregroundWorkflow = Workflow.ID.make(`wfl_foreground_${crypto.randomUUID()}`)
    const foregroundID = Responses.ID.make(`resp_foreground_${crypto.randomUUID()}`)
    const backgroundWorkflow = Workflow.ID.make(`wfl_background_${crypto.randomUUID()}`)
    const backgroundID = Responses.ID.make(`resp_background_${crypto.randomUUID()}`)
    await seedPair(databasePath, foregroundWorkflow, foregroundID, false)
    await seedPair(databasePath, backgroundWorkflow, backgroundID, true)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const foreground = yield* waitTerminal(foregroundWorkflow, foregroundID)

          const responsesService = yield* ResponsesV2.Service
          let background = yield* responsesService.get(backgroundID)
          while (background.status !== "completed") {
            yield* Effect.sleep(10)
            background = yield* responsesService.get(backgroundID)
          }

          const normalize = (resource: typeof foreground) => ({
            ...resource,
            id: "<id>",
            workflowID: "<workflow>",
            background: "<mode>",
            requestHash: "<request-hash>",
            createdAt: "<created-at>",
            completedAt: "<completed-at>",
          })
          expect(normalize(foreground)).toEqual(normalize(background))
          expect(foreground).toMatchObject({
            model: "deepseek-v4-flash",
            status: "completed",
            background: false,
            store: true,
            output: [{ type: "message", role: "assistant", content: "你好！" }],
            usage: { inputTokens: 120, outputTokens: 15, totalTokens: 135 },
          })
          expect(background).toMatchObject({ status: "completed", background: true })
        }).pipe(
          Effect.provide(
            runtimeLayer({
              databasePath,
              body: deepSeekSSE(events),
              ownerID: "terminal-worker",
              onRequest: (request) => requests.push({ url: request.url }),
            }),
          ),
        ),
      ),
    )
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.deepseek.test/responses",
      "https://api.deepseek.test/responses",
    ])
  })
}, 15_000)

test("previous_response_id reconstructs stored context and rejects unusable parents", async () => {
  await withDatabase("previous", async ({ databasePath }) => {
    const workflowID = Workflow.ID.make(`wfl_previous_${crypto.randomUUID()}`)
    const parentID = Responses.ID.make(`resp_parent_${crypto.randomUUID()}`)
    const nonStoredID = Responses.ID.make(`resp_nonstored_${crypto.randomUUID()}`)
    const blockedWorkflow = (id: Workflow.ID, responseID?: Responses.ID): Workflow.CreateInput => ({
      id,
      type: "previous-response-fixture",
      input: {},
      budget: { maxAttempts: 2 },
      stages: [
        {
          type: "design",
          ordinal: 0,
          maxAttempts: 1,
          recoveryPolicy: "restart_safe",
          idempotencyKey: `previous/${id}/blocked`,
          input: { responseID: Responses.ID.make(`resp_blocker_${id.slice(4)}`) },
        },
        {
          type: "deliver",
          ordinal: 1,
          maxAttempts: 1,
          recoveryPolicy: "restart_safe",
          idempotencyKey: `previous/${id}/deliver`,
          input: responseID === undefined ? { responseBinding: "workflow" } : { responseID },
        },
      ],
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { OpenCode } = yield* Effect.promise(() => import("../src"))
          const opencode = yield* OpenCode.create()
          yield* opencode.workflows.create(blockedWorkflow(workflowID, parentID))
          yield* opencode.responses.create({
            id: parentID,
            workflowID,
            model: "deepseek-v4-flash",
            background: true,
            store: true,
            requestHash: `sha256:${parentID}`,
            input: [{ type: "message", role: "user", content: "parent input" }],
          })
        }),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const responses = yield* ResponsesV2.Service
        const events = yield* EventV2.Service
        const nonStoredWorkflowID = Workflow.ID.make(`wfl_nonstored_parent_${crypto.randomUUID()}`)
        const nonStoredWorkflow = blockedWorkflow(nonStoredWorkflowID, nonStoredID)
        yield* events.publish(WorkflowEvent.Created, {
          workflowID: nonStoredWorkflowID,
          timestamp: yield* DateTime.now,
          type: nonStoredWorkflow.type,
          input: nonStoredWorkflow.input,
          budget: nonStoredWorkflow.budget,
          stages: nonStoredWorkflow.stages.map((stage) => ({
            ...stage,
            id: stage.id ?? Workflow.StageID.create(),
          })) as [
            Workflow.StageInput & { id: Workflow.StageID },
            ...(Workflow.StageInput & { id: Workflow.StageID })[],
          ],
        })
        yield* responses.create({
          id: nonStoredID,
          workflowID: nonStoredWorkflowID,
          model: "deepseek-v4-flash",
          background: false,
          store: false,
          requestHash: `sha256:${nonStoredID}`,
          input: [{ type: "message", role: "user", content: "ephemeral" }],
        })
        yield* responses.cancel({ responseID: nonStoredID })
        yield* responses.complete({
          responseID: parentID,
          output: [{ type: "message", role: "assistant", content: "parent output" }],
          usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
        })
      }).pipe(Effect.provide(coreLayer(databasePath)), Effect.scoped),
    )

    const childID = Responses.ID.make(`resp_child_${crypto.randomUUID()}`)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { OpenCode } = yield* Effect.promise(() => import("../src"))
          const opencode = yield* OpenCode.create()
          const childWorkflowID = Workflow.ID.make(`wfl_child_${crypto.randomUUID()}`)
          yield* opencode.workflows.create(blockedWorkflow(childWorkflowID, childID))
          const child = yield* opencode.responses.create({
            id: childID,
            workflowID: childWorkflowID,
            model: "deepseek-v4-flash",
            background: true,
            store: true,
            previous_response_id: parentID,
            requestHash: `sha256:${childID}`,
            input: [{ type: "message", role: "user", content: "continue only" }],
          })
          if (Stream.isStream(child)) return yield* Effect.die("Expected JSON, received SSE")
          expect(child.previousResponseID).toBe(parentID)

          const missingWorkflowID = Workflow.ID.make(`wfl_missing_parent_${crypto.randomUUID()}`)
          yield* opencode.workflows.create(blockedWorkflow(missingWorkflowID))
          const missing = yield* opencode.responses
            .create({
              workflowID: missingWorkflowID,
              model: "deepseek-v4-flash",
              background: true,
              store: true,
              previous_response_id: Responses.ID.make("resp_missing_parent"),
              requestHash: `sha256:missing:${crypto.randomUUID()}`,
              input: [{ type: "message", role: "user", content: "missing" }],
            })
            .pipe(Effect.flip)
          const nonStoredWorkflowID = Workflow.ID.make(`wfl_unusable_nonstored_${crypto.randomUUID()}`)
          yield* opencode.workflows.create(blockedWorkflow(nonStoredWorkflowID))
          const nonStored = yield* opencode.responses
            .create({
              workflowID: nonStoredWorkflowID,
              model: "deepseek-v4-flash",
              background: true,
              store: true,
              previous_response_id: nonStoredID,
              requestHash: `sha256:nonstored:${crypto.randomUUID()}`,
              input: [{ type: "message", role: "user", content: "nonstored" }],
            })
            .pipe(Effect.flip)
          yield* opencode.responses.delete({ responseID: parentID })
          const deletedWorkflowID = Workflow.ID.make(`wfl_deleted_parent_${crypto.randomUUID()}`)
          yield* opencode.workflows.create(blockedWorkflow(deletedWorkflowID))
          const deleted = yield* opencode.responses
            .create({
              workflowID: deletedWorkflowID,
              model: "deepseek-v4-flash",
              background: true,
              store: true,
              previous_response_id: parentID,
              requestHash: `sha256:deleted:${crypto.randomUUID()}`,
              input: [{ type: "message", role: "user", content: "deleted" }],
            })
            .pipe(Effect.flip)

          expect(missing._tag).toBe("ResponseConflictError")
          expect(nonStored._tag).toBe("ResponseConflictError")
          expect(deleted._tag).toBe("ResponseConflictError")
        }),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const responses = yield* ResponsesV2.Service
        expect(yield* responses.contextItems(childID)).toEqual([
          { type: "message", role: "user", content: "parent input" },
          { type: "message", role: "assistant", content: "parent output" },
          { type: "message", role: "user", content: "continue only" },
        ])
      }).pipe(Effect.provide(coreLayer(databasePath)), Effect.scoped),
    )
  })
}, 20_000)

test("concurrent conversation appends receive durable contiguous ordinals", async () => {
  await withDatabase("conversation", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { OpenCode } = yield* Effect.promise(() => import("../src"))
          const opencode = yield* OpenCode.create()
          const conversationID = Responses.ConversationID.make(`conv_concurrent_${crypto.randomUUID()}`)
          yield* opencode.conversations.create({ id: conversationID, metadata: {} })
          yield* Effect.all(
            Array.from({ length: 12 }, (_, index) =>
              opencode.conversations.appendItem({
                conversationID,
                payload: { type: "message", role: "user", content: `append-${index}` },
              }),
            ),
            { concurrency: "unbounded" },
          )
          const first = yield* opencode.conversations.items({ conversationID })
          const second = yield* opencode.conversations.items({ conversationID })
          const contents = first.map((item) => item.payload.content)
          if (!contents.every((content): content is string => typeof content === "string")) {
            throw new Error("Expected string conversation content")
          }
          expect(first.map((item) => item.ordinal)).toEqual(Array.from({ length: 12 }, (_, index) => index))
          expect(contents.toSorted((left, right) => left.localeCompare(right))).toEqual(
            Array.from({ length: 12 }, (_, index) => `append-${index}`).toSorted((left, right) =>
              left.localeCompare(right),
            ),
          )
          expect(second).toEqual(first)
        }),
      ),
    )
  })
}, 15_000)

test("crash after native DeepSeek response.created restarts the safe attempt and settles exactly once", async () => {
  await withDatabase("crash", async ({ directory, databasePath }) => {
    const workflowID = Workflow.ID.make(`wfl_response_crash_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_response_crash_${crypto.randomUUID()}`)
    const markerPath = path.join(directory, "created.json")
    const attemptPath = path.join(directory, "attempts.log")
    const envPath = path.join(directory, "child-env.json")
    const safeEnvironment = Object.fromEntries(
      [
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "BUN_INSTALL_CACHE_DIR",
        "OPENCODE_CONFIG_DIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
      ]
        .filter((name) => !/(KEY|TOKEN|SECRET|AUTH)/i.test(name))
        .flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
    )
    const child = Bun.spawn(
      [process.execPath, workerPath, databasePath, workflowID, responseID, markerPath, attemptPath, envPath],
      { cwd: path.dirname(workerPath), env: safeEnvironment, stdout: "pipe", stderr: "pipe" },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const exitCode = await child.exited
    const [output, errorOutput] = await Promise.all([stdout, stderr])
    expect({ exitCode, output, errorOutput }).toEqual({ exitCode: 23, output: "", errorOutput: "" })
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({
      responseID,
      nativeEvent: "response.created",
      sequenceNumber: 0,
      parserSequenceNumber: 0,
      providerResponseID: "resp_provider_created",
      semanticStepConfirmed: true,
    })
    expect(JSON.parse(await readFile(envPath, "utf8"))).toEqual({ credentialNames: [] })
    expect((await readFile(attemptPath, "utf8")).trim().split("\n")).toEqual([
      "workflow-attempt-1",
      "provider-attempt-1:response.created",
    ])

    await Bun.sleep(200)
    const fullEvents = await fixture("text-stream")
    const requests: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const response = yield* waitTerminal(workflowID, responseID)
          const workflows = yield* WorkflowV2.Service
          const workflow = yield* workflows.get(workflowID)
          expect(response).toMatchObject({
            id: responseID,
            status: "completed",
            output: [{ type: "message", role: "assistant", content: "你好！" }],
            usage: { inputTokens: 120, outputTokens: 15, totalTokens: 135 },
          })
          expect(workflow.run.status).toBe("succeeded")
          expect(workflow.stages[0]).toMatchObject({ status: "succeeded", attempt: 2 })
          expect(workflow.artifacts).toHaveLength(1)
        }).pipe(
          Effect.provide(
            runtimeLayer({
              databasePath,
              body: deepSeekSSE(fullEvents),
              ownerID: "restart-worker",
              attemptPath,
              onRequest: (request) => requests.push(request.url),
            }),
          ),
        ),
      ),
    )
    expect(requests).toEqual(["https://api.deepseek.test/responses"])
    expect((await readFile(attemptPath, "utf8")).trim().split("\n")).toEqual([
      "workflow-attempt-1",
      "provider-attempt-1:response.created",
      "workflow-attempt-2",
    ])

    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      expect(sqlite.query("select count(*) as count from response").get()).toEqual({ count: 1 })
      expect(sqlite.query("select count(*) as count from workflow_run where id = ?").get(workflowID)).toEqual({
        count: 1,
      })
      expect(durableEventCount(sqlite, responseID, responseTerminalTypes)).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, workflowID, workflowTerminalTypes)).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, workflowID, [durableType(WorkflowEvent.Stage.Succeeded)])).toEqual({ count: 1 })
      expect(durableStageAttempts(sqlite, workflowID)).toEqual([1, 2])
      expect(durableEventCount(sqlite, responseID, [durableType(ResponseEvent.Created)])).toEqual({ count: 1 })
    } finally {
      sqlite.close()
    }
  })
}, 20_000)

test("unsupported DeepSeek fields remain explicit diagnostics", async () => {
  await withDatabase("capabilities", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { OpenCode } = yield* Effect.promise(() => import("../src"))
          const opencode = yield* OpenCode.create()
          const workflowID = Workflow.ID.make(`wfl_capability_${crypto.randomUUID()}`)
          yield* opencode.workflows.create(workflowInput(workflowID))
          const field = yield* opencode.responses
            .create({
              workflowID,
              model: "deepseek-v4-flash",
              background: false,
              store: true,
              requestHash: `sha256:field:${crypto.randomUUID()}`,
              input: [{ type: "message", role: "user", content: "unsupported" }],
              reasoning: { effort: "high" },
            })
            .pipe(Effect.flip)
          const unknownModel = yield* opencode.responses
            .create({
              workflowID,
              model: "deepseek-v5-future",
              background: false,
              store: true,
              requestHash: `sha256:model:${crypto.randomUUID()}`,
              input: [{ type: "message", role: "user", content: "future" }],
            })
            .pipe(Effect.flip)
          const backgroundStream = yield* opencode.responses
            .create({
              workflowID,
              model: "deepseek-v4-flash",
              background: true,
              stream: true,
              store: true,
              requestHash: `sha256:background-stream:${crypto.randomUUID()}`,
              input: [{ type: "message", role: "user", content: "reject background streaming" }],
            })
            .pipe(Effect.flip)

          expect(field).toMatchObject({ _tag: "UnsupportedCapabilityError", capability: "reasoning" })
          expect(backgroundStream).toMatchObject({
            _tag: "InvalidRequestError",
            kind: "invalid_combination",
            field: "stream",
          })
          expect(unknownModel).toMatchObject({
            _tag: "UnsupportedModelCapabilityError",
            provider: "deepseek",
            model: "deepseek-v5-future",
            required: "responses",
            supported: [],
            planned: false,
          })
        }),
      ),
    )
  })
}, 15_000)

test("a corrupted native DeepSeek event sequence fails both Response and workflow exactly once", async () => {
  await withDatabase("corrupt-native", async ({ databasePath }) => {
    const workflowID = Workflow.ID.make(`wfl_corrupt_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_corrupt_${crypto.randomUUID()}`)
    const events = (await fixture("text-stream")).map((event) => ({ ...event }))
    const completed = events.find((event) => event.type === "response.completed")!
    completed.sequence_number = 1
    await seedPair(databasePath, workflowID, responseID, true)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workflow = yield* waitWorkflowStatus(workflowID, "failed")
          const responses = yield* ResponsesV2.Service
          const response = yield* responses.get(responseID)
          expect(response).toMatchObject({
            status: "failed",
            error: { code: "invalid_provider_output", message: "Native Responses provider output was invalid" },
          })
          expect(workflow.stages[0]?.error).toMatchObject({
            category: response.error!.type,
            code: response.error!.code,
            message: response.error!.message,
          })
        }).pipe(Effect.provide(runtimeLayer({ databasePath, body: deepSeekSSE(events), ownerID: "corrupt-worker" }))),
      ),
    )
    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      expect(durableEventCount(sqlite, responseID, responseTerminalTypes)).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, responseID, [durableType(ResponseEvent.Failed)])).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, workflowID, workflowTerminalTypes)).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, workflowID, [durableType(WorkflowEvent.Failed)])).toEqual({ count: 1 })
    } finally {
      sqlite.close()
    }
  })
}, 15_000)

test("a retryable 429 keeps the Response in progress until workflow attempt two completes it once", async () => {
  await withDatabase("retry-success", async ({ databasePath }) => {
    const workflowID = Workflow.ID.make(`wfl_retry_success_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_retry_success_${crypto.randomUUID()}`)
    const successBody = deepSeekSSE(await fixture("text-stream"))
    let requests = 0
    await seedPair(databasePath, workflowID, responseID, true)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const response = yield* waitTerminal(workflowID, responseID)
          expect(response).toMatchObject({ status: "completed", error: undefined })
        }).pipe(
          Effect.provide(
            runtimeLayer({
              databasePath,
              ownerID: "retry-success-worker",
              body: JSON.stringify({ error: { message: "TASK20_RETRY_429_BODY_DO_NOT_STORE" } }),
              responseInit: {
                status: 429,
                headers: { "content-type": "application/json", "retry-after-ms": "0" },
              },
              onRequest: () => requests++,
              responseForRequest: ({ requestNumber }) =>
                requestNumber <= 3
                  ? {
                      body: JSON.stringify({ error: { message: "TASK20_RETRY_429_BODY_DO_NOT_STORE" } }),
                      responseInit: {
                        status: 429,
                        headers: { "content-type": "application/json", "retry-after-ms": "0" },
                      },
                    }
                  : { body: successBody },
            }),
          ),
        ),
      ),
    )
    expect(requests).toBe(4)

    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      expect(durableStageAttempts(sqlite, workflowID)).toEqual([1, 2])
      expect(durableEventCount(sqlite, responseID, responseTerminalTypes)).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, responseID, [durableType(ResponseEvent.Completed)])).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, workflowID, workflowTerminalTypes)).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, workflowID, [durableType(WorkflowEvent.Succeeded)])).toEqual({ count: 1 })
      expect(JSON.stringify(sqlite.query("select * from event").all())).not.toContain(
        "TASK20_RETRY_429_BODY_DO_NOT_STORE",
      )
    } finally {
      sqlite.close()
    }
  })
}, 20_000)

test("retryable 500 exhaustion fails the Response and workflow once with the same safe diagnostic", async () => {
  await withDatabase("retry-exhausted", async ({ databasePath }) => {
    const workflowID = Workflow.ID.make(`wfl_retry_exhausted_${crypto.randomUUID()}`)
    const responseID = Responses.ID.make(`resp_retry_exhausted_${crypto.randomUUID()}`)
    const providerBodySentinel = "TASK20_RETRY_500_BODY_DO_NOT_STORE"
    let requests = 0
    await seedPair(databasePath, workflowID, responseID, true)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workflow = yield* waitWorkflowStatus(workflowID, "failed")
          const responses = yield* ResponsesV2.Service
          const response = yield* responses.get(responseID)
          expect(response).toMatchObject({
            status: "failed",
            error: {
              type: "transient",
              code: "provider_internal",
              message: "RequestExecutor.execute: Provider request failed with HTTP 500",
            },
          })
          expect(workflow.stages[0]?.error).toMatchObject({
            category: response.error!.type,
            code: response.error!.code,
            message: response.error!.message,
          })
        }).pipe(
          Effect.provide(
            runtimeLayer({
              databasePath,
              ownerID: "retry-exhausted-worker",
              body: JSON.stringify({ error: { message: providerBodySentinel } }),
              responseInit: {
                status: 500,
                headers: { "content-type": "application/json", "retry-after-ms": "0" },
              },
              onRequest: () => requests++,
              responseForRequest: () => ({
                body: JSON.stringify({ error: { message: providerBodySentinel } }),
                responseInit: {
                  status: 500,
                  headers: { "content-type": "application/json", "retry-after-ms": "0" },
                },
              }),
            }),
          ),
        ),
      ),
    )
    expect(requests).toBe(6)

    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      expect(durableStageAttempts(sqlite, workflowID)).toEqual([1, 2])
      expect(durableEventCount(sqlite, responseID, responseTerminalTypes)).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, responseID, [durableType(ResponseEvent.Failed)])).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, workflowID, workflowTerminalTypes)).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, workflowID, [durableType(WorkflowEvent.Failed)])).toEqual({ count: 1 })
      const durable = JSON.stringify({
        events: sqlite.query("select * from event").all(),
        responses: sqlite.query("select * from response").all(),
        workflows: sqlite.query("select * from workflow_run").all(),
        stages: sqlite.query("select * from workflow_stage").all(),
      })
      expect(durable).not.toContain(providerBodySentinel)
    } finally {
      sqlite.close()
    }
  })
}, 20_000)

test("provider-origin HTTP bodies and non-replayable reasoning never reach durable state or logs", async () => {
  await withDatabase("provider-leakage", async ({ databasePath }) => {
    const reasoningSentinel = "TASK20_PROVIDER_REASONING_SENTINEL_DO_NOT_STORE"
    const providerBodySentinel = "TASK20_PROVIDER_BODY_SENTINEL_DO_NOT_STORE"
    const captured: string[] = []
    const failureWorkflow = Workflow.ID.make(`wfl_provider_body_${crypto.randomUUID()}`)
    const failureResponse = Responses.ID.make(`resp_provider_body_${crypto.randomUUID()}`)
    const previousError = console.error
    const previousLog = console.log
    console.error = (...values) => captured.push(values.map(String).join(" "))
    console.log = (...values) => captured.push(values.map(String).join(" "))
    try {
      const reasoningEvents = (await fixture("text-stream")).map((event) =>
        event.type === "response.reasoning_text.delta" ? { ...event, delta: reasoningSentinel } : event,
      )
      const successWorkflow = Workflow.ID.make(`wfl_provider_reasoning_${crypto.randomUUID()}`)
      const successResponse = Responses.ID.make(`resp_provider_reasoning_${crypto.randomUUID()}`)
      await seedPair(databasePath, successWorkflow, successResponse, true)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            expect((yield* waitTerminal(successWorkflow, successResponse)).status).toBe("completed")
          }).pipe(
            Effect.provide(
              runtimeLayer({ databasePath, body: deepSeekSSE(reasoningEvents), ownerID: "reasoning-worker" }),
            ),
          ),
        ),
      )

      await seedPair(databasePath, failureWorkflow, failureResponse, true)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const workflow = yield* waitWorkflowStatus(failureWorkflow, "failed")
            const responses = yield* ResponsesV2.Service
            const response = yield* responses.get(failureResponse)
            expect(response).toMatchObject({
              status: "failed",
              error: {
                type: "invalid_request",
                code: "invalid_request",
                message: "RequestExecutor.execute: Provider request failed with HTTP 400",
              },
            })
            expect(workflow.stages[0]?.error).toMatchObject({
              category: response.error!.type,
              code: response.error!.code,
              message: response.error!.message,
            })
          }).pipe(
            Effect.provide(
              runtimeLayer({
                databasePath,
                body: JSON.stringify({ error: { message: providerBodySentinel } }),
                responseInit: { status: 400, headers: { "content-type": "application/json" } },
                ownerID: "provider-body-worker",
              }),
            ),
          ),
        ),
      )
    } finally {
      console.error = previousError
      console.log = previousLog
    }

    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      const durable = JSON.stringify({
        events: sqlite.query("select type, data from event").all(),
        responses: sqlite.query("select * from response").all(),
        workflows: sqlite.query("select * from workflow_run").all(),
        stages: sqlite.query("select * from workflow_stage").all(),
        artifacts: sqlite.query("select * from workflow_artifact").all(),
        responseItems: sqlite.query("select * from response_item").all(),
        captured,
      })
      expect(durable).not.toContain(reasoningSentinel)
      expect(durable).not.toContain(providerBodySentinel)
      expect(durableEventCount(sqlite, failureResponse, responseTerminalTypes)).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, failureResponse, [durableType(ResponseEvent.Failed)])).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, failureWorkflow, workflowTerminalTypes)).toEqual({ count: 1 })
      expect(durableEventCount(sqlite, failureWorkflow, [durableType(WorkflowEvent.Failed)])).toEqual({ count: 1 })
    } finally {
      sqlite.close()
    }
  })
}, 20_000)

test("embedded admission rejects secret and non-persistable provider sentinels without database or log leakage", async () => {
  await withDatabase("leakage", async ({ databasePath }) => {
    const sentinels = {
      apiKey: "TASK20_APIKEY_SENTINEL_DO_NOT_STORE",
      authorization: "TASK20_AUTHORIZATION_SENTINEL_DO_NOT_STORE",
      reasoning: "TASK20_REASONING_SENTINEL_DO_NOT_STORE",
      providerBody: "TASK20_PROVIDER_BODY_SENTINEL_DO_NOT_STORE",
    }
    const captured: string[] = []
    const previousError = console.error
    const previousLog = console.log
    console.error = (...values) => captured.push(values.map(String).join(" "))
    console.log = (...values) => captured.push(values.map(String).join(" "))
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { OpenCode } = yield* Effect.promise(() => import("../src"))
            const opencode = yield* OpenCode.create()
            const workflowID = Workflow.ID.make(`wfl_leakage_${crypto.randomUUID()}`)
            yield* opencode.workflows.create(workflowInput(workflowID))
            const cases = [
              ["apiKey", { apiKey: sentinels.apiKey }],
              ["authorization", { headers: { Authorization: sentinels.authorization } }],
              ["non-persistable reasoning", { reasoning_content: sentinels.reasoning, persistable: false }],
              ["provider response body", { provider_response_body: sentinels.providerBody }],
            ] as const
            const rejected = yield* Effect.all(
              cases.map(([name, payload], index) =>
                opencode.responses
                  .create({
                    workflowID,
                    model: "deepseek-v4-flash",
                    background: false,
                    store: true,
                    requestHash: `sha256:leakage:${index}:${crypto.randomUUID()}`,
                    input: [{ type: "message", role: "user", content: "reject unsafe payload", ...payload }],
                  })
                  .pipe(
                    Effect.flip,
                    Effect.map((error) => [name, error._tag, "kind" in error ? error.kind : undefined]),
                  ),
              ),
              { concurrency: 1 },
            )
            expect(rejected).toEqual([
              ["apiKey", "InvalidRequestError", "unsafe_persistence"],
              ["authorization", "InvalidRequestError", "unsafe_persistence"],
              ["non-persistable reasoning", "InvalidRequestError", "unsafe_persistence"],
              ["provider response body", "InvalidRequestError", "unsafe_persistence"],
            ])
          }),
        ),
      )
    } finally {
      console.error = previousError
      console.log = previousLog
    }

    const sqlite = new SqliteDatabase(databasePath, { readonly: true })
    try {
      expect(sqlite.query("select count(*) as count from response").get()).toEqual({ count: 0 })
      const durable = JSON.stringify({
        events: sqlite.query("select type, data from event").all(),
        responses: sqlite.query("select * from response").all(),
        workflows: sqlite.query("select * from workflow_run").all(),
        captured,
      })
      for (const sentinel of Object.values(sentinels)) expect(durable).not.toContain(sentinel)
    } finally {
      sqlite.close()
    }
  })
}, 15_000)
