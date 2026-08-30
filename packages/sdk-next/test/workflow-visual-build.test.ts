import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenCode as PromiseOpenCode } from "@opencode-ai/client"
import { OpenCode as EffectOpenCode } from "@opencode-ai/client/effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { createEmbeddedRoutes, type ApplicationServiceFactory } from "@opencode-ai/server/routes"
import { WorkflowRuntimeRecovery } from "@opencode-ai/server/workflow/runtime-recovery"
import { Context, Effect, Layer, LayerMap } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"

const locationA = path.join(tmpdir(), "opencode-sdk-visual-build-location-a")
const locationB = path.join(tmpdir(), "opencode-sdk-visual-build-location-b")

const input = (delivery: "background" | "foreground" = "background") => ({
  prompt: "Build the visual experience",
  budget: { maxAttempts: 3, maxTokens: 20_000, maxTurns: 20, maxToolCalls: 40 },
  visual: { maxRevisions: 1, maxTokens: 12_000, maxTurns: 12, maxToolCalls: 24 },
  preview: { kind: "static" as const, entrypoint: "index.html" },
  delivery,
})

test("generated Promise and Effect clients share one location-scoped visual-build admission", async () => {
  await Promise.all([locationA, locationB].map((directory) => fs.mkdir(directory, { recursive: true })))
  await Promise.all([locationA, locationB].map((directory) => fs.writeFile(`${directory}\\index.html`, "ready")))
  const state = { wakes: 0 }
  const routeGraph = createEmbeddedRoutes({ buildApplicationServices: applicationFactory(state) })
  const web = HttpRouter.toWebHandler(routeGraph.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  })
  const requestServices = Context.make(
    PermissionSaved.Service,
    PermissionSaved.Service.of({
      list: () => Effect.die("unused"),
      add: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
    }),
  )
  const fetch = Object.assign(
    (request: RequestInfo | URL, init?: RequestInit) => web.handler(new Request(request, init), requestServices),
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch
  const promise = PromiseOpenCode.make({ baseUrl: "http://opencode.local", fetch })

  try {
    expect(typeof promise.workflows.visualBuildCreate).toBe("function")

    const first = await promise.workflows.visualBuildCreate(
      { ...input(), "idempotency-key": "sdk-visual-build-retry" },
      { headers: { "x-opencode-directory": locationA } },
    )
    const retry = await promise.workflows.visualBuildCreate(
      { ...input(), "idempotency-key": "sdk-visual-build-retry" },
      { headers: { "x-opencode-directory": locationA } },
    )

    expect(first.response).toMatchObject({ status: "queued", background: true, store: true })
    expect(retry.workflow.id).toBe(first.workflow.id)
    expect(retry.response.id).toBe(first.response.id)
    expect(retry.workflow.location?.directory).toBe(locationA)
    expect(state.wakes).toBe(1)

    const locatedA = await promise.workflows.visualBuildCreate(input(), {
      headers: { "x-opencode-directory": locationA },
    })
    const locatedB = await promise.workflows.visualBuildCreate(input(), {
      headers: { "x-opencode-directory": locationB },
    })
    expect(locatedA.workflow.location?.directory).toBe(locationA)
    expect(locatedB.workflow.location?.directory).toBe(locationB)
    expect(locatedB.workflow.id).not.toBe(locatedA.workflow.id)
    expect(locatedB.response.id).not.toBe(locatedA.response.id)

    const effectFetch = withDirectory(fetch, locationA)
    const effect = await Effect.runPromise(
      EffectOpenCode.make({ baseUrl: "http://opencode.local" }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, effectFetch),
      ),
    )
    expect(typeof effect.workflows.visualBuildCreate).toBe("function")
    const foreground = await Effect.runPromise(
      effect.workflows.visualBuildCreate({
        ...input("foreground"),
        "idempotency-key": "sdk-visual-build-foreground",
      }),
    )
    expect(String(foreground.workflow.location?.directory)).toBe(locationA)
    expect(foreground.response).toMatchObject({ status: "completed", background: false, store: true })
    expect(foreground.response.workflowID).toBe(foreground.workflow.id)

    const strictBody = await fetch("http://opencode.local/api/workflow/visual-build", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": locationA },
      body: JSON.stringify({ ...input(), directory: locationB }),
    })
    expect(strictBody.status).toBe(400)

    const numericEnvironment = await fetch("http://opencode.local/api/workflow/visual-build", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": locationA },
      body: JSON.stringify({
        ...input(),
        preview: { kind: "script", argv: ["bun", "run", "preview"], env: { PORT: 4096 } },
      }),
    })
    expect(numericEnvironment.status).toBe(400)

    const strictHeader = await fetch("http://opencode.local/api/workflow/visual-build", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": locationA,
        "idempotency-key": "x".repeat(129),
      },
      body: JSON.stringify(input()),
    })
    expect(strictHeader.status).toBe(400)
  } finally {
    await web.dispose()
    await Promise.all([locationA, locationB].map((directory) => fs.rm(directory, { recursive: true, force: true })))
  }
}, 30_000)

