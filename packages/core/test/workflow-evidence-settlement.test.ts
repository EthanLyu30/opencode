import { describe, expect, test } from "bun:test"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowSchema } from "@opencode-ai/core/workflow"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { WorkflowVisualEvidence } from "@opencode-ai/core/workflow/visual-evidence"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"
import { DateTime, Effect } from "effect"

describe("Workflow Local visual evidence settlement", () => {
  test("exposes the post-EventV2 settlement and durable reconciliation boundaries", () => {
    expect(Reflect.get(WorkflowExecutionLocal, "settleProjectedEvidence")).toBeFunction()
    expect(Reflect.get(WorkflowExecutionLocal, "reconcileDurableEvidence")).toBeFunction()
  })

  test("commit/releases only after the projected complete Artifact reload and reconciles it idempotently", async () => {
    const workflowID = WorkflowSchema.ID.make("wfl_evidence_settlement")
    const stageID = WorkflowSchema.StageID.make("wfs_evidence_settlement")
    const viewport = { name: "desktop", width: 16, height: 16 }
    const bytes = WorkflowVisualHost.deterministicPng(viewport)
    const pngSha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    const coordinates = {
      schemaVersion: 1 as const,
      workflowID,
      stageID,
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
      pngSha256,
      width: viewport.width,
      height: viewport.height,
      evidenceBytes: bytes.byteLength,
    }
    const commit = WorkflowVisualReviewArtifact.commitScreenshot(
      WorkflowVisualReviewArtifact.capturedImage({
        workflowID,
        kind: "implementation",
        viewport: viewport.name,
        revision: 0,
        bytes,
        evidenceReceipt: receipt,
      }),
    )
    const stage = {
      id: stageID,
      workflowID,
      type: "visual_review",
      ordinal: 0,
      status: "succeeded" as const,
      attempt: 1,
      maxAttempts: 2,
      recoveryPolicy: "restart_safe" as const,
      idempotencyKey: "evidence-settlement",
      input: { revision: 0 },
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(2) },
    }
    const artifact = {
      id: WorkflowSchema.ArtifactID.make("wfa_evidence_settlement"),
      workflowID,
      stageID,
      ...commit,
      timeCreated: DateTime.makeUnsafe(2),
    }
    const workflow = WorkflowSchema.Info.make({
      id: workflowID,
      type: "visual-build",
      status: "running",
      input: {},
      budget: {},
      usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
      version: 1,
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
    })
    const detail = { run: workflow, stages: [stage], artifacts: [artifact] }
    const workflows = WorkflowStore.Service.of({
      list: () => Effect.succeed([workflow]),
      get: () => Effect.succeed(detail),
      stage: () => Effect.succeed(stage),
      artifacts: () => Effect.succeed([artifact]),
      gateBudget: () => Effect.succeed(false),
      claimCandidates: () => Effect.succeed([]),
      claim: () => Effect.succeedNone,
      renew: () => Effect.succeed(false),
      expired: () => Effect.succeed([]),
    })
    const order = ["eventv2"]
    let reconciled: WorkflowVisualHost.ReconcileEvidenceInput | undefined
    const artifactBinding = WorkflowVisualHost.evidenceArtifactBinding({ receipt, artifact })
    const evidenceSummary = (state: "committed" | "released") => ({
      evidenceID: receipt.evidenceID,
      coordinates,
      receipt,
      state,
      artifact: artifactBinding,
      createdAt: 1,
      updatedAt: 2,
    })
    const visualHost: WorkflowVisualHost.Interface = {
      materializeReference: () => Effect.die("unused"),
      prepareImplementation: () => Effect.die("unused"),
      capture: () => Effect.die("unused"),
      lookupEvidence: () => Effect.die("unused"),
      commitEvidence: () => Effect.sync(() => (order.push("commit"), evidenceSummary("committed"))),
      releaseEvidence: () => Effect.sync(() => (order.push("release"), evidenceSummary("released"))),
      abandonEvidence: () => Effect.die("unused"),
      reconcileEvidence: (input) =>
        Effect.sync(() => {
          reconciled = input
          return { active: [], committed: [], released: [], abandoned: [], ambiguous: [] }
        }),
      recoverExpired: () => Effect.void,
    }
    await Effect.runPromise(
      WorkflowExecutionLocal.settleProjectedEvidence({
        workflowID,
        expectedArtifacts: [artifact],
        workflows,
        visualHost,
      }),
    )
    expect(order).toEqual(["eventv2", "commit", "release"])
    await Effect.runPromise(WorkflowExecutionLocal.reconcileDurableEvidence({ workflows, visualHost }))
    expect(reconciled?.committed).toEqual([{ receipt, artifact, release: true }])

    const postEventFailure = await Effect.runPromise(
      WorkflowExecutionLocal.settleProjectedEvidence({
        workflowID,
        expectedArtifacts: [artifact],
        workflows,
        visualHost: {
          ...visualHost,
          commitEvidence: () =>
            Effect.fail(
              new WorkflowVisualHost.Failure({
                operation: "commit_evidence",
                code: "visual_host_unavailable",
                message: "restart required",
              }),
            ),
        },
      }).pipe(Effect.flip),
    )
    expect(postEventFailure.code).toBe("visual_host_unavailable")
    expect((await Effect.runPromise(workflows.get(workflowID)))?.stages[0]?.status).toBe("succeeded")
  })

  test("reconciles every visual workflow through deterministic bounded pages beyond one thousand", async () => {
    const runs = Array.from({ length: 1_001 }, (_, index) =>
      WorkflowSchema.Info.make({
        id: WorkflowSchema.ID.make(`wfl_reconcile_${String(index).padStart(4, "0")}`),
        type: "visual-build",
        status: "running",
        input: {},
        budget: {},
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
        version: 1,
        time: { created: DateTime.makeUnsafe(index + 1), updated: DateTime.makeUnsafe(index + 1) },
      }),
    )
    const details = new Map(runs.map((run) => [run.id, { run, stages: [], artifacts: [] }] as const))
    const workflows = WorkflowStore.Service.of({
      list: (input) => {
        const cursor = input?.cursor
        const start =
          cursor === undefined
            ? 0
            : runs.findIndex(
                (run) =>
                  DateTime.toEpochMillis(run.time.created) > cursor.timeCreated ||
                  (DateTime.toEpochMillis(run.time.created) === cursor.timeCreated && run.id > cursor.workflowID),
              )
        return Effect.succeed(
          runs.slice(start < 0 ? runs.length : start, (start < 0 ? runs.length : start) + (input?.limit ?? 50)),
        )
      },
      get: (id) => Effect.succeed(details.get(id)),
      stage: () => Effect.succeed(undefined),
      artifacts: () => Effect.succeed([]),
      gateBudget: () => Effect.succeed(false),
      claimCandidates: () => Effect.succeed([]),
      claim: () => Effect.succeedNone,
      renew: () => Effect.succeed(false),
      expired: () => Effect.succeed([]),
    })
    const reconciled: string[] = []
    const visualHost: WorkflowVisualHost.Interface = {
      materializeReference: () => Effect.die("unused"),
      prepareImplementation: () => Effect.die("unused"),
      capture: () => Effect.die("unused"),
      lookupEvidence: () => Effect.die("unused"),
      commitEvidence: () => Effect.die("unused"),
      releaseEvidence: () => Effect.die("unused"),
      abandonEvidence: () => Effect.die("unused"),
      reconcileEvidence: (input) =>
        Effect.sync(() => {
          reconciled.push(input.workflowID)
          return { active: [], committed: [], released: [], abandoned: [], ambiguous: [] }
        }),
      recoverExpired: () => Effect.void,
    }

    await Effect.runPromise(WorkflowExecutionLocal.reconcileDurableEvidence({ workflows, visualHost, limit: 100 }))

    expect(reconciled).toHaveLength(1_001)
    expect(reconciled).toEqual(runs.map((run) => run.id))
  })

  test("retries a transient startup reconciliation failure through the shared periodic iteration", async () => {
    const run = WorkflowSchema.Info.make({
      id: WorkflowSchema.ID.make("wfl_reconcile_transient"),
      type: "visual-build",
      status: "running",
      input: {},
      budget: {},
      usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
      version: 1,
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
    })
    const workflows = WorkflowStore.Service.of({
      list: (input) => Effect.succeed(input?.cursor === undefined ? [run] : []),
      get: () => Effect.succeed({ run, stages: [], artifacts: [] }),
      stage: () => Effect.succeed(undefined),
      artifacts: () => Effect.succeed([]),
      gateBudget: () => Effect.succeed(false),
      claimCandidates: () => Effect.succeed([]),
      claim: () => Effect.succeedNone,
      renew: () => Effect.succeed(false),
      expired: () => Effect.succeed([]),
    })
    let attempts = 0
    const visualHost: WorkflowVisualHost.Interface = {
      materializeReference: () => Effect.die("unused"),
      prepareImplementation: () => Effect.die("unused"),
      capture: () => Effect.die("unused"),
      lookupEvidence: () => Effect.die("unused"),
      commitEvidence: () => Effect.die("unused"),
      releaseEvidence: () => Effect.die("unused"),
      abandonEvidence: () => Effect.die("unused"),
      reconcileEvidence: () => {
        attempts++
        return attempts === 1
          ? Effect.fail(
              new WorkflowVisualHost.Failure({
                operation: "reconcile_evidence",
                code: "visual_host_unavailable",
                message: "transient startup failure",
              }),
            )
          : Effect.succeed({ active: [], committed: [], released: [], abandoned: [], ambiguous: [] })
      },
      recoverExpired: () => Effect.void,
    }

    await Effect.runPromise(WorkflowExecutionLocal.reconcileEvidenceIteration({ workflows, visualHost }))
    await Effect.runPromise(WorkflowExecutionLocal.reconcileEvidenceIteration({ workflows, visualHost }))

    expect(attempts).toBe(2)
  })

  test("retains a fair bounded cursor across ticks and wraps only after reaching the synthetic tail", async () => {
    const total = 7
    const run = (index: number) =>
      WorkflowSchema.Info.make({
        id: WorkflowSchema.ID.make(`wfl_fair_${String(index).padStart(3, "0")}`),
        type: "visual-build",
        status: "running",
        input: {},
        budget: {},
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
        version: 1,
        time: { created: DateTime.makeUnsafe(index + 1), updated: DateTime.makeUnsafe(index + 1) },
      })
    const workflows = WorkflowStore.Service.of({
      list: (input) => {
        const start = input?.cursor?.timeCreated ?? 0
        return Effect.succeed(
          Array.from({ length: Math.min(input?.limit ?? 1, Math.max(0, total - start)) }, (_, offset) =>
            run(start + offset),
          ),
        )
      },
      get: (id) => {
        const index = Number(id.slice(-3))
        const value = run(index)
        return Effect.succeed({ run: value, stages: [], artifacts: [] })
      },
      stage: () => Effect.succeed(undefined),
      artifacts: () => Effect.succeed([]),
      gateBudget: () => Effect.succeed(false),
      claimCandidates: () => Effect.succeed([]),
      claim: () => Effect.succeedNone,
      renew: () => Effect.succeed(false),
      expired: () => Effect.succeed([]),
    })
    const reconciled: string[] = []
    const visualHost: WorkflowVisualHost.Interface = {
      materializeReference: () => Effect.die("unused"),
      prepareImplementation: () => Effect.die("unused"),
      capture: () => Effect.die("unused"),
      lookupEvidence: () => Effect.die("unused"),
      commitEvidence: () => Effect.die("unused"),
      releaseEvidence: () => Effect.die("unused"),
      abandonEvidence: () => Effect.die("unused"),
      reconcileEvidence: (input) =>
        Effect.sync(() => {
          reconciled.push(input.workflowID)
          return { active: [], committed: [], released: [], abandoned: [], ambiguous: [] }
        }),
      recoverExpired: () => Effect.void,
    }
    const state = WorkflowExecutionLocal.makeReconciliationState()

    for (let tick = 0; tick < 5; tick++)
      await Effect.runPromise(
        WorkflowExecutionLocal.reconcileEvidenceIteration({ workflows, visualHost, state, limit: 1, maxPages: 2 }),
      )

    expect(reconciled.slice(0, total)).toEqual(Array.from({ length: total }, (_, index) => run(index).id))
    expect(reconciled[total]).toBe(run(0).id)
  })
})
