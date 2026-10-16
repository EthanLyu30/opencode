import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Layer } from "effect"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { WorkflowVisualBuild } from "@opencode-ai/schema/workflow-visual-build"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Workflow } from "@opencode-ai/schema/workflow"
import { CodingAdmissionReceipt } from "../src/workflow/coding/admission-receipt"
import { CodingHostPlan } from "../src/workflow/coding/host-plan"
import { WorkflowBenchmarkTransport } from "../src/workflow/benchmark-transport"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { makeGlobalNode } from "../src/effect/app-node"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { ProjectV2 } from "../src/project"
import { WorkflowAdmission } from "../src/workflow/admission"
import { CodingAdmission } from "../src/workflow/coding/admission"
import { CodingAuthority } from "../src/workflow/coding/authority"
import { CodingModelSelection } from "../src/workflow/coding/model-selection"
import { WorkflowExecution } from "../src/workflow/execution"
import { WorkflowStore } from "../src/workflow/store"
import { WorkflowRunTable } from "../src/workflow/sql"
import { ModelSelection } from "../src/workflow/model-selection"
import { ResponseTable } from "../src/responses/sql"
import { ResponsesStore } from "../src/responses/store"
import { SessionTable } from "../src/session/sql"
import { SessionStore } from "../src/session/store"
import { fixtureAdmissionSnapshot } from "./fixtures/workflow-model-catalog"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const counts = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return [
    (yield* db.select().from(WorkflowRunTable).all().pipe(Effect.orDie)).length,
    (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).length,
    (yield* db.select().from(ResponseTable).all().pipe(Effect.orDie)).length,
  ]
})
let wakes = 0
let failWake = false
let snapshots = 0
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      CodingAdmission.node,
      WorkflowAdmission.node,
      CodingAuthority.node,
      WorkflowStore.node,
      ResponsesStore.node,
      SessionStore.node,
      EventV2.node,
      Database.node,
    ]),
    [
      [
        WorkflowExecution.node,
        makeGlobalNode({
          service: WorkflowExecution.Service,
          layer: Layer.effect(
            WorkflowExecution.Service,
            Effect.gen(function* () {
              const database = yield* Database.Service
              return WorkflowExecution.Service.of({
                wake: Effect.gen(function* () {
                  expect(yield* counts.pipe(Effect.provideService(Database.Service, database))).toEqual([1, 1, 1])
                  wakes++
                  if (failWake) return yield* Effect.die(new Error("post-commit wake crash"))
                }),
                interrupt: () => Effect.void,
                active: Effect.succeed(new Set<Workflow.ID>()),
              })
            }),
          ),
          deps: [Database.node],
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
              snapshots++
              return fixtureAdmissionSnapshot()
            }),
        }),
      ],
      [CodingAuthority.node, CodingAdmission.authorityNode],
    ],
  ),
)
const request = (delivery: "foreground" | "background" = "background") =>
  WorkflowCodingBuild.CreateInput.make({
    prompt: "Fix a library, not a page",
    delivery,
    checks: { cwd: ".", test: "bun-test" },
    coding: { maxRevisions: 1, maxTokens: 12000, maxTurns: 12, maxToolCalls: 24 },
    budget: { maxTokens: 20000, maxTurns: 20, maxToolCalls: 40, maxAttempts: 27 },
  })
const workspace = () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (value) => Effect.promise(() => value[Symbol.asyncDispose]()))
const locationOf = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })

