export * as WorkflowExecutor from "./executor"

import { LLMError, Message } from "@opencode-ai/llm"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Responses } from "@opencode-ai/schema/responses"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Context, DateTime, Effect, Layer, Schema, Scope } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Hash } from "../util/hash"
import { WorkflowModelExecution } from "./execution/model"
import { WorkflowRoleContract } from "./execution/contract"
import { WorkflowRoleExecution } from "./execution/role"
import { WorkflowRetry } from "./retry"
import { WorkflowRouting } from "./routing"
import { WorkflowSecretGuard } from "./secret-guard"
import { WorkflowStageMachine } from "./stage-machine"
import { WorkflowGraph } from "./graph"

export interface ExecutionInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly stages: ReadonlyArray<Workflow.Stage>
  readonly artifacts: ReadonlyArray<Workflow.Artifact>
  readonly remainingDurationMs?: number
  readonly lease: {
    readonly owner: string
    readonly attempt: number
    readonly expiresAt: DateTime.Utc
  }
  /**
   * Persists a bounded, secret-checked continuation for the current fenced
   * attempt. The local runtime owns event publication so executors cannot
   * bypass cancellation or lease fencing.
   */
  readonly saveCheckpoint: (checkpoint: Checkpoint) => Effect.Effect<void, ExecutionFailure>
}

/**
 * Opaque, secret-validated JSON a stage may persist to support a future
 * recovery attempt. Stage A stores this value but does not interpret Git or
 * workspace state. Executors may use these conventional fields when useful:
 *
 * - `workspaceRevision`: a stable revision identifier for the workspace.
 * - `dirtyPaths`: paths changed while the stage ran.
 * - `manifestArtifactID`: an artifact containing a durable output manifest.
 */
export type Checkpoint = Readonly<Record<string, unknown>> & {
  readonly workspaceRevision?: string
  readonly dirtyPaths?: readonly string[]
  readonly manifestArtifactID?: Workflow.ArtifactID
}

export interface Result {
  readonly checkpoint?: Checkpoint
  readonly artifacts?: ReadonlyArray<Workflow.ArtifactCommit>
  readonly usage: Workflow.Usage
  readonly responseSettlement?: Extract<ResponseSettlement, { readonly type: "completed" }>
  readonly roleReceipt?: WorkflowRoleExecution.Receipt
  /** Ephemeral trusted media/text used to rebuild the exact contract at Local's settlement gate. */
  readonly trustedMessages?: readonly Message[]
  /** Ephemeral exact prior-stage dependencies used by Local's final authority gate. */
  readonly trustedDependencies?: readonly Workflow.Artifact[]
}

export interface ExecutionFailure {
  readonly failure: Workflow.Failure
  readonly usage: Workflow.Usage
  readonly responseSettlement?: Extract<ResponseSettlement, { readonly type: "failed" | "incomplete" }>
}

export type ResponseSettlement =
  | {
      readonly type: "completed"
      readonly responseID: Responses.ID
      readonly output: ReadonlyArray<Responses.ItemPayload>
      readonly usage?: Responses.Usage
      readonly store: boolean
      readonly conversationID?: Responses.ConversationID
    }
  | {
      readonly type: "incomplete"
      readonly responseID: Responses.ID
      readonly output: ReadonlyArray<Responses.ItemPayload>
      readonly error: Responses.Error
      readonly usage?: Responses.Usage
      readonly store: boolean
      readonly conversationID?: Responses.ConversationID
    }
  | {
      readonly type: "failed"
      readonly responseID: Responses.ID
      readonly error: Responses.Error
      readonly usage?: Responses.Usage
      readonly store: boolean
    }

