import { createHash } from "node:crypto"
import { closeSync, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Database as BunDatabase } from "bun:sqlite"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { llmClient, httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"
import { createEmbeddedRoutes, type ApplicationServiceFactory } from "@opencode-ai/server/routes"
import { WorkflowProductionEvidenceServer } from "@opencode-ai/server/workflow/production-evidence"
import { WorkflowRuntimeRecovery } from "@opencode-ai/server/workflow/runtime-recovery"
import { type PlaywrightCapture } from "@opencode-ai/server/workflow/playwright"
import { type ProcessOwnership } from "@opencode-ai/server/workflow/process-ownership"
import { WorkflowVisualHostServer } from "@opencode-ai/server/workflow/visual-host"
import {
  LLMClient,
  LLMEvent,
  LLMResponse,
  mergeProviderOptions,
  type LLMClientService,
  type LLMRequest,
} from "../../../llm/src"
import { Context, Effect, Layer, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { assertSafeValue, assertScannerRejectsDynamicProbes, scanDatabase } from "./workflow-production-safety"
import { replayProductionBatches } from "./workflow-production-replay"
import { loadRecording, recordingPath } from "./workflow-production-recording"
import {
  systems,
  type ProductionCrashOptions,
  type ProductionRecording,
  type ProviderRequestObservation,
  type RecordingStage,
  type RuntimeCounters,
  type RuntimeObservation,
  type ToolAmbiguityObservation,
} from "./workflow-production-types"

export {
  assertProductionAcceptanceDatabaseSafeSurface,
  assertProductionAcceptanceSafeSurface,
} from "./workflow-production-safety"
export type {
  ProductionCrashOptions,
  ProductionRecording,
  ProviderRequestObservation,
  RuntimeCounters,
  RuntimeObservation,
  ToolAmbiguityObservation,
} from "./workflow-production-types"
export { loadRecording, recordingPath } from "./workflow-production-recording"

export function runProductionScenario(caseRoot: string, crash?: ProductionCrashOptions): Promise<RuntimeObservation>
export function runProductionScenario(
  caseRoot: string,
  crash: undefined,
  mode: "observe-tool-ambiguity",
): Promise<ToolAmbiguityObservation>
export async function runProductionScenario(
  caseRoot: string,
  crash?: ProductionCrashOptions,
  mode?: "observe-tool-ambiguity",
): Promise<RuntimeObservation | ToolAmbiguityObservation> {
  const root = await fs.realpath(caseRoot)
  const workspace = path.join(root, "workspace")
  const databasePath = path.join(root, "data", "workflow.sqlite")
  const hostRoot = path.join(root, "host")
  const evidenceRoot = path.join(root, "evidence")
  const ownershipPath = path.join(root, "ownership.json")
  const recording = await loadRecording()
  const credentialSentinel = `fixture-credential-${crypto.randomUUID()}`
  const counters: RuntimeCounters = {
    providerCalls: 0,
    credentialReads: 0,
    outboundCalls: 0,
    browserCaptures: 0,
    browserCloses: 0,
    functionalTests: 0,
    processStarts: 0,
    processStops: 0,
    processRecovers: 0,
  }
  const browserBodies: Array<{
    kind: "reference" | "implementation"
    revision: number
    sha256: string
    size: number
  }> = []
  const frozenTests: Array<{ revision: number; sha256: string; size: number; exit: number }> = []
  const boundedLogs: string[] = []
  const providerRequests: ProviderRequestObservation[] = []

  await Promise.all(
    [databasePath, hostRoot, evidenceRoot].map((target, index) =>
      fs.mkdir(index === 0 ? path.dirname(target) : target, { recursive: true }),
    ),
  )
  const resume = recordedModelResumeState(databasePath, recording)
  const expectedProviderCalls =
    recording.stages.length -
    resume.index +
    recording.stages.slice(resume.index).filter((stage) => stage.toolScript.length > 0).length -
    (resume.pendingTool ? 1 : 0)
  const model = recordedModel(recording, counters, providerRequests, credentialSentinel, resume)
  const previewResumeCount = recordedPreviewResumeState(evidenceRoot, recording)
  const capabilities = previewCapabilities(recording, hostRoot, browserBodies, previewResumeCount)
  const browser = recordedBrowser(counters, capabilities)
  const ownership = fileBackedOwnership(ownershipPath, counters, hostRoot, capabilities, crash)
  const command = frozenCommandSandbox(counters, frozenTests, boundedLogs)
  const visualNode = productionVisualNode({ hostRoot, evidenceRoot, browser, ownership, capabilities })
  const commandNode = makeLocationNode({
    service: WorkflowCommandSandbox.Service,
    layer: Layer.succeed(WorkflowCommandSandbox.Service, command),
    deps: [],
  })
  const routeGraph = createEmbeddedRoutes({
    workflow: { visualHost: visualNode, commandSandbox: commandNode },
    buildApplicationServices: applicationFactory({
      databasePath,
      model,
      credentialSentinel,
      counters,
      crash,
    }),
  })
  const web = HttpRouter.toWebHandler(routeGraph.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
  const requestServices = Context.make(
    PermissionSaved.Service,
    PermissionSaved.Service.of({
      list: () => Effect.succeed([]),
      add: () => Effect.void,
      remove: () => Effect.void,
    }),
  )
  const fetch = Object.assign(
    (request: RequestInfo | URL, init?: RequestInit) => web.handler(new Request(request, init), requestServices),
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    () => {
      counters.outboundCalls++
      throw new Error("Global fetch is forbidden in the production acceptance")
    },
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch
  const { OpenCode } = await import("@opencode-ai/client")
  const client = OpenCode.make({ baseUrl: "http://opencode.local", fetch })
  let observation: RuntimeObservation | ToolAmbiguityObservation | undefined
  const resumedPreviewKind = recordedPreviewKind(databasePath)
  const admissionInput = {
    prompt: "Build the frozen offline production experience",
    budget: { maxAttempts: 20, maxTokens: 20_000, maxTurns: 40, maxToolCalls: 20 },
    visual: { maxRevisions: 2, maxTokens: 12_000, maxTurns: 20, maxToolCalls: 10 },
    preview:
      crash?.boundary === "preview-start-intent" || resumedPreviewKind === "script"
        ? ({ kind: "script" as const, argv: ["node", "server.mjs"] } as const)
        : ({ kind: "static" as const, entrypoint: "index.html" } as const),
    delivery: "foreground" as const,
    "idempotency-key": "task-23-11-production-acceptance",
  }
  const admissionHeaders = { "x-opencode-directory": workspace }
  try {
    if (mode === "observe-tool-ambiguity") {
      const controller = new AbortController()
      void client.workflows
        .visualBuildCreate(admissionInput, { headers: admissionHeaders, signal: controller.signal })
        .catch(() => undefined)
      const approval = await waitForToolAmbiguity(databasePath)
      controller.abort()
      if (
        counters.providerCalls !== 0 ||
        counters.browserCaptures !== 0 ||
        counters.functionalTests !== 0 ||
        counters.processStarts !== 0 ||
        approval.toolContinuations !== 0
      ) {
        throw new Error("Pending tool recovery did not fail closed at the exact approval boundary")
      }
      await assertAcceptanceSurfaces({
        databasePath,
        evidenceRoot,
        recording,
        providerRequests,
        browserBodies,
        frozenTests,
        boundedLogs,
        childEnvironment: process.env,
        forbiddenSentinels: [credentialSentinel, "trustedMessages"],
      })
      observation = {
        workflowStatus: approval.workflowStatus,
        responseStatus: approval.responseStatus,
        stage: {
          role: approval.role,
          revision: approval.revision,
          status: approval.stageStatus,
          error: { code: approval.errorCode },
        },
        providerCalls: counters.providerCalls,
        toolContinuations: approval.toolContinuations,
        workspaceSha256: sha256(await fs.readFile(path.join(workspace, "index.html"))),
      }
      return observation
    }
    const admitted = await client.workflows.visualBuildCreate(admissionInput, { headers: admissionHeaders })
    const detail = await client.workflows.get({ workflowID: admitted.workflow.id })
    const artifacts = await client.workflows.artifacts({ workflowID: admitted.workflow.id })
    const response = await client.responses.get({ responseID: admitted.response.id })
    if (counters.providerCalls !== expectedProviderCalls)
      throw new Error(`Recording did not settle exactly: ${counters.providerCalls}`)
    capabilities.assertSettled()
    if (response.usage === undefined) throw new Error("Stored Response usage is absent")
    assertRecordedTerminal(recording, detail, artifacts, { ...response, usage: response.usage })
    const stored = (() => {
      const database = new BunDatabase(databasePath, { readonly: true })
      try {
        return {
          responseItemKinds: assertStoredResponseItems(database, admitted.response.id, admitted.workflow.id, recording),
          workflowSessionVisibility:
            database
              .query<{ visibility: string }, [string]>("SELECT visibility FROM session WHERE id = ?")
              .get(detail.run.sessionID ?? "")?.visibility ?? null,
          conversationCount:
            database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM conversation").get()?.count ?? -1,
        }
      } finally {
        database.close()
      }
    })()
    const evidence = readEvidence(evidenceRoot)
    const responseItems = response.output.map((item) => item.type)
    if (responseItems.some((type) => typeof type !== "string")) {
      throw new Error("Stored Response output contains a non-string item type")
    }
    const responseItemTypes = responseItems as string[]
    const stageByID = new Map(detail.stages.map((stage) => [stage.id, stage]))
    const toolContinuations = artifacts
      .filter((artifact) => artifact.kind === "tool-continuation")
      .map((artifact) => {
        const owner = stageByID.get(artifact.stageID)
        const metadata = artifact.metadata
        if (owner === undefined || metadata === null || typeof metadata !== "object") {
          throw new Error("Tool continuation owner or metadata is absent")
        }
        return {
          role: owner.type,
          revision: typeof owner.input.revision === "number" ? owner.input.revision : -1,
          callID: String(Reflect.get(metadata, "callID")),
          name: String(Reflect.get(metadata, "name")),
        }
      })
    await assertAcceptanceSurfaces({
      databasePath,
      evidenceRoot,
      recording,
      providerRequests,
      browserBodies,
      frozenTests,
      boundedLogs,
      childEnvironment: process.env,
      forbiddenSentinels: [credentialSentinel, "trustedMessages"],
    })
    const replay = await replayProductionBatches(databasePath, root)
    observation = {
      workflowID: admitted.workflow.id,
      responseID: admitted.response.id,
      workflowStatus: detail.run.status,
      responseStatus: response.status,
      stages: detail.stages.map((stage) => ({
        ordinal: stage.ordinal,
        role: stage.type,
        revision: typeof stage.input.revision === "number" ? stage.input.revision : -1,
        status: stage.status,
        attempt: stage.attempt,
      })),
      artifacts: artifacts.map((artifact) => ({
        kind: artifact.kind,
        stageID: artifact.stageID,
        sha256: artifact.sha256,
        size: artifact.size,
      })),
      counters,
      browserBodies,
      frozenTests,
      evidence: evidence.items,
      evidenceBytes: evidence.total,
      responseItems: responseItemTypes,
      responseItemKinds: stored.responseItemKinds,
      responseUsage: response.usage,
      toolContinuations,
      workflowSessionVisibility: stored.workflowSessionVisibility,
      conversationCount: stored.conversationCount,
      finalWorkspaceSha256: sha256(await fs.readFile(path.join(workspace, "index.html"))),
      secretScanPassed: true,
      providerRequests,
      replay,
    }
  } finally {
    try {
      await web.dispose()
    } finally {
      globalThis.fetch = originalFetch
    }
  }
  if (observation === undefined) throw new Error("Production observation was not collected")
  return { ...observation, counters: { ...counters } }
}

function recordedPreviewKind(databasePath: string): "static" | "script" | undefined {
  if (!existsSync(databasePath)) return undefined
  const database = new BunDatabase(databasePath, { readonly: true })
  try {
    const row = database.query<{ input: string }, []>("SELECT input FROM workflow_run LIMIT 1").get()
    if (row === null) return undefined
    const value: unknown = JSON.parse(row.input)
    if (value === null || typeof value !== "object") return undefined
    const plan = Reflect.get(value, "workflow.production-host-plan.v1")
    const preview = plan !== null && typeof plan === "object" ? Reflect.get(plan, "preview") : undefined
    const kind = preview !== null && typeof preview === "object" ? Reflect.get(preview, "kind") : undefined
    return kind === "static" || kind === "script" ? kind : undefined
  } finally {
    database.close()
  }
}

function applicationFactory(input: {
  readonly databasePath: string
  readonly model: Layer.Layer<LLMClientService>
  readonly credentialSentinel: string
  readonly counters: RuntimeCounters
  readonly crash?: ProductionCrashOptions
}): ApplicationServiceFactory {
  const databaseLayer = Database.layerFromPath(input.databasePath)
  const databaseNode = makeGlobalNode({
    service: Database.Service,
    layer: databaseLayer,
    deps: [],
  })
  const cleanupNode = makeGlobalNode({ name: ToolOutputStore.cleanupNode.name, layer: Layer.empty, deps: [] })
  const recoveryNode = makeGlobalNode({
    service: WorkflowRuntimeRecovery.Service,
    layer: Layer.succeed(
      WorkflowRuntimeRecovery.Service,
      WorkflowRuntimeRecovery.Service.of({ healthy: true, recovered: 0, skipped: 0, ready: true }),
    ),
    deps: [],
  })
  const credentialNode = makeGlobalNode({
    service: Credential.Service,
    layer: Layer.mock(Credential.Service, {
      list: (integrationID) =>
        Effect.sync(() => {
          input.counters.credentialReads++
          return [
            new Credential.Info({
              id: Credential.ID.create(),
              integrationID,
              label: "offline-recording",
              value: Credential.Key.make({ type: "key", key: input.credentialSentinel }),
            }),
          ]
        }),
    }),
    deps: [],
  })
  const modelNode = makeGlobalNode({ service: LLMClient.Service, layer: input.model, deps: [] })
  const outboundNode = makeGlobalNode({
    service: HttpClient.HttpClient,
    layer: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() =>
        Effect.sync(() => {
          input.counters.outboundCalls++
          throw new Error("Scoped outbound transport is forbidden in the production acceptance")
        }),
      ),
    ),
    deps: [],
  })
  const executionNode = WorkflowExecutionLocal.nodeWith({
    ownerID: "task-23-11-production-owner",
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 5,
    concurrency: 1,
  })
  const selectedExecutionNode =
    input.crash?.boundary === "admission-postcommit-prewake"
      ? makeGlobalNode({
          service: WorkflowExecution.Service,
          layer: Layer.succeed(
            WorkflowExecution.Service,
            WorkflowExecution.Service.of({
              wake: Effect.sync(() => {
                writeCrashMarker(input.crash!.markerPath, { boundary: input.crash!.boundary })
                process.exit(17)
              }),
              active: Effect.succeed(new Set()),
              interrupt: () => Effect.void,
            }),
          ),
          deps: [],
        })
      : executionNode
  const eventNode =
    input.crash !== undefined && input.crash.boundary !== "admission-postcommit-prewake"
      ? crashEventNode(databaseLayer, input.crash, input.counters)
      : undefined

  return (services, replacements) =>
    AppNodeBuilder.build(services, [
      ...replacements.filter(
        ([source]) =>
          source.name !== WorkflowExecution.node.name &&
          (eventNode === undefined || source.name !== EventV2.node.name) &&
          source.name !== Credential.node.name &&
          source.name !== llmClient.name &&
          source.name !== httpClient.name,
      ),
      [Database.node, databaseNode],
      [ToolOutputStore.cleanupNode, cleanupNode],
      [WorkflowRuntimeRecovery.node, recoveryNode],
      [Credential.node, credentialNode],
      [llmClient, modelNode],
      [httpClient, outboundNode],
      ...(eventNode === undefined ? [] : ([[EventV2.node, eventNode]] as const)),
      [WorkflowExecution.node, selectedExecutionNode],
    ])
}

function crashEventNode(
  databaseLayer: Layer.Layer<Database.Service>,
  crash: ProductionCrashOptions,
  counters: RuntimeCounters,
) {
  const base = EventV2.layerWith().pipe(Layer.provide(databaseLayer))
  const layer = Layer.effect(
    EventV2.Service,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const publish: EventV2.Interface["publish"] = (definition, data, options) => {
        const prePublish =
          (crash.boundary === "png-staged-before-event" && relatedScreenshot(options)) ||
          (crash.boundary === "terminal-before-publish" && relatedTerminal(options))
        if (prePublish) return crashProcess(crash, counters)
        return events
          .publish(definition, data, options)
          .pipe(
            Effect.tap(() => (checkpointBoundary(crash.boundary, data) ? crashProcess(crash, counters) : Effect.void)),
          )
      }
      return EventV2.Service.of({ ...events, publish })
    }),
  ).pipe(Layer.provide(base))
  return makeGlobalNode({ service: EventV2.Service, layer, deps: [] })
}

