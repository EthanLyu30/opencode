import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowCredentialScope } from "@opencode-ai/core/workflow/model-catalog/credential-scope"
import { WorkflowModelDiscovery } from "@opencode-ai/core/workflow/model-catalog/discovery"
import { WorkflowModelCatalogService } from "@opencode-ai/core/workflow/model-catalog/service"
import { WorkflowModelCatalogStore } from "@opencode-ai/core/workflow/model-catalog/store"
import { ModelAvailability } from "@opencode-ai/core/workflow/model-availability"
import { ModelSelection } from "@opencode-ai/core/workflow/model-selection"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import {
  fixtureCatalogue,
  fixtureAdmissionSnapshot,
  fixturePolicy,
} from "../../core/test/fixtures/workflow-model-catalog"
import { WorkflowBusinessArtifact } from "@opencode-ai/core/workflow/artifacts/business"
import { WorkflowModelCatalogRuntime } from "../src/workflow/model-catalog-runtime"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { Credential } from "@opencode-ai/core/credential"

test("actual file-backed runtime restarts retain the same head and bind generation to environment account", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "offline.env")
  await fs.writeFile(file, "opaque fake launcher metadata")
  const environment = {
    OPENCODE_ENV_FILE: file,
    MOONSHOT_API_KEY: "offline-account-A",
    DEEPSEEK_API_KEY: "offline-account-A",
  }
  const configuration = WorkflowModelCatalogRuntime.credentialConfiguration(environment)
  const scopeLayer = () =>
    WorkflowCredentialScope.layer.pipe(
      Layer.provide(Layer.succeed(WorkflowCredentialScope.Runtime, configuration)),
      Layer.provide(Database.layerFromPath(":memory:")),
      Layer.provide(
        Layer.mock(Credential.Service, {
          get: () => Effect.die("must not obtain database account B"),
          list: () => Effect.die("must not list database account B"),
        }),
      ),
    )
  const resolve = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* WorkflowCredentialScope.Service
        return [yield* scope.resolve("kimi"), yield* scope.resolve("deepseek")]
      }).pipe(Effect.provide(scopeLayer())),
    )
  const first = await resolve()
  expect(await resolve()).toEqual(first)
  const scopeSha256 = WorkflowCredentialScope.hash(first)
  const catalogue = fixtureCatalogue({ scopeSha256, observedAt: Date.now() })
  const store = await WorkflowModelCatalogStore.open(tmp.path, scopeSha256)
  const head = await store.publish({ expectedHeadSha256: null, catalogue, policy: fixturePolicy(catalogue) })
  const run = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const catalogue = yield* WorkflowModelCatalogService.Service
        const available = yield* ModelAvailability.Service
        const view = yield* catalogue.view()
        const selection = ModelSelection.freeze(
          yield* catalogue.snapshot(),
          Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
        )
        expect(yield* available.credential!(selection, "kimi")).toBe("offline-account-A")
        expect(view.head).toEqual(head)
        return selection
      }).pipe(
        Effect.provide(WorkflowModelCatalogRuntime.availabilityLayer),
        Effect.provide(
          WorkflowModelCatalogService.layer({ root: tmp.path, automatic: false }).pipe(
            Layer.provide(
              Layer.mock(WorkflowModelDiscovery.Service, {
                refresh: () => Effect.die("fresh file scope should retain its head"),
              }),
            ),
          ),
        ),
        Effect.provide(scopeLayer()),
      ),
    )
  const pinned = await run()
  expect(await run()).toEqual(pinned)
  await fs.writeFile(file, "changed fake metadata for rotation")
  expect(WorkflowCredentialScope.hash(await resolve())).not.toBe(scopeSha256)
  expect(JSON.stringify(await store.read())).not.toContain("offline-account-A")
})

test.each(["failed", "omitted", "retired"])(
  "production pinned availability requires fresh volatile observation: %s",
  async (mode) => {
    await using tmp = await tmpdir()
    const identity = (providerID: WorkflowModelCatalog.ProviderID) => ({
      referenceID: `offline-${providerID}`,
      revision: "ephemeral:offline",
      origin: providerID === "kimi" ? "https://api.moonshot.cn" : "https://api.deepseek.com",
    })
    const scope = Layer.succeed(WorkflowCredentialScope.Service, {
      resolve: (providerID) => Effect.succeed(identity(providerID)),
      credential: () => Effect.succeed("offline-A"),
    })
    const scopeSha256 = WorkflowCredentialScope.hash([identity("kimi"), identity("deepseek")])
    const catalogue = fixtureCatalogue({ scopeSha256 })
    const store = await WorkflowModelCatalogStore.open(tmp.path, scopeSha256)
    const head = await store.publish({ expectedHeadSha256: null, catalogue, policy: fixturePolicy(catalogue) })
    const { sha256, ...content } = fixtureAdmissionSnapshot()
    const updated = { ...content, scopeSha256 }
    const selection = ModelSelection.freeze(
      { ...updated, sha256: WorkflowBusinessArtifact.hash(updated) },
      Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
    )
    const discovery = Layer.succeed(WorkflowModelDiscovery.Service, {
      refresh: (providerID, scopeSha256) =>
        mode === "failed"
          ? Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "discovery_failed" }))
          : Effect.succeed(
              fixtureCatalogue({
                scopeSha256,
                observedAt: Date.now(),
                models: catalogue.models
                  .filter(
                    (entry) => entry.providerID === providerID && (mode !== "omitted" || entry.modelID !== "kimi-k3"),
                  )
                  .map((entry) => ({ ...entry, lifecycle: "superseded" as const })),
              }),
            ),
    })
    const service = WorkflowModelCatalogService.layer({ root: tmp.path, automatic: false }).pipe(
      Layer.provide(scope),
      Layer.provide(discovery),
    )
    const result = Effect.runPromise(
      ModelAvailability.Service.use((available) => available.check(selection)).pipe(
        Effect.provide(WorkflowModelCatalogRuntime.availabilityLayer),
        Effect.provide(service),
        Effect.provide(scope),
      ),
    )
    if (mode === "retired") await result
    else await expect(result).rejects.toThrow(mode === "failed" ? "discovery_failed" : "model_unavailable")
    expect((await store.read()).head).toEqual(head)
  },
)