export interface Interface {
  readonly execute: (input: ExecutionInput) => Effect.Effect<Result, ExecutionFailure, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkflowExecutor") {}

export const emptyLayer = Layer.succeed(
  Service,
  Service.of({
    execute: (input) =>
      Effect.fail({
        failure: {
          category: "invalid_request",
          code: "unsupported_stage",
          message: `No executor is registered for stage type ${input.stage.type}`,
        },
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
      }),
  }),
)

const injectedRoleLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const models = yield* WorkflowModelExecution.Service
    const evidence = yield* WorkflowRoleExecution.Service
    return Service.of({
      execute: (input) =>
        Effect.gen(function* () {
          const role = yield* Schema.decodeUnknownEffect(WorkflowRole.Role)(input.stage.type).pipe(
            Effect.mapError(() => unsupportedRole(input.stage.type)),
          )
          const route = yield* Effect.try({
            try: () =>
              WorkflowRouting.resolve({
                role,
                budget: input.workflow.budget,
                requested: WorkflowRouting.requestedFromStage(role, input.stage.input),
              }),
            catch: routeFailure,
          })
          const state = yield* WorkflowStageMachine.replay({
            stages: input.stages,
            artifacts: input.artifacts,
            beforeOrdinal: input.stage.ordinal,
          }).pipe(Effect.mapError(transitionFailure))
          if (state.status !== "active" || state.role !== role)
            return yield* Effect.fail(
              transitionFailure(
                new WorkflowStageMachine.InvalidOutcome({
                  code: state.status === "completed" ? "already_completed" : "role_mismatch",
                }),
              ),
            )

          const preparation =
            input.workflow.type !== "visual-build"
              ? undefined
              : yield* WorkflowRoleExecution.prepare({
                  workflow: input.workflow,
                  stage: input.stage,
                  revision: revisionOf(input.stage),
                  location:
                    input.workflow.location ??
                    (yield* Effect.fail(invalidOutcome("Production visual roles require Location", zeroUsage))),
                  priorArtifacts: input.artifacts,
                  admission: { workflowInput: input.workflow.input, stageInput: input.stage.input },
                  checkpoint: input.stage.checkpoint,
                }).pipe(
                  Effect.provideService(WorkflowRoleExecution.Service, evidence),
                  Effect.mapError((error) => roleEvidenceFailure(error, zeroUsage)),
                )
          const result = yield* models.execute({ ...input, route, preparation }).pipe(Effect.mapError(modelFailure))
          if (result.artifacts?.some((artifact) => artifact.kind === WorkflowStageMachine.OUTCOME_ARTIFACT_KIND))
            return yield* Effect.fail(
              invalidOutcome(
                "Model execution returned a reserved role outcome artifact",
                result.usage,
                result.responseSettlement,
              ),
            )
          const strict = result.contract !== undefined || result.semantic !== undefined
          if (strict && (result.contract === undefined || result.semantic === undefined))
            return yield* Effect.fail(
              invalidOutcome(
                "Model execution returned an incomplete role contract result",
                result.usage,
                result.responseSettlement,
              ),
            )
          if (!strict && input.workflow.type === "visual-build")
            return yield* Effect.fail(
              invalidOutcome(
                "Production visual roles require a host-bound role contract result",
                result.usage,
                result.responseSettlement,
              ),
            )
          const strictSemantic = strict
            ? yield* Effect.try({
                try: () => WorkflowRoleContract.decode(result.contract!, result.semantic),
                catch: () =>
                  invalidOutcome(
                    "Model output did not match the strict role contract",
                    result.usage,
                    result.responseSettlement,
                  ),
              })
            : undefined
          if (strict && input.workflow.type === "visual-build" && result.providerUsage === undefined)
            return yield* Effect.fail(
              invalidOutcome(
                "Production visual roles require host-measured provider usage",
                result.usage,
                result.responseSettlement,
              ),
            )
          const settlement =
            strict && input.workflow.type === "visual-build"
              ? yield* WorkflowRoleExecution.settle({
                  workflow: input.workflow,
                  stage: input.stage,
                  contract: result.contract!,
                  semantic: strictSemantic!,
                  priorArtifacts: input.artifacts,
                  settledToolEvidence: result.artifacts ?? [],
                  executionUsage: result.usage,
                  providerUsage: result.providerUsage!,
                  ...(preparation === undefined ? {} : { preparation }),
                }).pipe(
                  Effect.provideService(WorkflowRoleExecution.Service, evidence),
                  Effect.mapError((error) => roleEvidenceFailure(error, result.usage, result.responseSettlement)),
                )
              : undefined
          const outcome = strict
            ? strictSemantic!.outcome
            : yield* Schema.decodeUnknownEffect(WorkflowRole.Outcome)(result.outcome).pipe(
                Effect.mapError(() =>
                  invalidOutcome(
                    "Model output did not match WorkflowRole.Outcome",
                    result.usage,
                    result.responseSettlement,
                  ),
                ),
              )
          const artifact =
            settlement?.artifacts.find((item) => item.kind === WorkflowStageMachine.OUTCOME_ARTIFACT_KIND) ??
            outcomeArtifact(input.stage, outcome)
          const nextState = yield* WorkflowStageMachine.advance(state, artifact).pipe(
            Effect.mapError((error) =>
              invalidOutcome(
                `Model outcome violated role state: ${error.code}`,
                result.usage,
                result.responseSettlement,
              ),
            ),
          )
          const declaredStages = input.stages.some((stage) => stage.id === input.stage.id)
            ? input.stages
            : [input.stage, ...input.stages]
          const skipped = new Set(
            yield* Effect.try({
              try: () => WorkflowGraph.unreachableAfter({ stages: declaredStages, stageID: input.stage.id, outcome }),
              catch: () =>
                invalidOutcome(
                  "Model outcome did not match the declared workflow graph",
                  result.usage,
                  result.responseSettlement,
                ),
            }),
          )
          const nextRoleStage = declaredStages
            .filter(
              (stage) =>
                stage.ordinal > input.stage.ordinal &&
                stage.status !== "skipped" &&
                !skipped.has(stage.id) &&
                Schema.is(WorkflowRole.Role)(stage.type),
            )
            .toSorted((left, right) => left.ordinal - right.ordinal)[0]
          if (nextState.status === "active" && nextRoleStage?.type !== nextState.role)
            return yield* Effect.fail(incompleteRoleWorkflow(nextState.role, result.usage, result.responseSettlement))
          if (nextState.status === "completed" && nextRoleStage !== undefined)
            return yield* Effect.fail(
              invalidOutcome(
                "Role workflow completed before its declared stages",
                result.usage,
                result.responseSettlement,
              ),
            )

          const trustedMessages = result.trustedMessages ?? preparation?.messages
          return {
            checkpoint: result.checkpoint,
            usage: result.usage,
            artifacts:
              settlement === undefined
                ? [...(result.artifacts ?? []), artifact]
                : [...(result.artifacts ?? []), ...settlement.artifacts],
            ...(settlement === undefined ? {} : { roleReceipt: settlement.receipt }),
            ...(trustedMessages === undefined ? {} : { trustedMessages }),
            ...(settlement?.dependencies === undefined ? {} : { trustedDependencies: settlement.dependencies }),
            responseSettlement: result.responseSettlement,
          }
        }),
    })
  }),
)