function checkpointBoundary(boundary: ProductionCrashOptions["boundary"], data: unknown): boolean {
  if (data === null || typeof data !== "object") return false
  const checkpoint = Reflect.get(data, "checkpoint")
  if (checkpoint === null || typeof checkpoint !== "object") return false
  const providerTurn = Reflect.get(checkpoint, "providerTurn")
  const activeTurn = Reflect.get(checkpoint, "activeTurn")
  if (boundary === "provider-result-checkpoint") {
    return (
      providerTurn !== null && typeof providerTurn === "object" && Reflect.get(providerTurn, "result") !== undefined
    )
  }
  if (activeTurn === null || typeof activeTurn !== "object") return false
  const results = Reflect.get(activeTurn, "results")
  if (boundary === "pending-tool-intent") return typeof Reflect.get(activeTurn, "pendingCallID") === "string"
  return (
    boundary === "settled-tool-result" &&
    !Reflect.has(activeTurn, "pendingCallID") &&
    Array.isArray(results) &&
    results.length === 1
  )
}

function relatedScreenshot(options: unknown): boolean {
  return related(options).some((item) => {
    const data = Reflect.get(item, "data")
    const artifact = data !== null && typeof data === "object" ? Reflect.get(data, "artifact") : undefined
    const kind = artifact !== null && typeof artifact === "object" ? Reflect.get(artifact, "kind") : undefined
    return (
      kind === WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND ||
      kind === WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND
    )
  })
}

