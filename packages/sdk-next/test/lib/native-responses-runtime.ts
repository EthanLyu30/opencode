import { appendFileSync } from "node:fs"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { ResponsesProjector } from "@opencode-ai/core/responses/projector"
import { ResponsesStore } from "@opencode-ai/core/responses/store"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { WorkflowRetry } from "@opencode-ai/core/workflow/retry"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { LLM, LLMError, Usage } from "../../../llm/src"
import { LLMClient, Protocol, RequestExecutor, Route, WebSocketExecutor } from "../../../llm/src/route"
import * as DeepSeek from "../../../llm/src/providers/deepseek"
import * as OpenAIResponses from "../../../llm/src/protocols/openai-responses"
import { Responses } from "../../../schema/src/responses"
import { Workflow } from "../../../schema/src/workflow"

export const fixture = async (name: string) => {
  const value = await Bun.file(
    new URL(`../../../llm/test/fixtures/deepseek-responses/${name}.json`, import.meta.url),
  ).json()
  return Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))(value)
}

export const deepSeekSSE = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")

export interface RecordedNativeResponse {
  readonly body: BodyInit
  readonly responseInit?: ResponseInit
}

interface TransportOptions extends RecordedNativeResponse {
  readonly onRequest?: (request: Request) => void
  readonly responseForRequest?: (input: {
    readonly request: Request
    readonly requestNumber: number
  }) => RecordedNativeResponse
}

const transportLayer = (options: TransportOptions) => {
  let requestNumber = 0
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
        options.onRequest?.(web)
        const response = options.responseForRequest?.({ request: web, requestNumber: ++requestNumber }) ?? options
        return HttpClientResponse.fromWeb(
          request,
          new Response(response.body, response.responseInit ?? { headers: { "content-type": "text/event-stream" } }),
        )
      }),
    ),
  )
  const request = RequestExecutor.layer.pipe(Layer.provide(http))
  const deps = Layer.mergeAll(request, WebSocketExecutor.layer)
  return Layer.mergeAll(deps, LLMClient.layer.pipe(Layer.provide(deps)))
}

export const createdOnlyBody = () => {
  const encoder = new TextEncoder()
  const created = deepSeekSSE([
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_provider_created", object: "response", status: "in_progress", output: [] },
    },
  ])
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(created))
    },
  })
}

export interface NativeCreatedObservation {
  readonly nativeEvent: string
  readonly sequenceNumber: number
  readonly parserSequenceNumber: number
  readonly providerResponseID: string
  readonly semanticStepConfirmed: true
}

export interface NativeRuntimeOptions {
  readonly databasePath: string
  readonly body: BodyInit
  readonly ownerID: string
  readonly attemptPath?: string
  readonly onRequest?: (request: Request) => void
  readonly responseInit?: ResponseInit
  readonly responseForRequest?: (input: {
    readonly request: Request
    readonly requestNumber: number
  }) => RecordedNativeResponse
  readonly onNativeCreated?: (observation: NativeCreatedObservation) => void
}

const nativeModel = (options: NativeRuntimeOptions) => {
  const model = DeepSeek.configure({
    baseURL: "https://api.deepseek.test",
    apiKey: "offline-fixture",
  }).responses("deepseek-v4-flash")
  if (!options.onNativeCreated) return model
  const stream = OpenAIResponses.protocol.stream
  const protocol = Protocol.make({
    id: model.route.protocol,
    body: model.route.body,
    stream: {
      ...stream,
      step: (state, event) =>
        stream.step(state, event).pipe(
          Effect.tap(([next]) => {
            if (
              event.type !== "response.created" ||
              event.sequence_number !== 0 ||
              next.sequenceNumber !== 0 ||
              typeof event.response?.id !== "string"
            )
              return Effect.void
            const observation: NativeCreatedObservation = {
              nativeEvent: event.type,
              sequenceNumber: event.sequence_number,
              parserSequenceNumber: next.sequenceNumber,
              providerResponseID: event.response.id,
              semanticStepConfirmed: true,
            }
            return Effect.sync(() => options.onNativeCreated!(observation))
          }),
        ),
    },
  })
  return Route.make({
    id: model.route.id,
    provider: model.provider,
    protocol,
    endpoint: model.route.endpoint,
    auth: model.route.auth,
    transport: model.route.transport,
    defaults: model.route.defaults,
  }).model({ id: model.id })
}

