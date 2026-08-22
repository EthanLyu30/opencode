import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Credential } from "@opencode-ai/core/credential"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { layer as locationLayer } from "./location"
import { sessionLocationLayer } from "./middleware/session-location"
import { WorkflowVisualHostServer } from "./workflow/visual-host"
import { WorkflowCommandSandboxServer } from "./workflow/command-sandbox"
import { WorkflowRuntimeRecovery } from "./workflow/runtime-recovery"

const applicationServices = LayerNode.group([
  Database.node,
  EventV2.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  SessionV2.node,
  WorkflowV2.node,
  WorkflowExecution.node,
  ResponsesV2.node,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
  WorkflowVisualHost.node,
  WorkflowRuntimeRecovery.node,
])

export function createRoutes(password?: string) {
  return makeRoutes(
    password
      ? ServerAuth.Config.configLayer({ username: "opencode", password: Option.some(password) })
      : ServerAuth.Config.layer,
  )
}

export function createEmbeddedRoutes() {
  return makeRoutes(ServerAuth.Config.configLayer({ username: "opencode", password: Option.none() }))
}

function makeRoutes<AuthError, AuthServices>(auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>) {
  const serviceLayer = AppNodeBuilder.build(applicationServices, [
    [SessionExecution.node, SessionExecutionLocal.node],
    [WorkflowExecution.node, WorkflowExecutionLocal.node],
    ...workflowReplacements(),
  ])

  return HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(handlers),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(auth),
    Layer.provide(serviceLayer),
  )
}

export function workflowReplacements(
  input: {
    readonly visualHost?: LayerNode.Node<WorkflowVisualHost.Service, any, any>
    readonly commandSandbox?: LayerNode.Node<WorkflowCommandSandbox.Service, any, any>
  } = {},
) {
  return [
    [WorkflowVisualHost.node, input.visualHost ?? WorkflowVisualHostServer.node],
    [WorkflowCommandSandbox.node, input.commandSandbox ?? WorkflowCommandSandboxServer.node],
  ] as const
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
