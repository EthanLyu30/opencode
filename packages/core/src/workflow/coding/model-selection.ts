export * as CodingModelSelection from "./model-selection"

import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { ModelSelection } from "../model-selection"
import { WorkflowBusinessArtifact } from "../artifacts/business"

export const RESERVED_INPUT_KEY = "workflow.coding-model-selection.v1"
export const FrozenSelection = Schema.Struct({
  kind: Schema.Literal(RESERVED_INPUT_KEY),
  locationSha256: WorkflowModelCatalog.Sha256,
  source: ModelSelection.FrozenSelection,
  routes: Schema.Record(WorkflowCodingBuild.Role, WorkflowModelCatalog.RouteSelection).annotate({
    parseOptions: { onExcessProperty: "error" },
  }),
  sha256: WorkflowModelCatalog.Sha256,
}).annotate({ identifier: "CodingModelSelection.FrozenSelection", parseOptions: { onExcessProperty: "error" } })
export interface FrozenSelection extends Schema.Schema.Type<typeof FrozenSelection> {}

export function freeze(selection: WorkflowModelCatalog.AdmissionSnapshot, location: Location.Ref): FrozenSelection {
  const source = ModelSelection.freeze(selection, location)
  const content = {
    kind: RESERVED_INPUT_KEY,
    locationSha256: source.locationSha256,
    source,
    routes: Object.fromEntries(
      WorkflowCodingBuild.Role.literals.map((role) => [
        role,
        source.snapshot.routes[role === "code_review" ? "design" : role],
      ]),
    ),
  }
  return validate({ ...content, sha256: WorkflowBusinessArtifact.hash(content) })
}

export function validate(input: unknown): FrozenSelection {
  try {
    const value = Schema.decodeUnknownSync(FrozenSelection)(input)
    const source = ModelSelection.validate(value.source)
    const { sha256, ...content } = value
    if (WorkflowBusinessArtifact.hash(content) !== sha256 || value.locationSha256 !== source.locationSha256)
      throw corrupt()
    for (const role of WorkflowCodingBuild.Role.literals) {
      if (
        WorkflowBusinessArtifact.encode(value.routes[role]) !==
        WorkflowBusinessArtifact.encode(source.snapshot.routes[role === "code_review" ? "design" : role])
      )
        throw corrupt()
      Object.freeze(value.routes[role].requiredCapabilities)
      Object.freeze(value.routes[role])
    }
    return Object.freeze({ ...value, source, routes: Object.freeze(value.routes) })
  } catch {
    throw corrupt()
  }
}

export function fromWorkflow(workflow: Workflow.Info): FrozenSelection {
  if (workflow.type !== "coding-build" || !workflow.location) throw corrupt()
  const selection = validate(workflow.input[RESERVED_INPUT_KEY])
  if (selection.locationSha256 !== WorkflowBusinessArtifact.locationSha256(workflow.location)) throw corrupt()
  return selection
}

export function withSelection(input: Readonly<Record<string, unknown>>, selection: FrozenSelection) {
  if (Object.hasOwn(input, RESERVED_INPUT_KEY) || Object.hasOwn(input, ModelSelection.RESERVED_INPUT_KEY))
    throw corrupt()
  return Object.freeze({ ...input, [RESERVED_INPUT_KEY]: validate(selection) })
}

function corrupt() {
  return new WorkflowModelCatalog.CatalogError({ code: "snapshot_corrupt" })
}
