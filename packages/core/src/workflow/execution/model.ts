export * as WorkflowModelExecution from "./model"

import { type LLMError } from "@opencode-ai/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import type { Checkpoint, ExecutionFailure, ExecutionInput, Result } from "../executor"
import { WorkflowRouting } from "../routing"

export interface Input extends ExecutionInput {
  readonly route: WorkflowRouting.Route
}

export interface Output extends Omit<Result, "artifacts"> {
  readonly outcome: unknown
  readonly artifacts?: Result["artifacts"]
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

export const node = makeGlobalNode({ service: Service, layer: emptyLayer, deps: [] })

export type { Checkpoint }