describe("Coding durable admission", () => {
  it.effect(
    "historical coding receipt decoding preserves expired transport identity without granting live execution",
    () =>
      Effect.gen(function* () {
        const root = yield* workspace()
        const location = locationOf(root.path)
        const binding = WorkflowBenchmarkTransport.freezeProfile({
          authority: "server",
          profile: {
            schemaVersion: 1,
            campaignID: "coding-history",
            runID: "coding-history-run",
            brokerOrigin: "http://127.0.0.1:43119",
            providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
            evidenceMode: "production",
            expiresAt: 2000,
            grant: "owned-offline-history-grant-not-real",
          },
          expectedCampaignID: "coding-history",
          expectedRunID: "coding-history-run",
          now: 1000,
        })
        const claim = "opencode.workflow.visual-build.admission-claim.v1:" + "a".repeat(64)
        const ids = CodingAdmissionReceipt.identities(claim)
        const selection = CodingModelSelection.freeze(fixtureAdmissionSnapshot(), location)
        const hostPlan = CodingHostPlan.freeze({ authority: "admission", location, checks: request().checks })
        const envelope = {
          type: CodingAdmissionReceipt.KIND,
          receipt: {
            kind: CodingAdmissionReceipt.KIND,
            requestHash: claim,
            request: request(),
            location,
            selection,
            hostPlan,
            ...ids,
            agent: "build",
            graph: CodingAdmissionReceipt.graph(claim, 1, ids.responseID),
            benchmarkTransport: binding,
          },
        }
        expect(() => CodingAdmissionReceipt.decode(envelope)).not.toThrow()
        expect(() =>
          WorkflowBenchmarkTransport.fromWorkflow({
            ...Workflow.Info.make({
              id: ids.workflowID,
              type: "coding-build",
              status: "running",
              input: {},
              budget: {},
              usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
              version: 1,
              time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
            }),
            input: { [WorkflowBenchmarkTransport.RESERVED_INPUT_KEY]: binding },
          }),
        ).toThrow(/expired/i)
        const fresh = WorkflowBenchmarkTransport.freezeProfile({
          authority: "server",
          profile: {
            schemaVersion: 1,
            campaignID: "coding-fresh",
            runID: "coding-fresh-run",
            brokerOrigin: "http://127.0.0.1:43119",
            providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
            evidenceMode: "production",
            expiresAt: Date.now() + 60000,
            grant: "owned-offline-fresh-grant-not-real",
          },
          expectedCampaignID: "coding-fresh",
          expectedRunID: "coding-fresh-run",
        })
        const admitted = Workflow.Info.make({
          id: ids.workflowID,
          type: "coding-build",
          status: "running",
          input: { [WorkflowBenchmarkTransport.RESERVED_INPUT_KEY]: fresh },
          budget: {},
          usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
          version: 1,
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        })
        expect(WorkflowBenchmarkTransport.fromWorkflow(admitted)).toEqual(fresh)
        expect(() => WorkflowBenchmarkTransport.fromWorkflow({ ...admitted, type: "arbitrary" })).toThrow()
      }),
  )
  for (const delivery of ["foreground", "background"] as const)
    it.effect(`atomically admits no-page ${delivery} resources before advisory wake`, () =>
      Effect.gen(function* () {
        const root = yield* workspace()
        const admission = yield* CodingAdmission.Service
        const authority = yield* CodingAuthority.Service
        const store = yield* WorkflowStore.Service
        wakes = 0
        const value = yield* admission.admit(request(delivery), locationOf(root.path), `coding-${delivery}`)
        expect(value.workflow.type).toBe("coding-build")
        expect(value.response.background).toBe(delivery === "background")
        expect(value.response.workflowID).toBe(value.workflow.id)
        expect(wakes).toBe(1)
        const detail = yield* store.get(value.workflow.id)
        expect(detail!.stages).toHaveLength(9)
        expect(detail!.stages.every((stage) => stage.maxAttempts === 3)).toBe(true)
        expect(detail!.stages.map((stage) => stage.type)).toEqual([
          "design",
          "decompose",
          "implement",
          "test",
          "code_review",
          "repair",
          "test",
          "code_review",
          "deliver",
        ])
        yield* authority.require(value.workflow)
        expect(yield* counts).toEqual([1, 1, 1])
      }),
    )
  it.effect("exact retry reuses pinned resources without model reselection; changed checks or kind conflict", () =>
    Effect.gen(function* () {
      const root = yield* workspace()
      const admission = yield* CodingAdmission.Service
      const visual = yield* WorkflowAdmission.Service
      const location = locationOf(root.path)
      snapshots = 0
      const first = yield* admission.admit(request(), location, "shared-kind-key")
      const second = yield* admission.admit(request(), location, "shared-kind-key")
      expect(second).toEqual(first)
      expect(snapshots).toBe(1)
      expect(CodingModelSelection.fromWorkflow(second.workflow).sha256).toBe(
        CodingModelSelection.fromWorkflow(first.workflow).sha256,
      )
      const changed = yield* admission
        .admit({ ...request(), checks: { cwd: ".", test: "bun-run-test" } }, location, "shared-kind-key")
        .pipe(Effect.flip)
      expect(changed._tag).toBe("Workflow.ConflictError")
      const otherKind = yield* visual
        .admitVisualBuild(
          WorkflowVisualBuild.CreateInput.make({
            prompt: "Build page",
            delivery: "background",
            budget: request().budget,
            visual: request().coding,
            preview: { kind: "static", entrypoint: "index.html" },
          }),
          location,
          "shared-kind-key",
        )
        .pipe(Effect.flip)
      expect(otherKind._tag).toBe("Workflow.ConflictError")
      expect(yield* counts).toEqual([1, 1, 1])
    }),
  )
  it.effect("projection failure rolls back Session, Response and Workflow with no wake", () =>
    Effect.gen(function* () {
      const root = yield* workspace()
      const events = yield* EventV2.Service
      const admission = yield* CodingAdmission.Service
      wakes = 0
      yield* events.project(WorkflowEvent.Created, () => Effect.die(new Error("rollback fixture")))
      const result = yield* admission.admit(request(), locationOf(root.path), "coding-rollback").pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* counts).toEqual([0, 0, 0])
      expect(wakes).toBe(0)
    }),
  )
  it.effect("post-commit wake crash is recovered by exact retry without duplicate resources", () =>
    Effect.gen(function* () {
      const root = yield* workspace()
      const admission = yield* CodingAdmission.Service
      const location = locationOf(root.path)
      failWake = true
      const first = yield* admission.admit(request(), location, "coding-wake-crash").pipe(Effect.exit)
      failWake = false
      expect(Exit.isFailure(first)).toBe(true)
      const retry = yield* admission.admit(request(), location, "coding-wake-crash")
      expect(retry.workflow.type).toBe("coding-build")
      expect(yield* counts).toEqual([1, 1, 1])
    }),
  )
  it.effect("unknown public fields, traversal and forged durable input are rejected", () =>
    Effect.gen(function* () {
      const root = yield* workspace()
      const admission = yield* CodingAdmission.Service
      const authority = yield* CodingAuthority.Service
      const location = locationOf(root.path)
      const invalid = yield* admission
        .admit({ ...request(), checks: { cwd: "../outside", test: "bun-test" } }, location, "coding-traversal")
        .pipe(Effect.exit)
      expect(Exit.isFailure(invalid)).toBe(true)
      const extra = yield* admission
        .admit({ ...request(), model: "caller-choice" } as WorkflowCodingBuild.CreateInput, location, "coding-extra")
        .pipe(Effect.exit)
      expect(Exit.isFailure(extra)).toBe(true)
      expect(yield* counts).toEqual([0, 0, 0])
      const valid = yield* admission.admit(request(), location, "coding-authority")
      const forged = yield* authority
        .require({ ...valid.workflow, input: { ...valid.workflow.input, prompt: "other request" } })
        .pipe(Effect.exit)
      expect(Exit.isFailure(forged)).toBe(true)
      const budgetIncrease = { ...valid.workflow, budget: { ...valid.workflow.budget, maxTokens: 30000 } }
      yield* authority.require(budgetIncrease)
    }),
  )
})
