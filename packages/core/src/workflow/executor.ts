export * as WorkflowExecutor from "./executor"

import { LLMError } from "@opencode-ai/llm"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Context, DateTime, Effect, Layer, Schema, Scope } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Hash } from "../util/hash"
import { WorkflowModelExecution } from "./execution/model"
import { WorkflowRetry } from "./retry"
import { WorkflowRouting } from "./routing"
import { WorkflowSecretGuard } from "./secret-guard"
import { WorkflowStageMachine } from "./stage-machine"

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
}

export interface ExecutionFailure {
  readonly failure: Workflow.Failure
  readonly usage: Workflow.Usage
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

export const roleLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const models = yield* WorkflowModelExecution.Service
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

          const result = yield* models.execute({ ...input, route }).pipe(Effect.mapError(modelFailure))
          if (result.artifacts?.some((artifact) => artifact.kind === WorkflowStageMachine.OUTCOME_ARTIFACT_KIND))
            return yield* Effect.fail(
              invalidOutcome("Model execution returned a reserved role outcome artifact", result.usage),
            )
          const outcome = yield* Schema.decodeUnknownEffect(WorkflowRole.Outcome)(result.outcome).pipe(
            Effect.mapError(() => invalidOutcome("Model output did not match WorkflowRole.Outcome", result.usage)),
          )
          const artifact = outcomeArtifact(input.stage, outcome)
          const nextState = yield* WorkflowStageMachine.advance(state, artifact).pipe(
            Effect.mapError((error) =>
              invalidOutcome(`Model outcome violated role state: ${error.code}`, result.usage),
            ),
          )
          const hasFutureRoleStage = input.stages.some(
            (stage) => stage.ordinal > input.stage.ordinal && Schema.is(WorkflowRole.Role)(stage.type),
          )
          if (!hasFutureRoleStage && nextState.status !== "completed")
            return yield* Effect.fail(incompleteRoleWorkflow(nextState.role, result.usage))

          return {
            checkpoint: result.checkpoint,
            usage: result.usage,
            artifacts: [...(result.artifacts ?? []), artifact],
          }
        }),
    })
  }),
)

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
  }
}

function invalidOutcome(message: string, usage: Workflow.Usage): ExecutionFailure {
  return {
    failure: {
      category: "schema",
      code: "invalid_role_outcome",
      message: WorkflowSecretGuard.sanitizeText(message),
    },
    usage,
  }
}

function incompleteRoleWorkflow(nextRole: WorkflowRole.Role, usage: Workflow.Usage): ExecutionFailure {
  return {
    failure: {
      category: "invalid_request",
      code: "incomplete_role_workflow",
      message: `Role workflow has no stage for ${nextRole}`,
    },
    usage,
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

export const node = makeGlobalNode({ service: Service, layer: roleLayer, deps: [WorkflowModelExecution.node] })