function relatedTerminal(options: unknown): boolean {
  const types = related(options).map((item) => {
    const definition = Reflect.get(item, "definition")
    return definition !== null && typeof definition === "object" ? Reflect.get(definition, "type") : undefined
  })
  return types.includes("workflow.succeeded") && types.includes("response.completed")
}

function related(options: unknown): readonly object[] {
  if (options === null || typeof options !== "object") return []
  const value = Reflect.get(options, "related")
  return Array.isArray(value) ? value.filter((item): item is object => item !== null && typeof item === "object") : []
}

function crashProcess(crash: ProductionCrashOptions, counters: RuntimeCounters): Effect.Effect<never> {
  return Effect.sync(() => {
    writeCrashMarker(crash.markerPath, { boundary: crash.boundary, counters })
    process.exit(17)
  })
}

function productionVisualNode(input: {
  readonly hostRoot: string
  readonly evidenceRoot: string
  readonly browser: PlaywrightCapture.Runtime
  readonly ownership: ProcessOwnership.Service
  readonly capabilities: PreviewCapabilities
}) {
  return makeGlobalNode({
    service: WorkflowVisualHost.Service,
    layer: Layer.unwrap(
      Effect.gen(function* () {
        const workflows = yield* WorkflowStore.Service
        const locations = yield* LocationServiceMap.Service
        const dependencies: WorkflowProductionEvidenceServer.ResolverDependencies = {
          getWorkflow: workflows.get,
          captureSnapshot: (location) =>
            Effect.flatMap(Snapshot.Service, (snapshot) => snapshot.capture()).pipe(
              Effect.provide(locations.get(location)),
            ),
          snapshotEntries: (location, snapshot) =>
            Effect.flatMap(Snapshot.Service, (service) => service.entries({ snapshot })).pipe(
              Effect.provide(locations.get(location)),
            ),
          snapshotContents: (location, snapshot) =>
            Effect.flatMap(Snapshot.Service, (service) => service.contents({ snapshot })).pipe(
              Effect.provide(locations.get(location)),
            ),
        }
        const resolveImplementation = WorkflowProductionEvidenceServer.makeImplementationResolver(dependencies)
        const resolvePreviewLease = WorkflowProductionEvidenceServer.makePreviewLeaseResolver(dependencies)
        const isPreviewLeaseLive = WorkflowProductionEvidenceServer.makePreviewLeaseLiveProbe(dependencies)
        const resolver: WorkflowVisualHost.ResolveImplementationContract = async (request) => {
          const contract = await resolveImplementation(request)
          input.capabilities.registerImplementation(
            request.revision,
            request.plan.configSha256,
            request.plan.locationRoot,
            request.plan.entrypoint,
            contract,
          )
          return contract
        }
        return WorkflowVisualHostServer.makeLayer({
          hostRoot: input.hostRoot,
          evidenceRoot: input.evidenceRoot,
          browser: input.browser,
          processOwnership: input.ownership,
          probeOwnedOrigin: input.capabilities.probeOwnedOrigin,
          resolveImplementationContract: resolver,
          resolvePreviewLease,
          isPreviewLeaseLive,
          requireImplementationSealedSnapshot: true,
          onRecordCreated: (directory) => input.capabilities.registerReferenceDirectory(directory),
        })
      }),
    ),
    deps: [WorkflowStore.node, LocationServiceMap.node],
  })
}

function recordedModel(
  recording: ProductionRecording,
  counters: RuntimeCounters,
  observations: ProviderRequestObservation[],
  credentialSentinel: string,
  resume: { readonly index: number; readonly pendingTool: boolean },
): Layer.Layer<LLMClientService> {
  let index = resume.index
  let pendingTool = resume.pendingTool
  return Layer.succeed(
    LLMClient.Service,
    LLMClient.Service.of({
      prepare: () => Effect.die("Recorded provider does not prepare transport requests"),
      stream: () => Stream.die("Recorded provider does not stream"),
      generate: (request) =>
        Effect.sync(() => {
          const stage = recording.stages[index]
          if (stage === undefined) throw new Error("Unexpected provider request after the recording terminal")
          validateRequest(request, stage, pendingTool)
          assertSafeValue(providerRequestSurface(request), "$providerRequest", new Set([credentialSentinel]))
          observations.push(observeProviderRequest(request, stage, pendingTool))
          counters.providerCalls++
          if (stage.toolScript.length > 0 && !pendingTool) {
            if (stage.toolScript.length !== 1) throw new Error("The frozen tool script must contain exactly one call")
            pendingTool = true
            const call = stage.toolScript[0]!
            const response = LLMResponse.fromEvents([
              LLMEvent.toolCall({ id: call.callID, name: call.name, input: call.input }),
              LLMEvent.finish({ reason: "tool-calls", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }),
            ])
            if (!response) throw new Error("Invalid recorded tool response")
            return response
          }
          pendingTool = false
          index++
          const text = JSON.stringify(stage.semantic)
          const response = LLMResponse.fromEvents([
            LLMEvent.textStart({ id: `semantic-${index}` }),
            LLMEvent.textDelta({ id: `semantic-${index}`, text }),
            LLMEvent.textEnd({ id: `semantic-${index}` }),
            LLMEvent.finish({ reason: stage.terminal.finishReason, usage: stage.usage }),
          ])
          if (!response) throw new Error("Invalid recorded semantic response")
          return response
        }),
    }),
  )
}

