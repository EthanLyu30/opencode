import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Option, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventTable } from "@opencode-ai/core/event/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowModelExecution } from "@opencode-ai/core/workflow/execution/model"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowStageTable } from "@opencode-ai/core/workflow/sql"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { ResponsesProjector } from "@opencode-ai/core/responses/projector"
import { ResponsesStore } from "@opencode-ai/core/responses/store"
import { WorkflowStageMachine } from "@opencode-ai/core/workflow/stage-machine"
import { WorkflowRoleContract } from "@opencode-ai/core/workflow/execution/contract"
import { WorkflowRoleExecution } from "@opencode-ai/core/workflow/execution/role"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { WorkflowGraph } from "@opencode-ai/core/workflow/graph"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"
import { WorkflowVisualEvidence } from "@opencode-ai/core/workflow/visual-evidence"
import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Session } from "@opencode-ai/schema/session"
import { Agent } from "@opencode-ai/schema/agent"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      WorkflowV2.node,
      WorkflowStore.node,
      WorkflowExecutor.node,
      ResponsesProjector.node,
      ResponsesStore.node,
      ResponsesV2.node,
    ]),
    [[WorkflowModelExecution.node, WorkflowModelExecution.emptyLayer]],
  ),
)

const successfulExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) =>
      Effect.succeed({
        checkpoint: { completed: stage.type },
        usage: { tokens: 120, turns: 1, toolCalls: 0, attempts: 0 },
        artifacts: [
          {
            kind: "result",
            uri: `artifact://${stage.workflowID}/result.json`,
            mime: "application/json",
            sha256: "a".repeat(64),
            size: 2,
            metadata: {},
          },
        ],
      }),
  }),
)

const workerOptions: WorkflowExecutionLocal.Options = {
  ownerID: "worker-test",
  leaseDurationMs: 5_000,
  heartbeatIntervalMs: 1_000,
  pollIntervalMs: 5,
  concurrency: 1,
}

const makeWorkerIt = (
  executor: Layer.Layer<WorkflowExecutor.Service>,
  options: WorkflowExecutionLocal.Options = workerOptions,
) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        EventV2.node,
        WorkflowV2.node,
        WorkflowStore.node,
        WorkflowExecutor.node,
        WorkflowExecution.node,
        ResponsesProjector.node,
        ResponsesStore.node,
        ResponsesV2.node,
      ]),
      [
        [WorkflowExecution.node, WorkflowExecutionLocal.nodeWith(options)],
        [WorkflowExecutor.node, executor],
      ],
    ),
  )

const workerIt = makeWorkerIt(successfulExecutor)

const durableEvidenceOrder: string[] = []
const reconciledEvidence: WorkflowVisualHost.ReconcileEvidenceInput[] = []
const durableEvidenceExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) => {
      const viewport = { name: "desktop", width: 16, height: 16 }
      const bytes = WorkflowVisualHost.deterministicPng(viewport)
      const coordinates = {
        schemaVersion: 1 as const,
        workflowID: stage.workflowID,
        stageID: stage.id,
        kind: "implementation" as const,
        revision: 0,
        viewport,
        configSha256: "1".repeat(64),
        sourceSha256: "2".repeat(64),
        readySelectorSha256: "3".repeat(64),
      }
      const receipt = {
        evidenceID: WorkflowVisualEvidence.evidenceID(coordinates),
        coordinates,
        pngSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        width: viewport.width,
        height: viewport.height,
        evidenceBytes: bytes.byteLength,
      }
      return Effect.succeed({
        usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 },
        artifacts: [
          WorkflowVisualReviewArtifact.commitScreenshot(
            WorkflowVisualReviewArtifact.capturedImage({
              workflowID: stage.workflowID,
              kind: "implementation",
              viewport: viewport.name,
              revision: 0,
              bytes,
              evidenceReceipt: receipt,
            }),
          ),
        ],
      })
    },
  }),
)

const durableEvidenceHost = Layer.effect(
  WorkflowVisualHost.Service,
  Effect.gen(function* () {
    const workflows = yield* WorkflowStore.Service
    return WorkflowVisualHost.Service.of({
      materializeReference: () => Effect.die("unused"),
      prepareImplementation: () => Effect.die("unused"),
      capture: () => Effect.die("unused"),
      lookupEvidence: () => Effect.die("unused"),
      commitEvidence: ({ artifact }) =>
        Effect.gen(function* () {
          const projected = yield* workflows.get(artifact.workflowID)
          const exact = projected?.artifacts.filter((candidate) => candidate.id === artifact.id) ?? []
          if (exact.length !== 1 || exact[0].sha256 !== artifact.sha256) {
            return yield* Effect.die("commitEvidence ran before the exact EventV2 Artifact projection")
          }
          durableEvidenceOrder.push("eventv2-projected", "commit-crash")
          return yield* Effect.fail(
            new WorkflowVisualHost.Failure({
              operation: "commit_evidence",
              code: "visual_host_unavailable",
              message: "simulated crash after EventV2 projection",
            }),
          )
        }),
      releaseEvidence: () => Effect.die("release must not run after a failed commit"),
      abandonEvidence: () => Effect.die("unused"),
      reconcileEvidence: (input) =>
        Effect.sync(() => {
          if (input.committed.length > 0) {
            durableEvidenceOrder.push("reconcile")
            reconciledEvidence.push(input)
          }
          return { active: [], committed: [], released: [], abandoned: [], ambiguous: [] }
        }),
      recoverExpired: () => Effect.void,
    })
  }),
)

const durableEvidenceHostNode = makeGlobalNode({
  service: WorkflowVisualHost.Service,
  layer: durableEvidenceHost,
  deps: [WorkflowStore.node],
})

const durableEvidenceIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      WorkflowV2.node,
      WorkflowStore.node,
      WorkflowExecutor.node,
      WorkflowExecution.node,
      ResponsesProjector.node,
      ResponsesStore.node,
      ResponsesV2.node,
    ]),
    [
      [WorkflowExecution.node, WorkflowExecutionLocal.nodeWith(workerOptions)],
      [WorkflowExecutor.node, durableEvidenceExecutor],
      [WorkflowVisualHost.node, durableEvidenceHostNode],
    ],
  ),
)

const duplicateArtifactExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) =>
      Effect.succeed({
        usage: { tokens: 20, turns: 1, toolCalls: 0, attempts: 0 },
        artifacts: [
          {
            kind: "result",
            uri: `artifact://${stage.workflowID}/result.json`,
            mime: "application/json",
            sha256: "b".repeat(64),
            size: 2,
            metadata: {},
          },
          {
            kind: "result",
            uri: `artifact://${stage.workflowID}/result-copy.json`,
            mime: "application/json",
            sha256: "b".repeat(64),
            size: 2,
            metadata: {},
          },
        ],
      }),
  }),
)

const duplicateArtifactIt = makeWorkerIt(duplicateArtifactExecutor)

const checkpointGuardExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: (input) => {
      const checkpoint = input.workflow.id.includes("secret")
        ? { apiKey: "sk-checkpoint-secret-sentinel" }
        : { payload: "x".repeat(256 * 1024) }
      return input
        .saveCheckpoint(checkpoint)
        .pipe(Effect.andThen(Effect.succeed({ usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 } })))
    },
  }),
)

const checkpointGuardIt = makeWorkerIt(checkpointGuardExecutor)

const incompleteRoleHistoryExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) => {
      const metadata = { schemaVersion: 1, role: "design", verdict: "ready", revision: 0 }
      const body = JSON.stringify(metadata)
      return Effect.succeed({
        usage: { tokens: 8, turns: 1, toolCalls: 0, attempts: 0 },
        artifacts: [
          {
            kind: WorkflowStageMachine.OUTCOME_ARTIFACT_KIND,
            uri: `artifact://${stage.workflowID}/incomplete-role-outcome.json`,
            mime: WorkflowStageMachine.OUTCOME_ARTIFACT_MIME,
            sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
            size: new TextEncoder().encode(body).byteLength,
            metadata,
          },
        ],
      })
    },
  }),
)

const incompleteRoleHistoryIt = makeWorkerIt(incompleteRoleHistoryExecutor)

const invalidBranchOutcomeExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ workflow, stage }) => {
      if (stage.type !== "design") {
        return Effect.fail({
          failure: {
            category: "invalid_request" as const,
            code: "unexpected_followup_stage",
            message: "Invalid design outcome must stop before the next role stage",
          },
          usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 },
        })
      }
      const outcome = { schemaVersion: 1 as const, role: "design" as const, verdict: "ready" as const, revision: 0 }
      const contract = WorkflowRoleContract.build({
        workflow,
        stage,
        route: WorkflowRouting.resolve({ role: "design", budget: workflow.budget }),
        priorArtifacts: [],
      })
      const authority = { ...contract.authority, promptVersion: "workflow-role/forged@1" }
      const contractFingerprint = WorkflowRoleContract.fingerprintAuthority(authority)
      const binding = WorkflowStageMachine.OutcomeBinding.make({
        bindingVersion: 1,
        outcome,
        contractFingerprint,
        contextDigest: contract.contextDigest,
        requiredArtifactSetSha256: WorkflowRoleExecution.artifactSetDigest([]),
      })
      const body = WorkflowStageMachine.encodeOutcome(binding)
      const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
      return Effect.succeed({
        usage: { tokens: 2, turns: 1, toolCalls: 0, attempts: 0 },
        artifacts: [
          {
            kind: WorkflowStageMachine.OUTCOME_ARTIFACT_KIND,
            uri: `workflow://${stage.workflowID}/stages/${stage.id}/role-outcome.json`,
            mime: WorkflowStageMachine.OUTCOME_ARTIFACT_MIME,
            sha256,
            size: new TextEncoder().encode(body).byteLength,
            metadata: binding,
          },
        ],
        roleReceipt: WorkflowRoleExecution.Receipt.make({
          receiptVersion: 1,
          workflowID: workflow.id,
          stageID: stage.id,
          role: "design",
          revision: 0,
          contractFingerprint,
          contextDigest: contract.contextDigest,
          requiredArtifactSetSha256: WorkflowRoleExecution.artifactSetDigest([]),
          outcomeSha256: sha256,
          authority,
        }),
      })
    },
  }),
)

const invalidBranchOutcomeIt = makeWorkerIt(invalidBranchOutcomeExecutor)

const branchOutcomeExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) => {
      const revision =
        stage.type === "deliver" ? 1 : typeof stage.input.revision === "number" ? stage.input.revision : 0
      const verdict =
        stage.type === "test"
          ? revision === 0
            ? "revise"
            : "pass"
          : stage.type === "visual_review"
            ? "pass"
            : stage.type === "deliver"
              ? "complete"
              : "ready"
      const metadata = { schemaVersion: 1 as const, role: stage.type, verdict, revision }
      const body = JSON.stringify(metadata)
      return Effect.succeed({
        usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 },
        artifacts: [
          {
            kind: WorkflowStageMachine.OUTCOME_ARTIFACT_KIND,
            uri: `workflow://${stage.workflowID}/stages/${stage.id}/role-outcome.json`,
            mime: WorkflowStageMachine.OUTCOME_ARTIFACT_MIME,
            sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
            size: new TextEncoder().encode(body).byteLength,
            metadata,
          },
        ],
        ...(stage.type === "deliver" && typeof stage.input.responseID === "string"
          ? {
              responseSettlement: {
                type: "completed" as const,
                responseID: Responses.ID.make(stage.input.responseID),
                output: [
                  {
                    type: "message" as const,
                    role: "assistant" as const,
                    content: "Visual build completed",
                  },
                ],
                store: true,
              },
            }
          : {}),
      })
    },
  }),
)

const branchOutcomeIt = makeWorkerIt(branchOutcomeExecutor)

const classifiedFailureExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) => {
      if (stage.attempt > 1) {
        return Effect.succeed({ usage: { tokens: 20, turns: 1, toolCalls: 0, attempts: 0 } })
      }
      return Effect.fail({
        failure: {
          category: "transient" as const,
          code: "rate_limit",
          message: "Bearer live-secret-token must wait",
          retryAfterMs: 0,
        },
        usage: { tokens: 10, turns: 1, toolCalls: 0, attempts: 0 },
      })
    },
  }),
)

