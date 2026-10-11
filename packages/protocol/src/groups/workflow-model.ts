import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { InvalidRequestError, UnauthorizedError } from "../errors"
// Derive portable transport shapes from the canonical fields; the Server revalidates
// cross-field, first-party and secret predicates before any service action or output.
const EvidenceWire = Schema.Struct({
  ...WorkflowModelCatalog.SourceEvidence.fields,
  url: Schema.NonEmptyString,
}).annotate({ parseOptions: { onExcessProperty: "error" } })
const MissingWire = Schema.Struct({
  firstAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  count: Schema.Int.check(Schema.isGreaterThan(0)),
})
const EntryWire = Schema.Struct({
  ...WorkflowModelCatalog.ModelEntry.fields,
  evidence: Schema.Array(EvidenceWire),
  missingObservation: Schema.NullOr(MissingWire),
})
const CatalogueWire = Schema.Struct({
  ...WorkflowModelCatalog.Catalogue.fields,
  models: Schema.Array(EntryWire).check(Schema.isMaxLength(256)),
})
const PolicyWire = Schema.Struct(WorkflowModelCatalog.Policy.fields)
const ViewWire = Schema.Struct({
  ...WorkflowModelCatalog.View.fields,
  catalogue: Schema.NullOr(CatalogueWire),
  policy: Schema.NullOr(PolicyWire),
})
const ActivationWire = Schema.Struct({
  ...WorkflowModelCatalog.ActivationInput.fields,
  replacements: Schema.NonEmptyArray(
    Schema.Struct({
      family: WorkflowModelCatalog.SelectedFamily,
      providerID: WorkflowModelCatalog.ProviderID,
      modelID: WorkflowModelCatalog.ModelID,
    }),
  ).check(Schema.isMaxLength(3)),
}).annotate({ parseOptions: { onExcessProperty: "error" } })
export const WorkflowModelGroup = HttpApiGroup.make("server.workflowModels")
  .add(
    HttpApiEndpoint.get("workflowModels.list", "/api/workflow-models", {
      success: Schema.Struct({ data: ViewWire }),
      error: [InvalidRequestError, UnauthorizedError],
    }),
  )
  .add(
    HttpApiEndpoint.post("workflowModels.refresh", "/api/workflow-models/refresh", {
      payload: WorkflowModelCatalog.RefreshInput,
      success: Schema.Struct({ data: ViewWire }),
      error: [InvalidRequestError, UnauthorizedError],
    }),
  )
  .add(
    HttpApiEndpoint.post("workflowModels.activate", "/api/workflow-models/activate", {
      payload: ActivationWire,
      success: Schema.Struct({ data: ViewWire }),
      error: [InvalidRequestError, UnauthorizedError],
    }),
  )
