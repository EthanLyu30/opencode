import fs from "node:fs/promises"
import path from "node:path"
import { Context, DateTime, Effect, Layer, Logger, Schema } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient, httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Database } from "@opencode-ai/core/database/database"
import { Credential } from "@opencode-ai/core/credential"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { ModelSelection } from "@opencode-ai/core/workflow/model-selection"
import { ModelAvailability } from "@opencode-ai/core/workflow/model-availability"
import { CodingArtifacts } from "@opencode-ai/core/workflow/coding/artifacts"
import { CodingHostPlan } from "@opencode-ai/core/workflow/coding/host-plan"
import { WorkflowBusinessArtifact } from "@opencode-ai/core/workflow/artifacts/business"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { Workflow } from "@opencode-ai/schema/workflow"
import { OpenCode } from "../../../client/src"
import { dynamicResponse } from "../../../llm/test/lib/http"
import { fixtureAdmissionSnapshot } from "../../../core/test/fixtures/workflow-model-catalog"
import { createEmbeddedRoutes } from "../../src/routes"
import { WorkflowModelCatalogRuntime } from "../../src/workflow/model-catalog-runtime"
import { WorkflowModelCatalogService } from "@opencode-ai/core/workflow/model-catalog/service"
import { WorkflowRuntimeRecovery } from "../../src/workflow/runtime-recovery"
import { CodingCheckLauncher } from "../../src/workflow/coding-check-launcher"
import { CodingProbeResult } from "../workflow-coding-probe"

