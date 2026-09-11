import { describe, expect, test } from "bun:test"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { WorkflowSchema } from "@opencode-ai/core/workflow"
import { WorkflowDecompositionArtifact } from "@opencode-ai/core/workflow/artifacts/decomposition"
import { WorkflowDesignArtifact } from "@opencode-ai/core/workflow/artifacts/design"
import { WorkflowImplementationArtifact } from "@opencode-ai/core/workflow/artifacts/implementation"
import { WorkflowRoleExecution } from "@opencode-ai/core/workflow/execution/role"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowProductionHostPlan } from "@opencode-ai/core/workflow/production-host-plan"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"
import { DateTime, Effect } from "effect"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { WorkflowProductionEvidenceServer } from "../src/workflow/production-evidence"

describe("Workflow production evidence Server composition", () => {
  test("owns the trusted implementation resolver and one normal/embedded composition factory", () => {
    expect(WorkflowProductionEvidenceServer.makeImplementationResolver).toBeFunction()
    expect(WorkflowProductionEvidenceServer.compositionNodes).toBeFunction()
  })

  test("treats a preview lease as live only while its Workflow is running and has no cancellation request", async () => {
    const workflowID = WorkflowSchema.ID.make("wfl_server_preview_lease_probe")
    const review = {
      ...stage(workflowID, "visual_review", 0, 0, "running"),
      leaseOwner: "preview-owner",
      leaseExpiresAt: DateTime.makeUnsafe(2_000),
    }
    const makeRun = (status: "running" | "failed", cancelRequestedAt?: number) =>
      WorkflowSchema.Info.make({
        id: workflowID,
        type: "visual-build",
        status,
        currentStageID: review.id,
        input: {},
        budget: {},
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
        version: 1,
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
        ...(cancelRequestedAt === undefined ? {} : { cancelRequestedAt: DateTime.makeUnsafe(cancelRequestedAt) }),
      })
    let detail = { run: makeRun("running"), stages: [review], artifacts: [] }
    const dependencies = { getWorkflow: () => Effect.succeed(detail) }
    const resolver = WorkflowProductionEvidenceServer.makePreviewLeaseResolver(dependencies, () => 1_000)
    const probe = WorkflowProductionEvidenceServer.makePreviewLeaseLiveProbe(dependencies, () => 1_000)
    const lease = await resolver(workflowID)

    expect(await probe(lease)).toBe(true)
    detail = { ...detail, run: makeRun("failed") }
    await expect(resolver(workflowID)).rejects.toThrow("Stage lease")
    expect(await probe(lease)).toBe(false)
    detail = { ...detail, run: makeRun("running", 900) }
    await expect(resolver(workflowID)).rejects.toThrow("Stage lease")
    expect(await probe(lease)).toBe(false)
  })

  test("reloads exact owner, revision, baseline, design, plan, and current workspace authority", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "workflow-production-resolver-"))
    try {
      const source = "<!doctype html><main>ready</main>"
      await fs.writeFile(path.join(directory, "index.html"), source)
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
      const workflowID = WorkflowSchema.ID.make("wfl_server_production_resolver")
      const designStage = stage(workflowID, "design", 0, 0)
      const decomposeStage = stage(workflowID, "decompose", 1, 0)
      const implementStage = stage(workflowID, "implement", 2, 0)
      const reviewStage = {
        ...stage(workflowID, "visual_review", 3, 0, "running"),
        leaseOwner: "production-resolver-owner",
        leaseExpiresAt: DateTime.makeUnsafe(4_000),
      }
      const sourceSha256 = new Bun.CryptoHasher("sha256").update(source).digest("hex")
      const spec = {
        schemaVersion: 1 as const,
        goals: ["Match the reference"],
        routes: [{ path: "/", goal: "Show it" }],
        layoutConstraints: ["Visible"],
        componentTree: [{ id: "root", component: "main", children: [] }],
        states: [{ name: "ready", description: "Ready" }],
        typography: [{ token: "body", family: "sans-serif", weight: 400, sizePx: 16, lineHeight: 1.5 }],
        colors: [{ token: "background", value: "#ffffff" }],
        responsiveRules: [{ viewport: "desktop", width: 1280, height: 720, rules: ["Desktop"] }],
        accessibilityRules: ["Use landmarks"],
        acceptanceCriteria: ["Matches"],
        projectStack: ["HTML"],
        referenceApp: {
          entrypoint: "index.html",
          readySelector: "main",
          files: [{ path: "index.html", sha256: sourceSha256, size: Buffer.byteLength(source) }],
          viewports: [{ name: "desktop", width: 1280, height: 720 }],
        },
      } as const
      const preview = PreviewPlan.freeze({ authority: "admission", location })
      const hostPlan = WorkflowProductionHostPlan.freeze({ authority: "admission", location, preview })
      const workflow = WorkflowSchema.Info.make({
        id: workflowID,
        type: "visual-build",
        status: "running",
        currentStageID: reviewStage.id,
        input: WorkflowProductionHostPlan.withPlan({}, hostPlan),
        budget: {},
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
        location,
        version: 1,
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
      })
      const baseline = Snapshot.ID.make("baseline")
      const entries = Snapshot.canonicalEntries([
        { path: RelativePath.make("index.html"), type: "file", sha256: sourceSha256, size: Buffer.byteLength(source) },
      ])
      const manifest = WorkflowImplementationArtifact.derive({
        workflowID,
        revision: 0,
        snapshotRef: baseline,
        before: [],
        after: entries,
      })
      const artifacts = [
        persisted(WorkflowDesignArtifact.commitSpec(workflowID, spec), designStage, "spec"),
        persisted(
          WorkflowDesignArtifact.commitReferenceApp(workflowID, spec, [{ path: "index.html", content: source }]),
          designStage,
          "reference",
        ),
        persisted(
          WorkflowDecompositionArtifact.commit(workflowID, location, {
            schemaVersion: 1,
            workflowID,
            revision: 0,
            snapshotRef: baseline,
            acceptanceCriteria: ["Matches"],
            tasks: [
              {
                id: "page",
                title: "Build",
                description: "Build",
                acceptanceCriteria: ["Matches"],
                dependsOn: [],
                files: ["index.html"],
              },
            ],
          }),
          decomposeStage,
          "plan",
        ),
        persisted(WorkflowImplementationArtifact.commit(workflowID, location, manifest), implementStage, "manifest"),
      ]
      const detail = { run: workflow, stages: [designStage, decomposeStage, implementStage, reviewStage], artifacts }
      let currentEntries = entries
      let capturedBytes = source
      const unexpectedCacheRoot = `${directory}-materializations`
      const resolver = WorkflowProductionEvidenceServer.makeImplementationResolver({
        getWorkflow: () => Effect.succeed(detail),
        captureSnapshot: () =>
          Effect.promise(async () => {
            capturedBytes = await fs.readFile(path.join(directory, "index.html"), "utf8")
            await fs.writeFile(path.join(directory, "index.html"), "changed after exact Snapshot capture")
            return Snapshot.ID.make("current")
          }),
        snapshotEntries: (_location, snapshot) => Effect.succeed(snapshot === baseline ? entries : currentEntries),
        snapshotContents: () =>
          Effect.promise(async () => {
            await fs.writeFile(path.join(directory, "index.html"), source)
            return currentEntries.map((entry) => ({ ...entry, bytes: Uint8Array.from(Buffer.from(capturedBytes)) }))
          }),
      })
      await expect(resolver({ workflowID, revision: 1, plan: preview })).rejects.toThrow("Stage authority")
      const resolved = await resolver({ workflowID, revision: 0, plan: preview })
      expect(resolved).toMatchObject({
        implementationSha256: WorkflowImplementationArtifact.hash(manifest),
        readySelector: "main",
      })
      const sealedSnapshot = resolved.sealedSnapshot
      expect(sealedSnapshot).toBeDefined()
      if (sealedSnapshot === undefined) return
      expect(
        Buffer.from(
          WorkflowWorkspaceMaterialization.bytes(sealedSnapshot.archive).get(RelativePath.make("index.html")) ?? [],
        ).toString("utf8"),
      ).toBe(source)
      expect(await fs.readFile(path.join(directory, "index.html"), "utf8")).toBe(source)
      expect(
        await fs.lstat(unexpectedCacheRoot).then(
          () => false,
          () => true,
        ),
      ).toBe(true)
      currentEntries = Snapshot.canonicalEntries([
        { path: RelativePath.make("index.html"), type: "file", sha256: "f".repeat(64), size: 1 },
      ])
      await expect(resolver({ workflowID, revision: 0, plan: preview })).rejects.toThrow("Current workspace")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})

function stage(
  workflowID: WorkflowSchema.ID,
  role: string,
  ordinal: number,
  revision: number,
  status: WorkflowSchema.Detail["stages"][number]["status"] = "succeeded",
): WorkflowSchema.Detail["stages"][number] {
  return {
    id: WorkflowSchema.StageID.make(`wfs_server_${role}_${revision}`),
    workflowID,
    type: role,
    ordinal,
    status,
    attempt: 1,
    maxAttempts: 2,
    recoveryPolicy: "restart_safe",
    idempotencyKey: `server/${role}/${revision}`,
    input: { revision },
    time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
  }
}

function persisted(
  commit: WorkflowRoleExecution.ResolverOutput["artifacts"][number],
  owner: WorkflowSchema.Detail["stages"][number],
  suffix: string,
): WorkflowSchema.Detail["artifacts"][number] {
  return {
    id: WorkflowSchema.ArtifactID.make(`wfa_server_${suffix}`),
    workflowID: owner.workflowID,
    stageID: owner.id,
    ...commit,
    timeCreated: DateTime.makeUnsafe(3),
  }
}