const classifiedFailureIt = makeWorkerIt(classifiedFailureExecutor)

const permanentFailureExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: () =>
      Effect.fail({
        failure: { category: "authentication" as const, code: "invalid_key", message: "bad key" },
        usage: { tokens: 7, turns: 1, toolCalls: 0, attempts: 0 },
      }),
  }),
)

const permanentFailureIt = makeWorkerIt(permanentFailureExecutor)

const ambiguousFailureExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: () =>
      Effect.fail({
        failure: { category: "ambiguous" as const, code: "lost", message: "unknown result" },
        usage: { tokens: 5, turns: 1, toolCalls: 1, attempts: 0 },
      }),
  }),
)

const ambiguousFailureIt = makeWorkerIt(ambiguousFailureExecutor)

const deadlineProbe: { remainingDurationMs?: number } = {}
const deadlineExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: (input) =>
      Effect.sync(() => {
        deadlineProbe.remainingDurationMs = input.remainingDurationMs
      }).pipe(
        Effect.andThen(Effect.sleep(200)),
        Effect.as({ usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 } }),
      ),
  }),
)

const deadlineIt = makeWorkerIt(deadlineExecutor)

const slowExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: () => Effect.sleep(200).pipe(Effect.as({ usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 } })),
  }),
)

const leaseLossIt = makeWorkerIt(slowExecutor, {
  ownerID: "worker-lease-loss",
  leaseDurationMs: 5_000,
  heartbeatIntervalMs: 30,
  pollIntervalMs: 5,
  concurrency: 1,
})

const concurrencyProbe = { active: 0, max: 0 }
const concurrentExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: () =>
      Effect.sync(() => {
        concurrencyProbe.active += 1
        concurrencyProbe.max = Math.max(concurrencyProbe.max, concurrencyProbe.active)
      }).pipe(
        Effect.andThen(Effect.sleep(75)),
        Effect.ensuring(
          Effect.sync(() => {
            concurrencyProbe.active -= 1
          }),
        ),
        Effect.as({ usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 } }),
      ),
  }),
)

const concurrencyIt = makeWorkerIt(concurrentExecutor, {
  ...workerOptions,
  ownerID: "worker-concurrency",
  concurrency: 2,
})

const interruptIt = makeWorkerIt(slowExecutor, {
  ...workerOptions,
  ownerID: "worker-interrupt",
})

const waitForActive = Effect.fnUntraced(function* (
  execution: WorkflowExecution.Interface,
  workflowID: Workflow.ID,
  expected: boolean,
) {
  while ((yield* execution.active).has(workflowID) !== expected) {
    yield* Effect.sleep(10)
  }
})

const createInput = (suffix: string): Workflow.CreateInput => ({
  id: Workflow.ID.make(`wfl_${suffix}`),
  type: "development",
  input: { brief: `Build ${suffix}` },
  budget: { maxAttempts: 3 },
  stages: [
    {
      id: Workflow.StageID.make(`wfs_${suffix}`),
      type: "build",
      ordinal: 0,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe",
      idempotencyKey: `${suffix}/build`,
      input: {},
    },
  ],
})

const admit = (workflow: WorkflowV2.Interface, input: Workflow.CreateInput) =>
  workflow.admit({
    ...input,
    location: Location.Ref.make({ directory: AbsolutePath.make("D:\\OpenCode-Audit") }),
    sessionID: Session.ID.make("ses_workflow_execution"),
    agent: Agent.ID.make("build"),
  })

