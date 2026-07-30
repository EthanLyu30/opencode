export * as WorkflowExecutor from "./executor"

import { Context, DateTime, Effect, Layer, Scope } from "effect"
import { Workflow } from "@opencode-ai/schema/workflow"
import { makeGlobalNode } from "../effect/app-node"

export interface ExecutionInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly lease: {
    readonly owner: string
    readonly attempt: number
    readonly expiresAt: DateTime.Utc
  }
}

export interface Result {
  readonly checkpoint?: Readonly<Record<string, unknown>>
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
