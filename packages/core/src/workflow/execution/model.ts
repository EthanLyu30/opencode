export * as WorkflowModelExecution from "./model"

import { LLMClient, LLMError, LLMResponse, Message, Model, ToolResultValue, Usage } from "@opencode-ai/llm"
import { Auth } from "@opencode-ai/llm/route"
import { Integration } from "@opencode-ai/schema/integration"
import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import { Credential } from "../../credential"
import { makeGlobalNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { ResponsesV2 } from "../../responses"
import { SessionMessage } from "../../session/message"
import { SessionStore } from "../../session/store"
import { ToolRegistry } from "../../tool/registry"
import { Hash } from "../../util/hash"
import { LocationServiceMap } from "../../location-service-map"
import type { Checkpoint, ExecutionFailure, ExecutionInput, Result } from "../executor"
import { WorkflowRetry } from "../retry"
import { WorkflowRoleAgents } from "../role-agents"
import { WorkflowRouting } from "../routing"
import { WorkflowSecretGuard } from "../secret-guard"
import { WorkflowToolLineage } from "../tool-lineage"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowRoleContract } from "./contract"
import * as WorkflowProviderRequest from "./provider-request"

export { fingerprintProviderRequest } from "./provider-request"

export interface Input extends ExecutionInput {
  readonly route: WorkflowRouting.Route
}

export interface Output extends Omit<Result, "artifacts"> {
  readonly outcome?: unknown
  readonly contract?: WorkflowRoleContract.Contract
  readonly semantic?: WorkflowRoleContract.RoleResult
  readonly artifacts?: Result["artifacts"]
  readonly providerUsage?: Responses.Usage
}

export interface Interface {
  readonly execute: (input: Input) => Effect.Effect<Output, ExecutionFailure | LLMError, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkflowModelExecution") {}

export const layerWith = (execute: Interface["execute"]) => Layer.succeed(Service, Service.of({ execute }))

export const emptyLayer = layerWith((input) =>
  Effect.fail({
    failure: {
      category: "invalid_request",
      code: "unsupported_stage",
      message: `No executor is registered for stage type ${input.stage.type}`,
    },
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
  }),
)

const ContinuationCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
})

const ContinuationResult = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  result: ToolResultValue,
})

const ContinuationTurn = Schema.Struct({
  calls: Schema.Array(ContinuationCall),
  results: Schema.Array(ContinuationResult),
})

const ContinuationActiveTurn = Schema.Struct({
  calls: Schema.Array(ContinuationCall),
  results: Schema.Array(ContinuationResult),
  pendingCallID: Schema.optional(Schema.String),
})

const ProviderResult = Schema.Struct({
  text: Schema.String,
  finishReason: Schema.String,
  toolCalls: Schema.Array(ContinuationCall),
  hostedItems: Schema.Array(Responses.ItemPayload),
})
type ProviderResult = typeof ProviderResult.Type

const ProviderTurn = Schema.Struct({
  sequence: Schema.Number,
  requestFingerprint: Schema.String,
  result: Schema.optional(ProviderResult),
})

const ModelContinuation = Schema.Struct({
  kind: Schema.Literal("workflow.model.continuation"),
  version: Schema.Literal(2),
  providerID: Schema.String,
  modelID: Schema.String,
  protocol: WorkflowRole.Protocol,
  reasoningEffort: WorkflowRole.ReasoningEffort,
  contractFingerprint: Schema.String,
  contextDigest: Schema.String,
  routeFingerprint: Schema.String,
  responseID: Responses.ID.pipe(Schema.optional),
  completedTurns: Schema.Number,
  turns: Schema.Array(ContinuationTurn),
  activeTurn: Schema.optional(ContinuationActiveTurn),
  providerTurn: Schema.optional(ProviderTurn),
  catalogFingerprint: Schema.String.pipe(Schema.optional),
  usage: Workflow.Usage,
  providerUsage: Responses.Usage,
  responseOutput: Schema.Array(Responses.ItemPayload),
  artifacts: Schema.Array(Workflow.ArtifactCommit),
})
type ModelContinuation = typeof ModelContinuation.Type
const TransientContinuation = Schema.Struct({
  kind: Schema.Literal("workflow.model.continuation.transient"),
  version: Schema.Literal(2),
  responseID: Responses.ID,
  contractFingerprint: Schema.String,
  contextDigest: Schema.String,
  routeFingerprint: Schema.String,
  usage: Workflow.Usage,
  providerUsage: Responses.Usage,
})

const LegacyContinuation = Schema.Struct({
  kind: Schema.Literal("workflow.model.continuation"),
  version: Schema.Literal(1),
  providerID: Schema.String,
  modelID: Schema.String,
  responseID: Responses.ID.pipe(Schema.optional),
  completedTurns: Schema.Number,
  turns: Schema.Array(ContinuationTurn),
  activeTurn: Schema.optional(ContinuationActiveTurn),
  catalogFingerprint: Schema.String.pipe(Schema.optional),
  usage: Workflow.Usage,
  providerUsage: Responses.Usage,
  responseOutput: Schema.Array(Responses.ItemPayload),
  artifacts: Schema.Array(Workflow.ArtifactCommit),
})
type LegacyContinuation = typeof LegacyContinuation.Type
const decodeLegacyContinuation = Schema.decodeUnknownSync(
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Unknown tool payloads require no runtime decoder service.
  LegacyContinuation as unknown as Schema.Decoder<LegacyContinuation>,
)
const LegacyTransientContinuation = Schema.Struct({
  kind: Schema.Literal("workflow.model.continuation.transient"),
  version: Schema.Literal(1),
  responseID: Responses.ID,
  usage: Workflow.Usage,
  providerUsage: Responses.Usage,
})
const decodeModelContinuation = Schema.decodeUnknownSync(
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Unknown tool payloads require no runtime decoder service.
  ModelContinuation as unknown as Schema.Decoder<ModelContinuation>,
)

const productionLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const responses = yield* ResponsesV2.Service
    const modelClient = yield* LLMClient.Service
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* SessionStore.Service

    return Service.of({
      execute: (input) => {
        const location = input.workflow.location
        if (location === undefined) {
          return Effect.fail(
            executionFailure(
              "transient",
              "workflow_location_required",
              "Workflow execution requires a persisted Location",
              0,
            ),
          )
        }
        const sessionID = input.workflow.sessionID
        if (sessionID === undefined) {
          return Effect.fail(
            executionFailure(
              "transient",
              "workflow_session_required",
              "Workflow execution requires a persisted Session",
              0,
            ),
          )
        }
        return Effect.gen(function* () {
          const session = yield* sessions.get(sessionID)
          if (
            session === undefined ||
            session.location.directory !== location.directory ||
            session.location.workspaceID !== location.workspaceID
          ) {
            return yield* Effect.fail(
              executionFailure(
                "transient",
                "workflow_session_required",
                "Workflow execution requires a Session at its persisted Location",
                0,
              ),
            )
          }
          return yield* Effect.gen(function* () {
            const requestedResponseID = yield* responseIDFromStage(input.stage.input)
            const responseBinding = yield* responseBindingFromStage(input.stage.input)
            if (requestedResponseID !== undefined && responseBinding) {
              return yield* Effect.fail(
                executionFailure(
                  "invalid_request",
                  "conflicting_response_binding",
                  "A deliver stage cannot combine responseID with responseBinding",
                ),
              )
            }
            const implicit =
              requestedResponseID === undefined && input.route.role === "deliver" && responseBinding
                ? yield* responses.activeByWorkflowID(input.workflow.id)
                : []
            if (implicit.length > 1) {
              return yield* Effect.fail(
                executionFailure(
                  "ambiguous",
                  "ambiguous_workflow_response",
                  "The deliver stage has more than one active Response",
                ),
              )
            }
            const responseID = requestedResponseID ?? implicit[0]?.id
            const response =
              responseID === undefined
                ? undefined
                : yield* responses
                    .get(responseID)
                    .pipe(
                      Effect.mapError((error) =>
                        error instanceof ResponsesV2.NotFoundError
                          ? executionFailure(
                              "transient",
                              "response_not_admitted",
                              "The linked Response has not been admitted yet",
                              0,
                            )
                          : responseFailure(error),
                      ),
                    )
            if (response !== undefined && response.workflowID !== input.workflow.id) {
              return yield* Effect.fail(
                executionFailure(
                  "invalid_request",
                  "response_workflow_mismatch",
                  "The linked Response belongs to a different workflow",
                ),
              )
            }
            if (response !== undefined && response.status !== "queued" && response.status !== "in_progress") {
              return yield* Effect.fail(
                executionFailure(
                  "invalid_request",
                  "response_already_terminal",
                  `The linked Response is already ${response.status}`,
                ),
              )
            }
            const route =
              response === undefined
                ? input.route
                : yield* Effect.try({
                    try: () => WorkflowRouting.forResponseModel(input.route, response.model),
                    catch: () =>
                      executionFailure(
                        "invalid_request",
                        "unsupported_response_model",
                        "The linked Response model is not supported by this workflow route",
                      ),
                  })
            const requestedPolicyDigest = yield* WorkflowToolLineage.policyDigest({
              workflow: input.workflow,
              stage: input.stage,
              route,
              agent: WorkflowRoleAgents.agentForRole(route.role),
            }).pipe(
              Effect.mapError((error) =>
                executionFailure("invalid_request", "workflow_tool_lineage_invalid", error.message),
              ),
            )
            const registry = yield* ToolRegistry.Service
            const workflowAuthority = yield* ToolRegistry.WorkflowAuthorityService
            const context =
              responseID === undefined
                ? undefined
                : yield* responseContext(responses, responseID, route).pipe(
                    Effect.mapError((error) => settleExecutionFailure(response, error)),
                  )
            if (responseID !== undefined) {
              if (response?.status === "queued")
                yield* responses.start(responseID).pipe(
                  Effect.mapError(responseFailure),
                  Effect.mapError((error) => settleExecutionFailure(response, error)),
                )
            }
            const contract = WorkflowRoleContract.build({
              workflow: input.workflow,
              stage: input.stage,
              route,
              priorArtifacts: input.artifacts,
              ...(context === undefined ? {} : { messages: context }),
            })
            const continuation = yield* continuationFromStage(input, responseID, responses, route, contract)
            if (continuation?.activeTurn?.pendingCallID !== undefined) {
              return yield* Effect.fail({
                failure: {
                  category: "ambiguous",
                  code: "tool_execution_ambiguous",
                  message: "A local tool may have produced side effects before its result was durably checkpointed.",
                },
                usage: zeroUsage,
              } satisfies ExecutionFailure)
            }
            const recoveryMaterialization =
              continuation?.catalogFingerprint === undefined
                ? undefined
                : yield* Effect.gen(function* () {
                    yield* WorkflowRoleAgents.reassert(route.role)
                    const materialization = yield* registry.materialize(contract.permissions)
                    if (materialization.fingerprint !== continuation.catalogFingerprint) {
                      return yield* Effect.fail(
                        executionFailure(
                          "ambiguous",
                          "tool_catalog_ambiguous",
                          "The executable tool catalog no longer matches the recovered provider turn",
                          0,
                        ),
                      )
                    }
                    if (continuation.providerTurn !== undefined) {
                      const recoveredMessages = [
                        ...contract.messages,
                        ...continuation.turns.flatMap(continuationMessages),
                      ]
                      const remainingTokens = remainingTokenBudget(input, route, continuation.usage)
                      const requestFingerprint = WorkflowProviderRequest.build({
                        model: route.model,
                        route,
                        contract,
                        sequence: continuation.providerTurn.sequence,
                        catalogFingerprint: materialization.fingerprint,
                        messages: recoveredMessages,
                        tools: materialization.definitions,
                        remainingTokens,
                      }).fingerprint
                      if (requestFingerprint !== continuation.providerTurn.requestFingerprint)
                        return yield* Effect.fail(
                          executionFailure(
                            "invalid_request",
                            "model_continuation_mismatch",
                            "Recovered provider request no longer matches its durable intent",
                          ),
                        )
                    }
                    return materialization
                  })
            if (continuation?.providerTurn !== undefined && continuation.providerTurn.result === undefined) {
              return yield* Effect.fail({
                failure: {
                  category: "ambiguous",
                  code: "provider_execution_ambiguous",
                  message: "A provider request may have completed before its result was durably checkpointed.",
                },
                usage: zeroUsage,
              } satisfies ExecutionFailure)
            }
            const model = yield* credentialedModel(credentials, route).pipe(
              Effect.mapError((error) => settleExecutionFailure(response, error)),
            )
            let messages = [...contract.messages, ...(continuation?.turns.flatMap(continuationMessages) ?? [])]
            let usage = continuation?.usage ?? zeroUsage
            let checkpointedUsage = continuation?.usage ?? zeroUsage
            let providerUsage: Responses.Usage = continuation?.providerUsage ?? {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            }
            const continuationTurns = [...(continuation?.turns ?? [])]
            const toolArtifacts: Workflow.ArtifactCommit[] = [...(continuation?.artifacts ?? [])]
            const responseOutput: Responses.ItemPayload[] = [...(continuation?.responseOutput ?? [])]
            let activeTurn = continuation?.activeTurn
            let providerTurn = continuation?.providerTurn
            let catalogFingerprint = continuation?.catalogFingerprint
            let recoverySnapshot = recoveryMaterialization
            let generated: ProviderResult | undefined
            while (true) {
              let materialization = recoverySnapshot
              recoverySnapshot = undefined
              if (activeTurn === undefined) {
                if (providerTurn?.result !== undefined) {
                  generated = providerTurn.result
                  providerTurn = undefined
                } else {
                  if (
                    route.budget.maxTurns !== undefined &&
                    input.workflow.usage.turns + usage.turns >= route.budget.maxTurns
                  ) {
                    return yield* Effect.fail(budgetFailure("turn", WorkflowRetry.usageDelta(usage, checkpointedUsage)))
                  }
                  const remainingTokens = remainingTokenBudget(input, route, usage)
                  if (remainingTokens === 0)
                    return yield* Effect.fail(
                      budgetFailure("token", WorkflowRetry.usageDelta(usage, checkpointedUsage)),
                    )
                  yield* WorkflowRoleAgents.reassert(route.role)
                  materialization = yield* registry.materialize(contract.permissions)
                  catalogFingerprint = materialization.fingerprint
                  const sequence = usage.turns + 1
                  const requestSnapshot = WorkflowProviderRequest.build({
                    model,
                    route,
                    contract,
                    sequence,
                    catalogFingerprint,
                    messages,
                    tools: materialization.definitions,
                    remainingTokens,
                  })
                  const requestFingerprint = requestSnapshot.fingerprint
                  providerTurn = { sequence, requestFingerprint }
                  yield* saveContinuation(input, responses, response, {
                    kind: "workflow.model.continuation",
                    version: 2,
                    providerID: route.providerID,
                    modelID: route.modelID,
                    protocol: route.protocol,
                    reasoningEffort: route.reasoningEffort,
                    contractFingerprint: contract.contractFingerprint,
                    contextDigest: contract.contextDigest,
                    routeFingerprint: contract.routeFingerprint,
                    ...(responseID === undefined ? {} : { responseID }),
                    completedTurns: usage.turns,
                    turns: continuationTurns,
                    providerTurn,
                    catalogFingerprint,
                    usage,
                    providerUsage,
                    responseOutput,
                    artifacts: toolArtifacts,
                  } satisfies ModelContinuation)
                  const raw = yield* modelClient
                    .generate(requestSnapshot.request)
                    .pipe(
                      Effect.mapError((error) =>
                        providerFailure(input, response, error, usage, checkpointedUsage, providerUsage),
                      ),
                    )
                  usage = addWorkflowUsage(usage, raw.usage)
                  providerUsage = addResponseUsage(providerUsage, raw.usage)
                  generated = yield* Effect.try({
                    try: () => normalizedProviderResult(raw),
                    catch: () => ({
                      failure: {
                        category: "schema" as const,
                        code: "provider_result_not_checkpointable",
                        message: "The normalized provider result could not be durably checkpointed",
                      },
                      usage,
                    }),
                  })
                  providerTurn = { sequence, requestFingerprint, result: generated }
                  yield* saveContinuation(input, responses, response, {
                    kind: "workflow.model.continuation",
                    version: 2,
                    providerID: route.providerID,
                    modelID: route.modelID,
                    protocol: route.protocol,
                    reasoningEffort: route.reasoningEffort,
                    contractFingerprint: contract.contractFingerprint,
                    contextDigest: contract.contextDigest,
                    routeFingerprint: contract.routeFingerprint,
                    ...(responseID === undefined ? {} : { responseID }),
                    completedTurns: usage.turns,
                    turns: continuationTurns,
                    providerTurn,
                    catalogFingerprint,
                    usage,
                    providerUsage,
                    responseOutput,
                    artifacts: toolArtifacts,
                  } satisfies ModelContinuation)
                  checkpointedUsage = usage
                }
                responseOutput.push(...generated.hostedItems)
                if (
                  generated.finishReason === "length" ||
                  generated.finishReason === "content-filter" ||
                  generated.finishReason === "unknown"
                ) {
                  const reason =
                    generated.finishReason === "length"
                      ? "max_output_tokens"
                      : generated.finishReason === "content-filter"
                        ? "content_filter"
                        : "provider_incomplete"
                  const partialCalls = generated.toolCalls.map((call) => ({
                    type: "function_call" as const,
                    call_id: call.id,
                    name: call.name,
                    arguments: JSON.stringify(call.input),
                  }))
                  const failure: Workflow.Failure = {
                    category: "unknown",
                    code: "provider_output_incomplete",
                    message: "Provider Responses output ended before the workflow role completed",
                  }
                  return yield* Effect.fail({
                    failure,
                    usage,
                    ...(responseID === undefined || response === undefined
                      ? {}
                      : {
                          responseSettlement: {
                            type: "incomplete" as const,
                            responseID,
                            output: [
                              ...responseOutput,
                              ...partialCalls,
                              { type: "message" as const, role: "assistant" as const, content: generated.text },
                            ],
                            error: {
                              type: "incomplete",
                              code: reason,
                              message:
                                reason === "max_output_tokens"
                                  ? "Provider output reached the maximum output token limit"
                                  : reason === "content_filter"
                                    ? "Provider output was stopped by content filtering"
                                    : "Provider output ended with an unspecified incomplete reason",
                            },
                            usage: providerUsage,
                            store: response.store,
                            ...(response.conversationID === undefined
                              ? {}
                              : { conversationID: response.conversationID }),
                          },
                        }),
                  } satisfies ExecutionFailure)
                }
                if (generated.finishReason === "error") {
                  const failure: Workflow.Failure = {
                    category: "unknown",
                    code: "provider_response_failed",
                    message: "Provider Responses execution failed",
                  }
                  return yield* Effect.fail({
                    failure,
                    usage,
                    ...(responseID === undefined || response === undefined
                      ? {}
                      : {
                          responseSettlement: {
                            type: "failed" as const,
                            responseID,
                            error: { type: failure.category, code: failure.code, message: failure.message },
                            usage: providerUsage,
                            store: response.store,
                          },
                        }),
                  } satisfies ExecutionFailure)
                }
                const calls = generated.toolCalls
                if (calls.length === 0) break
                activeTurn = {
                  calls: calls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
                  results: [],
                }
                providerTurn = undefined
              }

              const remainingCalls = activeTurn.calls.slice(activeTurn.results.length)
              const settledResults = [...activeTurn.results]
              if (remainingCalls.length > 0 && materialization === undefined) {
                yield* WorkflowRoleAgents.reassert(route.role)
                materialization = yield* registry.materialize(contract.permissions)
                if (catalogFingerprint === undefined || materialization.fingerprint !== catalogFingerprint) {
                  return yield* Effect.fail(
                    executionFailure(
                      "ambiguous",
                      "tool_catalog_ambiguous",
                      "The executable tool catalog no longer matches the recovered provider turn",
                      0,
                    ),
                  )
                }
              }
              for (const call of remainingCalls) {
                if (
                  route.budget.maxToolCalls !== undefined &&
                  input.workflow.usage.toolCalls + usage.toolCalls + 1 > route.budget.maxToolCalls
                ) {
                  return yield* Effect.fail(
                    budgetFailure("tool call", WorkflowRetry.usageDelta(usage, checkpointedUsage)),
                  )
                }
                usage = { ...usage, toolCalls: usage.toolCalls + 1 }
                yield* saveContinuation(input, responses, response, {
                  kind: "workflow.model.continuation",
                  version: 2,
                  providerID: route.providerID,
                  modelID: route.modelID,
                  protocol: route.protocol,
                  reasoningEffort: route.reasoningEffort,
                  contractFingerprint: contract.contractFingerprint,
                  contextDigest: contract.contextDigest,
                  routeFingerprint: contract.routeFingerprint,
                  ...(responseID === undefined ? {} : { responseID }),
                  completedTurns: usage.turns,
                  turns: continuationTurns,
                  activeTurn: { calls: activeTurn.calls, results: settledResults, pendingCallID: call.id },
                  ...(catalogFingerprint === undefined ? {} : { catalogFingerprint }),
                  usage,
                  providerUsage,
                  responseOutput,
                  artifacts: toolArtifacts,
                } satisfies ModelContinuation)

                if (materialization === undefined)
                  return yield* Effect.die("Workflow tool snapshot was not materialized")
                const settlement = yield* workflowAuthority
                  .settle({
                    materialization,
                    workflowID: input.workflow.id,
                    stageID: input.stage.id,
                    route,
                    policyDigest: requestedPolicyDigest,
                    sessionID,
                    agent: WorkflowRoleAgents.agentForRole(route.role),
                    assistantMessageID: workflowMessageID(input.stage.id, call.id),
                    call: { type: "tool-call", ...call },
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      error instanceof ToolRegistry.WorkflowAuthorityError
                        ? executionFailure(
                            "invalid_request",
                            "workflow_tool_lineage_invalid",
                            WorkflowSecretGuard.sanitizeText(error.message),
                          )
                        : executionFailure(
                            "transient",
                            "tool_output_retention_failed",
                            WorkflowSecretGuard.sanitizeText(error.message),
                            0,
                          ),
                    ),
                  )
                const evidence = JSON.stringify({
                  type: "function_call_output",
                  ...(responseID === undefined ? {} : { responseID }),
                  callID: call.id,
                  name: call.name,
                  input: call.input,
                  result: settlement.result,
                })
                WorkflowRoleContract.assertGenericProviderValue(settlement.result)
                WorkflowSecretGuard.assertSafe(evidence)
                if (response?.store !== false) {
                  toolArtifacts.push({
                    kind: "tool-continuation",
                    uri: `workflow-tool://${input.workflow.id}/${input.stage.id}/${encodeURIComponent(call.id)}`,
                    mime: "application/json",
                    sha256: Hash.sha256(evidence),
                    size: Buffer.byteLength(evidence),
                    metadata: JSON.parse(evidence),
                  })
                }
                responseOutput.push(
                  { type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) },
                  { type: "function_call_output", call_id: call.id, output: JSON.stringify(settlement.result) },
                )
                settledResults.push({ id: call.id, name: call.name, result: settlement.result })
                activeTurn = { calls: activeTurn.calls, results: settledResults }
                yield* saveContinuation(input, responses, response, {
                  kind: "workflow.model.continuation",
                  version: 2,
                  providerID: route.providerID,
                  modelID: route.modelID,
                  protocol: route.protocol,
                  reasoningEffort: route.reasoningEffort,
                  contractFingerprint: contract.contractFingerprint,
                  contextDigest: contract.contextDigest,
                  routeFingerprint: contract.routeFingerprint,
                  ...(responseID === undefined ? {} : { responseID }),
                  completedTurns: usage.turns,
                  turns: continuationTurns,
                  activeTurn,
                  ...(catalogFingerprint === undefined ? {} : { catalogFingerprint }),
                  usage,
                  providerUsage,
                  responseOutput,
                  artifacts: toolArtifacts,
                } satisfies ModelContinuation)
                checkpointedUsage = usage
              }
              const turn = {
                calls: activeTurn.calls,
                results: settledResults,
              }
              continuationTurns.push(turn)
              activeTurn = undefined
              catalogFingerprint = undefined
              // Give cancellation/scope finalizers a scheduling point after the
              // durable hand-off and before any next provider request begins.
              yield* Effect.yieldNow
              messages = [...messages, ...continuationMessages(turn)]
            }
            if (generated === undefined) return yield* Effect.die("Workflow model turn completed without a response")
            const semantic = yield* Effect.try({
              try: () => WorkflowRoleContract.decodeJson(contract, generated.text),
              catch: () => {
                const failure = executionFailure(
                  "schema",
                  "invalid_role_outcome",
                  "Model output did not match the strict role contract",
                )
                return settleExecutionFailure(response, { ...failure, usage })
              },
            })
            return {
              outcome: semantic.outcome,
              contract,
              semantic,
              usage,
              providerUsage,
              artifacts: toolArtifacts,
              responseSettlement:
                responseID === undefined || response === undefined
                  ? undefined
                  : {
                      type: "completed" as const,
                      responseID,
                      output: [
                        ...responseOutput,
                        { type: "message" as const, role: "assistant" as const, content: generated.text },
                      ],
                      usage: providerUsage,
                      store: response.store,
                      ...(response.conversationID === undefined ? {} : { conversationID: response.conversationID }),
                    },
            }
          }).pipe(Effect.provide(locations.get(location)), Effect.scoped)
        })
      },
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: productionLayer,
  deps: [Credential.node, ResponsesV2.node, LocationServiceMap.node, SessionStore.node, llmClient],
})

