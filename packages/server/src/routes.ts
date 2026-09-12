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
import { WorkflowAdmission } from "@opencode-ai/core/workflow/admission"
import { WorkflowBenchmarkTransport } from "@opencode-ai/core/workflow/benchmark-transport"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowRoleExecution } from "@opencode-ai/core/workflow/execution/role"
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
import { WorkflowCommandSandboxServer } from "./workflow/command-sandbox"
import { WorkflowRuntimeRecovery } from "./workflow/runtime-recovery"
import { WorkflowProductionEvidenceServer } from "./workflow/production-evidence"
import { ProductionHostRuntime } from "./workflow/production-host-runtime"

const applicationServices = LayerNode.group([
  Database.node,
  EventV2.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  SessionV2.node,
  WorkflowV2.node,
  WorkflowExecution.node,
  WorkflowAdmission.node,
  ResponsesV2.node,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
  WorkflowVisualHost.node,
  WorkflowRuntimeRecovery.node,
])

function applicationReplacements(workflow: Parameters<typeof workflowReplacements>[0] = {}) {
  return [
    [WorkflowBenchmarkTransport.node, ProductionHostRuntime.benchmarkTransportNode],
    [SessionExecution.node, SessionExecutionLocal.node],
    [WorkflowExecution.node, WorkflowExecutionLocal.node],
    ...workflowReplacements(workflow),
  ] as const
}

function defaultApplicationServiceBuilder<A, E>(
  services: LayerNode.Node<A, E, LayerNode.Tag | undefined>,
  replacements: ReturnType<typeof applicationReplacements>,
) {
  return AppNodeBuilder.build(services, replacements)
}

export type ApplicationServiceBuilder = typeof defaultApplicationServiceBuilder

type DefaultApplicationServiceOut = LayerNode.Output<typeof applicationServices>
type DefaultApplicationServiceError = LayerNode.Error<typeof applicationServices>

export type ApplicationServiceFactory<
  ServiceOut = DefaultApplicationServiceOut,
  ServiceError = DefaultApplicationServiceError,
  ServiceIn = never,
> = (
  services: typeof applicationServices,
  replacements: ReturnType<typeof applicationReplacements>,
  build: ApplicationServiceBuilder,
) => Layer.Layer<ServiceOut, ServiceError, ServiceIn>

export interface RouteCompositionOptions<
  ServiceOut = DefaultApplicationServiceOut,
  ServiceError = DefaultApplicationServiceError,
  ServiceIn = never,
> {
  readonly workflow?: Parameters<typeof workflowReplacements>[0]
  readonly buildApplicationServices?: ApplicationServiceFactory<ServiceOut, ServiceError, ServiceIn>
}

export function createRoutes<
  ServiceOut = DefaultApplicationServiceOut,
  ServiceError = DefaultApplicationServiceError,
  ServiceIn = never,
>(password?: string, composition: RouteCompositionOptions<ServiceOut, ServiceError, ServiceIn> = {}) {
  return makeRoutes(
    password
      ? ServerAuth.Config.configLayer({ username: "opencode", password: Option.some(password) })
      : ServerAuth.Config.layer,
    composition,
  )
}

export function createEmbeddedRoutes<
  ServiceOut = DefaultApplicationServiceOut,
  ServiceError = DefaultApplicationServiceError,
  ServiceIn = never,
>(composition: RouteCompositionOptions<ServiceOut, ServiceError, ServiceIn> = {}) {
  return makeRoutes(ServerAuth.Config.configLayer({ username: "opencode", password: Option.none() }), composition)
}

function makeRoutes<AuthError, AuthServices, ServiceOut, ServiceError, ServiceIn>(
  auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>,
  composition: RouteCompositionOptions<ServiceOut, ServiceError, ServiceIn>,
) {
  const replacements = applicationReplacements(composition.workflow)
  if (composition.buildApplicationServices) {
    return provideApplicationServices(
      auth,
      composition.buildApplicationServices(applicationServices, replacements, defaultApplicationServiceBuilder),
    )
  }
  return provideApplicationServices(auth, defaultApplicationServiceBuilder(applicationServices, replacements))
}

function provideApplicationServices<AuthError, AuthServices, ServiceOut, ServiceError, ServiceIn>(
  auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>,
  serviceLayer: Layer.Layer<ServiceOut, ServiceError, ServiceIn>,
) {
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
    readonly roleEvidence?: LayerNode.Node<WorkflowRoleExecution.Service, any, any>
  } = {},
) {
  const production = WorkflowProductionEvidenceServer.compositionNodes()
  return [
    [WorkflowVisualHost.node, input.visualHost ?? production.visualHost],
    [WorkflowCommandSandbox.node, input.commandSandbox ?? WorkflowCommandSandboxServer.node],
    [WorkflowRoleExecution.node, input.roleEvidence ?? production.roleEvidence],
  ] as const
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
