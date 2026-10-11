import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { WorkflowModelGroup } from "@opencode-ai/protocol/groups/workflow-model"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { controller } from "../handlers/workflow-model"
import { WorkflowModelCatalogRuntime } from "./model-catalog-runtime"
import { ServerAuth } from "../auth"
import { authorizationLayer } from "../middleware/authorization"
import { schemaErrorLayer } from "../middleware/schema-error"
import { Option } from "effect"

// Authenticated in-process HTTP only: no listening port, persisted password or public bypass.
export function makeLocalHandler() {
  const password = randomUUID()
  const api = HttpApi.make("workflow-model-local")
    .add(WorkflowModelGroup)
    .middleware(Authorization)
    .middleware(SchemaErrorMiddleware)
  const handler = HttpApiBuilder.group(api, "server.workflowModels", (handlers) =>
    Effect.gen(function* () {
      const catalogue = yield* controller
      return handlers
        .handle("workflowModels.list", () => catalogue.list().pipe(Effect.map((data) => ({ data }))))
        .handle("workflowModels.refresh", (ctx) =>
          catalogue.refresh(ctx.payload).pipe(Effect.map((data) => ({ data }))),
        )
        .handle("workflowModels.activate", (ctx) =>
          catalogue.activate(ctx.payload).pipe(Effect.map((data) => ({ data }))),
        )
    }),
  )
  const routes = HttpApiBuilder.layer(api).pipe(
    Layer.provide(handler),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(ServerAuth.Config.configLayer({ username: "opencode", password: Option.some(password) })),
    Layer.provide(AppNodeBuilder.build(WorkflowModelCatalogRuntime.node)),
    Layer.provide(HttpServer.layerServices),
  )
  const web = HttpRouter.toWebHandler(routes, { disableLogger: true })
  return { header: ServerAuth.header({ username: "opencode", password })!, handler: web.handler, dispose: web.dispose }
}
