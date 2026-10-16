import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Database } from "@opencode-ai/core/database/database"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { ModelSelection } from "@opencode-ai/core/workflow/model-selection"
import { WorkflowModelCatalogService } from "@opencode-ai/core/workflow/model-catalog/service"
import { fixtureAdmissionSnapshot } from "../../core/test/fixtures/workflow-model-catalog"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { createRoutes } from "../src/routes"
import { WorkflowModelCatalogRuntime } from "../src/workflow/model-catalog-runtime"
import { WorkflowRuntimeRecovery } from "../src/workflow/runtime-recovery"

const input = {
  prompt: "Fix a library without any web page",
  budget: { maxTokens: 20000, maxTurns: 20, maxToolCalls: 40, maxAttempts: 27 },
  coding: { maxRevisions: 1, maxTokens: 12000, maxTurns: 12, maxToolCalls: 24 },
  checks: { cwd: ".", test: "bun-test" },
  delivery: "background",
}

async function fixture(completeForeground = false) {
  const root = await tmpdir()
  const calls = { snapshots: 0 }
  const graph = createRoutes("offline-coding-password", {
    buildApplicationServices: (services, replacements) =>
      AppNodeBuilder.build(services, [
        ...replacements,
        [Database.node, Database.layerFromPath(":memory:")],
        [
          WorkflowExecution.node,
          makeGlobalNode({
            service: WorkflowExecution.Service,
            deps: [ResponsesV2.node],
            layer: Layer.effect(
              WorkflowExecution.Service,
              Effect.gen(function* () {
                const responses = yield* ResponsesV2.Service
                return WorkflowExecution.Service.of({
                  wake: completeForeground
                    ? Effect.gen(function* () {
                        // HTTP-only terminal fixture: real durable Response projection, not a workflow-execution proof.
                        for (const response of yield* responses.list())
                          if (!response.background && response.status === "queued")
                            yield* responses.complete({ responseID: response.id, output: [] }).pipe(Effect.orDie)
                      })
                    : Effect.void,
                  interrupt: () => Effect.void,
                  active: Effect.succeed(new Set()),
                })
              }),
            ),
          }),
        ],
        [
          ProjectV2.node,
          Layer.succeed(ProjectV2.Service, {
            resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
            directories: () => Effect.succeed([]),
            commit: () => Effect.void,
          }),
        ],
        [
          ModelSelection.node,
          Layer.succeed(ModelSelection.Service, {
            snapshot: () =>
              Effect.sync(() => {
                calls.snapshots++
                return fixtureAdmissionSnapshot()
              }),
          }),
        ],
        [
          WorkflowModelCatalogRuntime.node,
          Layer.succeed(WorkflowModelCatalogService.Service, {
            checkPinned: () => Effect.die("no provider checks in HTTP contract fixture"),
            view: () => Effect.die("no real catalogue"),
            refresh: () => Effect.die("no discovery"),
            activate: () => Effect.die("no activation"),
            snapshot: () => Effect.die("use frozen fixture"),
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
  const services = Context.make(PermissionSaved.Service, {
    list: () => Effect.die("unused"),
    add: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
  })
  return {
    root,
    calls,
    request: (path: string, body?: unknown, options: { auth?: boolean; location?: boolean; key?: string } = {}) =>
      web.handler(
        new Request(`http://localhost${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...(options.auth === false
              ? {}
              : { Authorization: `Basic ${Buffer.from("opencode:offline-coding-password").toString("base64")}` }),
            ...(options.location === false ? {} : { "x-opencode-directory": encodeURIComponent(root.path) }),
            ...(options.key ? { "Idempotency-Key": options.key } : {}),
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        services,
      ),
    [Symbol.asyncDispose]: async () => {
      await web.dispose()
      await root[Symbol.asyncDispose]()
    },
  }
}

describe("location-bound coding HTTP contract", () => {
  test("foreground HTTP follows the associated durable terminal Response rather than returning its queued admission copy", async () => {
    await using server = await fixture(true)
    const result = await server.request("/api/workflow/coding-build", { ...input, delivery: "foreground" })
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({
      data: { workflow: { type: "coding-build" }, response: { status: "completed", background: false } },
    })
  })
  test("requires normal authentication and explicit Location before admission", async () => {
    await using server = await fixture()
    expect((await server.request("/api/workflow/coding-build", input, { auth: false })).status).toBe(401)
    expect((await server.request("/api/workflow/coding-build", input, { location: false })).status).toBe(400)
    expect(server.calls.snapshots).toBe(0)
  })

  test("admits a no-preview coding task once, exposes associated resources and exclusive SSE replay, and cancels", async () => {
    await using server = await fixture()
    const response = await server.request("/api/workflow/coding-build", input, { key: "coding-http-once" })
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as {
      data: { workflow: { id: string; type: string }; response: { id: string; workflowID: string } }
    }
    expect(data.workflow.type).toBe("coding-build")
    expect(data.response.workflowID).toBe(data.workflow.id)
    const duplicate = await server.request("/api/workflow/coding-build", input, { key: "coding-http-once" })
    expect(((await duplicate.json()) as { data: typeof data }).data).toEqual(data)
    expect(server.calls.snapshots).toBe(1)
    expect(
      (
        await server.request(
          "/api/workflow/coding-build",
          { ...input, checks: { cwd: ".", test: "bun-run-test" } },
          { key: "coding-http-once" },
        )
      ).status,
    ).toBe(409)
    expect((await server.request(`/api/workflow/${data.workflow.id}`)).status).toBe(200)
    const resource = await server.request(`/v1/responses/${data.response.id}`)
    expect(await resource.json()).toMatchObject({ id: data.response.id, workflowID: data.workflow.id })
    const history = (await (await server.request(`/api/workflow/${data.workflow.id}/history?after=0`)).json()) as {
      data: Array<{ durable: { seq: number } }>
    }
    expect(history.data.length).toBeGreaterThan(0)
    expect(history.data.every((event) => event.durable.seq > 0)).toBe(true)
    const stream = await server.request(`/api/workflow/${data.workflow.id}/event?after=0`)
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('"seq":1')
    expect(first).not.toContain('"seq":0')
    await reader.cancel()
    expect((await server.request(`/api/workflow/${data.workflow.id}/cancel`, {})).status).toBe(204)
  })

  test("query Location is explicit and unknown authority or provider fields are rejected without admission", async () => {
    await using server = await fixture()
    for (const extra of [
      { model: "untrusted" },
      { baseURL: "http://untrusted.invalid" },
      { preview: {} },
      { hostPlan: {} },
      { benchmarkTransport: {} },
    ]) {
      expect((await server.request("/api/workflow/coding-build", { ...input, ...extra })).status).toBe(400)
    }
    expect(server.calls.snapshots).toBe(0)
    const canary = "offline-credential-canary-never-a-real-key"
    const rejected = await server.request("/api/workflow/coding-build", { ...input, apiKey: canary })
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).not.toContain(canary)
    const path = `/api/workflow/coding-build?location[directory]=${encodeURIComponent(server.root.path)}`
    expect((await server.request(path, input, { location: false, key: "query-location" })).status).toBe(200)
    expect(server.calls.snapshots).toBe(1)
  })
})