function responseIDFromStage(input: Readonly<Record<string, unknown>>) {
  if (!Object.hasOwn(input, "responseID")) return Effect.succeed(undefined)
  return Schema.decodeUnknownEffect(Responses.ID)(input.responseID).pipe(
    Effect.mapError(() => executionFailure("invalid_request", "invalid_response_id", "Stage response ID is invalid")),
  )
}

function responseBindingFromStage(input: Readonly<Record<string, unknown>>) {
  if (!Object.hasOwn(input, "responseBinding")) return Effect.succeed(false)
  if (input.responseBinding === "workflow") return Effect.succeed(true)
  return Effect.fail(
    executionFailure(
      "invalid_request",
      "invalid_response_binding",
      "Stage responseBinding must be workflow when provided",
    ),
  )
}

function continuationFromStage(
  input: Input,
  responseID: Responses.ID | undefined,
  responses: ResponsesV2.Interface,
  route: WorkflowRouting.Route,
  contract: WorkflowRoleContract.Contract,
) {
  const checkpoint = input.stage.checkpoint
  if (checkpoint?.kind === "workflow.model.continuation.transient") {
    if (checkpoint.version === 1)
      return Effect.fail(
        executionFailure(
          "invalid_request",
          "model_continuation_mismatch",
          "Legacy transient model continuation cannot replay under a role contract",
        ),
      )
    return Schema.decodeUnknownEffect(TransientContinuation)(checkpoint).pipe(
      Effect.mapError(() =>
        executionFailure("schema", "invalid_model_continuation", "Transient model continuation reference is invalid"),
      ),
      Effect.flatMap((reference) => {
        if (
          reference.responseID !== responseID ||
          reference.contractFingerprint !== contract.contractFingerprint ||
          reference.contextDigest !== contract.contextDigest ||
          reference.routeFingerprint !== contract.routeFingerprint
        ) {
          return Effect.fail(
            executionFailure(
              "invalid_request",
              "model_continuation_mismatch",
              "Transient model continuation does not match the current Response",
            ),
          )
        }
        return responses
          .transientContinuation(reference.responseID)
          .pipe(
            Effect.flatMap((continuation) =>
              continuation === undefined
                ? Effect.fail(
                    executionFailure(
                      "ambiguous",
                      "transient_continuation_lost",
                      "The non-stored Response continuation is no longer available in this process",
                    ),
                  )
                : decodeAndValidateContinuation(continuation, input, responseID, route, contract),
            ),
          )
      }),
    )
  }
  if (checkpoint?.kind !== "workflow.model.continuation") return Effect.succeed(undefined)
  if (checkpoint.version === 1) {
    return Schema.decodeUnknownEffect(LegacyContinuation)(checkpoint).pipe(
      Effect.mapError(() =>
        executionFailure("schema", "invalid_model_continuation", "Legacy model continuation checkpoint is invalid"),
      ),
      Effect.flatMap((legacy) =>
        isEmptyLegacyContinuation(legacy)
          ? Effect.succeed(undefined)
          : Effect.fail(
              executionFailure(
                "invalid_request",
                "model_continuation_mismatch",
                "Legacy model continuation cannot replay under a role contract",
              ),
            ),
      ),
    )
  }
  return decodeAndValidateContinuation(checkpoint, input, responseID, route, contract)
}

