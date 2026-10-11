import { describe, expect, test } from "bun:test"
import { createRoutes } from "../src/routes"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Database } from "@opencode-ai/core/database/database"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorkflowModelCatalogService } from "@opencode-ai/core/workflow/model-catalog/service"
import { WorkflowBusinessArtifact } from "@opencode-ai/core/workflow/artifacts/business"
import { WorkflowModelCatalogRuntime } from "../src/workflow/model-catalog-runtime"
import { WorkflowRuntimeRecovery } from "../src/workflow/runtime-recovery"
import { fixtureCatalogue, fixturePolicy } from "../../core/test/fixtures/workflow-model-catalog"

function view(): WorkflowModelCatalog.View {
  const catalogue = fixtureCatalogue()
  const policy = fixturePolicy(catalogue)
  const content = {
    schemaVersion: 1 as const,
    scopeSha256: catalogue.scopeSha256,
    generation: 1,
    catalogueSha256: catalogue.sha256,
    policySha256: policy.sha256,
  }
  return {
    catalogue,
    policy,
    head: { ...content, sha256: WorkflowBusinessArtifact.hash(content) },
    stale: false,
    refreshStatus: "idle",
    failureCode: null,
  }
}
async function fixture(password: string | undefined = "offline-http-password") {
  const calls = { refresh: 0, activate: 0, snapshots: 0 }
  const expected = view()
  const graph = createRoutes(password, {
    buildApplicationServices: (services, replacements) =>
      AppNodeBuilder.build(services, [
        ...replacements,
        [Database.node, Database.layerFromPath(":memory:")],
        [
          WorkflowModelCatalogRuntime.node,
          Layer.succeed(WorkflowModelCatalogService.Service, {
            checkPinned: () => Effect.die("metadata API cannot execute"),
            view: () => Effect.succeed(expected),
            refresh: () =>
              Effect.sync(() => {
                calls.refresh++
                return expected
              }),
            activate: (input) =>
              Effect.suspend(() => {
                calls.activate++
                return input.expectedHeadSha256 !== expected.head!.sha256
                  ? Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "selection_conflict" }))
                  : Effect.succeed(expected)
              }),
            snapshot: () =>
              Effect.sync(() => {
                calls.snapshots++
                throw new Error("metadata API cannot admit/generate")
              }),
          }),
        ],
        [
          ToolOutputStore.cleanupNode,
          makeGlobalNode({ name: ToolOutputStore.cleanupNode.name, layer: Layer.empty, deps: [] }),
        ],
        [
          WorkflowRuntimeRecovery.node,
          Layer.succeed(WorkflowRuntimeRecovery.Service, { healthy: true, recovered: 0, skipped: 0, ready: true }),
        ],
      ]),
  })
  const web = HttpRouter.toWebHandler(graph.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
  const requestServices = Context.make(PermissionSaved.Service, {
    list: () => Effect.die("unused"),
    add: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
  })
  return {
    calls,
    expected,
    request: (path: string, body?: unknown, authenticated = true) =>
      web.handler(
        new Request(`http://localhost${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...(authenticated && password
              ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
              : {}),
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        requestServices,
      ),
    [Symbol.asyncDispose]: () => web.dispose(),
  }
}
describe("shared authenticated workflow catalogue API", () => {
  test("deployment catalogue roots cannot escape their managed D data directory", () => {
    const root = "D:\\OpenCode-Local\\data\\workflow-model-catalog"
    expect(
      WorkflowModelCatalogRuntime.rootFromEnvironment({
        OPENCODE_ROOT: "D:\\OpenCode-Local",
        OPENCODE_WORKFLOW_MODEL_CATALOG_ROOT: root,
      }),
    ).toBe(root)
    for (const candidate of [
      "C:\\catalogue",
      "D:\\",
      "relative",
      "D:\\OpenCode-Local\\data\\..\\escape",
      "D:\\other-catalogue",
    ]) {
      expect(() =>
        WorkflowModelCatalogRuntime.rootFromEnvironment({
          OPENCODE_ROOT: "D:\\OpenCode-Local",
          OPENCODE_WORKFLOW_MODEL_CATALOG_ROOT: candidate,
        }),
      ).toThrow()
    }
  })
  test("duplicate-family activation fails canonical validation before the service", async () => {
    await using server = await fixture()
    const replacement = { family: "deepseek-pro", providerID: "deepseek", modelID: "deepseek-pro-successor-fixture" }
    const response = await server.request("/api/workflow-models/activate", {
      expectedHeadSha256: server.expected.head!.sha256,
      replacements: [replacement, { ...replacement, modelID: "another-fixture" }],
    })
    expect(response.status).toBe(400)
    expect(server.calls.activate).toBe(0)
  })
  test("list and metadata refresh return the same sanitized contract without admission", async () => {
    await using server = await fixture()
    const list = await server.request("/api/workflow-models")
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ data: server.expected })
    const refreshed = await server.request("/api/workflow-models/refresh", { force: true })
    expect(refreshed.status).toBe(200)
    expect(await refreshed.json()).toEqual({ data: server.expected })
    expect(server.calls).toEqual({ refresh: 1, activate: 0, snapshots: 0 })
  })
  test("unauthenticated activation never enters the business service", async () => {
    await using server = await fixture()
    const response = await server.request(
      "/api/workflow-models/activate",
      {
        expectedHeadSha256: server.expected.head!.sha256,
        replacements: [{ family: "deepseek-pro", providerID: "deepseek", modelID: "deepseek-pro-successor-fixture" }],
      },
      false,
    )
    expect(response.status).toBe(401)
    expect(server.calls.activate).toBe(0)
  })
  test("an unconfigured auth password cannot turn catalogue administration into anonymous writes", async () => {
    await using server = await fixture("")
    const response = await server.request(
      "/api/workflow-models/activate",
      {
        expectedHeadSha256: server.expected.head!.sha256,
        replacements: [{ family: "deepseek-pro", providerID: "deepseek", modelID: "deepseek-pro-successor-fixture" }],
      },
      false,
    )
    expect(response.status).toBe(401)
    expect(server.calls.activate).toBe(0)
  })
  test("public refresh cannot inject credentials, origins or contract authority", async () => {
    await using server = await fixture()
    for (const patch of [
      { origin: "https://untrusted.invalid" },
      { apiKey: "offline-secret-fixture" },
      { profileID: "deepseek-responses-v4-v1" },
    ]) {
      expect(() => Schema.decodeUnknownSync(WorkflowModelCatalog.RefreshInput)({ force: true, ...patch })).toThrow()
      const response = await server.request("/api/workflow-models/refresh", { force: true, ...patch })
      expect(response.status).toBe(400)
    }
    expect(server.calls.refresh).toBe(0)
  })
  test("rejected credential-shaped fields are never echoed in public diagnostics", async () => {
    await using server = await fixture()
    const canary = "sk-offline-model-catalogue-canary"
    const response = await server.request("/api/workflow-models/refresh", { force: true, apiKey: canary })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain(canary)
    expect(server.calls.refresh).toBe(0)
  })
  test("activation rejects a stale displayed head with a body-free conflict", async () => {
    await using server = await fixture()
    const response = await server.request("/api/workflow-models/activate", {
      expectedHeadSha256: "f".repeat(64),
      replacements: [{ family: "deepseek-pro", providerID: "deepseek", modelID: "deepseek-pro-successor-fixture" }],
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ kind: "selection_conflict" })
    expect(server.calls.activate).toBe(1)
    expect(server.calls.snapshots).toBe(0)
  })
})