const sanitizedFailure = (error: unknown) => {
  if (!(error instanceof LLMError))
    return {
      category: "unknown" as const,
      code: "native_responses_failed",
      message: "Native Responses execution failed",
    }
  const base = WorkflowRetry.fromLLMError(error)
  const response =
    error.reason._tag === "InvalidProviderOutput"
      ? { code: "invalid_provider_output", message: "Native Responses provider output was invalid" }
      : { code: base.code, message: base.message }
  return { ...base, ...response }
}

export const runtimeLayer = (options: NativeRuntimeOptions) => {
  const llm = transportLayer(options)
  const executorLayer = Layer.effect(
    WorkflowExecutor.Service,
    Effect.gen(function* () {
      const responses = yield* ResponsesV2.Service
      return WorkflowExecutor.Service.of({
        execute: (input) =>
          Effect.gen(function* () {
            const responseID = yield* Schema.decodeUnknownEffect(Responses.ID)(input.stage.input.responseID).pipe(
              Effect.mapError(() => ({
                failure: {
                  category: "schema" as const,
                  code: "invalid_response_id",
                  message: "Stage response ID is invalid",
                },
                usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
              })),
            )
            const resource = yield* responses.get(responseID)
            if (resource.status === "queued") yield* responses.start(responseID)
            if (options.attemptPath) {
              yield* Effect.sync(() =>
                appendFileSync(options.attemptPath!, `workflow-attempt-${input.stage.attempt}\n`),
              )
            }
            const model = nativeModel(options)
            const generated = yield* LLMClient.generate(
              LLM.request({ model, prompt: "Execute the recorded conformance response." }),
            ).pipe(
              Effect.provide(llm),
              Effect.catch((error) => {
                const failure = sanitizedFailure(error)
                const decision = WorkflowRetry.decide({
                  failure,
                  attempt: input.stage.attempt,
                  maxAttempts: input.stage.maxAttempts,
                  now: 0,
                  randomUnit: 0,
                })
                const settleResponse =
                  decision.type === "retry"
                    ? Effect.void
                    : responses.fail({
                        responseID,
                        error: { code: failure.code, message: failure.message, type: failure.category },
                        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                      })
                return settleResponse.pipe(
                  Effect.andThen(
                    Effect.fail({
                      failure,
                      usage: { tokens: 0, turns: 1, toolCalls: 0, attempts: 0 },
                    }),
                  ),
                )
              }),
            )
            const generatedUsage = generated.usage ?? new Usage({})
            yield* responses.complete({
              responseID,
              output: [{ type: "message", role: "assistant", content: generated.text }],
              usage: usage(generatedUsage),
            })
            return {
              usage: {
                tokens: generatedUsage.totalTokens ?? 0,
                turns: 1,
                toolCalls: generated.events.filter((event) => event.type === "tool-call").length,
                attempts: 0,
              },
              artifacts: [
                {
                  kind: "response",
                  uri: `response://${responseID}`,
                  mime: "application/json",
                  sha256: new Bun.CryptoHasher("sha256").update(generated.text).digest("hex"),
                  size: new TextEncoder().encode(generated.text).byteLength,
                  metadata: { responseID },
                },
              ],
            }
          }).pipe(
            Effect.mapError((error) =>
              "failure" in error
                ? error
                : {
                    failure: {
                      category: "unknown" as const,
                      code: "response_persistence_failed",
                      message: "Response persistence failed",
                    },
                    usage: { tokens: 0, turns: 1, toolCalls: 0, attempts: 0 },
                  },
            ),
          ),
      })
    }),
  )
  const executorNode = makeGlobalNode({
    service: WorkflowExecutor.Service,
    layer: executorLayer,
    deps: [ResponsesV2.node],
  })
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      WorkflowProjector.node,
      WorkflowStore.node,
      ResponsesProjector.node,
      ResponsesStore.node,
      ResponsesV2.node,
      WorkflowExecutor.node,
      WorkflowExecution.node,
      WorkflowV2.node,
    ]),
    [
      [Database.node, Database.layerFromPath(options.databasePath)],
      [WorkflowExecutor.node, executorNode],
      [
        WorkflowExecution.node,
        WorkflowExecutionLocal.nodeWith({
          ownerID: options.ownerID,
          leaseDurationMs: 120,
          heartbeatIntervalMs: 40,
          pollIntervalMs: 5,
          concurrency: 1,
        }),
      ],
    ],
  )
}

