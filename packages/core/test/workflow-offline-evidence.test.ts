import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { DateTime, Effect } from "effect"
import { AbsolutePath } from "../src/schema"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Location } from "@opencode-ai/schema/location"
import { WorkflowRoleContract } from "../src/workflow/execution/contract"
import { WorkflowRoleExecution } from "../src/workflow/execution/role"
import { WorkflowRouting } from "../src/workflow/routing"
import { WorkflowBenchmarkTransport } from "../src/workflow/benchmark-transport"
import { WorkflowProductionHostPlan } from "../src/workflow/production-host-plan"
import { PreviewPlan as WorkflowPreviewPlan } from "../src/workflow/preview-plan"
import { WorkflowVisualReviewArtifact } from "../src/workflow/artifacts/visual-review"
import { Hash } from "../src/util/hash"

test("offline evidence survives modern production artifact validation through repair and delivery", async () => {
  const root = path.join("D:\\OpenCode-Benchmark\\Task24\\tmp", `offline-evidence-${crypto.randomUUID()}`)
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, "index.html"), "<!doctype html><main>Fixture</main>")
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"bun test"}}')
  try {
    const location = Location.Ref.make({ directory: AbsolutePath.make(root) })
    const binding = WorkflowBenchmarkTransport.freezeProfile({
      authority: "server",
      expectedCampaignID: "offline-test",
      expectedRunID: "offline-test",
      profile: {
        schemaVersion: 1,
        campaignID: "offline-test",
        runID: "offline-test",
        brokerOrigin: "http://127.0.0.1:43191",
        providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
        evidenceMode: "deterministic_offline",
        expiresAt: Date.now() + 60000,
        grant: "task24-offline-test-grant-000000000001",
      },
    })
    const plan = WorkflowProductionHostPlan.freeze({
      authority: "admission",
      location,
      preview: WorkflowPreviewPlan.freeze({ authority: "admission", location }),
    })
    const input = WorkflowBenchmarkTransport.withBinding(
      WorkflowProductionHostPlan.withPlan(
        { visual: { maxRevisions: 1, maxTokens: 40000, maxTurns: 100, maxToolCalls: 120 } },
        plan,
      ),
      binding,
    )
    const workflow = Workflow.Info.make({
      id: Workflow.ID.make("wfl_offline_fixture"),
      type: "visual-build",
      status: "running",
      input,
      budget: { maxTokens: 240000, maxTurns: 156, maxToolCalls: 120, maxAttempts: 36 },
      usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
      location,
      version: 1,
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
    })
    const source = "<!doctype html><main>Reference fixture</main>"
    const spec = {
      schemaVersion: 1,
      goals: ["Fixture"],
      routes: [{ path: "/", goal: "Fixture" }],
      layoutConstraints: ["Fixture"],
      componentTree: [{ id: "root", component: "main", children: [] }],
      states: [{ name: "ready", description: "Ready" }],
      typography: [{ token: "body", family: "sans-serif", weight: 400, sizePx: 16, lineHeight: 1.5 }],
      colors: [{ token: "background", value: "#ffffff" }],
      responsiveRules: [{ viewport: "desktop", width: 32, height: 24, rules: ["Fit"] }],
      accessibilityRules: ["Semantic"],
      acceptanceCriteria: ["Renders"],
      projectStack: ["HTML"],
      referenceApp: {
        entrypoint: "index.html",
        readySelector: "main",
        files: [{ path: "index.html", sha256: Hash.sha256(source), size: Buffer.byteLength(source) }],
        viewports: [{ name: "desktop", width: 32, height: 24 }],
      },
    }
    const artifacts: Workflow.Artifact[] = []
    const roles = ["design", "decompose", "implement", "test", "repair", "test", "visual_review", "deliver"] as const
    for (const [index, role] of roles.entries()) {
      const revision = index >= 4 ? 1 : 0
      const stage = Workflow.Stage.make({
        id: Workflow.StageID.make(`wfs_offline_${index}`),
        workflowID: workflow.id,
        type: role,
        ordinal: index,
        status: "running",
        attempt: 1,
        maxAttempts: 4,
        recoveryPolicy: "restart_safe",
        idempotencyKey: `offline/${index}`,
        input: { revision },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1), started: DateTime.makeUnsafe(1) },
      })
      const contract = WorkflowRoleContract.build({
        workflow,
        stage,
        route: WorkflowRouting.resolve({ role, budget: workflow.budget, benchmarkTransport: binding }),
        priorArtifacts: artifacts,
      })
      const verdict =
        role === "deliver"
          ? "complete"
          : role === "test"
            ? revision === 0
              ? "revise"
              : "pass"
            : role === "visual_review"
              ? "pass"
              : "ready"
      const payload =
        role === "design"
          ? { spec, sources: [{ path: "index.html", content: source }] }
          : role === "decompose"
            ? {
                acceptanceCriteria: ["Renders"],
                tasks: [
                  {
                    id: "build",
                    title: "Build",
                    description: "Build",
                    acceptanceCriteria: ["Renders"],
                    dependsOn: [],
                    files: ["src/app.ts"],
                  },
                ],
              }
            : role === "visual_review"
              ? { verdict: "pass", score: 100, findings: [] }
              : { summary: "Deterministic offline fixture" }
      const semantic = WorkflowRoleContract.decode(contract, {
        contractVersion: 1,
        outcome: { schemaVersion: 1, role, verdict, revision },
        payload,
      })
      const settled = await WorkflowRoleExecution.settle({
        workflow,
        stage,
        contract,
        semantic,
        priorArtifacts: artifacts,
        settledToolEvidence: [],
        executionUsage: { tokens: 4, turns: 1, toolCalls: 0, attempts: 0 },
        providerUsage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      }).pipe(Effect.provide(WorkflowRoleExecution.deterministicLayer), Effect.runPromise)
      for (const commit of settled.artifacts)
        artifacts.push(
          Workflow.Artifact.make({
            ...commit,
            id: Workflow.ArtifactID.make(`wfa_offline_${artifacts.length}`),
            workflowID: workflow.id,
            stageID: stage.id,
            timeCreated: DateTime.makeUnsafe(index + 2),
          }),
        )
    }
    expect(artifacts.filter((artifact) => artifact.kind === "workflow.delivery")).toHaveLength(1)
    const screenshots = artifacts.filter((artifact) => artifact.mime === "image/png")
    expect(screenshots).toHaveLength(2)
    for (const { id: _id, workflowID: _workflowID, stageID: _stageID, timeCreated: _time, ...commit } of screenshots) {
      expect(
        WorkflowVisualReviewArtifact.decodeScreenshot(commit, workflow.id).evidenceReceipt?.coordinates.stageID,
      ).toBe(Workflow.StageID.make("wfs_offline_6"))
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
