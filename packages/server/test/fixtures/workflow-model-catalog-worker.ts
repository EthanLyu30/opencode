import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Clock, DateTime, Effect, Exit, Layer, Logger, Option, Schema } from "effect"
import { HttpRouter, HttpServer, FetchHttpClient } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { LLM, LLMClient, Message, Model } from "@opencode-ai/llm"
import { Auth } from "@opencode-ai/llm/route"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Workflow } from "@opencode-ai/schema/workflow"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { Database } from "@opencode-ai/core/database/database"
import { Credential } from "@opencode-ai/core/credential"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { WorkflowAdmission } from "@opencode-ai/core/workflow/admission"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowModelExecution } from "@opencode-ai/core/workflow/execution/model"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { ResponsesStore } from "@opencode-ai/core/responses/store"
import { ModelSelection } from "@opencode-ai/core/workflow/model-selection"
import { ModelAvailability } from "@opencode-ai/core/workflow/model-availability"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { WorkflowModelCatalogService } from "@opencode-ai/core/workflow/model-catalog/service"
import { WorkflowModelCatalogStore } from "@opencode-ai/core/workflow/model-catalog/store"
import { WorkflowModelCatalogPolicy } from "@opencode-ai/core/workflow/model-catalog/policy"
import { WorkflowModelDiscovery } from "@opencode-ai/core/workflow/model-catalog/discovery"
import { WorkflowModelSources } from "@opencode-ai/core/workflow/model-catalog/sources"
import { WorkflowCredentialScope } from "@opencode-ai/core/workflow/model-catalog/credential-scope"
import { WorkflowModelGroup } from "@opencode-ai/protocol/groups/workflow-model"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"
import {
  fixtureCatalogue,
  fixtureDiscovery,
  fixtureEntry,
  fixturePolicy,
} from "../../../core/test/fixtures/workflow-model-catalog"
import { dynamicResponse } from "../../../llm/test/lib/http"
import { controller } from "../../src/handlers/workflow-model"
import { ServerAuth } from "../../src/auth"
import { authorizationLayer } from "../../src/middleware/authorization"
import { schemaErrorLayer } from "../../src/middleware/schema-error"