function decodeAndValidateContinuation(
  checkpoint: unknown,
  input: Input,
  responseID: Responses.ID | undefined,
  route: WorkflowRouting.Route,
  contract: WorkflowRoleContract.Contract,
) {
  return decodeContinuation(checkpoint).pipe(
    Effect.flatMap((continuation) => {
      const toolCalls = continuation.turns.reduce((total, turn) => total + turn.calls.length, 0)
      const activeResults = continuation.activeTurn?.results.length ?? 0
      const pendingCalls = continuation.activeTurn?.pendingCallID === undefined ? 0 : 1
      const activeTurnInvalid =
        continuation.activeTurn !== undefined &&
        (continuation.activeTurn.calls.length === 0 ||
          continuation.activeTurn.results.length > continuation.activeTurn.calls.length ||
          continuation.activeTurn.results.some(
            (result, index) =>
              result.id !== continuation.activeTurn!.calls[index]?.id ||
              result.name !== continuation.activeTurn!.calls[index]?.name,
          ) ||
          (continuation.activeTurn.pendingCallID !== undefined &&
            continuation.activeTurn.pendingCallID !==
              continuation.activeTurn.calls[continuation.activeTurn.results.length]?.id))
      const invalidTurns = continuation.turns.some(
        (turn) =>
          turn.calls.length === 0 ||
          turn.calls.length !== turn.results.length ||
          turn.calls.some(
            (call, index) => call.id !== turn.results[index]?.id || call.name !== turn.results[index]?.name,
          ),
      )
      const expectedTurns =
        continuation.turns.length +
        (continuation.activeTurn === undefined ? 0 : 1) +
        (continuation.providerTurn?.result === undefined ? 0 : 1)
      const expectedProviderSequence =
        continuation.providerTurn === undefined
          ? undefined
          : continuation.providerTurn.result === undefined
            ? continuation.usage.turns + 1
            : continuation.usage.turns
      if (
        continuation.providerID !== route.providerID ||
        continuation.modelID !== route.modelID ||
        continuation.protocol !== route.protocol ||
        continuation.reasoningEffort !== route.reasoningEffort ||
        continuation.contractFingerprint !== contract.contractFingerprint ||
        continuation.contextDigest !== contract.contextDigest ||
        continuation.routeFingerprint !== contract.routeFingerprint ||
        continuation.responseID !== responseID ||
        continuation.completedTurns !== continuation.usage.turns ||
        continuation.completedTurns !== expectedTurns ||
        continuation.usage.toolCalls !== toolCalls + activeResults + pendingCalls ||
        continuation.providerTurn?.sequence !== expectedProviderSequence ||
        (continuation.providerTurn !== undefined && continuation.catalogFingerprint === undefined) ||
        (continuation.providerTurn !== undefined && continuation.activeTurn !== undefined) ||
        activeTurnInvalid ||
        invalidTurns
      ) {
        return Effect.fail(
          executionFailure(
            "invalid_request",
            "model_continuation_mismatch",
            "Workflow model continuation does not match the current route or Response",
          ),
        )
      }
      return Effect.succeed(continuation)
    }),
  )
}

