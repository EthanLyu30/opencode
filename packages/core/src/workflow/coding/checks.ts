export * as CodingChecks from "./checks"

import { Location } from "@opencode-ai/schema/location"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Context, Data, Effect, Layer } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { Snapshot } from "../../snapshot"
import { WorkflowWorkspaceMaterialization } from "../workspace-materialization"
import { CodingArtifacts } from "./artifacts"
import { CodingHostPlan } from "./host-plan"

export class CheckFailure extends Data.TaggedError("CodingChecks.CheckFailure")<{
  readonly code: string
  readonly message: string
}> {}
export interface Request {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly revision: number
  readonly sealedSnapshot: WorkflowWorkspaceMaterialization.Sealed
  readonly plan: CodingHostPlan.Plan
}
export interface Interface {
  readonly captureSnapshot: (location: Location.Ref) => Effect.Effect<Snapshot.ID, CheckFailure>
  readonly snapshotEntries: (
    location: Location.Ref,
    snapshot: Snapshot.ID,
  ) => Effect.Effect<readonly Snapshot.Entry[], CheckFailure>
  readonly sealWorkspace: (
    input: Omit<WorkflowWorkspaceMaterialization.BindInput, "snapshotRef" | "archive">,
  ) => Effect.Effect<WorkflowWorkspaceMaterialization.Sealed, CheckFailure>
  readonly run: (input: Request) => Effect.Effect<CodingArtifacts.CheckRecord, CheckFailure>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/CodingChecks") {}
const unavailable = () =>
  Effect.fail(
    new CheckFailure({
      code: "coding_checks_unavailable",
      message: "Controlled coding checks are unavailable; host-shell fallback is forbidden",
    }),
  )
export const failClosedLayer = Layer.succeed(
  Service,
  Service.of({
    captureSnapshot: unavailable,
    snapshotEntries: unavailable,
    sealWorkspace: unavailable,
    run: unavailable,
  }),
)
export const node = makeGlobalNode({ service: Service, layer: failClosedLayer, deps: [] })
