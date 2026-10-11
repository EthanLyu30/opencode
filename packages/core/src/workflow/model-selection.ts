export * as ModelSelection from "./model-selection"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Context, Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { makeGlobalNode } from "../effect/app-node"
import { WorkflowBusinessArtifact } from "./artifacts/business"
import { WorkflowModelCatalogPolicy } from "./model-catalog/policy"

export const RESERVED_INPUT_KEY = "workflow.model-selection.v1"
export const FrozenSelection = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  locationSha256: WorkflowModelCatalog.Sha256,
  snapshot: WorkflowModelCatalog.AdmissionSnapshot,
  sha256: WorkflowModelCatalog.Sha256,
}).annotate({ identifier: "Workflow.ModelSelection", parseOptions: { onExcessProperty: "error" } })
export interface FrozenSelection extends Schema.Schema.Type<typeof FrozenSelection> {}
export class Service extends Context.Service<
  Service,
  {
    snapshot: () => Effect.Effect<WorkflowModelCatalog.AdmissionSnapshot | undefined, WorkflowModelCatalog.CatalogError>
  }
>()("Workflow.ModelSelection.Source") {}
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.succeed(Service, { snapshot: () => Effect.succeed(undefined) }),
  deps: [],
})

export function freeze(snapshot: WorkflowModelCatalog.AdmissionSnapshot, location: Location.Ref): FrozenSelection {
  const decoded = validateSnapshot(snapshot)
  const owner = Schema.decodeUnknownSync(Location.Ref)(location)
  const content = { schemaVersion: 1 as const, locationSha256: WorkflowBusinessArtifact.hash(owner), snapshot: decoded }
  return Object.freeze({ ...content, sha256: WorkflowBusinessArtifact.hash(content) })
}
export function validate(input: unknown): FrozenSelection {
  const value = Schema.decodeUnknownSync(FrozenSelection)(input)
  const snapshot = validateSnapshot(value.snapshot)
  const { sha256, ...content } = value
  if (WorkflowBusinessArtifact.hash(content) !== sha256) throw corrupt()
  return Object.freeze({ ...value, snapshot })
}
export function fromWorkflow(workflow: Workflow.Info): FrozenSelection {
  const value = validate(workflow.input[RESERVED_INPUT_KEY])
  if (!workflow.location || WorkflowBusinessArtifact.hash(workflow.location) !== value.locationSha256) throw corrupt()
  return value
}
export function optionalFromWorkflow(workflow: Workflow.Info): FrozenSelection | undefined {
  return Object.hasOwn(workflow.input, RESERVED_INPUT_KEY) ? fromWorkflow(workflow) : undefined
}
export function withSelection(input: Readonly<Record<string, unknown>>, selection: FrozenSelection) {
  if (Object.hasOwn(input, RESERVED_INPUT_KEY)) throw corrupt()
  return { ...input, [RESERVED_INPUT_KEY]: validate(selection) }
}
function corrupt() {
  return new WorkflowModelCatalog.CatalogError({ code: "snapshot_corrupt" })
}
function validateSnapshot(input: unknown) {
  const value = Schema.decodeUnknownSync(WorkflowModelCatalog.AdmissionSnapshot)(input)
  const { sha256, ...content } = value
  if (WorkflowBusinessArtifact.hash(content) !== sha256) throw corrupt()
  const routes = Object.fromEntries(
    WorkflowRole.Role.literals.map((role) => {
      const route = value.routes[role]
      const rule = WorkflowModelCatalogPolicy.requirements[role]
      const profile = WorkflowModelCatalog.adapterProfile(route.adapterProfileID)
      if (
        !profile ||
        profile.providerID !== route.providerID ||
        profile.protocol !== route.protocol ||
        profile.wireContractSha256 !== route.adapterProfileSha256 ||
        route.providerID !== rule.providerID ||
        route.protocol !== rule.protocol ||
        route.reasoningEffort !== rule.reasoningEffort ||
        WorkflowBusinessArtifact.encode([...route.requiredCapabilities].sort()) !==
          WorkflowBusinessArtifact.encode([...rule.capabilities].sort()) ||
        route.requiredCapabilities.some((capability) => !profile.capabilities.includes(capability)) ||
        !profile.effortLevels.includes(route.reasoningEffort) ||
        (route.providerID === "kimi" && /^(?:kimi[-_:])?k?2(?:[._:-]|$)/i.test(route.modelID))
      )
        throw corrupt()
      return [role, Object.freeze({ ...route, requiredCapabilities: Object.freeze([...route.requiredCapabilities]) })]
    }),
  ) as WorkflowModelCatalog.AdmissionSnapshot["routes"]
  return Object.freeze({ ...value, routes: Object.freeze(routes) })
}