export function checkpointUsage(
  checkpoint: Readonly<Record<string, unknown>> | undefined,
): Effect.Effect<Workflow.Usage, ExecutionFailure> {
  return checkpointState(checkpoint).pipe(Effect.map((state) => state.usage))
}

export function checkpointState(checkpoint: Readonly<Record<string, unknown>> | undefined): Effect.Effect<
  {
    readonly usage: Workflow.Usage
    readonly providerUsage: Responses.Usage
    readonly responseID?: Responses.ID
  },
  ExecutionFailure
> {
  if (checkpoint?.kind === "workflow.model.continuation.transient") {
    if (checkpoint.version === 1) {
      return Schema.decodeUnknownEffect(LegacyTransientContinuation)(checkpoint).pipe(
        Effect.map((reference) => ({
          usage: reference.usage,
          providerUsage: reference.providerUsage,
          responseID: reference.responseID,
        })),
        Effect.mapError(() =>
          executionFailure("schema", "invalid_model_continuation", "Transient model continuation reference is invalid"),
        ),
      )
    }
    return Schema.decodeUnknownEffect(TransientContinuation)(checkpoint).pipe(
      Effect.map((reference) => ({
        usage: reference.usage,
        providerUsage: reference.providerUsage,
        responseID: reference.responseID,
      })),
      Effect.mapError(() =>
        executionFailure("schema", "invalid_model_continuation", "Transient model continuation reference is invalid"),
      ),
    )
  }
  if (checkpoint?.kind !== "workflow.model.continuation") {
    return Effect.succeed({
      usage: zeroUsage,
      providerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    })
  }
  if (checkpoint.version === 1) {
    return Effect.try({
      try: () => decodeLegacyContinuation(checkpoint),
      catch: () =>
        executionFailure("schema", "invalid_model_continuation", "Legacy model continuation checkpoint is invalid"),
    }).pipe(
      Effect.map((continuation) => ({
        usage: continuation.usage,
        providerUsage: continuation.providerUsage,
        ...(continuation.responseID === undefined ? {} : { responseID: continuation.responseID }),
      })),
    )
  }
  return decodeContinuation(checkpoint).pipe(
    Effect.map((continuation) => ({
      usage: continuation.usage,
      providerUsage: continuation.providerUsage,
      ...(continuation.responseID === undefined ? {} : { responseID: continuation.responseID }),
    })),
  )
}