describe("Workflow lease acquisition", () => {
  it.effect("workflow cancellation atomically cancels every active explicit Response", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const responses = yield* ResponsesV2.Service
      const first = Responses.ID.make("resp_cancel_multi_first")
      const second = Responses.ID.make("resp_cancel_multi_second")
      const blocker = Responses.ID.make("resp_cancel_multi_blocker")
      const base = createInput("cancel_multi_response")
      const input: Workflow.CreateInput = {
        ...base,
        stages: [
          { ...base.stages[0], input: { responseID: blocker } },
          {
            id: Workflow.StageID.make("wfs_cancel_multi_first"),
            type: "deliver",
            ordinal: 1,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "cancel/multi/first",
            input: { responseID: first },
          },
          {
            id: Workflow.StageID.make("wfs_cancel_multi_second"),
            type: "deliver",
            ordinal: 2,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "cancel/multi/second",
            input: { responseID: second },
          },
        ],
      }
      yield* admit(workflow, input)
      for (const responseID of [first, second]) {
        yield* responses.create({
          id: responseID,
          workflowID: input.id!,
          model: "deepseek-v4-flash",
          background: true,
          store: true,
          requestHash: `sha256:${responseID}`,
          input: [{ type: "message", role: "user", content: responseID }],
        })
      }

      yield* workflow.cancel(input.id!)
      expect((yield* responses.get(first)).status).toBe("cancelled")
      expect((yield* responses.get(second)).status).toBe("cancelled")
      expect((yield* workflow.get(input.id!)).run.cancelRequestedAt).toBeDefined()
    }),
  )

  it.effect("does not consume an attempt before a linked response is admitted", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const base = createInput("response_not_admitted_claim")
      const input: Workflow.CreateInput = {
        ...base,
        stages: [{ ...base.stages[0], input: { responseID: "resp_not_admitted_claim" } }],
      }
      yield* admit(workflow, input)

      expect(Option.isNone(yield* store.claim({ owner: "worker-a", now: 1_000, leaseDurationMs: 30_000 }))).toBe(true)
      expect((yield* store.stage(input.stages[0].id!))?.attempt).toBe(0)
    }),
  )

  it.effect("does not consume an attempt before a workflow-bound Response is admitted", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const responses = yield* ResponsesV2.Service
      const base = createInput("workflow_bound_response_claim")
      const responseID = Responses.ID.make("resp_workflow_bound_response_claim")
      const input: Workflow.CreateInput = {
        ...base,
        stages: [
          {
            ...base.stages[0],
            type: "deliver",
            maxAttempts: 1,
            input: { responseBinding: "workflow" },
          },
        ],
      }
      yield* admit(workflow, input)

      expect(Option.isNone(yield* store.claim({ owner: "worker-a", now: 1_000, leaseDurationMs: 30_000 }))).toBe(true)
      expect((yield* store.stage(input.stages[0].id!))?.attempt).toBe(0)

      yield* responses.create({
        id: responseID,
        workflowID: input.id!,
        model: "deepseek-v4-flash",
        background: true,
        store: true,
        requestHash: `sha256:${responseID}`,
        input: [{ type: "message", role: "user", content: "continue" }],
      })

      expect(Option.isSome(yield* store.claim({ owner: "worker-a", now: 2_000, leaseDurationMs: 30_000 }))).toBe(true)
      expect((yield* store.stage(input.stages[0].id!))?.attempt).toBe(1)
    }),
  )

  it.effect("leases an ordinary deliver stage without a Response binding", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const base = createInput("ordinary_deliver_claim")
      const input: Workflow.CreateInput = {
        ...base,
        stages: [{ ...base.stages[0], type: "deliver", maxAttempts: 1, input: {} }],
      }
      yield* admit(workflow, input)

      expect(Option.isSome(yield* store.claim({ owner: "worker-a", now: 1_000, leaseDurationMs: 30_000 }))).toBe(true)
      expect((yield* store.stage(input.stages[0].id!))?.attempt).toBe(1)
    }),
  )

  it.effect("allows only one worker to lease one stage", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const input = createInput("one")
      yield* admit(workflow, input)

      const results = yield* Effect.all(
        [
          store.claim({ owner: "worker-a", now: 1_000, leaseDurationMs: 30_000 }),
          store.claim({ owner: "worker-b", now: 1_000, leaseDurationMs: 30_000 }),
        ],
        { concurrency: "unbounded" },
      )

      expect(results.filter(Option.isSome)).toHaveLength(1)
      const stage = yield* store.stage(input.stages[0].id!)
      expect(stage?.attempt).toBe(1)
      if (!stage?.leaseOwner) throw new Error("leased stage is missing its owner")
      expect(["worker-a", "worker-b"]).toContain(stage.leaseOwner)

      const history = yield* workflow.history({ workflowID: input.id!, limit: 20 })
      expect(history.events.filter((event) => event.type === "workflow.stage.leased")).toHaveLength(1)
    }),
  )

  it.effect(
    "survives 100 repeated two-worker races without duplicate leases",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const store = yield* WorkflowStore.Service
        const winners = yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              yield* admit(workflow, createInput(`race_${index}`))
              const results = yield* Effect.all(
                [
                  store.claim({ owner: `worker-a-${index}`, now: 2_000 + index, leaseDurationMs: 30_000 }),
                  store.claim({ owner: `worker-b-${index}`, now: 2_000 + index, leaseDurationMs: 30_000 }),
                ],
                { concurrency: "unbounded" },
              )
              return results.filter(Option.isSome).length
            }),
          { concurrency: 1 },
        )

        expect(winners).toEqual(Array.from({ length: 100 }, () => 1))
      }),
    30_000,
  )

  it.effect("renews only the current unexpired fencing token", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const input = createInput("renew")
      yield* admit(workflow, input)
      const claimed = yield* store.claim({ owner: "worker-a", now: 1_000, leaseDurationMs: 30_000 })
      expect(Option.isSome(claimed)).toBe(true)

      expect(
        yield* store.renew({
          stageID: input.stages[0].id!,
          owner: "worker-a",
          attempt: 2,
          now: 2_000,
          expiresAt: 32_000,
        }),
      ).toBe(false)
      expect(
        yield* store.renew({
          stageID: input.stages[0].id!,
          owner: "worker-a",
          attempt: 1,
          now: 31_001,
          expiresAt: 61_001,
        }),
      ).toBe(false)
      expect(
        yield* store.renew({
          stageID: input.stages[0].id!,
          owner: "worker-a",
          attempt: 1,
          now: 30_000,
          expiresAt: 60_000,
        }),
      ).toBe(true)
    }),
  )
})

describe("Workflow executor", () => {
  it.effect("fails unsupported stages without exposing provider state", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const store = yield* WorkflowStore.Service
      const executor = yield* WorkflowExecutor.Service
      const input = createInput("unsupported")
      const run = yield* admit(workflow, input)
      const claimed = yield* store.claim({ owner: "worker-a", now: 1_000, leaseDurationMs: 30_000 })
      const stage = Option.getOrThrow(claimed)

      const failure = yield* executor
        .execute({
          workflow: run,
          stage,
          stages: [stage],
          artifacts: [],
          saveCheckpoint: () => Effect.void,
          lease: {
            owner: "worker-a",
            attempt: 1,
            expiresAt: DateTime.makeUnsafe(31_000),
          },
        })
        .pipe(Effect.flip)

      expect(failure).toEqual({
        failure: {
          category: "invalid_request",
          code: "unsupported_stage",
          message: "No role route is registered for stage type build",
        },
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
      })
    }),
  )
})