function recordedModelResumeState(
  databasePath: string,
  recording: ProductionRecording,
): { readonly index: number; readonly pendingTool: boolean } {
  if (!Bun.file(databasePath).size) return { index: 0, pendingTool: false }
  let database: BunDatabase | undefined
  try {
    database = new BunDatabase(databasePath, { readonly: true })
    const table = database
      .query<
        { count: number },
        []
      >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'workflow_stage'")
      .get()
    if (table?.count !== 1) throw new Error("Durable recorded provider stage table is absent")
    const stages = database
      .query<{ stage_type: string; status: string; input: string; checkpoint: string | null }, []>(
        "SELECT stage_type, status, input, checkpoint FROM workflow_stage ORDER BY ordinal",
      )
      .all()
      .map((stage) => {
        const input: unknown = JSON.parse(stage.input)
        const revision = input !== null && typeof input === "object" ? Reflect.get(input, "revision") : undefined
        if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
          throw new Error("Durable recorded provider stage revision is invalid")
        }
        return { ...stage, revision: revision as number }
      })
    const skippedVisual = stages.filter((stage) => stage.stage_type === "visual_review" && stage.revision === 0)
    const providerStages = stages.filter((stage) => !(stage.stage_type === "visual_review" && stage.revision === 0))
    if (skippedVisual.length !== 1 || providerStages.length !== recording.stages.length) {
      throw new Error("Durable recorded provider topology cardinality drifted")
    }
    for (const [position, stage] of providerStages.entries()) {
      const expected = recording.stages[position]
      if (expected === undefined || stage.stage_type !== expected.role || stage.revision !== expected.revision) {
        throw new Error("Durable recorded provider topology order drifted")
      }
    }
    let index = 0
    let incomplete = false
    for (const stage of providerStages) {
      if (stage.status === "succeeded") {
        if (incomplete) throw new Error("Durable recorded provider success is not an ordered prefix")
        index++
      } else {
        incomplete = true
      }
    }
    const running = providerStages.filter((stage) => stage.status === "running")
    if (running.length > 1 || (running.length === 1 && running[0] !== providerStages[index])) {
      throw new Error("Durable recorded provider running stage is not the next prefix member")
    }
    const active = running[0]
    let pendingTool = false
    if (active?.checkpoint !== null && active?.checkpoint !== undefined) {
      const checkpoint = JSON.parse(active.checkpoint)
      const providerTurn = checkpoint?.providerTurn
      if (providerTurn !== null && typeof providerTurn === "object" && providerTurn.result !== undefined) index++
      const activeTurn = checkpoint?.activeTurn
      pendingTool =
        activeTurn !== null &&
        typeof activeTurn === "object" &&
        !Object.hasOwn(activeTurn, "pendingCallID") &&
        Array.isArray(activeTurn.results) &&
        activeTurn.results.length === 1
    }
    if (index < 0 || index > recording.stages.length) throw new Error("Durable recorded provider offset is invalid")
    if (pendingTool && recording.stages[index]?.toolScript.length !== 1) {
      throw new Error("Durable recorded provider tool continuation is not bound to its expected stage")
    }
    return { index, pendingTool }
  } finally {
    database?.close()
  }
}

async function waitForToolAmbiguity(databasePath: string): Promise<{
  readonly workflowStatus: "waiting_approval"
  readonly responseStatus: string
  readonly role: "implement"
  readonly revision: 0
  readonly stageStatus: "waiting_approval"
  readonly errorCode: "tool_execution_ambiguous"
  readonly toolContinuations: number
}> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    let database: BunDatabase | undefined
    try {
      if (!Bun.file(databasePath).size) {
        await Bun.sleep(5)
        continue
      }
      database = new BunDatabase(databasePath, { readonly: true })
      const row = database
        .query<
          {
            workflow_status: string
            response_status: string
            role: string
            stage_input: string
            stage_status: string
            error: string | null
          },
          []
        >(
          "SELECT wr.status AS workflow_status, r.status AS response_status, ws.stage_type AS role, ws.input AS stage_input, ws.status AS stage_status, ws.error AS error FROM workflow_run AS wr JOIN workflow_stage AS ws ON ws.workflow_id = wr.id JOIN response AS r ON r.workflow_id = wr.id WHERE ws.stage_type = 'implement'",
        )
        .get()
      if (row?.workflow_status !== "waiting_approval") {
        await Bun.sleep(5)
        continue
      }
      const stageInput = JSON.parse(row.stage_input)
      const error = JSON.parse(row.error ?? "null")
      if (
        row.response_status !== "queued" ||
        row.role !== "implement" ||
        stageInput?.revision !== 0 ||
        row.stage_status !== "waiting_approval" ||
        error?.code !== "tool_execution_ambiguous"
      ) {
        throw new Error("Pending tool approval projection is internally inconsistent")
      }
      const toolContinuations =
        database
          .query<
            { count: number },
            []
          >("SELECT COUNT(*) AS count FROM workflow_artifact WHERE kind = 'tool-continuation'")
          .get()?.count ?? -1
      return {
        workflowStatus: "waiting_approval",
        responseStatus: row.response_status,
        role: "implement",
        revision: 0,
        stageStatus: "waiting_approval",
        errorCode: "tool_execution_ambiguous",
        toolContinuations,
      }
    } catch (error) {
      if (!(error instanceof Error) || !/unable to open|no such table/i.test(error.message)) throw error
    } finally {
      database?.close()
    }
    await Bun.sleep(5)
  }
  throw new Error("Pending tool recovery did not reach its durable approval condition")
}

function observeProviderRequest(
  request: LLMRequest,
  stage: RecordingStage,
  afterTool: boolean,
): ProviderRequestObservation {
  return {
    role: stage.role,
    revision: stage.revision,
    phase: afterTool ? "after-tool" : "initial",
    messageRoles: request.messages.map((message) => message.role),
    messages: request.messages.map((message) => ({
      role: message.role,
      parts: message.content.map((part) => {
        if (part.type === "text") {
          const text = String(part.text)
          return { type: part.type, sha256: sha256(Buffer.from(text)), size: Buffer.byteLength(text) }
        }
        if (part.type === "media") {
          const bytes = typeof part.data === "string" ? Buffer.from(part.data) : Buffer.from(part.data)
          return {
            type: part.type,
            mediaType: part.mediaType,
            sha256: sha256(bytes),
            size: bytes.byteLength,
            metadata: part.metadata,
          }
        }
        return Object.freeze({
          type: part.type,
          ...("id" in part ? { id: part.id } : {}),
          ...("name" in part ? { name: part.name } : {}),
          ...("toolCallId" in part ? { toolCallId: part.toolCallId } : {}),
          ...("toolCallID" in part ? { toolCallID: part.toolCallID } : {}),
        })
      }),
    })),
    tools: request.tools.map((tool) => tool.name),
  }
}

