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
import path from "node:path"
import { WorkflowProductionEvidenceServer } from "../src/workflow/production-evidence"

describe("Workflow production evidence Server composition", () => {
  test("owns the trusted implementation resolver and one normal/embedded composition factory", () => {
    expect(WorkflowProductionEvidenceServer.makeImplementationResolver).toBeFunction()
    expect(WorkflowProductionEvidenceServer.compositionNodes).toBeFunction()
  })

  test("reloads exact owner, revision, baseline, design, plan, and current workspace authority", async () => {
    const directory = await fs.mkdtemp("D:\\OpenCode-Task23.7b\\resolver-")
    try {
      const source = "<!doctype html><main>ready</main>"
      await fs.writeFile(path.join(directory, "index.html"), source)
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
      const workflowID = WorkflowSchema.ID.make("wfl_server_production_resolver")
      const designStage = stage(workflowID, "design", 0, 0)
      const decomposeStage = stage(workflowID, "decompose", 1, 0)
      const implementStage = stage(workflowID, "implement", 2, 0)
      const reviewStage = stage(workflowID, "visual_review", 3, 0, "running")
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
      const materializationRoot = `${directory}-materializations`
      let materializationFences = 0
      let rejectMaterializationRoot = false
      const resolver = WorkflowProductionEvidenceServer.makeImplementationResolver({
        getWorkflow: () => Effect.succeed(detail),
        captureSnapshot: () =>
          Effect.promise(async () => {
            capturedBytes = await fs.readFile(path.join(directory, "index.html"), "utf8")
            await fs.writeFile(path.join(directory, "index.html"), "changed after exact Snapshot capture")
            return Snapshot.ID.make("current")
          }),
        snapshotEntries: (_location, snapshot) => Effect.succeed(snapshot === baseline ? entries : currentEntries),
        materializationRoot: () => materializationRoot,
        verifyMaterializationRoot: async (root) => {
          expect(root).toBe(path.resolve(materializationRoot))
          materializationFences++
          if (rejectMaterializationRoot) throw new TypeError("hostile junction identity")
        },
        materializeSnapshot: (_location, _snapshot, target) =>
          Effect.promise(async () => {
            await fs.mkdir(target, { recursive: true })
            await fs.writeFile(path.join(target, "index.html"), capturedBytes)
            await fs.writeFile(path.join(directory, "index.html"), source)
          }),
      } as Parameters<typeof WorkflowProductionEvidenceServer.makeImplementationResolver>[0])
      await expect(resolver({ workflowID, revision: 1, plan: preview })).rejects.toThrow("Stage authority")
      const resolved = await resolver({ workflowID, revision: 0, plan: preview })
      expect(resolved).toMatchObject({
        implementationSha256: WorkflowImplementationArtifact.hash(manifest),
        readySelector: "main",
      })
      if (resolved.materialization === undefined) throw new Error("missing exact materialization")
      expect(await fs.readFile(path.join(resolved.materialization.root, "index.html"), "utf8")).toBe(source)
      expect(await fs.readFile(path.join(directory, "index.html"), "utf8")).toBe(source)
      expect(materializationFences).toBeGreaterThanOrEqual(4)
      const manager = WorkflowProductionEvidenceServer.makeMaterializationLeaseManager({
        root: () => materializationRoot,
        verifyRoot: async (root) => {
          expect(root).toBe(path.resolve(materializationRoot))
        },
        getWorkflow: () => Effect.succeed(detail),
      })
      const ownerRoot = path.dirname(resolved.materialization.root)
      expect(
        await manager.release({
          workflowID,
          stageID: WorkflowSchema.StageID.make("wfs_foreign_cleanup_owner"),
          revision: 0,
        }),
      ).toBe(false)
      expect(await fs.lstat(ownerRoot).then(() => true)).toBe(true)
      expect(await manager.release({ workflowID, stageID: reviewStage.id, revision: 0 })).toBe(true)
      expect(
        await fs.lstat(ownerRoot).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      currentEntries = Snapshot.canonicalEntries([
        { path: RelativePath.make("index.html"), type: "file", sha256: "f".repeat(64), size: 1 },
      ])
      await expect(resolver({ workflowID, revision: 0, plan: preview })).rejects.toThrow("Current workspace")
      currentEntries = entries
      rejectMaterializationRoot = true
      await expect(resolver({ workflowID, revision: 0, plan: preview })).rejects.toThrow("materialization")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
      await fs.rm(`${directory}-materializations`, { recursive: true, force: true })
    }
  })

  test("garbage-collects exact terminal leases fairly while retaining a foreign owner", async () => {
    const root = await fs.mkdtemp("D:\\OpenCode-Task23.7b\\lease-gc-")
    try {
      const details = new Map<string, WorkflowSchema.Detail>()
      const emptyArchive = await WorkflowWorkspaceMaterialization.seal([], async () => {
        throw new Error("empty archive has no readable entries")
      })
      for (let index = 0; index < 3; index++) {
        const workflowID = WorkflowSchema.ID.make(`wfl_gc_${index}`)
        const stageID = WorkflowSchema.StageID.make(`wfs_gc_${index}`)
        const location = Location.Ref.make({ directory: AbsolutePath.make(`D:\\workspace-${index}`) })
        const provisional = {
          workflowID,
          stageID,
          revision: 0,
          location,
          snapshotRef: Snapshot.ID.make(`snapshot-${index}`),
          manifestSha256: String(index + 1).repeat(64),
          workspaceSha256: emptyArchive.workspaceSha256,
        }
        const identity = WorkflowWorkspaceMaterialization.materializationID(provisional)
        const ownerRoot = path.join(root, identity)
        const treeRoot = path.join(ownerRoot, "tree")
        const leasesRoot = path.join(ownerRoot, "leases")
        await fs.mkdir(treeRoot, { recursive: true })
        await fs.mkdir(leasesRoot)
        await fs.writeFile(
          path.join(ownerRoot, "owner.json"),
          JSON.stringify({
            schemaVersion: 1,
            materializationID: identity,
            workflowID: provisional.workflowID,
            revision: provisional.revision,
            location: provisional.location,
            snapshotRef: provisional.snapshotRef,
            manifestSha256: provisional.manifestSha256,
            workspaceSha256: provisional.workspaceSha256,
          }),
        )
        const lease = WorkflowWorkspaceMaterialization.make({
          ...provisional,
          root: AbsolutePath.make(treeRoot),
          archive: emptyArchive,
        })
        await fs.writeFile(
          path.join(leasesRoot, `${lease.leaseID}.json`),
          JSON.stringify({ schemaVersion: 1, state: "active", lease, acquiredAt: 1 }),
        )
        const failed = stage(workflowID, "test", 0, 0, "failed")
        details.set(workflowID, {
          run: WorkflowSchema.Info.make({
            id: workflowID,
            type: "visual-build",
            status: "running",
            input: {},
            budget: {},
            usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
            version: 1,
            time: { created: DateTime.makeUnsafe(index + 1), updated: DateTime.makeUnsafe(index + 1) },
          }),
          stages: [{ ...failed, id: stageID }],
          artifacts: [],
        })
      }
      const foreign = "f".repeat(64)
      await fs.mkdir(path.join(root, foreign))
      await fs.writeFile(path.join(root, foreign, "foreign.txt"), "retain")
      const manager = WorkflowProductionEvidenceServer.makeMaterializationLeaseManager({
        root: () => root,
        verifyRoot: async () => undefined,
        getWorkflow: (id) => Effect.succeed(details.get(id)),
        batchSize: 1,
        now: () => 2,
      })

      for (let tick = 0; tick < 6; tick++) await manager.gcTick()

      const retained = (await fs.readdir(root)).sort()
      expect(retained).toEqual([foreign])
      expect(await fs.readFile(path.join(root, foreign, "foreign.txt"), "utf8")).toBe("retain")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("retains a materialization whose durable owner authority differs from its lease", async () => {
    const root = await fs.mkdtemp("D:\\OpenCode-Task23.7b\\lease-foreign-owner-")
    try {
      const emptyArchive = await WorkflowWorkspaceMaterialization.seal([], async () => {
        throw new Error("empty archive has no readable entries")
      })
      const workflowID = WorkflowSchema.ID.make("wfl_gc_owner_authority")
      const stageID = WorkflowSchema.StageID.make("wfs_gc_owner_authority")
      const location = Location.Ref.make({ directory: AbsolutePath.make("D:\\workspace-owner-authority") })
      const provisional = {
        workflowID,
        stageID,
        revision: 0,
        location,
        snapshotRef: Snapshot.ID.make("snapshot-owner-authority"),
        manifestSha256: "1".repeat(64),
        workspaceSha256: emptyArchive.workspaceSha256,
      }
      const identity = WorkflowWorkspaceMaterialization.materializationID(provisional)
      const ownerRoot = path.join(root, identity)
      const treeRoot = path.join(ownerRoot, "tree")
      const leasesRoot = path.join(ownerRoot, "leases")
      await fs.mkdir(treeRoot, { recursive: true })
      await fs.mkdir(leasesRoot)
      await fs.writeFile(
        path.join(ownerRoot, "owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          materializationID: identity,
          workflowID: "wfl_foreign_owner",
          revision: provisional.revision,
          location: provisional.location,
          snapshotRef: provisional.snapshotRef,
          manifestSha256: provisional.manifestSha256,
          workspaceSha256: provisional.workspaceSha256,
        }),
      )
      const lease = WorkflowWorkspaceMaterialization.make({
        ...provisional,
        root: AbsolutePath.make(treeRoot),
        archive: emptyArchive,
      })
      await fs.writeFile(
        path.join(leasesRoot, `${lease.leaseID}.json`),
        JSON.stringify({ schemaVersion: 1, state: "active", lease, acquiredAt: 1 }),
      )
      const manager = WorkflowProductionEvidenceServer.makeMaterializationLeaseManager({
        root: () => root,
        verifyRoot: async () => undefined,
        getWorkflow: () => Effect.succeed(undefined),
      })

      expect(await manager.release({ workflowID, stageID, revision: 0 })).toBe(false)
      expect(await fs.readFile(path.join(ownerRoot, "owner.json"), "utf8")).toContain("wfl_foreign_owner")

      await fs.writeFile(
        path.join(ownerRoot, "owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          materializationID: identity,
          workflowID: provisional.workflowID,
          revision: provisional.revision,
          location: provisional.location,
          snapshotRef: provisional.snapshotRef,
          manifestSha256: provisional.manifestSha256,
          workspaceSha256: provisional.workspaceSha256,
        }),
      )
      const outsideLease = path.join(root, "outside-lease.json")
      await fs.link(path.join(leasesRoot, `${lease.leaseID}.json`), outsideLease)
      expect(await manager.release({ workflowID, stageID, revision: 0 })).toBe(false)
      expect(await fs.readFile(outsideLease, "utf8")).toContain('"state":"active"')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
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
