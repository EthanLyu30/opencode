export * as ModelAvailability from "./model-availability"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { ModelSelection } from "./model-selection"

export class Service extends Context.Service<
  Service,
  {
    check: (selection: ModelSelection.FrozenSelection) => Effect.Effect<void, WorkflowModelCatalog.CatalogError>
  }
>()("Workflow.ModelAvailability") {}
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.succeed(Service, {
    check: () => Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "model_unavailable" })),
  }),
  deps: [],
})
export function check(selection: ModelSelection.FrozenSelection) {
  return Effect.flatMap(Service, (service) => service.check(selection))
}
export function checkCatalogue(selection: ModelSelection.FrozenSelection, catalogue: WorkflowModelCatalog.Catalogue) {
  return Effect.try({
    try: () => {
      const pinned = ModelSelection.validate(selection)
      if (catalogue.scopeSha256 !== pinned.snapshot.scopeSha256)
        throw new WorkflowModelCatalog.CatalogError({ code: "scope_mismatch" })
      for (const route of Object.values(pinned.snapshot.routes)) {
        const entry = catalogue.models.find(
          (entry) => entry.providerID === route.providerID && entry.modelID === route.modelID,
        )
        if (!entry || entry.availability !== "available")
          throw new WorkflowModelCatalog.CatalogError({ code: "model_unavailable" })
        if (
          entry.compatibility !== "supported" ||
          entry.adapterProfileID !== route.adapterProfileID ||
          entry.adapterProfileSha256 !== route.adapterProfileSha256 ||
          entry.protocol !== route.protocol ||
          !entry.effortLevels.includes(route.reasoningEffort) ||
          route.requiredCapabilities.some((capability) => !entry.capabilities.includes(capability))
        )
          throw new WorkflowModelCatalog.CatalogError({ code: "unverified_contract" })
        if (entry.priceSha256 !== route.priceSha256)
          throw new WorkflowModelCatalog.CatalogError({ code: "approval_mismatch" })
        if (entry.advertisedRevision !== route.advertisedRevision)
          throw new WorkflowModelCatalog.CatalogError({ code: "selection_conflict" })
      }
    },
    catch: (error) =>
      error instanceof WorkflowModelCatalog.CatalogError
        ? error
        : new WorkflowModelCatalog.CatalogError({ code: "snapshot_corrupt" }),
  })
}