function validateRequest(request: LLMRequest, stage: RecordingStage, afterTool: boolean): void {
  const semanticOutcome = Reflect.get(stage.semantic, "outcome")
  if (
    semanticOutcome === null ||
    typeof semanticOutcome !== "object" ||
    Reflect.get(semanticOutcome, "role") !== stage.role ||
    Reflect.get(semanticOutcome, "revision") !== stage.revision
  ) {
    throw new Error(`Recorded semantic revision mismatch at ${stage.role}/r${stage.revision}`)
  }
  const system = request.system.map((part) => part.text).join("\n")
  if (system !== systems[stage.role])
    throw new Error(`Recorded role order mismatch at ${stage.role}/r${stage.revision}`)
  if (request.model.provider !== stage.provider || request.model.id !== stage.model) {
    throw new Error(`Recorded provider route mismatch at ${stage.role}/r${stage.revision}`)
  }
  if (request.model.route.protocol !== stage.protocol) throw new Error(`Recorded protocol mismatch at ${stage.role}`)
  const providerOptions = mergeProviderOptions(
    request.model.route.defaults.providerOptions,
    request.model.defaults?.providerOptions,
    request.providerOptions,
  )
  const reasoningEffort =
    stage.provider === "kimi" ? providerOptions?.kimi?.reasoningEffort : providerOptions?.deepseek?.reasoningEffort
  if (reasoningEffort !== stage.effort) {
    throw new Error(`Recorded effort mismatch at ${stage.role}`)
  }
  if (request.responseFormat?.type !== "json") throw new Error(`Recorded response schema is absent at ${stage.role}`)
  const responseSchema = JSON.stringify(request.responseFormat.schema)
  if (
    !responseSchema.includes("outcome") ||
    !responseSchema.includes("role") ||
    !responseSchema.includes("revision") ||
    !responseSchema.includes(stage.role)
  ) {
    throw new Error(`Recorded response schema lost its role outcome shape at ${stage.role}/r${stage.revision}`)
  }
  const expectedTools =
    stage.role === "implement" || stage.role === "repair"
      ? ["apply_patch", "bash", "edit", "glob", "grep", "read", "write"]
      : ["glob", "grep", "read"]
  if (JSON.stringify(request.tools.map((tool) => tool.name)) !== JSON.stringify(expectedTools)) {
    throw new Error(`Recorded tool catalog mismatch at ${stage.role}/r${stage.revision}`)
  }
  const expectedRoles = afterTool ? ["user", "assistant", "tool"] : ["user"]
  if (JSON.stringify(request.messages.map((message) => message.role)) !== JSON.stringify(expectedRoles)) {
    throw new Error(`Recorded message role chain mismatch at ${stage.role}/r${stage.revision}`)
  }
  const user = request.messages[0]
  if (user?.content[0]?.type !== "text") throw new Error(`Recorded user context is absent at ${stage.role}`)
  const userText = user.content[0].text
  if (stage.role === "test") {
    const facts = JSON.parse(userText)
    if (
      facts.template !== "workflow-role/test-host-facts@1" ||
      facts.revision !== stage.revision ||
      typeof facts.implementationSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(facts.implementationSha256) ||
      !Array.isArray(facts.argv) ||
      typeof facts.exitCode !== "number" ||
      typeof facts.log !== "string"
    ) {
      throw new Error(`Recorded test context drifted at r${stage.revision}`)
    }
  } else if (stage.role === "visual_review") {
    if (
      !userText.startsWith(
        "Compare the browser-rendered reference and implementation images against this design specification. Return only strict visual-review.json.\n",
      )
    ) {
      throw new Error(`Recorded visual-review text context drifted at r${stage.revision}`)
    }
  } else if (stage.role === "deliver") {
    if (userText !== "Build the frozen offline production experience") {
      throw new Error("Recorded delivery context differs from the admitted input")
    }
  } else {
    const facts = JSON.parse(userText)
    if (
      facts.template !== `workflow-role/${stage.role}@1` ||
      typeof facts.workflow?.id !== "string" ||
      facts.stage?.role !== stage.role ||
      facts.stage?.revision !== stage.revision ||
      facts.stage?.input?.revision !== stage.revision
    ) {
      throw new Error(`Recorded default context drifted at ${stage.role}/r${stage.revision}`)
    }
  }
  const media = request.messages.flatMap((message) => message.content.filter((part) => part.type === "media"))
  if (stage.role === "visual_review") {
    if (media.length !== 2 || user.content.length !== 3) {
      throw new Error(`Recorded visual media count drifted at r${stage.revision}`)
    }
    const png = WorkflowVisualHost.deterministicPng({ name: "desktop", width: 1280, height: 720 })
    const expectedPng = { sha256: sha256(png), size: png.byteLength }
    for (const [index, part] of media.entries()) {
      const bytes = typeof part.data === "string" ? Buffer.from(part.data) : Buffer.from(part.data)
      const expectedKind = index === 0 ? "reference" : "implementation"
      const expectedRevision = index === 0 ? 0 : stage.revision
      const metadata = part.metadata
      if (
        part.mediaType !== "image/png" ||
        sha256(bytes) !== expectedPng.sha256 ||
        bytes.byteLength !== expectedPng.size ||
        metadata?.kind !== expectedKind ||
        metadata.viewport !== "desktop" ||
        metadata.revision !== expectedRevision ||
        typeof metadata.imageID !== "string" ||
        !metadata.imageID.endsWith(
          expectedKind === "reference" ? "-reference-desktop" : `-implementation-desktop-r${stage.revision}`,
        )
      ) {
        throw new Error(`Recorded visual media identity drifted at r${stage.revision}`)
      }
    }
  } else if (media.length !== 0 || user.content.length !== 1) {
    throw new Error(`Recorded non-visual message chain contains media at ${stage.role}/r${stage.revision}`)
  }
  const calls = request.messages.flatMap((message) => message.content.filter((part) => part.type === "tool-call"))
  const results = request.messages.flatMap((message) => message.content.filter((part) => part.type === "tool-result"))
  if (!afterTool) {
    if (calls.length !== 0 || results.length !== 0)
      throw new Error(`Recorded initial request contains stale tool context`)
    return
  }
  const script = stage.toolScript[0]
  if (
    stage.toolScript.length !== 1 ||
    script === undefined ||
    calls.length !== 1 ||
    results.length !== 1 ||
    calls[0]?.id !== script.callID ||
    calls[0]?.name !== script.name ||
    JSON.stringify(calls[0]?.input) !== JSON.stringify(script.input) ||
    results[0]?.id !== script.callID ||
    results[0]?.name !== script.name ||
    results[0]?.result.type === "error"
  ) {
    throw new Error(`Recorded tool continuation mismatch at ${stage.role}/r${stage.revision}`)
  }
}

interface PreviewCapabilities {
  readonly registerReferenceDirectory: (directory: string) => Promise<void>
  readonly registerImplementation: (
    revision: number,
    configurationSha256: string,
    locationRoot: string,
    entrypoint: string | undefined,
    contract: WorkflowVisualHost.ImplementationCaptureContract,
  ) => void
  readonly consume: (url: string, signal: AbortSignal) => Promise<void>
  readonly registerOwnedOrigin: (origin: string) => void
  readonly releaseOwnedOrigin: (origin: string) => void
  readonly probeOwnedOrigin: (origin: string, signal: AbortSignal) => Promise<boolean>
  readonly assertAllowedOrigins: (origins: readonly string[]) => void
  readonly assertSettled: () => void
}

export interface RecordedStaticImplementationCapability {
  readonly revision: number
  readonly configurationSha256: string
  readonly sourceSha256: string
  readonly previewLease: WorkflowVisualHost.PreviewLeaseAuthority
}

export async function assertRecordedStaticImplementationCapability(
  hostRoot: string,
  hostID: string,
  expected: RecordedStaticImplementationCapability,
): Promise<void> {
  try {
    const lexicalRoot = path.resolve(hostRoot)
    const canonicalRoot = await fs.realpath(lexicalRoot)
    const rootStat = await fs.lstat(lexicalRoot)
    if (canonicalRoot !== lexicalRoot || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new TypeError("host root is not canonical")
    }
    if (!/^[a-f0-9]{64}$/.test(hostID)) throw new TypeError("host ID is invalid")
    const directory = path.resolve(canonicalRoot, hostID)
    const canonicalDirectory = await fs.realpath(directory)
    const directoryStat = await fs.lstat(directory)
    if (
      path.dirname(directory) !== canonicalRoot ||
      canonicalDirectory !== directory ||
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink()
    ) {
      throw new TypeError("host directory is not an owned direct child")
    }
    const file = path.resolve(directory, ".host.json")
    const canonicalBefore = await fs.realpath(file)
    const before = await fs.lstat(file)
    if (
      path.dirname(file) !== directory ||
      canonicalBefore !== file ||
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > 16 * 1024
    ) {
      throw new TypeError("manifest file is not exact")
    }
    const handle = await fs.open(file, "r")
    let text: string
    try {
      const opened = await handle.stat()
      if (!isRecordedSingleOwnerFile(opened) || !sameRecordedAuthorityFileIdentity(before, opened)) {
        throw new TypeError("manifest identity changed before read")
      }
      const bytes = Buffer.alloc(opened.size)
      const read = await handle.read(bytes, 0, bytes.length, 0)
      const overflow = Buffer.alloc(1)
      const extra = await handle.read(overflow, 0, 1, bytes.length)
      const afterHandle = await handle.stat()
      const afterPath = await fs.lstat(file)
      const canonicalAfter = await fs.realpath(file)
      if (
        read.bytesRead !== bytes.length ||
        extra.bytesRead !== 0 ||
        canonicalAfter !== file ||
        !isRecordedSingleOwnerFile(afterHandle) ||
        !isRecordedSingleOwnerFile(afterPath) ||
        !sameRecordedAuthorityFileIdentity(opened, afterHandle) ||
        !sameRecordedAuthorityFileIdentity(opened, afterPath)
      ) {
        throw new TypeError("manifest identity changed during read")
      }
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } finally {
      await handle.close()
    }
    const value: unknown = JSON.parse(text)
    if (JSON.stringify(value) !== text) throw new TypeError("manifest JSON is not canonical")
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("manifest body is invalid")
    }
    const manifest = value as Record<string, unknown>
    const keys = [
      "attempt",
      "claimGeneration",
      "claimKey",
      "claimSha256",
      "configurationSha256",
      "createdAt",
      "hostID",
      "kind",
      "leaseExpiresAt",
      "leaseOwner",
      "nonce",
      "purpose",
      "revision",
      "sourceSha256",
      "stageID",
      "workflowID",
    ]
    const actualKeys = Object.keys(manifest).sort()
    if (JSON.stringify(actualKeys) !== JSON.stringify(keys)) throw new TypeError("manifest shape is not exact")
    const hash = (field: string) => typeof manifest[field] === "string" && /^[a-f0-9]{64}$/.test(manifest[field])
    if (
      manifest.hostID !== hostID ||
      manifest.kind !== "static" ||
      manifest.purpose !== "implementation" ||
      manifest.revision !== expected.revision ||
      manifest.configurationSha256 !== expected.configurationSha256 ||
      manifest.sourceSha256 !== expected.sourceSha256 ||
      manifest.workflowID !== expected.previewLease.workflowID ||
      manifest.stageID !== expected.previewLease.stageID ||
      manifest.attempt !== expected.previewLease.attempt ||
      manifest.leaseOwner !== expected.previewLease.leaseOwner ||
      !Number.isSafeInteger(manifest.leaseExpiresAt) ||
      Number(manifest.leaseExpiresAt) < expected.previewLease.leaseExpiresAt ||
      !Number.isSafeInteger(manifest.createdAt) ||
      Number(manifest.createdAt) < 0 ||
      !hash("claimKey") ||
      !hash("claimGeneration") ||
      !hash("claimSha256") ||
      !hash("nonce")
    ) {
      throw new TypeError("manifest authority differs from the registered implementation")
    }
  } catch (cause) {
    throw new TypeError("Recorded static implementation capability manifest is not exact", { cause })
  }
}