export const roleLayer = injectedRoleLayer.pipe(Layer.provide(WorkflowRoleExecution.failClosedLayer))

export const roleLayerWith = (evidence: Layer.Layer<WorkflowRoleExecution.Service>) =>
  injectedRoleLayer.pipe(Layer.provide(evidence))

function revisionOf(stage: Workflow.Stage): number {
  const revision = stage.input.revision ?? 0
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    throw new Error("Role revision is invalid")
  return revision
}

function outcomeArtifact(stage: Workflow.Stage, outcome: WorkflowRole.Outcome): Workflow.ArtifactCommit {
  const body = WorkflowStageMachine.encodeOutcome(outcome)
  return {
    kind: WorkflowStageMachine.OUTCOME_ARTIFACT_KIND,
    uri: `workflow://${stage.workflowID}/stages/${stage.id}/role-outcome.json`,
    mime: WorkflowStageMachine.OUTCOME_ARTIFACT_MIME,
    sha256: Hash.sha256(body),
    size: new TextEncoder().encode(body).byteLength,
    metadata: { ...outcome },
  }
}

function unsupportedRole(type: string): ExecutionFailure {
  return {
    failure: {
      category: "invalid_request",
      code: "unsupported_stage",
      message: `No role route is registered for stage type ${WorkflowSecretGuard.sanitizeText(type)}`,
    },
    usage: zeroUsage,
  }
}

