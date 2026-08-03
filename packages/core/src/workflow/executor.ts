export * as WorkflowExecutor from "./executor"

import { Context, DateTime, Effect, Layer, Scope } from "effect"
import { Workflow } from "@opencode-ai/schema/workflow"
import { makeGlobalNode } from "../effect/app-node"

export interface ExecutionInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
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

export const node = makeGlobalNode({ service: Service, layer: emptyLayer, deps: [] })