const key = "offline-private-probe-credential"
const phases = [
  "seed",
  "read",
  "publish-before",
  "publish-after",
  "activate",
  "admit",
  "pending",
  "ambiguous",
  "settled",
  "replay",
  "gate",
  "gate-restart",
  "fences",
] as const
const ownerCodec = Schema.Struct({ nonce: Schema.String })
const identity = (providerID: WorkflowModelCatalog.ProviderID) => ({
  referenceID: `private-probe-${providerID}`,
  revision: "offline-1",
  origin: providerID === "kimi" ? "https://api.moonshot.cn" : "https://api.deepseek.com",
})
const scopeSha256 = WorkflowCredentialScope.hash([identity("kimi"), identity("deepseek")])
const successors = [
  fixtureEntry("kimi-flagship", { modelID: "kimi-successor-fixture", predecessor: "kimi-k3" }),
  fixtureEntry("deepseek-pro", { modelID: "deepseek-pro-successor-fixture", predecessor: "deepseek-v4-pro" }),
  fixtureEntry("deepseek-flash", { modelID: "deepseek-flash-successor-fixture", predecessor: "deepseek-v4-flash" }),
]
const source = "<!doctype html><html><body><main>Offline probe</main></body></html>"
const design = {
  contractVersion: 1,
  outcome: { schemaVersion: 1, role: "design", verdict: "ready", revision: 0 },
  payload: {
    spec: DesignArtifact.Spec.make({
      schemaVersion: 1,
      goals: ["Render offline fixture"],
      routes: [{ path: "/", goal: "Show the fixture" }],
      layoutConstraints: ["Keep main visible"],
      componentTree: [{ id: "root", component: "main", children: [] }],
      states: [{ name: "ready", description: "The fixture is ready" }],
      typography: [{ token: "body", family: "sans-serif", weight: 400, sizePx: 16, lineHeight: 1.5 }],
      colors: [{ token: "background", value: "#ffffff" }],
      responsiveRules: [{ viewport: "desktop", width: 1280, height: 720, rules: ["Keep main visible"] }],
      accessibilityRules: ["Use semantic landmarks"],
      acceptanceCriteria: ["The fixture renders"],
      projectStack: ["HTML"],
      referenceApp: {
        entrypoint: "index.html",
        readySelector: "main",
        files: [
          {
            path: "index.html",
            sha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
            size: Buffer.byteLength(source),
          },
        ],
        viewports: [{ name: "desktop", width: 1280, height: 720 }],
      },
    }),
    sources: [{ path: "index.html", content: source }],
  },
}
function invariant(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Private catalogue fixture: ${label}`)
}
function ready(phase: string, data: Readonly<Record<string, unknown>>, stop = false) {
  return Effect.sync(() => process.stdout.write(JSON.stringify({ phase, pid: process.pid, data }) + "\n")).pipe(
    Effect.andThen(stop ? Effect.never : Effect.void),
  )
}

// Only the compiled acceptance entry may call this; it has no listening port or configurable provider origin.
export async function runPrivateCatalogueWorker(args: readonly string[]) {
  const [root, nonce, phaseInput, expectedHead] = args
  invariant(root && path.isAbsolute(root) && path.basename(root).startsWith("opencode-catalogue-probe-"), "owned root")
  invariant(process.platform !== "win32" || path.parse(root).root.toLowerCase() === "d:\\", "D root")
  invariant(
    process.env.NODE_ENV === "test" && process.env.OPENCODE_DISABLE_WORKFLOW_MODEL_DISCOVERY === "true",
    "offline gate",
  )
  invariant(nonce && process.env.OPENCODE_PRIVATE_CATALOGUE_PROBE === nonce, "private grant")
  const marker = Schema.decodeUnknownSync(ownerCodec)(
    JSON.parse(await fs.readFile(path.join(root, "probe-owner.json"), "utf8")),
  )
  invariant(marker.nonce === nonce, "ownership grant")
  let ancestor: string | undefined = root
  while (ancestor) {
    const stat = await fs.lstat(ancestor)
    const real = await fs.realpath(ancestor)
    // Bun on Windows reports a drive root as "D:" rather than "D:\\".
    const canonical = process.platform === "win32" && /^[a-z]:$/i.test(real) ? real + "\\" : real
    invariant(
      !stat.isSymbolicLink() && canonical.toLowerCase() === path.resolve(ancestor).toLowerCase(),
      "root ancestry",
    )
    ancestor = path.dirname(ancestor) === ancestor ? undefined : path.dirname(ancestor)
  }
  const phase = Schema.decodeUnknownSync(Schema.Literals(phases))(phaseInput)
  // The deployed launcher may load its normal environment. No fixture service is permitted to obtain it.
  for (const name of ["MOONSHOT_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"]) delete process.env[name]
  const catalogueRoot = path.join(root, "catalogue")
  const workspace = path.join(root, "workspace")
  await fs.mkdir(workspace, { recursive: true })
  if (phase === "seed") await fs.writeFile(path.join(workspace, "index.html"), source, { flag: "wx" })
  const location = Location.Ref.make({ directory: AbsolutePath.make(workspace) })
  const store = await WorkflowModelCatalogStore.open(catalogueRoot, scopeSha256)
  let now = Date.now()
  const systemClock = await Effect.runPromise(Clock.Clock)
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: (duration) => systemClock.sleep(duration),
  }
  let generation = 0
  let availabilityChecks = 0
  const dispatchCount = () => generation
  const scope = Layer.succeed(WorkflowCredentialScope.Service, {
    resolve: (providerID) => Effect.succeed(identity(providerID)),
    credential: () => Effect.succeed(key),
  })
  const entries = [...fixtureCatalogue().models, ...successors].map((entry) => ({
    ...entry,
    evidence: [WorkflowModelSources.metadataEvidence(entry.providerID, 0)],
  }))
  const authority = WorkflowModelSources.reviewed(entries)
  const metadataFetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      invariant(request.method === "GET", "metadata GET only")
      invariant(request.headers.get("authorization") === `Bearer ${key}`, "private metadata credential")
      const providerID =
        request.url === "https://api.moonshot.cn/v1/models"
          ? "kimi"
          : request.url === "https://api.deepseek.com/models"
            ? "deepseek"
            : undefined
      invariant(providerID, "first-party metadata URL")
      return Response.json(fixtureDiscovery(providerID, entries))
    },
    { preconnect: () => undefined },
  ) satisfies typeof fetch
  const parsedDiscovery = WorkflowModelDiscovery.layer.pipe(
    Layer.provide(scope),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, metadataFetch)),
  )
  const reviewedDiscovery = Layer.effect(
    WorkflowModelDiscovery.Service,
    Effect.gen(function* () {
      const discovery = yield* WorkflowModelDiscovery.Service
      return {
        refresh: (providerID: WorkflowModelCatalog.ProviderID, scopeSha256: string) =>
          discovery.refresh(providerID, scopeSha256).pipe(
            Effect.map((catalogue) =>
              WorkflowModelCatalogPolicy.normalizeCatalogue(
                {
                  ...catalogue,
                  models: catalogue.models.map((entry) => authority.verify(entry, entry.evidence)),
                },
                scopeSha256,
              ),
            ),
          ),
      }
    }),
  ).pipe(Layer.provide(parsedDiscovery))
  const catalogueLayer = WorkflowModelCatalogService.layer({
    root: catalogueRoot,
    automatic: false,
    initialPolicy: (scopeSha256) => fixturePolicy(fixtureCatalogue({ scopeSha256 })),
  }).pipe(Layer.provide(scope), Layer.provide(reviewedDiscovery), Layer.provide(Layer.succeed(Clock.Clock, clock)))
  const provider = dynamicResponse(({ text, request, respond }) =>
    Effect.gen(function* () {
      const body = JSON.parse(text)
      const protocol = new URL(request.url).pathname
      invariant(
        request.method === "POST" && ["/v1/chat/completions", "/responses"].includes(protocol),
        "native wire URL",
      )
      invariant(body.model === "kimi-k3" || body.model === "deepseek-pro-successor-fixture", "exact native model")
      generation++
      yield* Effect.promise(() =>
        fs.appendFile(path.join(root, "calls.jsonl"), JSON.stringify({ protocol, modelID: body.model }) + "\n"),
      )
      const output = protocol === "/responses" ? "offline delivery" : JSON.stringify(design)
      const stream =
        protocol === "/responses"
          ? [
              { type: "response.created", sequence_number: 0, response: { id: "resp_probe", status: "in_progress" } },
              {
                type: "response.output_item.added",
                sequence_number: 1,
                output_index: 0,
                item: { type: "message", id: "msg_probe", role: "assistant", status: "in_progress", content: [] },
              },
              {
                type: "response.output_text.delta",
                sequence_number: 2,
                item_id: "msg_probe",
                output_index: 0,
                content_index: 0,
                delta: output,
              },
              {
                type: "response.completed",
                sequence_number: 3,
                response: {
                  id: "resp_probe",
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      id: "msg_probe",
                      role: "assistant",
                      status: "completed",
                      content: [{ type: "output_text", text: output, annotations: [] }],
                    },
                  ],
                  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                },
              },
            ]
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join("")
          : `data: ${JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\ndata: [DONE]\n\n`
      return respond(stream, { headers: { "content-type": "text/event-stream" } })
    }),
  )
  const graph = AppNodeBuilder.build(
    LayerNode.group([
      EventV2.node,
      WorkflowAdmission.node,
      WorkflowStore.node,
      ResponsesStore.node,
      WorkflowV2.node,
      ApplicationTools.node,
      LocationServiceMap.node,
      WorkflowModelExecution.node,
    ]),
    [
      [Database.node, Database.layerFromPath(path.join(root, "workflow.sqlite"))],
      [llmClient, provider],
      [SessionExecution.node, SessionExecution.noopLayer],
      [
        Credential.node,
        Layer.mock(Credential.Service, {
          list: (integrationID) =>
            Effect.succeed([
              new Credential.Info({
                id: Credential.ID.make("crd_probe"),
                integrationID,
                label: "offline",
                value: Credential.Key.make({ type: "key", key }),
              }),
            ]),
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
        WorkflowExecution.node,
        Layer.succeed(WorkflowExecution.Service, {
          wake: Effect.void,
          interrupt: () => Effect.void,
          active: Effect.succeed(new Set<Workflow.ID>()),
        }),
      ],
      [
        ModelSelection.node,
        Layer.effect(
          ModelSelection.Service,
          Effect.gen(function* () {
            const catalogue = yield* WorkflowModelCatalogService.Service
            return { snapshot: () => catalogue.snapshot() }
          }),
        ).pipe(Layer.provide(catalogueLayer)),
      ],
      [
        ModelAvailability.node,
        Layer.succeed(ModelAvailability.Service, {
          check: (selection) =>
            Effect.tryPromise({
              try: () => {
                availabilityChecks++
                return store.read()
              },
              catch: () => new WorkflowModelCatalog.CatalogError({ code: "snapshot_corrupt" }),
            }).pipe(
              Effect.flatMap((view) => {
                invariant(view.catalogue, "availability catalogue")
                const catalogue = ["replay", "gate", "gate-restart"].includes(phase)
                  ? fixtureCatalogue({
                      ...view.catalogue,
                      models: view.catalogue.models.map((entry) => ({
                        ...entry,
                        advertisedRevision: "drifted-private-fixture",
                      })),
                    })
                  : view.catalogue
                return ModelAvailability.checkCatalogue(selection, catalogue)
              }),
            ),
        }),
      ],
    ],
  )
  const request = {
    prompt: "offline catalogue process acceptance",
    budget: { maxTokens: 100_000, maxTurns: 20, maxToolCalls: 20, maxAttempts: 100 },
    visual: { maxRevisions: 0, maxTokens: 100_000, maxTurns: 20, maxToolCalls: 20 },
    preview: { kind: "static" as const, entrypoint: "index.html" },
    delivery: "background" as const,
  }
  const admit = (key: string) =>
    WorkflowAdmission.Service.use((admission) => admission.admitVisualBuild(request, location, key))
  const readEffect = Effect.tryPromise({
    try: () => store.read(),
    catch: () => new WorkflowModelCatalog.CatalogError({ code: "snapshot_corrupt" }),
  })
  const execution = Effect.gen(function* () {
    const workflows = yield* WorkflowStore.Service
    const events = yield* EventV2.Service
    const models = yield* WorkflowModelExecution.Service
    const api = yield* WorkflowV2.Service
    if (phase === "seed") {
      const view = yield* WorkflowModelCatalogService.Service.use((catalogue) => catalogue.refresh(true)).pipe(
        Effect.provide(catalogueLayer),
      )
      invariant(view.policy?.choices["kimi-flagship"].modelID === "kimi-k3", "discovery leaves policy unchanged")
      const original = yield* admit("original")
      return yield* ready(
        phase,
        { generation, originalModelID: ModelSelection.fromWorkflow(original.workflow).snapshot.routes.design.modelID },
        true,
      )
    }
    if (phase === "read") {
      const view = yield* readEffect
      return yield* ready(phase, {
        head: view.head?.sha256,
        current: view.policy?.choices["kimi-flagship"].modelID,
        predecessorLifecycle: view.catalogue?.models.find((entry) => entry.modelID === "kimi-k3")?.lifecycle,
      })
    }
    if (phase === "publish-before" || phase === "publish-after") {
      const view = yield* readEffect
      invariant(view.catalogue && view.policy && view.head, "seeded catalogue")
      const catalogue = WorkflowModelCatalogPolicy.normalizeCatalogue(
        { ...view.catalogue, observedAt: view.catalogue.observedAt + 1 },
        scopeSha256,
      )
      yield* Effect.promise(async () => {
        const writer = await WorkflowModelCatalogStore.open(catalogueRoot, scopeSha256, {
          onPublish: async (boundary) => {
            if (boundary !== (phase === "publish-before" ? "before_head" : "after_head")) return
            await Effect.runPromise(ready(phase, { scopeSha256 }, true))
          },
        })
        await writer.publish({ expectedHeadSha256: view.head!.sha256, catalogue, policy: view.policy! })
      })
      return
    }
    if (phase === "activate") {
      invariant(expectedHead && Schema.is(WorkflowModelCatalog.Sha256)(expectedHead), "displayed CAS head")
      const localApi = HttpApi.make("private-catalogue-probe")
        .add(WorkflowModelGroup)
        .middleware(Authorization)
        .middleware(SchemaErrorMiddleware)
      const handlers = HttpApiBuilder.group(localApi, "server.workflowModels", (handlers) =>
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
      const web = HttpRouter.toWebHandler(
        HttpApiBuilder.layer(localApi).pipe(
          Layer.provide(handlers),
          Layer.provide(authorizationLayer),
          Layer.provide(schemaErrorLayer),
          Layer.provide(
            ServerAuth.Config.configLayer({ username: "opencode", password: Option.some("offline-probe-auth") }),
          ),
          Layer.provide(catalogueLayer),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      )
      const result = yield* Effect.tryPromise({
        try: async () => {
          const headers = {
            Authorization: ServerAuth.header({ username: "opencode", password: "offline-probe-auth" })!,
            "Content-Type": "application/json",
          }
          try {
            const listed = await web.handler(new Request("http://private.invalid/api/workflow-models", { headers }))
            invariant(listed.status === 200, "authenticated list")
            Schema.decodeUnknownSync(WorkflowModelCatalog.View)((await listed.json()).data)
            const response = await web.handler(
              new Request("http://private.invalid/api/workflow-models/activate", {
                method: "POST",
                headers,
                body: JSON.stringify({
                  expectedHeadSha256: expectedHead,
                  replacements: successors.map((entry) => ({
                    family: entry.family,
                    providerID: entry.providerID,
                    modelID: entry.modelID,
                  })),
                }),
              }),
            )
            if (response.status === 200) {
              Schema.decodeUnknownSync(WorkflowModelCatalog.View)((await response.json()).data)
              return true
            }
            invariant(
              response.status === 400 && (await response.json()).kind === "selection_conflict",
              "typed CAS rejection",
            )
            const view = await store.read()
            invariant(view.head?.sha256 !== expectedHead, "CAS rejection preserves winner")
            return false
          } finally {
            await web.dispose()
          }
        },
        catch: () => new Error("Private catalogue activation failed"),
      })
      return yield* ready(phase, { activated: result, generation })
    }
    const original = yield* admit("original")
    // claim() is deliberately global; admit the second runnable task after original replay.
    const selected = ["admit", "gate", "gate-restart"].includes(phase) ? yield* admit("successor") : undefined
    invariant(original.response.model === "deepseek-v4-pro", "original delivery Response stays pinned")
    if (selected) invariant(selected.response.model === "deepseek-pro-successor-fixture", "new delivery Response pin")
    if (phase === "admit") {
      invariant(selected, "new admission")
      return yield* ready(
        phase,
        { newAdmissionModelID: ModelSelection.fromWorkflow(selected.workflow).snapshot.routes.design.modelID },
        true,
      )
    }
    const target = ["gate", "gate-restart"].includes(phase) ? selected?.workflow : original.workflow
    invariant(target, "runnable workflow")
    let detail = (yield* workflows.get(target.id))!
    now = Math.max(now, DateTime.toEpochMillis(detail.stages[0].time.updated) + 1)
    if (phase === "ambiguous" || phase === "replay") {
      const expired = detail.stages[0]
      invariant(expired.leaseExpiresAt && expired.status === "running", "crashed leased stage")
      now = DateTime.toEpochMillis(expired.leaseExpiresAt) + 1
      if (phase === "replay") {
        yield* events.publish(WorkflowEvent.Stage.RetryScheduled, {
          workflowID: target.id,
          stageID: expired.id,
          attempt: expired.attempt,
          leaseOwner: expired.leaseOwner,
          timestamp: DateTime.makeUnsafe(now),
          notBefore: DateTime.makeUnsafe(now),
          failure: { category: "transient", code: "lease_expired", message: "Offline settled-result recovery" },
          usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
          leaseFence: {
            variant: "expired_recovery",
            expectedStatus: "running",
            observedLeaseExpiresAt: expired.leaseExpiresAt,
          },
        })
        detail = (yield* workflows.get(target.id))!
      }
    }
    if (phase === "gate-restart") {
      invariant(
        detail.run.status === "waiting_approval" && detail.stages[0].error?.code === "model_unavailable",
        "durable configuration gate",
      )
      const failed = yield* api
        .resolveRecovery({ workflowID: target.id, stageID: detail.stages[0].id, action: "retry" })
        .pipe(Effect.exit)
      invariant(Exit.isFailure(failed), "drift cannot approve retry")
      return yield* ready(phase, { generation })
    }
    if (phase === "settled") {
      invariant(detail.stages[0].status === "waiting_approval", "pending-call approval")
      yield* api.resolveRecovery({ workflowID: target.id, stageID: detail.stages[0].id, action: "retry" })
      detail = (yield* workflows.get(target.id))!
    }
    let stage = detail.stages[0]
    if (stage.status === "pending" || stage.status === "retry_wait") {
      stage = Option.getOrThrow(
        yield* workflows.claim({ owner: `private-probe-${phase}`, now, leaseDurationMs: 180_000 }),
      )
      invariant(stage.workflowID === target.id, "exact stage claim")
      yield* events.publish(WorkflowEvent.Started, {
        workflowID: target.id,
        timestamp: DateTime.makeUnsafe(now),
      })
      yield* events.publish(WorkflowEvent.Stage.Started, {
        workflowID: target.id,
        stageID: stage.id,
        attempt: stage.attempt,
        leaseOwner: stage.leaseOwner,
        timestamp: DateTime.makeUnsafe(now),
      })
      detail = (yield* workflows.get(target.id))!
      stage = detail.stages.find((candidate) => candidate.id === stage.id)!
    }
    const selection = ModelSelection.fromWorkflow(detail.run)
    const fence = { workflowID: target.id, stageID: stage.id, attempt: stage.attempt, leaseOwner: stage.leaseOwner }
    const checkpoint = (value: Readonly<Record<string, unknown>>) =>
      events
        .publish(WorkflowEvent.Stage.Checkpointed, {
          ...fence,
          timestamp: DateTime.makeUnsafe(now),
          checkpoint: value,
        })
        .pipe(Effect.asVoid)
    if (phase === "fences") {
      const lost = yield* events
        .publish(WorkflowEvent.Stage.Checkpointed, {
          ...fence,
          leaseOwner: "private-probe-settled",
          attempt: stage.attempt - 1,
          timestamp: DateTime.makeUnsafe(now),
          checkpoint: { privateProbe: true },
        })
        .pipe(Effect.exit)
      invariant(Exit.isFailure(lost), "lost lease cannot publish checkpoint")
      yield* api.cancel(target.id)
      const cancelled = yield* checkpoint({ privateProbe: true }).pipe(Effect.exit)
      invariant(Exit.isFailure(cancelled), "cancellation wins over late checkpoint")
      return yield* ready(phase, { generation })
    }
    const route = WorkflowRouting.resolve({ role: "design", budget: detail.run.budget, selection })
    const result = yield* models
      .execute({
        workflow: detail.run,
        stage,
        stages: detail.stages,
        artifacts: detail.artifacts,
        lease: { owner: stage.leaseOwner!, attempt: stage.attempt, expiresAt: stage.leaseExpiresAt! },
        route,
        saveCheckpoint: (value) =>
          checkpoint(value).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                const turn = value.providerTurn
                const boundary =
                  typeof turn === "object" &&
                  turn !== null &&
                  (phase === "pending" ? !("result" in turn) : phase === "settled" && "result" in turn)
                return boundary ? ready(phase, { generation }, true) : Effect.void
              }),
            ),
          ),
      })
      .pipe(Effect.exit)
    if (phase === "ambiguous" || phase === "gate") {
      invariant(Exit.isFailure(result), "expected provider/configuration gate")
      const error = Cause.squash(result.cause)
      invariant(
        error && typeof error === "object" && "failure" in error && "usage" in error,
        "typed model execution failure",
      )
      const failure = Schema.decodeUnknownSync(Workflow.Failure)(error.failure)
      const usage = Schema.decodeUnknownSync(Workflow.Usage)(error.usage)
      invariant(
        failure.code === (phase === "gate" ? "model_unavailable" : "provider_execution_ambiguous"),
        "exact gate code",
      )
      invariant(generation === 0, "gate cannot generate")
      yield* events.publish(WorkflowEvent.Approval.Requested, {
        ...fence,
        timestamp: DateTime.makeUnsafe(now),
        reason: phase === "gate" ? "workflow_model_required" : "ambiguous_execution",
        failure,
        usage,
        leaseFence:
          phase === "ambiguous"
            ? { variant: "expired_recovery", expectedStatus: "running", observedLeaseExpiresAt: stage.leaseExpiresAt! }
            : { variant: "live_execution", expectedStatus: "running" },
      })
      return yield* ready(phase, { generation }, phase === "gate")
    }
    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause)
      const failure =
        error && typeof error === "object" && "failure" in error
          ? Schema.decodeUnknownSync(Workflow.Failure)(error.failure)
          : undefined
      invariant(
        false,
        `${phase}: ${failure && /^[a-z0-9_]{1,80}$/.test(failure.code) ? failure.code : "execution_failed"}`,
      )
    }
    invariant(phase === "replay" && Exit.isSuccess(result), "settled checkpoint resumes")
    invariant(
      generation === 0 && result.value.contract?.authority.authorityVersion === 2,
      "settled result not redispatched",
    )
    invariant(availabilityChecks === 0, "settled replay skips changed availability")
    const replayCalls = generation
    const recoveredModelID = result.value.contract.authority.route.modelID
    invariant(recoveredModelID === "kimi-k3", "frozen authority route")
    const successorSelection = yield* WorkflowModelCatalogService.Service.use((catalogue) => catalogue.snapshot()).pipe(
      Effect.provide(catalogueLayer),
    )
    invariant(successorSelection, "current policy native smoke")
    const successorRoute = WorkflowRouting.resolve({
      role: "implement",
      budget: original.workflow.budget,
      selection: ModelSelection.freeze(successorSelection, location),
    })
    const successorModel = Model.update(successorRoute.model, {
      route: successorRoute.model.route.with({ auth: Auth.bearer(key) }),
    })
    const response = yield* LLMClient.generate(
      LLM.request({ model: successorModel, messages: [Message.user("offline")] }),
    ).pipe(Effect.provide(provider), Effect.exit)
    invariant(Exit.isSuccess(response), "native successor Responses stream accepted")
    invariant(response.value.text === "offline delivery", "native successor Responses event stream")
    invariant(dispatchCount() === 1, "one native successor dispatch")
    return yield* ready(phase, { generation: replayCalls, recoveredModelID })
  })
  await Effect.runPromise(
    execution.pipe(
      Effect.provide(graph),
      Effect.provideService(Clock.Clock, clock),
      Effect.provide(Logger.layer([])),
      Effect.scoped,
    ),
  )
}