function isRecordedSingleOwnerFile(value: { readonly nlink: number; isFile(): boolean; isSymbolicLink(): boolean }) {
  return value.isFile() && !value.isSymbolicLink() && value.nlink === 1
}

function sameRecordedAuthorityFileIdentity(
  left: {
    readonly dev: number
    readonly ino: number
    readonly mode: number
    readonly nlink: number
    readonly size: number
    readonly mtimeMs: number
    readonly ctimeMs: number
    readonly birthtimeMs: number
  },
  right: {
    readonly dev: number
    readonly ino: number
    readonly mode: number
    readonly nlink: number
    readonly size: number
    readonly mtimeMs: number
    readonly ctimeMs: number
    readonly birthtimeMs: number
  },
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs
  )
}

function previewCapabilities(
  recording: ProductionRecording,
  hostRoot: string,
  observed: Array<{
    kind: "reference" | "implementation"
    revision: number
    sha256: string
    size: number
  }>,
  resumeCount: number,
): PreviewCapabilities {
  const references = new Map<string, string>()
  const implementations: Array<{
    readonly kind: "implementation"
    readonly revision: number
    readonly bytes: Uint8Array
    readonly authority: RecordedStaticImplementationCapability
  }> = []
  const hostIDs = new Set<string>()
  const ownedOrigins = new Set<string>()
  const resumed = new Map<string, ProductionRecording["expectedPreviews"][number]>(
    recording.expectedPreviews
      .slice(0, resumeCount)
      .map((preview) => [`${preview.kind}:${preview.revision}`, preview] as const),
  )
  let index = resumeCount

  function resumeCapability(input: {
    readonly kind: "reference" | "implementation"
    readonly revision: number
    readonly bytes: Uint8Array
  }): boolean {
    const key = `${input.kind}:${input.revision}`
    const expected = resumed.get(key)
    if (expected === undefined) return false
    const actual = {
      kind: input.kind,
      revision: input.revision,
      sha256: sha256(input.bytes),
      size: input.bytes.byteLength,
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("Resumed preview capability differs from its exact durable evidence")
    }
    resumed.delete(key)
    return true
  }

  return {
    registerReferenceDirectory: async (directory) => {
      const canonicalRoot = await fs.realpath(hostRoot)
      const canonical = await fs.realpath(directory)
      const hostID = path.basename(canonical)
      if (
        path.dirname(canonical) !== canonicalRoot ||
        !/^[a-f0-9]{64}$/.test(hostID) ||
        references.has(hostID) ||
        hostIDs.has(hostID)
      ) {
        throw new Error("Reference capability ownership is not exact")
      }
      if (resumed.delete("reference:0")) {
        hostIDs.add(hostID)
        return
      }
      references.set(hostID, canonical)
    },
    registerImplementation: (revision, configurationSha256, locationRoot, entrypoint, contract) => {
      const relativeEntrypoint =
        entrypoint === undefined ? "index.html" : path.relative(locationRoot, entrypoint).replaceAll("\\", "/")
      if (relativeEntrypoint !== "index.html" || contract.sealedSnapshot === undefined) {
        throw new Error("Implementation capability has no exact sealed entrypoint")
      }
      const sealed = WorkflowWorkspaceMaterialization.validate(contract.sealedSnapshot)
      if (sealed.revision !== revision) throw new Error("Implementation capability revision drifted")
      const bytes = WorkflowWorkspaceMaterialization.bytes(sealed.archive).get(relativeEntrypoint as never)
      if (bytes === undefined) throw new Error("Implementation capability entrypoint is absent")
      if (contract.previewLease === undefined) throw new Error("Implementation capability has no exact preview lease")
      const capability = {
        kind: "implementation" as const,
        revision,
        bytes: Uint8Array.from(bytes),
        authority: {
          revision,
          configurationSha256,
          sourceSha256: contract.implementationSha256,
          previewLease: contract.previewLease,
        },
      }
      if (resumeCapability(capability)) return
      implementations.push(capability)
    },
    registerOwnedOrigin: (origin) => {
      if (ownedOrigins.has(origin) || exactOwnedOrigin(origin) === undefined) {
        throw new Error("Owned preview origin was not unique and canonical")
      }
      ownedOrigins.add(origin)
    },
    releaseOwnedOrigin: (origin) => {
      if (!ownedOrigins.delete(origin)) throw new Error("Owned preview origin release was not exact")
    },
    probeOwnedOrigin: async (origin, signal) => {
      if (signal.aborted) throw signal.reason
      return ownedOrigins.has(origin) && exactOwnedOrigin(origin) !== undefined
    },
    assertAllowedOrigins: (origins) => {
      if (origins.length === 0) return
      if (origins.length !== 1 || !ownedOrigins.has(origins[0] ?? "")) {
        throw new Error("Browser recording received an unauthenticated proxy origin")
      }
    },
    consume: async (url, signal) => {
      if (signal.aborted) throw signal.reason
      const parsed = new URL(url)
      const hostID = parsed.pathname.match(/^\/([a-f0-9]{64})\/$/)?.[1]
      const ownedOrigin = parsed.href.endsWith("/") ? parsed.href.slice(0, -1) : parsed.href
      const directOwned = ownedOrigins.has(ownedOrigin) && parsed.href === `${ownedOrigin}/`
      if (
        parsed.protocol !== "http:" ||
        parsed.hostname !== "127.0.0.1" ||
        parsed.port === "" ||
        !Number.isSafeInteger(Number(parsed.port)) ||
        Number(parsed.port) <= 0 ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.search !== "" ||
        parsed.hash !== "" ||
        (!directOwned && (hostID === undefined || parsed.href !== `${parsed.origin}/${hostID}/` || hostIDs.has(hostID)))
      ) {
        throw new Error("Browser recording received a non-exact loopback capability")
      }
      let body: { readonly kind: "reference" | "implementation"; readonly revision: number; readonly bytes: Uint8Array }
      const referenceDirectory = hostID === undefined ? undefined : references.get(hostID)
      if (referenceDirectory !== undefined) {
        const entrypoint = path.join(referenceDirectory, "index.html")
        const canonical = await fs.realpath(entrypoint)
        const stat = await fs.lstat(entrypoint)
        if (path.dirname(canonical) !== referenceDirectory || !stat.isFile() || stat.isSymbolicLink()) {
          throw new Error("Reference capability entrypoint escaped its owned root")
        }
        body = { kind: "reference", revision: 0, bytes: new Uint8Array(await fs.readFile(canonical)) }
        references.delete(hostID!)
      } else {
        const implementation = implementations[0]
        if (implementation === undefined) throw new Error("Unregistered implementation capability")
        if (!directOwned) {
          if (hostID === undefined) throw new Error("Static implementation capability has no exact host ID")
          await assertRecordedStaticImplementationCapability(hostRoot, hostID, implementation.authority)
        }
        implementations.shift()
        body = implementation
      }
      const actual = {
        kind: body.kind,
        revision: body.revision,
        sha256: sha256(body.bytes),
        size: body.bytes.byteLength,
      }
      const expected = recording.expectedPreviews[index++]
      if (expected === undefined || JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error("Preview capability body order, identity, hash, or size drifted")
      }
      if (hostID !== undefined) hostIDs.add(hostID)
      observed.push(actual)
    },
    assertSettled: () => {
      if (
        index !== recording.expectedPreviews.length ||
        implementations.length !== 0 ||
        references.size !== 0 ||
        observed.length !== recording.expectedPreviews.length - resumeCount
      ) {
        throw new Error("Preview capability recording is missing, extra, or unsettled")
      }
    },
  }
}