function routeFailure(error: unknown): ExecutionFailure {
  if (error instanceof WorkflowRouting.InvalidRouteOverride) {
    return {
      failure: {
        category: "invalid_request",
        code: "invalid_route_override",
        message: WorkflowSecretGuard.sanitizeText(error.message),
      },
      usage: zeroUsage,
    }
  }
  if (error instanceof WorkflowRouting.PolicyViolation) {
    return {
      failure: {
        category: "invalid_request",
        code: "role_route_violation",
        message: WorkflowSecretGuard.sanitizeText(error.message),
      },
      usage: zeroUsage,
    }
  }
  return unknownFailure(error)
}

function transitionFailure(error: WorkflowStageMachine.InvalidOutcome): ExecutionFailure {
  return {
    failure: {
      category: "invalid_request",
      code: "role_transition_violation",
      message: `Role workflow state rejected the stage: ${error.code}`,
    },
    usage: zeroUsage,
  }
}

function modelFailure(error: ExecutionFailure | LLMError): ExecutionFailure {
  if (error instanceof LLMError) return { failure: WorkflowRetry.fromLLMError(error), usage: zeroUsage }
  return {
    failure: {
      ...error.failure,
      message: WorkflowSecretGuard.sanitizeText(error.failure.message),
    },
    usage: error.usage,
    ...(error.responseSettlement === undefined ? {} : { responseSettlement: error.responseSettlement }),
  }
}

function invalidOutcome(
  message: string,
  usage: Workflow.Usage,
  settlement?: Result["responseSettlement"],
): ExecutionFailure {
  return failedOutcome(
    {
      category: "schema",
      code: "invalid_role_outcome",
      message: WorkflowSecretGuard.sanitizeText(message),
    },
    usage,
    settlement,
  )
}

function roleEvidenceFailure(
  error: WorkflowRoleExecution.EvidenceFailure,
  usage: Workflow.Usage,
  settlement?: Result["responseSettlement"],
): ExecutionFailure {
  const ambiguousCodes = new Set([
    "role_evidence_unavailable",
    "preview_configuration_required",
    "snapshot_required",
    "workspace_stale",
    "functional_test_unavailable",
    "visual_host_unavailable",
    "delivery_evidence_stale",
    "evidence_capture_ambiguous",
  ])
  const category =
    error.category ??
    (ambiguousCodes.has(error.code) || /(?:_required|_unavailable|_stale|_ambiguous)$/.test(error.code)
      ? "ambiguous"
      : "schema")
  return failedOutcome(
    {
      category,
      code: error.code,
      message: WorkflowSecretGuard.sanitizeText(error.message),
    },
    usage,
    settlement,
  )
}

function incompleteRoleWorkflow(
  nextRole: WorkflowRole.Role,
  usage: Workflow.Usage,
  settlement?: Result["responseSettlement"],
): ExecutionFailure {
  return failedOutcome(
    {
      category: "invalid_request",
      code: "incomplete_role_workflow",
      message: `Role workflow has no stage for ${nextRole}`,
    },
    usage,
    settlement,
  )
}

function failedOutcome(
  failure: Workflow.Failure,
  usage: Workflow.Usage,
  settlement?: Result["responseSettlement"],
): ExecutionFailure {
  return {
    failure,
    usage,
    ...(settlement === undefined
      ? {}
      : {
          responseSettlement: {
            type: "failed" as const,
            responseID: settlement.responseID,
            error: { type: failure.category, code: failure.code, message: failure.message },
            usage: settlement.usage,
            store: settlement.store,
          },
        }),
  }
}

function unknownFailure(error: unknown): ExecutionFailure {
  return {
    failure: {
      category: "unknown",
      code: "role_routing_failed",
      message: WorkflowSecretGuard.sanitizeText(error instanceof Error ? error.message : "Role routing failed"),
    },
    usage: zeroUsage,
  }
}

const zeroUsage: Workflow.Usage = { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 }

export const node = makeGlobalNode({
  service: Service,
  layer: injectedRoleLayer,
  deps: [WorkflowModelExecution.node, WorkflowRoleExecution.node],
})
