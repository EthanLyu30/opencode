export * as WorkflowExecution from "./execution"

import { Context, Effect, Layer } from "effect"
import { Workflow } from "@opencode-ai/schema/workflow"
import { makeGlobalNode } from "../effect/app-node"

export interface Interface {
  readonly wake: Effect.Effect<void>
  readonly interrupt: (workflowID: Workflow.ID) => Effect.Effect<void>
  readonly active: Effect.Effect<ReadonlySet<Workflow.ID>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkflowExecution") {}

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    wake: Effect.void,
    interrupt: () => Effect.void,
    active: Effect.succeed(new Set<Workflow.ID>()),
  }),
)

export const node = makeGlobalNode({ service: Service, layer: noopLayer, deps: [] })
