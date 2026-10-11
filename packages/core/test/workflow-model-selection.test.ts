import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { WorkflowVisualBuild } from "@opencode-ai/schema/workflow-visual-build"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { WorkflowAdmission } from "../src/workflow/admission"
import { WorkflowStore } from "../src/workflow/store"
import { WorkflowExecution } from "../src/workflow/execution"
import { ProjectV2 } from "../src/project"
import { ResponsesStore } from "../src/responses/store"
import { ResponsesAdmission } from "../src/responses/admission"
import { WorkflowRoleContract } from "../src/workflow/execution/contract"
import { WorkflowRoleExecution } from "../src/workflow/execution/role"
import { WorkflowV2 } from "../src/workflow"
import { WorkflowExecutor } from "../src/workflow/executor"
import { WorkflowModelExecution } from "../src/workflow/execution/model"
import { WorkflowExecutionLocal } from "../src/workflow/execution/local"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Session } from "@opencode-ai/schema/session"
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { ModelSelection } from "../src/workflow/model-selection"
import { ModelAvailability } from "../src/workflow/model-availability"
import { WorkflowRouting } from "../src/workflow/routing"
import { WorkflowBusinessArtifact } from "../src/workflow/artifacts/business"
import { WorkflowModelCatalogPolicy } from "../src/workflow/model-catalog/policy"
import { fixtureCatalogue } from "./fixtures/workflow-model-catalog"