function withDirectory(fetch: typeof globalThis.fetch, directory: string): typeof globalThis.fetch {
  return Object.assign(
    (request: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set("x-opencode-directory", directory)
      return fetch(request, { ...init, headers })
    },
    { preconnect: () => undefined },
  )
}

function applicationFactory(state: { wakes: number }): ApplicationServiceFactory {
  const databaseNode = makeGlobalNode({
    service: Database.Service,
    layer: Database.layerFromPath(":memory:"),
    deps: [],
  })
  const cleanupNode = makeGlobalNode({
    name: ToolOutputStore.cleanupNode.name,
    layer: Layer.empty,
    deps: [],
  })
  const recoveryNode = makeGlobalNode({
    service: WorkflowRuntimeRecovery.Service,
    layer: Layer.succeed(
      WorkflowRuntimeRecovery.Service,
      WorkflowRuntimeRecovery.Service.of({ healthy: true, recovered: 0, skipped: 0, ready: true }),
    ),
    deps: [],
  })
  const projectNode = makeGlobalNode({
    service: ProjectV2.Service,
    layer: Layer.succeed(
      ProjectV2.Service,
      ProjectV2.Service.of({
        directories: () => Effect.succeed([]),
        resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
        commit: () => Effect.void,
      }),
    ),
    deps: [],
  })
  const locationMapNode = makeGlobalNode({
    service: LocationServiceMap.Service,
    layer: Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(
        (ref: Location.Ref) =>
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- this no-provider fixture intentionally supplies only services reached by admission
          Layer.mergeAll(
            Layer.succeed(
              Location.Service,
              Location.Service.of({
                directory: ref.directory,
                workspaceID: ref.workspaceID,
                project: { id: ProjectV2.ID.global, directory: ref.directory },
              }),
            ),
            AgentV2.locationLayer,
          ) as unknown as Layer.Layer<LocationServices>,
        { idleTimeToLive: "1 minute" },
      ),
    ),
    deps: [],
  })
  const executionNode = makeGlobalNode({
    service: WorkflowExecution.Service,
    layer: Layer.effect(
      WorkflowExecution.Service,
      Effect.gen(function* () {
        const responses = yield* ResponsesV2.Service
        return WorkflowExecution.Service.of({
          wake: Effect.gen(function* () {
            state.wakes++
            const pending = (yield* responses.list()).filter(
              (response) => !response.background && response.status === "queued",
            )
            yield* Effect.forEach(
              pending,
              (response) =>
                responses
                  .complete({ responseID: response.id, output: [] })
                  .pipe(Effect.delay("10 millis"), Effect.orDie, Effect.forkChild),
              { discard: true },
            )
          }),
          interrupt: () => Effect.void,
          active: Effect.succeed(new Set()),
        })
      }),
    ),
    deps: [ResponsesV2.node],
  })

  return (services, replacements) =>
    AppNodeBuilder.build(services, [
      ...replacements.filter(([source]) => source.name !== WorkflowExecution.node.name),
      [Database.node, databaseNode],
      [ToolOutputStore.cleanupNode, cleanupNode],
      [WorkflowRuntimeRecovery.node, recoveryNode],
      [ProjectV2.node, projectNode],
      [LocationServiceMap.node, locationMapNode],
      [WorkflowExecution.node, executionNode],
    ])
}