describe("Workflow local execution", () => {
  branchOutcomeIt.live("persists branch skips in the winning stage settlement batch", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const responses = yield* ResponsesV2.Service
      const { db } = yield* Database.Service
      const workflowID = Workflow.ID.make("wfl_worker_branch_skips")
      const responseID = Responses.ID.make("resp_worker_branch_skips")
      const declared = WorkflowGraph.expandVisualBuild({
        maxRevisions: 2,
        maxAttempts: 1,
        responseID,
      })
      const stage = (input: Workflow.RoleStageInput, index: number): Workflow.RoleStageInput => ({
        ...input,
        id: Workflow.StageID.make(`wfs_worker_branch_${index}`),
        input: { ...input.input },
      })
      const stages: [Workflow.RoleStageInput, ...Workflow.RoleStageInput[]] = [
        stage(declared[0], 0),
        ...declared.slice(1).map((input, index) => stage(input, index + 1)),
      ]
      yield* admit(workflow, {
        id: workflowID,
        type: "development",
        input: { brief: "Exercise both skip branches" },
        budget: { maxAttempts: 12 },
        stages,
      })
      yield* responses.create({
        id: responseID,
        workflowID,
        model: "deepseek-v4-flash",
        background: true,
        store: true,
        requestHash: `sha256:${responseID}`,
        input: [{ type: "message", role: "user", content: "Build and deliver the visual" }],
      })
      yield* workflow.events({ workflowID }).pipe(
        Stream.filter((event) => event.type === "workflow.succeeded" || event.type === "workflow.failed"),
        Stream.runHead,
        Effect.timeout("3 seconds"),
      )

      const detail = yield* workflow.get(workflowID)
      expect(detail.run.status).toBe("succeeded")
      expect(detail.stages.at(-1)?.input.responseID).toBe(responseID)
      expect(detail.stages.map((stage) => [stage.type, stage.input.revision, stage.status])).toEqual([
        ["design", 0, "succeeded"],
        ["decompose", 0, "succeeded"],
        ["implement", 0, "succeeded"],
        ["test", 0, "succeeded"],
        ["visual_review", 0, "skipped"],
        ["repair", 1, "succeeded"],
        ["test", 1, "succeeded"],
        ["visual_review", 1, "succeeded"],
        ["repair", 2, "skipped"],
        ["test", 2, "skipped"],
        ["visual_review", 2, "skipped"],
        ["deliver", 2, "succeeded"],
      ])

      const rows = yield* db
        .select({ type: EventTable.type, batchID: EventTable.batch_id, data: EventTable.data })
        .from(EventTable)
        .all()
        .pipe(Effect.orDie)
      const skipRows = rows.filter((row) => row.type === "workflow.stage.skipped.1")
      expect(skipRows).toHaveLength(4)
      for (const row of skipRows) {
        if (typeof row.data !== "object" || row.data === null || !("sourceStageID" in row.data)) {
          throw new Error("Skipped event is missing its source stage")
        }
        const sourceStageID = row.data.sourceStageID
        expect(
          rows.some(
            (candidate) =>
              candidate.batchID === row.batchID &&
              candidate.type === "workflow.stage.succeeded.1" &&
              typeof candidate.data === "object" &&
              candidate.data !== null &&
              "stageID" in candidate.data &&
              candidate.data.stageID === sourceStageID,
          ),
        ).toBe(true)
        expect(
          rows.some(
            (candidate) => candidate.batchID === row.batchID && candidate.type === "workflow.artifact.created.1",
          ),
        ).toBe(true)
      }
      const terminalWorkflow = rows.find((row) => row.type === "workflow.succeeded.1")
      const terminalResponse = rows.find(
        (row) =>
          row.type === "response.completed.1" &&
          typeof row.data === "object" &&
          row.data !== null &&
          "responseID" in row.data &&
          row.data.responseID === responseID,
      )
      const terminalStage = rows.find(
        (row) =>
          row.type === "workflow.stage.succeeded.1" &&
          typeof row.data === "object" &&
          row.data !== null &&
          "stageID" in row.data &&
          row.data.stageID === detail.stages.at(-1)?.id,
      )
      expect(terminalWorkflow?.batchID).toBeDefined()
      expect(terminalResponse?.batchID).toBe(terminalWorkflow?.batchID)
      expect(terminalStage?.batchID).toBe(terminalWorkflow?.batchID)
      expect(yield* responses.get(responseID)).toMatchObject({
        status: "completed",
        output: [{ type: "message", role: "assistant", content: "Visual build completed" }],
      })
    }),
  )

  checkpointGuardIt.live(
    "rejects secret-bearing and oversized mid-stage checkpoints before durable publication",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const { db } = yield* Database.Service
        const inputs = [createInput("checkpoint_secret"), createInput("checkpoint_oversized")]
        for (const input of inputs) {
          yield* admit(workflow, input)
          yield* workflow.events({ workflowID: input.id! }).pipe(
            Stream.filter((event) => event.type === "workflow.approval.requested"),
            Stream.runHead,
            Effect.timeout("2 seconds"),
          )
        }

        const secret = yield* workflow.get(inputs[0].id!)
        const oversized = yield* workflow.get(inputs[1].id!)
        expect(secret.stages[0]).toMatchObject({
          status: "waiting_approval",
          checkpoint: undefined,
          error: { code: "unsafe_checkpoint" },
        })
        expect(oversized.stages[0]).toMatchObject({
          status: "waiting_approval",
          checkpoint: undefined,
          error: { code: "checkpoint_too_large" },
        })
        const durable = JSON.stringify(
          yield* db.select({ type: EventTable.type, data: EventTable.data }).from(EventTable).all().pipe(Effect.orDie),
        )
        expect(durable).not.toContain("checkpoint-secret-sentinel")
        expect(durable).not.toContain('"workflow.stage.checkpointed"')
      }),
    5_000,
  )

  incompleteRoleHistoryIt.live("fails final role validation before stage success can make the run stick", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const base = createInput("incomplete_role_history")
      const input: Workflow.CreateInput = {
        ...base,
        stages: [{ ...base.stages[0], type: "design", idempotencyKey: "incomplete-role-history/design" }],
      }
      yield* admit(workflow, input)
      yield* workflow.events({ workflowID: input.id! }).pipe(
        Stream.filter((event) => event.type === "workflow.failed"),
        Stream.runHead,
        Effect.timeout("2 seconds"),
      )

      const detail = yield* workflow.get(input.id!)
      expect(detail.run.status).toBe("failed")
      expect(detail.stages[0].status).toBe("failed")
      expect(detail.stages[0].error?.code).toBe("incomplete_role_workflow")
    }),
  )

  invalidBranchOutcomeIt.live("atomically rejects a mutually consistent forged binding and receipt", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const responses = yield* ResponsesV2.Service
      const { db } = yield* Database.Service
      const workflowID = Workflow.ID.make("wfl_invalid_branch_outcome")
      const responseID = Responses.ID.make("resp_invalid_branch_outcome")
      const designStageID = Workflow.StageID.make("wfs_invalid_branch_design")
      const decomposeStageID = Workflow.StageID.make("wfs_invalid_branch_decompose")
      const deliverStageID = Workflow.StageID.make("wfs_invalid_branch_deliver")
      yield* admit(workflow, {
        id: workflowID,
        type: "visual-build",
        input: { brief: "Reject invalid branch authority" },
        budget: { maxAttempts: 2 },
        stages: [
          {
            id: designStageID,
            type: "design",
            ordinal: 0,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "invalid-branch/design/r0",
            input: { revision: 0, responseID },
          },
          {
            id: decomposeStageID,
            type: "decompose",
            ordinal: 1,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "invalid-branch/decompose/r0",
            input: { revision: 0 },
          },
          {
            id: deliverStageID,
            type: "deliver",
            ordinal: 2,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "invalid-branch/deliver/r0",
            input: { revision: 0, responseID },
          },
        ],
      })
      yield* responses.create({
        id: responseID,
        workflowID,
        model: "deepseek-v4-flash",
        background: true,
        store: true,
        requestHash: `sha256:${responseID}`,
        input: [{ type: "message", role: "user", content: "Reject an invalid outcome" }],
      })
      yield* workflow.events({ workflowID }).pipe(
        Stream.filter((event) => event.type === "workflow.failed"),
        Stream.runHead,
        Effect.timeout("2 seconds"),
      )

      const detail = yield* workflow.get(workflowID)
      expect(detail.run.status).toBe("failed")
      expect(detail.stages.map((stage) => [stage.id, stage.status])).toEqual([
        [designStageID, "failed"],
        [decomposeStageID, "pending"],
        [deliverStageID, "pending"],
      ])
      expect(detail.stages[0].error?.code).toBe("invalid_role_evidence")
      const rows = yield* db
        .select({ type: EventTable.type, batchID: EventTable.batch_id, data: EventTable.data })
        .from(EventTable)
        .all()
        .pipe(Effect.orDie)
      const stageFailure = rows.find(
        (row) =>
          row.type === "workflow.stage.failed.1" &&
          typeof row.data === "object" &&
          row.data !== null &&
          "stageID" in row.data &&
          row.data.stageID === designStageID,
      )
      const workflowFailure = rows.find((row) => row.type === "workflow.failed.1")
      const responseFailure = rows.find(
        (row) =>
          row.type === "response.failed.1" &&
          typeof row.data === "object" &&
          row.data !== null &&
          "responseID" in row.data &&
          row.data.responseID === responseID,
      )
      expect(stageFailure?.batchID).toBeDefined()
      expect(workflowFailure?.batchID).toBe(stageFailure?.batchID)
      expect(responseFailure?.batchID).toBe(stageFailure?.batchID)
      expect(rows).not.toContainEqual(
        expect.objectContaining({
          type: "workflow.stage.succeeded.1",
          data: expect.objectContaining({ stageID: designStageID }),
        }),
      )
      expect(rows.some((row) => row.type === "workflow.artifact.created.1")).toBe(false)
      expect(rows.some((row) => row.type === "workflow.stage.skipped.1")).toBe(false)
      expect(rows.some((row) => row.type === "workflow.succeeded.1")).toBe(false)
      expect(rows.some((row) => row.type === "response.completed.1")).toBe(false)
      expect(yield* responses.get(responseID)).toMatchObject({
        status: "failed",
        error: { code: "invalid_role_evidence" },
      })
    }),
  )

  deadlineIt.live(
    "times out at the workflow deadline before the duration gate requests approval",
    () =>
      Effect.gen(function* () {
        deadlineProbe.remainingDurationMs = undefined
        const workflow = yield* WorkflowV2.Service
        const input = {
          ...createInput("worker_deadline"),
          budget: { maxAttempts: 3, maxDurationMs: 100 },
        }
        yield* admit(workflow, input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter(
            (event) => event.type === "workflow.approval.requested" && event.data.reason === "budget_exhausted",
          ),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        const detail = yield* workflow.get(input.id!)
        const history = yield* workflow.history({ workflowID: input.id!, limit: 50 })
        expect(deadlineProbe.remainingDurationMs).toBeGreaterThan(0)
        expect(deadlineProbe.remainingDurationMs).toBeLessThanOrEqual(100)
        expect(detail.run.status).toBe("waiting_approval")
        expect(detail.stages[0].status).toBe("retry_wait")
        expect(
          history.events.some(
            (event) =>
              event.type === "workflow.stage.retry_scheduled" && event.data.failure.code === "workflow_deadline",
          ),
        ).toBe(true)
        const retry = history.events.find((event) => event.type === "workflow.stage.retry_scheduled")
        const approval = history.events.find(
          (event) => event.type === "workflow.approval.requested" && event.data.reason === "budget_exhausted",
        )
        if (!retry || !approval) throw new Error("deadline history is incomplete")
        expect(
          DateTime.toEpochMillis(approval.data.timestamp) - DateTime.toEpochMillis(retry.data.timestamp),
        ).toBeLessThan(200)
        expect(
          history.events
            .filter((event) => event.type === "workflow.budget.threshold_reached")
            .map((event) => event.data.percent),
        ).toEqual([50, 80, 100])
      }),
    5_000,
  )

  classifiedFailureIt.live(
    "retries transient execution failures and persists sanitized history exactly once",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_retry")
        yield* admit(workflow, input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.succeeded"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        const detail = yield* workflow.get(input.id!)
        const history = yield* workflow.history({ workflowID: input.id!, limit: 50 })
        expect(detail.run.usage).toEqual({ tokens: 30, turns: 2, toolCalls: 0, attempts: 2 })
        expect(history.events.filter((event) => event.type === "workflow.stage.retry_scheduled")).toHaveLength(1)
        expect(history.events.filter((event) => event.type === "workflow.stage.leased")).toHaveLength(2)
        expect(JSON.stringify(history.events)).not.toContain("live-secret")
      }),
    5_000,
  )

  permanentFailureIt.live(
    "fails the stage and run for a non-retryable execution failure",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_permanent_failure")
        yield* admit(workflow, input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.failed"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        const detail = yield* workflow.get(input.id!)
        const history = yield* workflow.history({ workflowID: input.id!, limit: 50 })
        expect(detail.run.status).toBe("failed")
        expect(detail.stages[0].status).toBe("failed")
        expect(detail.run.usage).toEqual({ tokens: 7, turns: 1, toolCalls: 0, attempts: 1 })
        expect(history.events.map((event) => event.type)).toContain("workflow.stage.failed")
      }),
    5_000,
  )

  permanentFailureIt.live(
    "atomically fails every active Response when a pre-deliver stage fails",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const responses = yield* ResponsesV2.Service
        const first = Responses.ID.make("resp_worker_multi_first")
        const second = Responses.ID.make("resp_worker_multi_second")
        const base = createInput("worker_multi_response_failure")
        const input: Workflow.CreateInput = {
          ...base,
          stages: [
            { ...base.stages[0], input: { responseID: first }, maxAttempts: 1 },
            {
              id: Workflow.StageID.make("wfs_worker_multi_deliver_first"),
              type: "deliver",
              ordinal: 1,
              maxAttempts: 1,
              recoveryPolicy: "restart_safe",
              idempotencyKey: "worker/multi/deliver-first",
              input: { responseID: first },
            },
            {
              id: Workflow.StageID.make("wfs_worker_multi_deliver_second"),
              type: "deliver",
              ordinal: 2,
              maxAttempts: 1,
              recoveryPolicy: "restart_safe",
              idempotencyKey: "worker/multi/deliver-second",
              input: { responseID: second },
            },
          ],
        }
        yield* admit(workflow, input)
        yield* responses.create({
          id: second,
          workflowID: input.id!,
          model: "deepseek-v4-flash",
          background: true,
          store: true,
          requestHash: `sha256:${second}`,
          input: [{ type: "message", role: "user", content: "second" }],
        })
        yield* responses.create({
          id: first,
          workflowID: input.id!,
          model: "deepseek-v4-flash",
          background: true,
          store: true,
          requestHash: `sha256:${first}`,
          input: [{ type: "message", role: "user", content: "first" }],
        })

        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.failed"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )
        expect((yield* responses.get(first)).status).toBe("failed")
        expect((yield* responses.get(second)).status).toBe("failed")
      }),
    5_000,
  )

  ambiguousFailureIt.live(
    "pauses an ambiguous execution for approval and accounts its usage",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_ambiguous_failure")
        yield* admit(workflow, input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.approval.requested"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        const detail = yield* workflow.get(input.id!)
        expect(detail.run.status).toBe("waiting_approval")
        expect(detail.stages[0].status).toBe("waiting_approval")
        expect(detail.run.usage).toEqual({ tokens: 5, turns: 1, toolCalls: 1, attempts: 1 })
      }),
    5_000,
  )

  workerIt.live(
    "polls a durable queued workflow that committed without an in-process wake",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_post_commit_poll")
        const timestamp = yield* DateTime.now
        const location = Location.Ref.make({ directory: AbsolutePath.make("D:\\OpenCode-Audit") })
        const stage = input.stages[0]
        yield* events.publish(WorkflowEvent.Created, {
          workflowID: input.id!,
          timestamp,
          type: input.type,
          input: input.input,
          budget: input.budget,
          stages: [{ ...stage, id: stage.id! }],
          location,
          sessionID: Session.ID.make("ses_workflow_execution"),
          agent: Agent.ID.make("build"),
        })
        yield* events.publish(WorkflowEvent.Stage.Queued, {
          workflowID: input.id!,
          stageID: input.stages[0].id!,
          timestamp,
        })

        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.succeeded"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )
        expect((yield* workflow.get(input.id!)).run.status).toBe("succeeded")
      }),
    5_000,
  )

  workerIt.live(
    "advances a created workflow through artifact commit to success",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_success")
        yield* admit(workflow, input)

        const completed = yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.succeeded"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        expect(Option.isSome(completed)).toBe(true)
        const detail = yield* workflow.get(input.id!)
        expect(detail.run.status).toBe("succeeded")
        expect(detail.artifacts).toHaveLength(1)
      }),
    5_000,
  )

  durableEvidenceIt.live(
    "projects screenshot EventV2 before host settlement and reconciles a post-projection crash",
    () =>
      Effect.gen(function* () {
        durableEvidenceOrder.length = 0
        reconciledEvidence.length = 0
        const workflow = yield* WorkflowV2.Service
        const base = createInput("durable_evidence_order")
        const input: Workflow.CreateInput = { ...base, type: "visual-build" }
        yield* admit(workflow, input)

        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.succeeded"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )
        for (let attempt = 0; attempt < 100 && reconciledEvidence.length === 0; attempt++) {
          yield* Effect.sleep(10)
        }

        const detail = yield* workflow.get(input.id!)
        expect(detail.run.status).toBe("succeeded")
        expect(detail.stages[0].status).toBe("succeeded")
        expect(detail.artifacts).toHaveLength(1)
        expect(durableEvidenceOrder.slice(0, 3)).toEqual(["eventv2-projected", "commit-crash", "reconcile"])
        expect(reconciledEvidence[0]?.committed).toHaveLength(1)
        expect(reconciledEvidence[0]?.committed[0]?.artifact).toEqual(detail.artifacts[0])
        expect(reconciledEvidence[0]?.committed[0]?.receipt.coordinates).toMatchObject({
          workflowID: input.id!,
          stageID: input.stages[0].id,
          kind: "implementation",
          revision: 0,
        })
        expect(reconciledEvidence[0]?.committed[0]?.release).toBe(true)
      }),
    5_000,
  )

  workerIt.live(
    "runs two stages in ordinal order and commits each artifact atomically with stage success",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const workflowID = Workflow.ID.make("wfl_worker_order")
        const first = Workflow.StageID.make("wfs_worker_order_first")
        const second = Workflow.StageID.make("wfs_worker_order_second")
        yield* admit(workflow, {
          id: workflowID,
          type: "development",
          input: { brief: "Build in order" },
          budget: { maxAttempts: 4 },
          stages: [
            {
              id: second,
              type: "build",
              ordinal: 1,
              maxAttempts: 2,
              recoveryPolicy: "restart_safe",
              idempotencyKey: "worker-order/build",
              input: {},
            },
            {
              id: first,
              type: "plan",
              ordinal: 0,
              maxAttempts: 2,
              recoveryPolicy: "restart_safe",
              idempotencyKey: "worker-order/plan",
              input: {},
            },
          ],
        })

        yield* workflow.events({ workflowID }).pipe(
          Stream.filter((event) => event.type === "workflow.succeeded"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        const history = yield* workflow.history({ workflowID, limit: 50 })
        const lifecycle = history.events.filter(
          (event) => event.type === "workflow.artifact.created" || event.type === "workflow.stage.succeeded",
        )
        expect(
          history.events.filter((event) => event.type === "workflow.stage.started").map((event) => event.data.stageID),
        ).toEqual([first, second])
        expect(lifecycle.map((event) => event.type)).toEqual([
          "workflow.stage.succeeded",
          "workflow.artifact.created",
          "workflow.stage.succeeded",
          "workflow.artifact.created",
        ])
      }),
    5_000,
  )

  duplicateArtifactIt.live(
    "keeps one artifact row for duplicate stage-kind-sha commits",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_duplicate_artifact")
        yield* admit(workflow, input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.succeeded"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        const detail = yield* workflow.get(input.id!)
        expect(detail.artifacts).toHaveLength(1)
        expect(detail.artifacts[0].sha256).toBe("b".repeat(64))
      }),
    5_000,
  )

  leaseLossIt.live(
    "prevents stale success when heartbeat renewal loses the lease",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const execution = yield* WorkflowExecution.Service
        const database = yield* Database.Service
        const input = createInput("worker_lease_loss")
        yield* admit(workflow, input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.stage.started"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )
        yield* database.db
          .update(WorkflowStageTable)
          .set({ lease_expires_at: 0 })
          .where(eq(WorkflowStageTable.id, input.stages[0].id!))
          .run()
          .pipe(Effect.orDie)
        yield* waitForActive(execution, input.id!, false).pipe(Effect.timeout("2 seconds"))

        const detail = yield* workflow.get(input.id!)
        const history = yield* workflow.history({ workflowID: input.id!, limit: 50 })
        const retries = history.events.filter((event) => event.type === "workflow.stage.retry_scheduled")
        const successes = history.events.filter((event) => event.type === "workflow.stage.succeeded")
        expect(detail.stages[0].status).toBe("succeeded")
        expect(retries).toHaveLength(1)
        expect(retries[0]?.data).toMatchObject({ attempt: 1, leaseOwner: "worker-lease-loss" })
        expect(successes).toHaveLength(1)
        expect(successes[0]?.data).toMatchObject({ attempt: 2, leaseOwner: "worker-lease-loss" })
        expect(history.events.some((event) => event.type === "workflow.succeeded")).toBe(true)
        expect((yield* execution.active).has(input.id!)).toBe(false)
      }),
    5_000,
  )

  concurrencyIt.live(
    "runs different workflows concurrently without exceeding configured slots",
    () =>
      Effect.gen(function* () {
        concurrencyProbe.active = 0
        concurrencyProbe.max = 0
        const workflow = yield* WorkflowV2.Service
        const inputs = [
          createInput("worker_concurrent_a"),
          createInput("worker_concurrent_b"),
          createInput("worker_concurrent_c"),
        ]
        yield* Effect.forEach(inputs, (input) => admit(workflow, input), { discard: true })
        yield* Effect.forEach(
          inputs,
          (input) =>
            workflow.events({ workflowID: input.id! }).pipe(
              Stream.filter((event) => event.type === "workflow.succeeded"),
              Stream.runHead,
              Effect.timeout("2 seconds"),
            ),
          { concurrency: "unbounded", discard: true },
        )

        expect(concurrencyProbe.max).toBe(2)
        expect(concurrencyProbe.active).toBe(0)
      }),
    5_000,
  )

  interruptIt.live(
    "settles interrupted execution as cancelled before results can commit",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const input = createInput("worker_cancel")
        yield* admit(workflow, input)
        yield* workflow.events({ workflowID: input.id! }).pipe(
          Stream.filter((event) => event.type === "workflow.stage.started"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
        )

        yield* Effect.all([workflow.cancel(input.id!), workflow.cancel(input.id!)], {
          concurrency: "unbounded",
          discard: true,
        })
        yield* workflow.cancel(input.id!)

        const detail = yield* workflow.get(input.id!)
        expect(detail.run.status).toBe("cancelled")
        expect(detail.stages[0].status).toBe("cancelled")
        expect(detail.artifacts).toEqual([])

        const history = yield* workflow.history({ workflowID: input.id!, limit: 50 })
        const types = history.events.map((event) => event.type)
        expect(history.events.filter((event) => event.type === "workflow.cancel.requested")).toHaveLength(1)
        expect(history.events.filter((event) => event.type === "workflow.stage.cancelled")).toHaveLength(1)
        expect(history.events.filter((event) => event.type === "workflow.cancelled")).toHaveLength(1)
        expect(types.indexOf("workflow.cancel.requested")).toBeLessThan(types.indexOf("workflow.stage.cancelled"))
        expect(types).not.toContain("workflow.stage.succeeded")
        expect(types).not.toContain("workflow.succeeded")
      }),
    5_000,
  )

  interruptIt.live(
    "returns copied active snapshots and treats idle interruption as a no-op",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const execution = yield* WorkflowExecution.Service
        const missing = Workflow.ID.make("wfl_worker_missing")
        yield* execution.interrupt(missing)

        const input = createInput("worker_interrupt")
        yield* admit(workflow, input)
        yield* waitForActive(execution, input.id!, true).pipe(Effect.timeout("2 seconds"))
        const first = yield* execution.active
        const second = yield* execution.active
        expect(first).not.toBe(second)
        expect(first.has(input.id!)).toBe(true)

        yield* execution.interrupt(input.id!)
        yield* waitForActive(execution, input.id!, false).pipe(Effect.timeout("2 seconds"))
        expect((yield* execution.active).has(input.id!)).toBe(false)
      }),
    5_000,
  )
})