const location = Location.Ref.make({ directory: AbsolutePath.make("D:/offline-model-selection") })
function snapshot(successor = false): WorkflowModelCatalog.AdmissionSnapshot {
  const catalogue = fixtureCatalogue()
  const routes = Object.fromEntries(
    WorkflowRole.Role.literals.map((role) => {
      const rule = WorkflowModelCatalogPolicy.requirements[role]
      const entry = catalogue.models.find((entry) => entry.family === rule.family)!
      return [
        role,
        {
          providerID: entry.providerID,
          modelID: successor ? `${entry.modelID}-successor-fixture` : entry.modelID,
          protocol: rule.protocol,
          reasoningEffort: rule.reasoningEffort,
          requiredCapabilities: [...rule.capabilities],
          adapterProfileID: entry.adapterProfileID!,
          adapterProfileSha256: entry.adapterProfileSha256!,
          priceSha256: entry.priceSha256!,
          advertisedRevision: entry.advertisedRevision,
        },
      ]
    }),
  )
  const value = {
    schemaVersion: 1 as const,
    catalogueSha256: catalogue.sha256,
    policySha256: "d".repeat(64),
    scopeSha256: catalogue.scopeSha256,
    routes,
  }
  return Schema.decodeUnknownSync(WorkflowModelCatalog.AdmissionSnapshot)({
    ...value,
    sha256: WorkflowBusinessArtifact.hash(value),
  })
}
const workflow = (selection: ModelSelection.FrozenSelection, owner = location) =>
  Workflow.Info.make({
    id: Workflow.ID.create(),
    type: "visual-build",
    status: "queued",
    input: { [ModelSelection.RESERVED_INPUT_KEY]: selection },
    budget: {},
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
    location: owner,
    version: 0,
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  })
let activeSnapshot: WorkflowModelCatalog.AdmissionSnapshot | undefined = snapshot()
let modelAvailable = false
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, WorkflowAdmission.node, WorkflowStore.node, ResponsesStore.node]),
    [
      [
        ModelSelection.node,
        Layer.succeed(ModelSelection.Service, { snapshot: () => Effect.sync(() => activeSnapshot) }),
      ],
      [
        WorkflowExecution.node,
        Layer.succeed(
          WorkflowExecution.Service,
          WorkflowExecution.Service.of({
            wake: Effect.void,
            interrupt: () => Effect.void,
            active: Effect.succeed(new Set()),
          }),
        ),
      ],
      [
        ProjectV2.node,
        Layer.succeed(ProjectV2.Service, {
          resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
          directories: () => Effect.succeed([]),
          commit: () => Effect.void,
        }),
      ],
    ],
  ),
)
const gateIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, WorkflowV2.node, WorkflowStore.node, WorkflowAdmission.node]),
    [
      [
        WorkflowExecution.node,
        WorkflowExecutionLocal.nodeWith({
          ownerID: "offline-model-gate",
          leaseDurationMs: 5000,
          heartbeatIntervalMs: 1000,
          pollIntervalMs: 5,
          concurrency: 1,
        }),
      ],
      [
        WorkflowExecutor.node,
        Layer.succeed(WorkflowExecutor.Service, {
          execute: () =>
            modelAvailable
              ? Effect.never
              : Effect.fail({
                  failure: {
                    category: "invalid_request",
                    code: "model_unavailable",
                    message: "Pinned model unavailable",
                  },
                  usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
                }),
        }),
      ],
      [WorkflowModelExecution.node, WorkflowModelExecution.emptyLayer],
      [
        ModelSelection.node,
        Layer.succeed(ModelSelection.Service, { snapshot: () => Effect.sync(() => activeSnapshot) }),
      ],
      [
        ModelAvailability.node,
        Layer.succeed(ModelAvailability.Service, {
          check: (selection) =>
            ModelAvailability.checkCatalogue(
              selection,
              fixtureCatalogue({
                models: fixtureCatalogue().models.map((entry) => ({
                  ...entry,
                  availability: modelAvailable ? "available" : "missing",
                })),
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
    ],
  ),
)

describe("durable model selection", () => {
  test("closing and reopening the durable database restores P1 delivery after P2 selection", async () => {
    await using root = await tmpdir()
    await Bun.write(path.join(root.path, "index.html"), "<!doctype html><title>restart</title>")
    const owner = Location.Ref.make({ directory: AbsolutePath.make(root.path) })
    const request = {
      prompt: "durable restart fixture",
      budget: {},
      visual: { maxRevisions: 0, maxTokens: 1000, maxTurns: 10, maxToolCalls: 10 },
      preview: { kind: "static" as const, entrypoint: "index.html" },
      delivery: "background" as const,
    }
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>, selected: WorkflowModelCatalog.AdmissionSnapshot) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([WorkflowAdmission.node, WorkflowStore.node, ResponsesStore.node]), [
              [Database.node, Database.layerFromPath(path.join(root.path, "selection.sqlite"))],
              [
                ModelSelection.node,
                Layer.succeed(ModelSelection.Service, { snapshot: () => Effect.succeed(selected) }),
              ],
              [
                WorkflowExecution.node,
                Layer.succeed(
                  WorkflowExecution.Service,
                  WorkflowExecution.Service.of({
                    wake: Effect.void,
                    interrupt: () => Effect.void,
                    active: Effect.succeed(new Set()),
                  }),
                ),
              ],
              [
                ProjectV2.node,
                Layer.succeed(ProjectV2.Service, {
                  resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
                  directories: () => Effect.succeed([]),
                  commit: () => Effect.void,
                }),
              ],
            ]),
          ),
          Effect.scoped,
        ) as Effect.Effect<A, E>,
      )
    const first = await run(
      Effect.gen(function* () {
        const admission = yield* WorkflowAdmission.Service
        return yield* admission.admitVisualBuild(request, owner, "durable-p1-restart")
      }),
      snapshot(),
    )
    const recovered = await run(
      Effect.gen(function* () {
        const admission = yield* WorkflowAdmission.Service
        const workflows = yield* WorkflowStore.Service
        const responses = yield* ResponsesStore.Service
        const retry = yield* admission.admitVisualBuild(request, owner, "durable-p1-restart")
        const detail = (yield* workflows.get(first.workflow.id))!
        const receipt = ResponsesAdmission.decodeVisualBuildReceipt(
          (yield* responses.items(first.response.id, "context"))[0].payload,
        )
        const route = WorkflowRouting.resolve({
          role: "deliver",
          budget: detail.run.budget,
          selection: ModelSelection.fromWorkflow(detail.run),
        })
        return { retry, receipt, modelID: WorkflowRouting.forResponseModel(route, retry.response.model).modelID }
      }),
      snapshot(true),
    )
    expect(recovered.retry.response.id).toBe(first.response.id)
    expect(recovered.modelID).toBe("deepseek-v4-pro")
    expect(recovered.receipt.schemaVersion).toBe(2)
    expect(ModelSelection.fromWorkflow(recovered.retry.workflow).sha256).toBe(
      ModelSelection.fromWorkflow(first.workflow).sha256,
    )
  })
  gateIt.live("normal create cannot inject an internal frozen selection", () =>
    Effect.gen(function* () {
      const service = yield* WorkflowV2.Service
      const selected = ModelSelection.freeze(snapshot(), location)
      const attempted = yield* service
        .create({
          type: "caller-forged-pin",
          input: { [ModelSelection.RESERVED_INPUT_KEY]: selected },
          budget: {},
          stages: [
            {
              type: "design",
              ordinal: 0,
              maxAttempts: 1,
              recoveryPolicy: "manual_required",
              idempotencyKey: "forged-pin",
              input: {},
            },
          ],
        })
        .pipe(Effect.flip)
      expect(attempted._tag).toBe("Workflow.ConflictError")
    }),
  )
  gateIt.live("unavailable is a fenced configuration approval, not ambiguous work or an automatic retry", () =>
    Effect.gen(function* () {
      modelAvailable = false
      const service = yield* WorkflowV2.Service
      const run = yield* service.admit({
        type: "offline-config-gate",
        input: {},
        budget: {},
        location,
        sessionID: Session.ID.create(),
        agent: Agent.ID.make("build"),
        stages: [
          {
            type: "design",
            ordinal: 0,
            maxAttempts: 1,
            recoveryPolicy: "manual_required",
            idempotencyKey: "offline-model-gate",
            input: {},
          },
        ],
      })
      const approval = yield* service.events({ workflowID: run.id }).pipe(
        Stream.filter((event) => event.type === "workflow.approval.requested"),
        Stream.runHead,
        Effect.timeout("2 seconds"),
      )
      expect(approval._tag).toBe("Some")
      if (approval._tag === "Some")
        expect(approval.value.data).toMatchObject({
          reason: "workflow_model_required",
          failure: { code: "model_unavailable", category: "invalid_request" },
          leaseFence: { variant: "live_execution" },
        })
      const detail = yield* service.get(run.id)
      expect(detail.run.status).toBe("waiting_approval")
      expect(detail.stages[0].status).toBe("waiting_approval")
      expect(detail.run.usage.tokens).toBe(0)
      expect(detail.run.usage.turns).toBe(0)
    }),
  )
  gateIt.live("configuration recovery requires the original available pin and cancellation wins", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => Bun.write(`${root.path}/index.html`, "<!doctype html><title>pin</title>"))
      const service = yield* WorkflowV2.Service
      const admission = yield* WorkflowAdmission.Service
      activeSnapshot = snapshot()
      modelAvailable = false
      const first = yield* admission.admitVisualBuild(
        {
          prompt: "offline pinned recovery",
          budget: { maxAttempts: 3 },
          visual: { maxRevisions: 0, maxTokens: 1000, maxTurns: 10, maxToolCalls: 10 },
          preview: { kind: "static", entrypoint: "index.html" },
          delivery: "background",
        },
        Location.Ref.make({ directory: AbsolutePath.make(root.path) }),
        "pinned-config-recovery",
      )
      yield* service.events({ workflowID: first.workflow.id }).pipe(
        Stream.filter((event) => event.type === "workflow.approval.requested"),
        Stream.runHead,
        Effect.timeout("2 seconds"),
      )
      const detail = yield* service.get(first.workflow.id)
      activeSnapshot = snapshot(true)
      const recovery = { workflowID: first.workflow.id, stageID: detail.stages[0].id, action: "retry" as const }
      const blocked = yield* service.resolveRecovery(recovery).pipe(Effect.flip)
      expect(blocked._tag).toBe("Workflow.ConflictError")
      modelAvailable = true
      yield* service.resolveRecovery(recovery)
      yield* service.events({ workflowID: first.workflow.id }).pipe(
        Stream.filter((event) => event.type === "workflow.stage.started" && event.data.attempt === 2),
        Stream.runHead,
        Effect.timeout("2 seconds"),
      )
      const resumed = yield* service.get(first.workflow.id)
      expect(ModelSelection.fromWorkflow(resumed.run).sha256).toBe(ModelSelection.fromWorkflow(first.workflow).sha256)
      expect(resumed.stages[0].attempt).toBe(2)
      yield* service.cancel(first.workflow.id)
      yield* service.events({ workflowID: first.workflow.id }).pipe(
        Stream.filter((event) => event.type === "workflow.cancelled"),
        Stream.runHead,
        Effect.timeout("2 seconds"),
      )
      expect((yield* service.get(first.workflow.id)).run.status).toBe("cancelled")
    }),
  )
  it.effect("a retained V1 receipt is byte-identical on exact retry after enabling catalogue defaults", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => Bun.write(`${root.path}/index.html`, "<!doctype html><title>legacy</title>"))
      const admission = yield* WorkflowAdmission.Service
      const responses = yield* ResponsesStore.Service
      const owner = Location.Ref.make({ directory: AbsolutePath.make(root.path) })
      const request = {
        prompt: "legacy receipt fixture",
        budget: {},
        visual: { maxRevisions: 0, maxTokens: 1000, maxTurns: 10, maxToolCalls: 10 },
        preview: { kind: "static" as const, entrypoint: "index.html" },
        delivery: "background" as const,
      }
      activeSnapshot = undefined
      const first = yield* admission.admitVisualBuild(request, owner, "legacy-fixed-retry")
      const original = (yield* responses.items(first.response.id, "context"))[0].payload
      const originalHash = WorkflowBusinessArtifact.hash(original)
      activeSnapshot = snapshot(true)
      expect((yield* admission.admitVisualBuild(request, owner, "legacy-fixed-retry")).response.model).toBe(
        "deepseek-v4-pro",
      )
      const after = (yield* responses.items(first.response.id, "context"))[0].payload
      expect(WorkflowBusinessArtifact.hash(after)).toBe(originalHash)
      expect(ResponsesAdmission.decodeVisualBuildReceipt(after).schemaVersion).toBe(1)
    }),
  )
  it.effect("durable exact retries reuse P1 while a new admission uses P2 and V2 authorities", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
      )
      const owner = Location.Ref.make({ directory: AbsolutePath.make(root.path) })
      yield* Effect.promise(() =>
        Bun.write(`${root.path}/index.html`, "<!doctype html><title>offline selection</title>"),
      )
      const admission = yield* WorkflowAdmission.Service
      const responses = yield* ResponsesStore.Service
      const store = yield* WorkflowStore.Service
      const request = WorkflowVisualBuild.CreateInput.make({
        prompt: "offline fixture",
        budget: {},
        visual: { maxRevisions: 0, maxTokens: 1000, maxTurns: 10, maxToolCalls: 10 },
        preview: { kind: "static", entrypoint: "index.html" },
        delivery: "background",
      })
      activeSnapshot = snapshot()
      const first = yield* admission.admitVisualBuild(request, owner, "frozen-selection-first")
      activeSnapshot = snapshot(true)
      const retry = yield* admission.admitVisualBuild(request, owner, "frozen-selection-first")
      expect(retry.response.id).toBe(first.response.id)
      expect(retry.response.model).toBe("deepseek-v4-pro")
      const second = yield* admission.admitVisualBuild(request, owner, "frozen-selection-second")
      expect(second.response.model).toBe("deepseek-v4-pro-successor-fixture")
      const receipts = yield* responses.items(second.response.id, "context")
      const receipt = ResponsesAdmission.decodeVisualBuildReceipt(receipts[0].payload)
      expect(receipt.schemaVersion).toBe(2)
      expect(ModelSelection.fromWorkflow(second.workflow).snapshot.routes.deliver.modelID).toBe(second.response.model)
      const detail = (yield* store.get(second.workflow.id))!
      const route = WorkflowRouting.resolve({
        role: "design",
        budget: {},
        selection: ModelSelection.fromWorkflow(detail.run),
      })
      const contract = WorkflowRoleContract.build({
        workflow: detail.run,
        stage: detail.stages[0],
        route,
        priorArtifacts: [],
      })
      expect(contract.authority.authorityVersion).toBe(2)
      expect("modelSelectionSha256" in contract.authority ? contract.authority.modelSelectionSha256 : undefined).toBe(
        ModelSelection.fromWorkflow(detail.run).sha256,
      )
      WorkflowRoleContract.verifyAuthority({
        authority: contract.authority,
        workflow: detail.run,
        stage: detail.stages[0],
        priorArtifacts: [],
      })
      expect(() =>
        Schema.decodeUnknownSync(WorkflowRoleExecution.Receipt)({
          receiptVersion: 1,
          workflowID: detail.run.id,
          stageID: detail.stages[0].id,
          role: "design",
          revision: 0,
          contractFingerprint: contract.contractFingerprint,
          contextDigest: contract.contextDigest,
          requiredArtifactSetSha256: "a".repeat(64),
          outcomeSha256: "a".repeat(64),
          authority: contract.authority,
        }),
      ).toThrow()
    }),
  )
  test("a frozen future admission keeps its exact delivery and role contracts", () => {
    const admitted = snapshot(true)
    const selection = ModelSelection.freeze(admitted, location)
    for (const role of WorkflowRole.Role.literals) {
      const route = WorkflowRouting.resolve({ role, budget: {}, selection })
      expect(route.modelID).toBe(admitted.routes[role].modelID)
      expect(route.reasoningEffort).toBe(admitted.routes[role].reasoningEffort)
      expect(String(route.model.id)).toBe(admitted.routes[role].modelID)
    }
    expect(Object.isFrozen(selection.snapshot.routes.deliver)).toBe(true)
    const restored = ModelSelection.fromWorkflow(workflow(JSON.parse(JSON.stringify(selection))))
    expect(restored.sha256).toBe(selection.sha256)
    const delivered = WorkflowRouting.forResponseModel(
      WorkflowRouting.resolve({ role: "deliver", budget: {}, selection: restored }),
      admitted.routes.deliver.modelID,
    )
    expect(String(delivered.model.id)).toBe(admitted.routes.deliver.modelID)
    expect(() => WorkflowRouting.forResponseModel(delivered, "deepseek-v4-pro")).toThrow()
  })
  test("no selection retains the historical legacy route, not the current catalogue", () => {
    ModelSelection.freeze(snapshot(true), location)
    expect(WorkflowRouting.resolve({ role: "deliver", budget: {} }).modelID).toBe("deepseek-v4-pro")
  })
  test("hash, owner and nested contract tampering fail closed", () => {
    const selection = ModelSelection.freeze(snapshot(), location)
    const owner = Location.Ref.make({ directory: AbsolutePath.make("D:/other-owner") })
    expect(() => ModelSelection.fromWorkflow(workflow(selection, owner))).toThrow()
    for (const patch of [
      { modelID: "other-fixture" },
      { adapterProfileSha256: "f".repeat(64) },
      { priceSha256: "f".repeat(64) },
    ]) {
      const mutated = {
        ...selection,
        snapshot: {
          ...selection.snapshot,
          routes: { ...selection.snapshot.routes, deliver: { ...selection.snapshot.routes.deliver, ...patch } },
        },
      }
      expect(() => ModelSelection.fromWorkflow(workflow(mutated))).toThrow()
    }
    const invalidRole = snapshot()
    const value = {
      ...invalidRole,
      routes: { ...invalidRole.routes, deliver: { ...invalidRole.routes.deliver, reasoningEffort: "max" as const } },
    }
    const { sha256: _, ...content } = value
    expect(() =>
      ModelSelection.freeze({ ...content, sha256: WorkflowBusinessArtifact.hash(content) }, location),
    ).toThrow()
  })
  test("availability never changes retired pins and detects absence or contract/price drift", async () => {
    const selection = ModelSelection.freeze(snapshot(), location)
    const catalogue = fixtureCatalogue({
      models: fixtureCatalogue().models.map((entry) => ({ ...entry, lifecycle: "superseded" as const })),
    })
    const check = (value: WorkflowModelCatalog.Catalogue) =>
      Effect.runPromise(ModelAvailability.checkCatalogue(selection, value))
    await check(catalogue)
    for (const change of [
      { availability: "missing" as const },
      { priceSha256: "f".repeat(64) },
      { advertisedRevision: "drift-fixture" },
    ]) {
      await expect(
        check(
          fixtureCatalogue({
            models: catalogue.models.map((entry) =>
              entry.providerID === "deepseek" ? { ...entry, ...change } : entry,
            ),
          }),
        ),
      ).rejects.toThrow()
    }
    expect(selection.snapshot.routes.deliver.modelID).toBe("deepseek-v4-pro")
  })
})