function saveContinuation(
  input: Input,
  responses: ResponsesV2.Interface,
  response: Responses.Resource | undefined,
  continuation: ModelContinuation,
) {
  if (response?.store !== false || continuation.responseID === undefined) return input.saveCheckpoint(continuation)
  return responses.saveTransientContinuation(continuation.responseID, continuation).pipe(
    Effect.andThen(
      input.saveCheckpoint({
        kind: "workflow.model.continuation.transient",
        version: 2,
        responseID: continuation.responseID,
        contractFingerprint: continuation.contractFingerprint,
        contextDigest: continuation.contextDigest,
        routeFingerprint: continuation.routeFingerprint,
        usage: continuation.usage,
        providerUsage: continuation.providerUsage,
      }),
    ),
  )
}

function decodeContinuation(checkpoint: unknown) {
  return Effect.try({
    try: () => {
      WorkflowSecretGuard.assertSafe(checkpoint)
      WorkflowRoleContract.assertGenericProviderValue(checkpoint)
    },
    catch: () => executionFailure("schema", "invalid_model_continuation", "Workflow model continuation is unsafe"),
  }).pipe(
    Effect.andThen(
      Effect.try({
        try: () => decodeModelContinuation(checkpoint),
        catch: () =>
          executionFailure("schema", "invalid_model_continuation", "Workflow model continuation checkpoint is invalid"),
      }),
    ),
  )
}