const bun = "D:\\OpenCode-Toolchain\\bun-1.3.14\\bun-windows-x64\\bun.exe"
const bunSha256 = "0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c"
const key = "offline-coding-fixture-not-a-real-key"
const wrong = "export const sum = (a: number, b: number) => a * b\n"
const correct = "export const sum = (a: number, b: number) => a + b\n"
function invariant(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Private catalogue fixture: coding_${label}`)
}

/** Called only after the existing private entry verifies nonce, owned ancestry and offline mode. */
export async function runPrivateCodingWorker(root: string, nonce: string, variant: string | undefined) {
  invariant(
    variant &&
      /^(repair|review|review-budget|exhaust|forged-pass|config-drift|source-drift|ignored-config|crash-settled|crash-write)(\/resume)?$/.test(
        variant,
      ),
    "scenario",
  )
  const resume = variant.endsWith("/resume")
  const scenario = variant.split("/")[0]!
  const reviewScenario = scenario === "review" || scenario === "review-budget"
  invariant(!resume || scenario.startsWith("crash-"), "resume_scenario")
  invariant(JSON.parse(await fs.readFile(path.join(root, "probe-owner.json"), "utf8")).nonce === nonce, "owner")
  invariant(
    new Bun.CryptoHasher("sha256").update(await Bun.file(bun).arrayBuffer()).digest("hex") === bunSha256,
    "pinned_bun",
  )
  const workspace = path.join(root, "workspace")
  if (!resume) {
    await fs.mkdir(workspace, { recursive: false })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ private: true, type: "module" }), {
      flag: "wx",
    })
    await fs.writeFile(path.join(workspace, "sum.ts"), "export const sum = (a: number, b: number) => a - b\n", {
      flag: "wx",
    })
    await fs.writeFile(
      path.join(workspace, "sum.test.ts"),
      'import { expect, test } from "bun:test"\nimport { sum } from "./sum"\ntest("positive sum", () => expect(sum(2, 3)).toBe(5))\ntest("negative sum", () => expect(sum(-2, 3)).toBe(1))\n',
      { flag: "wx" },
    )
    if (scenario === "ignored-config") {
      await fs.writeFile(path.join(workspace, "bunfig.toml"), '[test]\npreload = ["./required-preload.ts"]\n', {
        flag: "wx",
      })
      await fs.writeFile(
        path.join(workspace, "required-preload.ts"),
        'throw new Error("Required frozen preload must fail")\n',
        { flag: "wx" },
      )
    }
    for (const args of [
      ["init", "--quiet"],
      ["add", "."],
      [
        "-c",
        "user.name=Offline Fixture",
        "-c",
        "user.email=offline@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
    ]) {
      const child = Bun.spawn(["C:\\Program Files\\Git\\cmd\\git.exe", ...args], {
        cwd: workspace,
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exit] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).arrayBuffer(),
      ])
      invariant(exit === 0, "git_fixture")
      if (scenario === "ignored-config" && args[0] === "init")
        await fs.appendFile(path.join(workspace, ".git", "info", "exclude"), "\nbunfig.toml\n")
    }
  }
  const state = { writes: 0, reviewReads: 0, previewCalls: 0, browserCalls: 0, outboundCalls: 0 }
  const roleModels: Record<string, string> = {}
  const stageCalls = new Map<string, number>()
  const calls: { stageID: string; sequence: number; model: string }[] = []
  const journal = path.join(root, "coding-calls.json")
  if (resume) {
    const saved = await Bun.file(journal).json()
    Object.assign(state, saved.state)
    Object.assign(roleModels, saved.roleModels)
    for (const [id, count] of saved.stageCalls) stageCalls.set(id, count)
    calls.push(...saved.calls)
  }
  const persist = () => fs.writeFile(journal, JSON.stringify({ state, roleModels, stageCalls: [...stageCalls], calls }))
  let store: WorkflowStore.Interface | undefined
  const barrier = () =>
    Effect.gen(function* () {
      invariant(store, "barrier_store")
      const runs = yield* store.list({ limit: 2 })
      const detail = yield* store.get(runs[0]!.id)
      const stage = detail!.stages.find((item) => item.status === "running")
      invariant(stage?.leaseExpiresAt, "barrier_lease")
      process.stdout.write(
        JSON.stringify({
          phase: "coding-barrier",
          pid: process.pid,
          data: { leaseExpiresAt: DateTime.toEpochMillis(stage.leaseExpiresAt) },
        }) + "\n",
      )
      return yield* Effect.never
    })
  const provider = dynamicResponse(({ text, request, respond }) =>
    Effect.gen(function* () {
      invariant(store, "provider_store")
      const workflows = yield* store.list({ limit: 2 })
      invariant(workflows.length === 1, "provider_workflow")
      const detail = yield* store.get(workflows[0]!.id)
      const active = detail!.stages.filter((stage) => stage.status === "running")
      invariant(active.length === 1, "provider_stage")
      const stage = active[0]!
      const body = JSON.parse(text)
      const role = stage.type
      const revision = CodingArtifacts.revisionOf(detail!.run, stage, detail!.artifacts)
      const expected =
        role === "design" || role === "decompose" || role === "code_review"
          ? "kimi-k3"
          : role === "test"
            ? "deepseek-v4-flash"
            : "deepseek-v4-pro"
      const url = new URL(request.url)
      invariant(body.model === expected && request.headers.authorization === `Bearer ${key}`, "pinned_native_request")
      invariant(
        url.origin === (expected === "kimi-k3" ? "https://api.moonshot.cn" : "https://api.deepseek.com"),
        "native_origin",
      )
      invariant(url.pathname === (expected === "kimi-k3" ? "/v1/chat/completions" : "/responses"), "native_protocol")
      roleModels[role] = body.model
      const call = stageCalls.get(stage.id) ?? 0
      stageCalls.set(stage.id, call + 1)
      const intent = stage.checkpoint?.providerTurn as { sequence?: number } | undefined
      invariant(typeof intent?.sequence === "number", "durable_provider_intent")
      calls.push({ stageID: stage.id, sequence: intent.sequence, model: body.model })
      const tool =
        call === 0 && (role === "implement" || role === "repair")
          ? {
              id: `call_${stage.id}`,
              name: "write",
              input: {
                path: "sum.ts",
                content: role === "implement" && !reviewScenario && scenario !== "ignored-config" ? wrong : correct,
              },
            }
          : call === 0 && role === "code_review"
            ? { id: `call_${stage.id}`, name: "read", input: { path: "sum.ts" } }
            : undefined
      if (role === "code_review" && call > 0) {
        invariant(text.includes("a + b"), "actual_review_source")
        state.reviewReads++
      }
      const record = role === "test" ? CodingArtifacts.checkpointChecks(stage) : undefined
      const plan =
        role === "test"
          ? CodingHostPlan.decode(detail!.run.input[CodingHostPlan.RESERVED_INPUT_KEY], detail!.run.location!)
          : undefined
      invariant(role !== "test" || (record && plan), "host_check_record")
      const verdict =
        role === "test"
          ? scenario === "forged-pass" || CodingArtifacts.checksPassed(record!.checks, plan!)
            ? "pass"
            : "revise"
          : role === "code_review"
            ? reviewScenario && revision === 0
              ? "revise"
              : "pass"
            : role === "deliver"
              ? "complete"
              : "ready"
      const payload =
        role === "design"
          ? {
              objective: "Repair the sum library",
              constraints: ["Do not change tests or configuration"],
              interfaces: ["sum(a,b): number"],
              files: ["sum.ts"],
              risks: [],
              acceptanceCriteria: ["Both real Bun tests pass"],
            }
          : role === "decompose"
            ? {
                acceptanceCriteria: ["Both real Bun tests pass"],
                tasks: [
                  {
                    id: "fix-sum",
                    title: "Fix sum",
                    description: "Implement addition in sum.ts",
                    files: ["sum.ts"],
                    dependsOn: [],
                    acceptanceCriteria: ["sum(2,3)=5", "sum(-2,3)=1"],
                  },
                ],
              }
            : role === "code_review"
              ? {
                  verdict,
                  findings:
                    verdict === "revise"
                      ? [
                          {
                            id: "review-blocker",
                            path: "sum.ts",
                            severity: "important",
                            blocking: true,
                            summary: "Recorded review requires a second implementation pass",
                          },
                        ]
                      : [],
                }
              : { summary: `Recorded ${role} result` }
      const semantic = JSON.stringify({
        contractVersion: 1,
        outcome: { schemaVersion: 1, role, revision, verdict },
        payload,
      })
      yield* Effect.promise(persist)
      return respond(nativeWire(url.pathname === "/responses", semantic, tool), {
        headers: { "content-type": "text/event-stream" },
      })
    }),
  )
  const mutations = makeLocationNode({
    service: FileMutation.Service,
    deps: [],
    layer: Layer.effect(
      FileMutation.Service,
      Effect.map(FileMutation.Service, (actual) => ({
        ...actual,
        writeTextPreservingBom: (input) =>
          actual.writeTextPreservingBom(input).pipe(
            Effect.tap(() =>
              Effect.promise(async () => {
                state.writes++
                if (scenario === "config-drift")
                  await fs.writeFile(
                    path.join(workspace, "package.json"),
                    JSON.stringify({ private: true, type: "module", changed: true }),
                  )
                await persist()
              }),
            ),
            Effect.tap(() => (scenario === "crash-write" && !resume ? barrier() : Effect.void)),
          ),
      })),
    ).pipe(Layer.provide(LayerNode.compile(FileMutation.node))),
  })
  const eventNode = makeGlobalNode({
    service: EventV2.Service,
    deps: [Database.node],
    layer: Layer.effect(
      EventV2.Service,
      Effect.map(EventV2.Service, (actual) => ({
        ...actual,
        publish: (definition, data, options) =>
          actual.publish(definition, data, options).pipe(
            Effect.tap(() => {
              if (scenario !== "crash-settled" || resume || definition.type !== "workflow.stage.checkpointed")
                return Effect.void
              const checkpoint = (data as { checkpoint?: { providerTurn?: { result?: unknown } } }).checkpoint
              return checkpoint?.providerTurn?.result === undefined ? Effect.void : barrier()
            }),
          ),
      })),
    ).pipe(Layer.provide(EventV2.layerWith())),
  })
  const command = makeLocationNode({
    service: WorkflowCommandSandbox.Service,
    deps: [WorkflowStore.node],
    layer: Layer.effect(
      WorkflowCommandSandbox.Service,
      Effect.gen(function* () {
        const workflows = yield* WorkflowStore.Service
        return WorkflowCommandSandbox.Service.of({
          run: () => Effect.die("No model shell in coding fixture"),
          runFrozenCoding: (input) =>
            Effect.promise(async () => {
              const sealed = WorkflowWorkspaceMaterialization.validate(input.sealedSnapshot)
              invariant(
                sealed.workflowID === input.workflowID &&
                  sealed.stageID === input.stageID &&
                  sealed.revision === input.revision,
                "sealed_owner",
              )
              const detail = await Effect.runPromise(workflows.get(input.workflowID))
              invariant(detail?.run.location, "command_workflow")
              const plan = CodingHostPlan.decode(
                detail.run.input[CodingHostPlan.RESERVED_INPUT_KEY],
                detail.run.location,
              )
              CodingHostPlan.verifyCurrentConfiguration(plan)
              invariant(plan.sha256 === input.planSha256 && plan.configSha256 === input.configSha256, "command_plan")
              const selected = plan.commands.find((item) => item.id === input.commandID)
              invariant(selected && selected.id === "test", "command_selection")
              const directory = await fs.mkdtemp(path.join(root, "check-"))
              const source = path.join(directory, "source")
              await fs.mkdir(source)
              for (const entry of sealed.archive.entries) {
                const target = path.resolve(source, entry.path)
                invariant(
                  path.relative(source, target) !== ".." && !path.relative(source, target).startsWith(`..${path.sep}`),
                  "archive_path",
                )
                await fs.mkdir(path.dirname(target), { recursive: true })
                await fs.writeFile(target, Buffer.from(entry.contentBase64, "base64"), { flag: "wx" })
              }
              const child = Bun.spawn(
                [
                  bun,
                  "--no-env-file",
                  "-e",
                  CodingCheckLauncher.source({
                    id: "test",
                    argv: selected.argv,
                    timeoutMs: 10000,
                    scratchRoot: path.join(directory, "scratch"),
                  }),
                ],
                {
                  cwd: path.resolve(source, plan.cwd),
                  env: process.env,
                  stdin: "ignore",
                  stdout: "pipe",
                  stderr: "pipe",
                },
              )
              const [exit, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
              ])
              invariant(stderr.length === 0, "trusted_launcher")
              if (scenario === "source-drift") await fs.writeFile(path.join(workspace, "sum.ts"), correct)
              return {
                ...CodingCheckLauncher.decode(stdout, exit),
                ownerSha256: WorkflowBusinessArtifact.hash({
                  workflowID: input.workflowID,
                  stageID: input.stageID,
                  authority: sealed.authoritySha256,
                }),
              }
            }),
        })
      }),
    ),
  })
  const visual = makeGlobalNode({
    service: WorkflowVisualHost.Service,
    deps: [],
    layer: Layer.mock(WorkflowVisualHost.Service, {
      materializeReference: () =>
        Effect.sync(() => {
          state.previewCalls++
          throw new Error("No coding preview")
        }),
      prepareImplementation: () =>
        Effect.sync(() => {
          state.previewCalls++
          throw new Error("No coding preview")
        }),
      capture: () =>
        Effect.sync(() => {
          state.browserCalls++
          throw new Error("No coding browser")
        }),
    }),
  })
  const graph = createEmbeddedRoutes({
    workflow: { commandSandbox: command, visualHost: visual },
    buildApplicationServices: (services, replacements) =>
      AppNodeBuilder.build(LayerNode.group([services, WorkflowStore.node]), [
        ...replacements,
        [Database.node, Database.layerFromPath(path.join(root, "workflow.sqlite"))],
        [llmClient, provider],
        [
          httpClient,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() =>
              Effect.sync(() => {
                state.outboundCalls++
                throw new Error("Coding outbound transport forbidden")
              }),
            ),
          ),
        ],
        [
          Credential.node,
          Layer.mock(Credential.Service, {
            list: (integrationID) =>
              Effect.succeed([
                new Credential.Info({
                  id: Credential.ID.make("crd_coding_fixture"),
                  integrationID,
                  label: "offline",
                  value: Credential.Key.make({ type: "key", key }),
                }),
              ]),
          }),
        ],
        [
          ModelSelection.node,
          Layer.succeed(ModelSelection.Service, { snapshot: () => Effect.succeed(fixtureAdmissionSnapshot(resume)) }),
        ],
        [
          ModelAvailability.node,
          Layer.succeed(ModelAvailability.Service, { check: () => Effect.void, credential: () => Effect.succeed(key) }),
        ],
        [WorkflowModelCatalogRuntime.node, Layer.mock(WorkflowModelCatalogService.Service, {})],
        [
          WorkflowRuntimeRecovery.node,
          Layer.succeed(WorkflowRuntimeRecovery.Service, { healthy: true, recovered: 0, skipped: 0, ready: true }),
        ],
        [
          ToolOutputStore.cleanupNode,
          makeGlobalNode({ name: ToolOutputStore.cleanupNode.name, layer: Layer.empty, deps: [] }),
        ],
        [FileMutation.node, mutations],
        [EventV2.node, eventNode],
        [
          WorkflowExecution.node,
          WorkflowExecutionLocal.nodeWith({
            ownerID: "coding-fixture",
            leaseDurationMs: 10000,
            heartbeatIntervalMs: 500,
            pollIntervalMs: 5,
            concurrency: 1,
          }),
        ],
      ]).pipe(
        Layer.tap((context) =>
          Effect.sync(() => {
            store = Context.get(context, WorkflowStore.Service)
          }),
        ),
      ),
  })
  const web = HttpRouter.toWebHandler(
    graph.pipe(Layer.provide(HttpServer.layerServices), Layer.provide(Logger.layer([]))),
    { disableLogger: true },
  )
  const requestServices = Context.make(PermissionSaved.Service, {
    list: () => Effect.succeed([]),
    add: () => Effect.void,
    remove: () => Effect.void,
  })
  const fetcher = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => web.handler(new Request(input, init), requestServices),
    { preconnect: () => {} },
  )
  const client = OpenCode.make({
    baseUrl: "http://opencode.internal",
    headers: { "x-opencode-directory": encodeURIComponent(workspace) },
    fetch: fetcher,
  })
  try {
    const input = {
      prompt: "Repair sum without a page; do not edit tests",
      checks: { cwd: ".", test: "bun-test" as const },
      coding: {
        maxRevisions: scenario === "exhaust" ? 0 : 1,
        maxTokens: 12000,
        maxTurns: scenario === "review" ? 20 : 12,
        maxToolCalls: 24,
      },
      budget: { maxTokens: 20000, maxTurns: 20, maxToolCalls: 40, maxAttempts: 27, maxDurationMs: 1800000 },
      delivery: "background" as const,
    }
    const forged = await fetcher("http://opencode.internal/api/workflow/coding-build", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(workspace) },
      body: JSON.stringify({
        ...input,
        "workflow.coding-host-plan.v1": { sha256: "0".repeat(64), authority: "admission" },
      }),
    })
    invariant(forged.status === 400, "forged_admission_status")
    const before = await Effect.runPromise(store!.list({ limit: 2 }))
    invariant(before.length === (resume ? 1 : 0), "forged_admission_no_write")
    const admitted = await client.workflows.codingBuildCreate({ ...input, "idempotency-key": "coding-offline-library" })
    let status = "queued"
    for await (const event of client.workflows.events({ workflowID: admitted.workflow.id })) {
      if (
        ["workflow.succeeded", "workflow.failed", "workflow.cancelled", "workflow.approval.requested"].includes(
          event.type,
        )
      ) {
        status = event.type.slice("workflow.".length)
        break
      }
    }
    const detail = await client.workflows.get({ workflowID: admitted.workflow.id })
    const response = await client.responses.get({ responseID: admitted.response.id })
    const durable = await Effect.runPromise(store!.get(Workflow.ID.make(admitted.workflow.id)))
    invariant(durable?.run.location, "durable_location")
    const artifacts = durable.artifacts
    const checked = artifacts
      .filter((item) => item.kind === CodingArtifacts.kinds.checks)
      .map((item) =>
        CodingArtifacts.decode("checks", CodingArtifacts.toCommit(item), durable.run.id, durable.run.location!),
      )
    const delivery = artifacts.find((item) => item.kind === CodingArtifacts.kinds.delivery)
    const payload = delivery
      ? CodingArtifacts.decode("delivery", CodingArtifacts.toCommit(delivery), durable.run.id, durable.run.location!)
      : undefined
    const checks = checked
      .map((record) => {
        const measured = record.checks.find((item) => item.id === "test" && item.status === "executed")
        invariant(measured?.status === "executed", "actual_tests")
        return {
          revision: record.revision,
          observedTests: measured.observedTests,
          failedTests: measured.failedTests,
          exitCode: measured.exitCode,
        }
      })
      .sort((a, b) => a.revision - b.revision)
    const replay = client.workflows.events({ workflowID: admitted.workflow.id, after: 0 })[Symbol.asyncIterator]()
    const first = await replay.next()
    await replay.return?.()
    const cancellationVerified =
      scenario === "crash-write" && resume
        ? await (async () => {
            await client.workflows.cancel({ workflowID: admitted.workflow.id })
            const cancelled = await client.workflows.get({ workflowID: admitted.workflow.id })
            const cancelledResponse = await client.responses.get({ responseID: admitted.response.id })
            return cancelled.run.status === "cancelled" && cancelledResponse.status === "cancelled"
          })()
        : false
    const result = Schema.decodeUnknownSync(CodingProbeResult)({
      workflowType: detail.run.type,
      workflowStatus: detail.run.status,
      responseStatus: response.status,
      roleModels,
      checks,
      ...state,
      deliveryValid:
        !!payload &&
        payload.testSha256 ===
          artifacts.find((item) => item.kind === CodingArtifacts.kinds.checks && item.sha256 === payload.testSha256)
            ?.sha256 &&
        artifacts.some(
          (item) => item.kind === CodingArtifacts.kinds.review && item.sha256 === payload.codeReviewSha256,
        ),
      sourceCorrect: (await fs.readFile(path.join(workspace, "sum.ts"), "utf8")) === correct,
      sseReplayExclusive: !first.done && (first.value.durable?.seq ?? 0) > 0,
      settledCallsReplayed: calls.length - new Set(calls.map((call) => `${call.stageID}:${call.sequence}`)).size,
      errorCode: detail.stages.find((item) => item.error)?.error?.code ?? "none",
      workerDeathProven: false,
      forgedAdmissionRejected: true,
      cancellationVerified,
    })
    process.stdout.write(JSON.stringify({ phase: "coding", pid: process.pid, data: result }) + "\n")
  } finally {
    await web.dispose()
  }
}

function nativeWire(responses: boolean, text: string, tool?: { id: string; name: string; input: unknown }) {
  if (!responses)
    return `data: ${JSON.stringify({ id: "chat_coding", choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { role: "assistant", content: text }, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`
  const item = tool
    ? {
        type: "function_call",
        id: `fc_${tool.id}`,
        call_id: tool.id,
        name: tool.name,
        arguments: JSON.stringify(tool.input),
        status: "completed",
      }
    : {
        type: "message",
        id: "msg_coding",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      }
  const values = [
    { type: "response.created", response: { id: "resp_coding_wire", status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: tool ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" },
    },
    ...(tool
      ? [
          {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: 0,
            delta: JSON.stringify(tool.input),
          },
          {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: 0,
            arguments: JSON.stringify(tool.input),
          },
        ]
      : [{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text }]),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_coding_wire",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]
  return values
    .map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
    .join("")
}
