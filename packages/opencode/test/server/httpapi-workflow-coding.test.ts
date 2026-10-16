import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

test("production CLI route graph installs its real frozen coding sandbox in the Location map", async () => {
  await using workspace = await tmpdir()
  let frozenCoding = false
  const execution = makeGlobalNode({
    service: WorkflowExecution.Service,
    deps: [LocationServiceMap.node],
    layer: Layer.effect(
      WorkflowExecution.Service,
      Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        const sandbox = yield* WorkflowCommandSandbox.Service.pipe(
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(workspace.path) }))),
        )
        frozenCoding = typeof sandbox.runFrozenCoding === "function"
        return WorkflowExecution.Service.of({
          wake: Effect.void,
          interrupt: () => Effect.void,
          active: Effect.succeed(new Set()),
        })
      }),
    ),
  })
  const web = HttpRouter.toWebHandler(HttpApiApp.createRoutes(undefined, { workflowExecution: execution }), {
    disableLogger: true,
  })
  try {
    const response = await web.handler(
      new Request("http://localhost/api/health"),
      Context.makeUnsafe<unknown>(new Map()),
    )
    expect(response.status).toBe(200)
    expect(frozenCoding).toBe(true)
  } finally {
    await web.dispose()
    await resetDatabase()
  }
}, 30000)