function isEmptyLegacyContinuation(continuation: typeof LegacyContinuation.Type): boolean {
  return (
    continuation.turns.length === 0 &&
    continuation.activeTurn === undefined &&
    continuation.artifacts.length === 0 &&
    continuation.responseOutput.length === 0 &&
    continuation.usage.tokens === 0 &&
    continuation.usage.turns === 0 &&
    continuation.usage.toolCalls === 0 &&
    continuation.providerUsage.totalTokens === 0
  )
}

function continuationMessages(turn: typeof ContinuationTurn.Type): Message[] {
  return [
    Message.assistant(
      turn.calls.map((call) => ({ type: "tool-call" as const, id: call.id, name: call.name, input: call.input })),
    ),
    ...turn.results.map((result) => Message.tool({ id: result.id, name: result.name, result: result.result })),
  ]
}

function credentialedModel(credentials: Credential.Interface, route: WorkflowRouting.Route) {
  return credentials.list(Integration.ID.make(route.providerID)).pipe(
    Effect.flatMap((saved) => {
      const value = saved.at(-1)?.value
      const secret = value?.type === "key" ? value.key : value?.type === "oauth" ? value.access : undefined
      if (secret === undefined)
        return Effect.fail(
          executionFailure(
            "authentication",
            "missing_provider_credential",
            `No credential is configured for ${route.providerID}`,
          ),
        )
      return Effect.succeed(Model.update(route.model, { route: route.model.route.with({ auth: Auth.bearer(secret) }) }))
    }),
  )
}

function responseContext(responses: ResponsesV2.Interface, responseID: Responses.ID, route: WorkflowRouting.Route) {
  return Effect.gen(function* () {
    const response = yield* responses.get(responseID).pipe(Effect.mapError(responseFailure))
    if (response.model !== route.modelID)
      return yield* Effect.fail(
        executionFailure(
          "invalid_request",
          "response_model_mismatch",
          `Response model does not match the ${route.role} route`,
        ),
      )
    const transient = response.store ? undefined : yield* responses.transientInput(responseID)
    const items = transient ?? (yield* responses.contextItems(responseID).pipe(Effect.mapError(responseFailure)))
    return yield* responseItemsToMessages(items)
  })
}

function responseItemsToMessages(items: ReadonlyArray<Responses.ItemPayload>) {
  return Effect.try({
    try: () => {
      const messages: Message[] = []
      const calls = new Map<string, { readonly name: string; readonly settled: boolean }>()
      let pendingCalls: Array<{ type: "tool-call"; id: string; name: string; input: unknown }> = []
      const flushCalls = () => {
        if (pendingCalls.length === 0) return
        messages.push(Message.assistant(pendingCalls))
        pendingCalls = []
      }
      for (const item of items) {
        if (item.type === "message") {
          flushCalls()
          const role = item.role
          if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer") {
            throw new Error("unsupported message role")
          }
          const content = responseMessageText(item.content)
          messages.push(Message.make({ role: role === "developer" ? "system" : role, content }))
          continue
        }
        if (item.type === "function_call") {
          if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string") {
            throw new Error("invalid function call")
          }
          if (calls.has(item.call_id)) throw new Error("duplicate function call")
          const input = JSON.parse(item.arguments)
          calls.set(item.call_id, { name: item.name, settled: false })
          pendingCalls.push({ type: "tool-call", id: item.call_id, name: item.name, input })
          continue
        }
        if (item.type === "function_call_output") {
          flushCalls()
          if (typeof item.call_id !== "string" || typeof item.output !== "string") {
            throw new Error("invalid function call output")
          }
          const call = calls.get(item.call_id)
          if (call === undefined || call.settled) throw new Error("orphan function call output")
          if (item.name !== undefined && item.name !== call.name) throw new Error("function call name mismatch")
          calls.set(item.call_id, { ...call, settled: true })
          messages.push(Message.tool({ id: item.call_id, name: call.name, result: responseToolResult(item.output) }))
          continue
        }
        if (item.type === "web_search_call") {
          flushCalls()
          if (typeof item.id !== "string" || typeof item.status !== "string") {
            throw new Error("invalid hosted web search call")
          }
          const providerMetadata = { openai: { itemId: item.id } }
          messages.push(
            Message.assistant([
              {
                type: "tool-call",
                id: item.id,
                name: "web_search",
                input: item.action ?? {},
                providerExecuted: true,
                providerMetadata,
              },
              {
                type: "tool-result",
                id: item.id,
                name: "web_search",
                result: { type: "json", value: item },
                providerExecuted: true,
                providerMetadata,
              },
            ]),
          )
          continue
        }
        // The selected production routes currently accept text and function
        // replay only. Do not silently replace images, files, or reasoning.
        throw new Error("unsupported response item")
      }
      flushCalls()
      if (Array.from(calls.values()).some((call) => !call.settled)) {
        throw new Error("unsettled function call")
      }
      return messages
    },
    catch: () =>
      executionFailure(
        "invalid_request",
        "unsupported_response_context",
        "Response context contains an unsupported or inconsistent item",
      ),
  })
}