function recordedPreviewResumeState(evidenceRoot: string, recording: ProductionRecording): number {
  const file = path.join(evidenceRoot, "evidence.sqlite")
  if (!existsSync(file)) return 0
  const database = new BunDatabase(file, { readonly: true })
  try {
    const table = database
      .query<
        { count: number },
        []
      >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'workflow_evidence_item'")
      .get()
    if (table?.count !== 1) throw new Error("Durable preview evidence table is absent")
    const rows = database
      .query<
        {
          preview_kind: string
          revision: number
          png_sha256: string
          evidence_bytes: number
        },
        []
      >(
        "SELECT preview_kind, revision, png_sha256, evidence_bytes FROM workflow_evidence_item WHERE state IN ('staged', 'committed', 'released') ORDER BY CASE preview_kind WHEN 'reference' THEN 0 ELSE 1 END, revision",
      )
      .all()
    if (rows.length > recording.expectedPreviews.length) {
      throw new Error("Durable preview evidence exceeds the frozen recording")
    }
    const png = WorkflowVisualHost.deterministicPng({ name: "desktop", width: 1280, height: 720 })
    const expectedPng = { sha256: sha256(png), size: png.byteLength }
    for (const [index, row] of rows.entries()) {
      const expected = recording.expectedPreviews[index]
      const actual = {
        kind: row.preview_kind,
        revision: row.revision,
      }
      if (
        expected === undefined ||
        JSON.stringify(actual) !== JSON.stringify({ kind: expected.kind, revision: expected.revision }) ||
        row.png_sha256 !== expectedPng.sha256 ||
        row.evidence_bytes !== expectedPng.size
      ) {
        throw new Error("Durable preview evidence is not the exact frozen prefix")
      }
    }
    return rows.length
  } finally {
    database.close()
  }
}

function exactOwnedOrigin(origin: string): string | undefined {
  try {
    const parsed = new URL(origin)
    return parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port !== "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === ""
      ? origin
      : undefined
  } catch {
    return undefined
  }
}

function recordedBrowser(counters: RuntimeCounters, capabilities: PreviewCapabilities): PlaywrightCapture.Runtime {
  return {
    capture: async (input) => {
      counters.browserCaptures++
      capabilities.assertAllowedOrigins(input.allowedOrigins)
      await capabilities.consume(input.url, input.signal)
      return WorkflowVisualHost.deterministicPng({ name: "desktop", ...input.viewport })
    },
    close: async () => {
      counters.browserCloses++
    },
  }
}

function frozenCommandSandbox(
  counters: RuntimeCounters,
  observations: Array<{ revision: number; sha256: string; size: number; exit: number }>,
  boundedLogs: string[],
): WorkflowCommandSandbox.Interface {
  return WorkflowCommandSandbox.Service.of({
    run: () => Effect.fail(new WorkflowCommandSandbox.Rejected({ message: "Model-authored Bash is forbidden" })),
    runFrozenTest: (request) =>
      Effect.try({
        try: () => {
          counters.functionalTests++
          const sealed = WorkflowWorkspaceMaterialization.validate(request.sealedSnapshot)
          const source = WorkflowWorkspaceMaterialization.bytes(sealed.archive).get("index.html" as never)
          if (source === undefined) throw new Error("Frozen archive does not contain index.html")
          const text = Buffer.from(source).toString("utf8")
          const expected = `implementation-r${request.revision}`
          if (!text.includes(expected)) throw new Error(`Frozen archive differs from ${expected}`)
          const exit = request.revision === 0 ? 1 : 0
          const output = `sealed-test-r${request.revision}:${exit}`
          observations.push({ revision: request.revision, sha256: sha256(source), size: source.byteLength, exit })
          boundedLogs.push(output)
          return { exit, output, truncated: false }
        },
        catch: () => new WorkflowCommandSandbox.Rejected({ message: "Frozen archive test authority is invalid" }),
      }),
  })
}

function fileBackedOwnership(
  file: string,
  counters: RuntimeCounters,
  hostRoot: string,
  capabilities: PreviewCapabilities,
  crash?: ProductionCrashOptions,
): ProcessOwnership.Service {
  type OwnershipEvent = {
    readonly operation: "start" | "stop" | "recover"
    readonly identity: ProcessOwnership.Identity
    readonly origin: string
    readonly finalGateResults: readonly boolean[]
  }
  const active = new Map<string, { readonly origin: string; readonly resolveExit: (exit: number) => void }>()
  const key = (identity: ProcessOwnership.Identity) => `${identity.hostID}:${identity.nonce}`
  const originFor = (identity: ProcessOwnership.Identity) =>
    `http://127.0.0.1:${20_000 + (Number.parseInt(identity.hostID.slice(0, 8), 16) % 30_000)}`
  let recordTail: Promise<void> = Promise.resolve()
  const record = (event: OwnershipEvent): Promise<void> => {
    const operation = recordTail.then(async () => {
      const prior: unknown = await fs.readFile(file, "utf8").then(JSON.parse, () => [])
      if (!Array.isArray(prior)) throw new Error("Preview ownership log is not an array")
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined
      try {
        handle = await fs.open(temporary, "wx", 0o600)
        await handle.writeFile(JSON.stringify([...prior, event]), "utf8")
        await handle.sync()
        await handle.close()
        handle = undefined
        await fs.rename(temporary, file)
      } finally {
        await handle?.close().catch(() => undefined)
        await fs.unlink(temporary).catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
        })
      }
    })
    recordTail = operation.catch(() => undefined)
    return operation
  }
  return Object.freeze({
    available: true,
    start: async (input: Parameters<ProcessOwnership.Service["start"]>[0]) => {
      counters.processStarts++
      const origin = originFor(input.identity)
      await record({ operation: "start", identity: input.identity, origin, finalGateResults: [] })
      if (crash?.boundary === "preview-start-intent") {
        const manifestPath = path.join(hostRoot, input.identity.hostID, ".host.json")
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))
        if (
          manifest.hostID !== input.identity.hostID ||
          manifest.workflowID !== input.identity.workflowID ||
          manifest.stageID !== input.identity.stageID ||
          manifest.attempt !== input.identity.attempt ||
          manifest.leaseOwner !== input.identity.leaseOwner ||
          manifest.leaseExpiresAt !== input.identity.leaseExpiresAt ||
          manifest.nonce !== input.identity.nonce ||
          manifest.kind !== "script"
        ) {
          throw new Error("Preview start intent is not bound to its durable ownership manifest")
        }
        writeCrashMarker(crash.markerPath, {
          boundary: crash.boundary,
          counters,
          identity: input.identity,
          origin,
          manifest,
        })
        process.exit(17)
      }
      capabilities.registerOwnedOrigin(origin)
      let resolveExit!: (exit: number) => void
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve
      })
      active.set(key(input.identity), { origin, resolveExit })
      return {
        origin,
        exited,
        stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
        stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      }
    },
    stop: async (input: Parameters<ProcessOwnership.Service["stop"]>[0]) => {
      counters.processStops++
      const owned = active.get(key(input.identity))
      if (owned === undefined || owned.origin !== input.process.origin) throw new Error("Preview stop identity drifted")
      const finalGateResults = input.finalGate === undefined ? [] : [await input.finalGate()]
      await record({
        operation: "stop",
        identity: input.identity,
        origin: owned.origin,
        finalGateResults,
      })
      if (finalGateResults.includes(false)) throw new Error("Preview stop lease became live")
      capabilities.releaseOwnedOrigin(owned.origin)
      owned.resolveExit(0)
      active.delete(key(input.identity))
    },
    recover: async (input: ProcessOwnership.RecoveryInput) => {
      counters.processRecovers++
      const result = await input.finalGate()
      await record({
        operation: "recover",
        identity: input.identity,
        origin: originFor(input.identity),
        finalGateResults: [result],
      })
      if (!result) throw new Error("Preview recovery lease became live")
    },
  })
}

function readEvidence(evidenceRoot: string) {
  const database = new BunDatabase(path.join(evidenceRoot, "evidence.sqlite"), { readonly: true })
  try {
    const items = database
      .query<{ preview_kind: string; revision: number; state: string; evidence_bytes: number }, []>(
        "SELECT preview_kind, revision, state, evidence_bytes FROM workflow_evidence_item ORDER BY revision, preview_kind",
      )
      .all()
      .map((row) => ({ kind: row.preview_kind, revision: row.revision, state: row.state, bytes: row.evidence_bytes }))
    const total =
      database.query<{ total: number | null }, []>("SELECT SUM(evidence_bytes) AS total FROM workflow_evidence").get()
        ?.total ?? 0
    return { items, total }
  } finally {
    database.close()
  }
}