export const admissionLayer = (databasePath: string) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      WorkflowProjector.node,
      WorkflowStore.node,
      ResponsesProjector.node,
      ResponsesStore.node,
      ResponsesV2.node,
      WorkflowV2.node,
    ]),
    [[Database.node, Database.layerFromPath(databasePath)]],
  )

export const workflowInput = (workflowID: Workflow.ID, responseID: Responses.ID): Workflow.CreateInput => ({
  id: workflowID,
  type: "responses-native-conformance",
  input: {},
  budget: { maxAttempts: 2 },
  stages: [
    {
      id: Workflow.StageID.make(`wfs_${workflowID.slice(4)}`),
      type: "deliver",
      ordinal: 0,
      maxAttempts: 2,
      recoveryPolicy: "restart_safe",
      idempotencyKey: `responses/${responseID}`,
      input: { responseID },
    },
  ],
})

export const createPair = (workflowID: Workflow.ID, responseID: Responses.ID, background: boolean) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowV2.Service
    const responses = yield* ResponsesV2.Service
    yield* workflows.create(workflowInput(workflowID, responseID))
    yield* responses.create({
      id: responseID,
      workflowID,
      model: "deepseek-v4-flash",
      background,
      store: true,
      requestHash: `sha256:${responseID}`,
      input: [{ type: "message", role: "user", content: "recorded native response" }],
    })
  })

export const seedPair = (
  databasePath: string,
  workflowID: Workflow.ID,
  responseID: Responses.ID,
  background: boolean,
) =>
  Effect.runPromise(
    Effect.scoped(createPair(workflowID, responseID, background).pipe(Effect.provide(admissionLayer(databasePath)))),
  )

export const createResponse = (workflowID: Workflow.ID, responseID: Responses.ID, background: boolean) =>
  Effect.gen(function* () {
    const responses = yield* ResponsesV2.Service
    return yield* responses.create({
      id: responseID,
      workflowID,
      model: "deepseek-v4-flash",
      background,
      store: true,
      requestHash: `sha256:${responseID}`,
      input: [{ type: "message", role: "user", content: "recorded native response" }],
    })
  })

export const waitTerminal = (workflowID: Workflow.ID, responseID: Responses.ID) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowV2.Service
    const responses = yield* ResponsesV2.Service
    let workflow = yield* workflows.get(workflowID)
    while (workflow.run.status !== "succeeded" && workflow.run.status !== "failed") {
      yield* Effect.sleep(10)
      workflow = yield* workflows.get(workflowID)
    }
    if (workflow.run.status !== "succeeded") throw new Error(`workflow reached ${workflow.run.status}`)
    return yield* responses.get(responseID)
  }).pipe(Effect.timeout("5 seconds"))

export const waitWorkflowStatus = (workflowID: Workflow.ID, expected: "succeeded" | "failed" | "cancelled") =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowV2.Service
    let workflow = yield* workflows.get(workflowID)
    while (workflow.run.status !== expected) {
      if (
        workflow.run.status === "succeeded" ||
        workflow.run.status === "failed" ||
        workflow.run.status === "cancelled"
      ) {
        throw new Error(`workflow reached ${workflow.run.status}, expected ${expected}`)
      }
      yield* Effect.sleep(10)
      workflow = yield* workflows.get(workflowID)
    }
    return workflow
  }).pipe(Effect.timeout("5 seconds"))

const usage = (value: Usage): Responses.Usage => ({
  inputTokens: value.inputTokens ?? 0,
  outputTokens: value.outputTokens ?? 0,
  totalTokens: value.totalTokens ?? 0,
})