function hostedResponseItems(response: LLMResponse): Responses.ItemPayload[] {
  const items = new Map<string, Responses.ItemPayload>()
  for (const event of response.events) {
    if (
      event.type !== "tool-result" ||
      event.providerExecuted !== true ||
      event.result.type !== "json" ||
      !Schema.is(Responses.ItemPayload)(event.result.value) ||
      event.result.value.type !== "web_search_call" ||
      typeof event.result.value.id !== "string"
    ) {
      continue
    }
    items.set(event.result.value.id, event.result.value)
  }
  return Array.from(items.values())
}

function normalizedProviderResult(response: LLMResponse): ProviderResult {
  const result = Schema.decodeUnknownSync(ProviderResult)({
    text: response.text,
    finishReason: response.finishReason,
    toolCalls: response.toolCalls
      .filter((call) => call.providerExecuted !== true)
      .map((call) => ({ id: call.id, name: call.name, input: call.input })),
    hostedItems: hostedResponseItems(response),
  })
  WorkflowRoleContract.assertGenericProviderValue(result)
  WorkflowSecretGuard.assertSafe(result)
  if (Buffer.byteLength(WorkflowBusinessArtifact.encode(result)) > 128 * 1024)
    throw new Error("Normalized provider result exceeds the durable checkpoint bound")
  return result
}

function responseMessageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) throw new Error("unsupported message content")
  return content
    .map((part) => {
      if (
        typeof part !== "object" ||
        part === null ||
        !("type" in part) ||
        !("text" in part) ||
        (part.type !== "input_text" && part.type !== "output_text" && part.type !== "text") ||
        typeof part.text !== "string"
      ) {
        throw new Error("unsupported message content part")
      }
      return part.text
    })
    .join("")
}

function responseToolResult(output: string): ToolResultValue {
  try {
    const parsed: unknown = JSON.parse(output)
    return ToolResultValue.make(parsed)
  } catch {
    return ToolResultValue.make(output, "text")
  }
}

function providerFailure(
  input: Input,
  response: Responses.Resource | undefined,
  error: LLMError,
  usage: Workflow.Usage,
  checkpointedUsage: Workflow.Usage,
  providerUsage: Responses.Usage,
): ExecutionFailure | LLMError {
  const failure = WorkflowRetry.fromLLMError(error)
  const decision = WorkflowRetry.decide({
    failure,
    attempt: input.stage.attempt,
    maxAttempts: input.stage.maxAttempts,
    now: 0,
    randomUnit: 0,
  })
  if (decision.type === "retry" && usage.turns === 0) return error
  if (decision.type === "retry" || decision.type === "approval") {
    return { failure, usage: WorkflowRetry.usageForDecision(decision, usage, checkpointedUsage) }
  }
  if (response === undefined) return { failure, usage }
  return {
    failure,
    usage,
    responseSettlement: {
      type: "failed",
      responseID: response.id,
      error: { type: failure.category, code: failure.code, message: failure.message },
      usage: providerUsage,
      store: response.store,
    },
  }
}

function responseFailure(error: unknown): ExecutionFailure {
  return executionFailure(
    "transient",
    "response_persistence_failed",
    WorkflowSecretGuard.sanitizeText(error instanceof Error ? error.message : "Response persistence failed"),
    0,
  )
}

function executionFailure(
  category: Workflow.FailureCategory,
  code: string,
  message: string,
  retryAfterMs?: number,
): ExecutionFailure {
  return {
    failure: { category, code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
    usage: zeroUsage,
  }
}

function settleExecutionFailure(response: Responses.Resource | undefined, error: ExecutionFailure): ExecutionFailure {
  if (
    response === undefined ||
    (response.status !== "queued" && response.status !== "in_progress") ||
    error.failure.category === "transient" ||
    error.failure.category === "ambiguous"
  ) {
    return error
  }
  return {
    ...error,
    responseSettlement: {
      type: "failed",
      responseID: response.id,
      error: {
        type: error.failure.category,
        code: error.failure.code,
        message: error.failure.message,
      },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      store: response.store,
    },
  }
}

function addWorkflowUsage(current: Workflow.Usage, usage: Usage | undefined): Workflow.Usage {
  return {
    tokens: current.tokens + (usage?.totalTokens ?? 0),
    turns: current.turns + 1,
    toolCalls: current.toolCalls,
    attempts: current.attempts,
  }
}

function addResponseUsage(current: Responses.Usage, usage: Usage | undefined): Responses.Usage {
  const cachedTokens = (current.inputTokensDetails?.cachedTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0)
  const reasoningTokens = (current.outputTokensDetails?.reasoningTokens ?? 0) + (usage?.reasoningTokens ?? 0)
  return {
    inputTokens: current.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: current.outputTokens + (usage?.outputTokens ?? 0),
    totalTokens: current.totalTokens + (usage?.totalTokens ?? 0),
    ...(cachedTokens === 0 ? {} : { inputTokensDetails: { cachedTokens } }),
    ...(reasoningTokens === 0 ? {} : { outputTokensDetails: { reasoningTokens } }),
  }
}

function budgetFailure(dimension: string, usage: Workflow.Usage): ExecutionFailure {
  return {
    failure: {
      category: "ambiguous",
      code: "workflow_budget_exhausted",
      message: `Workflow ${dimension} budget was exhausted before the next model continuation`,
    },
    usage,
  }
}

function workflowMessageID(stageID: Workflow.StageID, callID: string) {
  return SessionMessage.ID.make(`msg_workflow_${stageID.slice(4)}_${Hash.sha256(callID).slice(0, 16)}`)
}

function remainingTokenBudget(input: Input, route: WorkflowRouting.Route, usage: Workflow.Usage): number | undefined {
  return route.budget.maxTokens === undefined
    ? undefined
    : Math.max(0, route.budget.maxTokens - input.workflow.usage.tokens - usage.tokens)
}

const zeroUsage: Workflow.Usage = { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 }

export type { Checkpoint }