async function assertAcceptanceSurfaces(input: {
  readonly databasePath: string
  readonly evidenceRoot: string
  readonly recording: ProductionRecording
  readonly providerRequests: readonly ProviderRequestObservation[]
  readonly browserBodies: readonly unknown[]
  readonly frozenTests: readonly unknown[]
  readonly boundedLogs: readonly string[]
  readonly childEnvironment: Readonly<Record<string, string | undefined>>
  readonly forbiddenSentinels: readonly string[]
}): Promise<void> {
  const forbidden = new Set(input.forbiddenSentinels)
  scanDatabase(input.databasePath, "$database", forbidden)
  scanDatabase(path.join(input.evidenceRoot, "evidence.sqlite"), "$evidence", forbidden)
  assertSafeValue(input.recording, "$fixture", forbidden)
  assertSafeValue(await fs.readFile(recordingPath, "utf8").then(JSON.parse), "$fixtureText", forbidden)
  assertSafeValue(input.providerRequests, "$capturedRequests", forbidden)
  assertSafeValue(input.browserBodies, "$browserObservations", forbidden)
  assertSafeValue(input.frozenTests, "$functionalTestObservations", forbidden)
  assertSafeValue(input.boundedLogs, "$boundedLogs", forbidden)
  assertSafeValue(input.childEnvironment, "$childEnvironment", forbidden)
  assertScannerRejectsDynamicProbes()
}

function providerRequestSurface(request: LLMRequest): unknown {
  return {
    system: request.system.map((part) => part.text),
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content.map((part) => {
        if (part.type === "text" || part.type === "reasoning") return { type: part.type, text: part.text }
        if (part.type === "media") {
          const bytes = typeof part.data === "string" ? Buffer.from(part.data) : Buffer.from(part.data)
          return {
            type: part.type,
            mediaType: part.mediaType,
            sha256: sha256(bytes),
            size: bytes.byteLength,
            metadata: part.metadata,
          }
        }
        if (part.type === "tool-call") {
          return { type: part.type, id: part.id, name: part.name, input: part.input }
        }
        return { type: part.type, id: part.id, name: part.name, result: part.result }
      }),
    })),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }
}

function assertRecordedTerminal(
  recording: ProductionRecording,
  detail: {
    readonly run: { readonly status: string }
    readonly stages: readonly {
      readonly id: string
      readonly ordinal: number
      readonly type: string
      readonly status: string
      readonly input: Readonly<Record<string, unknown>>
    }[]
  },
  artifacts: readonly {
    readonly stageID: string
    readonly kind: string
    readonly uri: string
    readonly metadata: unknown
  }[],
  response: {
    readonly status: string
    readonly store: boolean
    readonly model: string
    readonly output: readonly unknown[]
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number }
  },
): void {
  const terminal = recording.terminal
  if (detail.run.status !== terminal.workflowStatus || response.status !== terminal.responseStatus) {
    throw new Error("Recorded terminal status drifted")
  }
  if (response.store !== terminal.responseStore) throw new Error("Recorded Response storage authority drifted")
  if (response.model !== terminal.source.model) throw new Error("Recorded Response model drifted")
  if (detail.stages.length !== terminal.preallocatedStages) throw new Error("Recorded preallocated stage count drifted")
  const skipped = detail.stages.filter((stage) => stage.status === "skipped")
  if (skipped.length !== terminal.skippedStages) throw new Error("Recorded skipped stage count drifted")
  const exactSkip = skipped[0]
  if (
    exactSkip?.type !== terminal.skippedStage.role ||
    exactSkip.ordinal !== terminal.skippedStage.ordinal ||
    exactSkip.input.revision !== terminal.skippedStage.revision
  ) {
    throw new Error("Recorded skipped stage identity drifted")
  }
  const source = recording.stages.at(-1)
  if (
    source?.role !== terminal.source.role ||
    source.revision !== terminal.source.revision ||
    source.provider !== terminal.source.provider ||
    source.model !== terminal.source.model ||
    source.protocol !== terminal.source.protocol
  ) {
    throw new Error("Recorded terminal source drifted")
  }
  const expectedOutput = [{ type: "message", role: "assistant", content: JSON.stringify(source.semantic) }]
  if (
    JSON.stringify(response.output) !== JSON.stringify(expectedOutput) ||
    JSON.stringify(response.usage) !== JSON.stringify(source.usage)
  ) {
    throw new Error("Stored Response output or usage differs from deliver r2")
  }
  const stages = new Map(detail.stages.map((stage) => [stage.id, stage]))
  const actual = new Map<string, number>()
  for (const artifact of artifacts) {
    const owner = stages.get(artifact.stageID)
    if (owner === undefined) throw new Error("Recorded artifact has a foreign stage owner")
    const revision = owner.input.revision
    const key = `${owner.type}\0${String(revision)}\0${artifact.kind}`
    actual.set(key, (actual.get(key) ?? 0) + 1)
  }
  const expected = new Map(
    recording.expectedArtifacts.map((artifact) => [
      `${artifact.role}\0${artifact.revision}\0${artifact.kind}`,
      artifact.count,
    ]),
  )
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error("Recorded artifact set is missing, duplicated, extra, or wrongly owned")
  }
  const expectedTools = recording.stages.filter((stage) => stage.toolScript.length > 0)
  const continuations = artifacts.filter((artifact) => artifact.kind === "tool-continuation")
  if (continuations.length !== expectedTools.length) throw new Error("Tool continuation count drifted")
  for (const [index, stage] of expectedTools.entries()) {
    const script = stage.toolScript[0]!
    const artifact = continuations[index]
    const owner = artifact === undefined ? undefined : stages.get(artifact.stageID)
    const metadata = artifact?.metadata
    if (
      artifact === undefined ||
      owner?.type !== stage.role ||
      owner.input.revision !== stage.revision ||
      metadata === null ||
      typeof metadata !== "object" ||
      Reflect.get(metadata, "type") !== "function_call_output" ||
      Reflect.get(metadata, "callID") !== script.callID ||
      Reflect.get(metadata, "name") !== script.name ||
      JSON.stringify(Reflect.get(metadata, "input")) !== JSON.stringify(script.input) ||
      Reflect.get(metadata, "result") === undefined ||
      !artifact.uri.endsWith(`/${encodeURIComponent(script.callID)}`)
    ) {
      throw new Error(`Tool invocation or continuation drifted at ${stage.role}/r${stage.revision}`)
    }
  }
}

function assertStoredResponseItems(
  database: BunDatabase,
  responseID: string,
  workflowID: string,
  recording: ProductionRecording,
): readonly string[] {
  const items = database
    .query<
      { ordinal: number; kind: string; payload: string },
      [string]
    >("SELECT ordinal, kind, payload FROM response_item WHERE response_id = ? ORDER BY ordinal")
    .all(responseID)
  if (
    items.length !== 3 ||
    JSON.stringify(items.map((item) => [item.ordinal, item.kind])) !==
      JSON.stringify([
        [0, "context"],
        [1, "input"],
        [2, "output"],
      ])
  ) {
    throw new Error("Stored Response item order or cardinality drifted")
  }
  const context = JSON.parse(items[0]!.payload)
  const input = JSON.parse(items[1]!.payload)
  const output = JSON.parse(items[2]!.payload)
  const source = recording.stages.at(-1)!
  if (
    context.type !== "workflow.visual-build.admission-receipt.v1" ||
    context.receipt?.ids?.workflowID !== workflowID ||
    context.receipt?.ids?.responseID !== responseID ||
    context.receipt?.response?.store !== true ||
    input.type !== "message" ||
    input.role !== "user" ||
    input.content !== "Build the frozen offline production experience" ||
    JSON.stringify(output) !==
      JSON.stringify({ type: "message", role: "assistant", content: JSON.stringify(source.semantic) })
  ) {
    throw new Error("Stored Response item authority is not bound to admission and deliver r2")
  }
  return Object.freeze(items.map((item) => item.kind))
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function writeCrashMarker(file: string, value: unknown): void {
  const handle = openSync(file, "wx", 0o600)
  try {
    writeFileSync(handle, JSON.stringify(value), { encoding: "utf8" })
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}
