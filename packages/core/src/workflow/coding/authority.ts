export * as CodingAuthority from "./authority"

import { Workflow } from "@opencode-ai/schema/workflow"
import { Context, Data, Effect, Layer } from "effect"
import { makeGlobalNode } from "../../effect/app-node"

export class Invalid extends Data.TaggedError("CodingAuthority.Invalid")<{ readonly message: string }> {}
export interface Interface {
  /** Verify durable Session/Response admission and frozen graph before any provider/tool dispatch. */
  readonly require: (workflow: Workflow.Info) => Effect.Effect<void, Invalid>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/CodingAuthority") {}
export const failClosedLayer = Layer.succeed(
  Service,
  Service.of({ require: () => Effect.fail(new Invalid({ message: "Trusted coding admission is unavailable" })) }),
)
export const node = makeGlobalNode({ service: Service, layer: failClosedLayer, deps: [] })
