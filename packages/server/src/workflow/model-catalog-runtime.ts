export * as WorkflowModelCatalogRuntime from "./model-catalog-runtime"
import { WorkflowModelCatalogService } from "@opencode-ai/core/workflow/model-catalog/service"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowCredentialScope } from "@opencode-ai/core/workflow/model-catalog/credential-scope"
import { WorkflowModelDiscovery } from "@opencode-ai/core/workflow/model-catalog/discovery"
import { WorkflowModelCatalogPolicy } from "@opencode-ai/core/workflow/model-catalog/policy"
import { ModelSelection } from "@opencode-ai/core/workflow/model-selection"
import { ModelAvailability } from "@opencode-ai/core/workflow/model-availability"
import { Database } from "@opencode-ai/core/database/database"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Effect, Layer } from "effect"
import path from "node:path"
import { ServerAuth } from "../auth"
export function authenticationLayer<E, R>(source: Effect.Effect<ServerAuth.Info, E, R>) {
  return Layer.effect(ServerAuth.Config, source)
}
const unavailable = () => new WorkflowModelCatalog.CatalogError({ code: "selection_required" })
const disabled = () =>
  process.env.OPENCODE_DISABLE_WORKFLOW_MODEL_DISCOVERY === "true" ||
  process.env.NODE_ENV === "test" ||
  process.env.OPENCODE_BENCHMARK_TRANSPORT_FILE !== undefined
export function rootFromEnvironment(environment: Readonly<Record<string, string | undefined>>) {
  const root = environment.OPENCODE_WORKFLOW_MODEL_CATALOG_ROOT
  if (!root) return undefined
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    path.parse(root).root === root ||
    (process.platform === "win32" && path.parse(root).root.toLowerCase() !== "d:\\")
  )
    throw unavailable()
  if (environment.OPENCODE_ROOT && root !== path.join(environment.OPENCODE_ROOT, "data", "workflow-model-catalog"))
    throw unavailable()
  return root
}
export function credentialConfiguration(environment: Readonly<Record<string, string | undefined>>) {
  const configuration = (providerID: "kimi" | "deepseek"): WorkflowCredentialScope.Configuration => {
    const name = providerID === "kimi" ? "MOONSHOT_API_KEY" : "DEEPSEEK_API_KEY"
    return {
      origin: providerID === "kimi" ? "https://api.moonshot.cn" : "https://api.deepseek.com",
      configurationRevision: "workflow-model-catalog-first-party-v1",
      ...(environment[name]
        ? {
            environment: {
              referenceID: `environment:${name}`,
              file: environment.OPENCODE_ENV_FILE,
              read: () =>
                Effect.suspend(() =>
                  environment[name] ? Effect.succeed(environment[name]!) : Effect.fail(unavailable()),
                ),
            },
          }
        : { integrationID: Integration.ID.make(providerID) }),
    }
  }
  return { providers: { kimi: configuration("kimi"), deepseek: configuration("deepseek") } }
}
const scopeNode = makeGlobalNode({
  service: WorkflowCredentialScope.Service,
  layer: WorkflowCredentialScope.layer.pipe(
    Layer.provide(Layer.sync(WorkflowCredentialScope.Runtime, () => credentialConfiguration(process.env))),
  ),
  deps: [Database.node, Credential.node],
})
const discoveryNode = makeGlobalNode({
  service: WorkflowModelDiscovery.Service,
  layer: WorkflowModelDiscovery.layer,
  deps: [scopeNode],
})
export const node = makeGlobalNode({
  service: WorkflowModelCatalogService.Service,
  layer: Layer.unwrap(
    Effect.sync(() => {
      const root = rootFromEnvironment(process.env)
      if (!root || disabled())
        return Layer.succeed(WorkflowModelCatalogService.Service, {
          view: () =>
            Effect.succeed({
              head: null,
              catalogue: null,
              policy: null,
              stale: true,
              refreshStatus: "failed",
              failureCode: "selection_required",
            }),
          refresh: () => Effect.fail(unavailable()),
          activate: () => Effect.fail(unavailable()),
          snapshot: () => Effect.fail(unavailable()),
          checkPinned: () => Effect.fail(unavailable()),
        })
      return WorkflowModelCatalogService.layer({
        root,
        initialPolicy: (scopeSha256) =>
          WorkflowModelCatalogPolicy.sealPolicy({
            schemaVersion: 1,
            scopeSha256,
            choices: {
              "kimi-flagship": { providerID: "kimi", modelID: "kimi-k3" },
              "deepseek-pro": { providerID: "deepseek", modelID: "deepseek-v4-pro" },
              "deepseek-flash": { providerID: "deepseek", modelID: "deepseek-v4-flash" },
            },
          }),
      })
    }),
  ),
  deps: [scopeNode, discoveryNode],
})
export const selectionNode = makeGlobalNode({
  service: ModelSelection.Service,
  layer: Layer.effect(
    ModelSelection.Service,
    Effect.gen(function* () {
      const catalogue = yield* WorkflowModelCatalogService.Service
      return {
        snapshot: () =>
          !rootFromEnvironment(process.env) || disabled() ? Effect.succeed(undefined) : catalogue.snapshot(),
      }
    }),
  ),
  deps: [node],
})
export const availabilityLayer = Layer.effect(
  ModelAvailability.Service,
  Effect.gen(function* () {
    const catalogue = yield* WorkflowModelCatalogService.Service
    const scope = yield* WorkflowCredentialScope.Service
    return {
      check: (selection: ModelSelection.FrozenSelection) => catalogue.checkPinned(selection),
      credential: (selection: ModelSelection.FrozenSelection, providerID: WorkflowModelCatalog.ProviderID) =>
        Effect.gen(function* () {
          const pinned = ModelSelection.validate(selection)
          const kimi = yield* scope.resolve("kimi")
          const deepseek = yield* scope.resolve("deepseek")
          if (WorkflowCredentialScope.hash([kimi, deepseek]) !== pinned.snapshot.scopeSha256)
            return yield* Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "scope_mismatch" }))
          return yield* scope.credential(providerID, providerID === "kimi" ? kimi : deepseek)
        }),
    }
  }),
)
export const availabilityNode = makeGlobalNode({
  service: ModelAvailability.Service,
  layer: availabilityLayer,
  deps: [node, scopeNode],
})
