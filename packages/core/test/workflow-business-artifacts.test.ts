import { describe, expect, test } from "bun:test"
import { WorkflowDecompositionArtifact } from "@opencode-ai/core/workflow/artifacts/decomposition"
import { WorkflowDeliveryArtifact } from "@opencode-ai/core/workflow/artifacts/delivery"
import { WorkflowImplementationArtifact } from "@opencode-ai/core/workflow/artifacts/implementation"
import { WorkflowTestArtifact } from "@opencode-ai/core/workflow/artifacts/test"
import { WorkflowTestLogArtifact } from "@opencode-ai/core/workflow/artifacts/test-log"
import * as WorkflowRoleBinding from "@opencode-ai/core/workflow/execution/role-binding"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/schema/schema"
import { VisualReview } from "@opencode-ai/schema/visual-review"
import { Delivery } from "@opencode-ai/schema/workflow-delivery-artifact"
import { Manifest } from "@opencode-ai/schema/workflow-implementation-artifact"
import { Result } from "@opencode-ai/schema/workflow-test-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { DateTime, Schema } from "effect"

const workflowID = Workflow.ID.make("wfl_business_artifacts")
const otherWorkflowID = Workflow.ID.make("wfl_other_business_artifacts")
const location = Location.Ref.make({ directory: AbsolutePath.make("D:\\workspace") })
const otherLocation = Location.Ref.make({ directory: AbsolutePath.make("D:\\other-workspace") })
const hash = "a".repeat(64)

const plan = {
  schemaVersion: 1,
  workflowID,
  revision: 3,
  snapshotRef: "snapshot:design-r3",
  acceptanceCriteria: ["The release page matches the approved design"],
  tasks: [
    {
      id: "release-page",
      title: "Implement release page",
      description: "Build the approved release page.",
      acceptanceCriteria: ["The primary action remains visible"],
      dependsOn: [],
      files: ["src/app.ts"],
    },
  ],
}

const manifest = {
  schemaVersion: 1,
  workflowID,
  revision: 3,
  snapshotRef: "snapshot:design-r3",
  workspaceSha256: hash,
  changes: [{ path: "src/app.ts", beforeSha256: "b".repeat(64), afterSha256: "c".repeat(64) }],
}

function passingTest(implementationSha256: string) {
  return {
    schemaVersion: 1,
    workflowID,
    revision: 3,
    implementationSha256,
    verdict: "pass" as const,
    tests: [
      {
        name: "unit",
        argv: ["bun", "test"],
        cwd: ".",
        exitCode: 0,
        log: {
          uri: `workflow://artifact/${workflowID}/test-log/${"d".repeat(64)}.txt`,
          sha256: "d".repeat(64),
          size: 96,
        },
      },
    ],
    preview: {
      workflowID,
      revision: 3,
      implementationSha256,
      uri: `workflow://preview/${workflowID}/r3/${implementationSha256}`,
    },
  }
}

function passingReview(): VisualReview.Artifact {
  return VisualReview.Artifact.make({
    schemaVersion: 1,
    revision: 3,
    verdict: "pass",
    score: 100,
    limits: { maxRevisions: 5, maxTokens: 1000, maxTurns: 2, maxToolCalls: 3 },
    usage: { tokens: 100, turns: 1, toolCalls: 2 },
    evidence: [
      {
        id: "reference-desktop",
        workflowID: DesignArtifact.SafeWorkflowID.make(workflowID),
        kind: "reference",
        viewport: "desktop",
        revision: 0,
        uri: "workflow://artifact/reference.png",
        mime: "image/png",
        sha256: "e".repeat(64),
        size: 64,
      },
      {
        id: "implementation-desktop",
        workflowID: DesignArtifact.SafeWorkflowID.make(workflowID),
        kind: "implementation",
        viewport: "desktop",
        revision: 3,
        uri: "workflow://artifact/implementation.png",
        mime: "image/png",
        sha256: "f".repeat(64),
        size: 64,
      },
    ],
    findings: [],
  })
}

function forge(commit: Workflow.ArtifactCommit, changes: Record<string, unknown>): Workflow.ArtifactCommit {
  const payload = {
    ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(commit.metadata.payload),
    ...changes,
  }
  const body = WorkflowImplementationArtifact.encode(payload)
  return Workflow.ArtifactCommit.make({
    ...commit,
    sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
    size: new TextEncoder().encode(body).byteLength,
    metadata: { payload },
  })
}

describe("workflow business artifact commits", () => {
  test("binds new durable test logs and results to the exact owning stage", () => {
    const stageID = Workflow.StageID.make("wfs_business_test")
    const commitExact = Reflect.get(WorkflowTestLogArtifact, "commitExact") as
      | ((
          workflowID: Workflow.ID,
          stageID: Workflow.StageID,
          revision: number,
          content: string,
        ) => Workflow.ArtifactCommit)
      | undefined
    expect(commitExact).toBeFunction()
    if (commitExact === undefined) return
    const log = commitExact(workflowID, stageID, 3, "tests passed\n")
    expect(log.uri).toBe(`workflow://artifact/${workflowID}/stages/${stageID}/test-log/r3/${log.sha256}.txt`)
    expect(() => WorkflowTestLogArtifact.decodeExact(log, workflowID, stageID, 3)).not.toThrow()
    expect(() => WorkflowTestLogArtifact.decodeExact(log, workflowID, Workflow.StageID.make("wfs_other"), 3)).toThrow()
    expect(() => WorkflowTestLogArtifact.decodeExact({ ...log, size: log.size + 1 }, workflowID, stageID, 3)).toThrow()
  })

  test("requires one exact durable log for every stage-owned test result reference", () => {
    const stageID = Workflow.StageID.make("wfs_business_test_binding")
    const workflow = Workflow.Info.make({
      id: workflowID,
      type: "visual-build",
      status: "running",
      input: {},
      location,
      budget: {},
      usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
      version: 1,
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
    })
    const stage = Workflow.Stage.make({
      id: stageID,
      workflowID,
      type: "test",
      ordinal: 1,
      status: "running",
      attempt: 1,
      maxAttempts: 2,
      recoveryPolicy: "restart_safe",
      idempotencyKey: "business/test-binding",
      input: { revision: 3 },
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
    })
    const log = WorkflowTestLogArtifact.commitExact(workflowID, stageID, 3, "tests passed\n")
    const implementationSha256 = "7".repeat(64)
    const result = {
      schemaVersion: 2 as const,
      workflowID,
      stageID,
      revision: 3,
      implementationSha256,
      verdict: "pass" as const,
      tests: [
        {
          name: "admission-frozen",
          argv: ["bun", "test"] as const,
          cwd: "." as const,
          exitCode: 0,
          log: { uri: log.uri, sha256: log.sha256, size: log.size },
        },
      ],
      preview: {
        workflowID,
        revision: 3,
        implementationSha256,
        uri: `workflow://preview/${workflowID}/r3/${implementationSha256}`,
      },
    }
    const testResult = WorkflowTestArtifact.commitExact(workflowID, stageID, location, result)
    const outcome = { schemaVersion: 1 as const, role: "test" as const, verdict: "pass" as const, revision: 3 }
    const validate = (artifacts: readonly Workflow.ArtifactCommit[]) =>
      WorkflowRoleBinding.validateBusinessArtifacts(workflow, stage, artifacts, [], outcome)

    expect(() => validate([testResult, log])).not.toThrow()
    expect(() => validate([testResult])).toThrow()
    expect(() => validate([testResult, log, log])).toThrow()
    expect(() => validate([testResult, { ...log, sha256: "8".repeat(64) }])).toThrow()
    expect(() => validate([testResult, { ...log, uri: `${log.uri}.wrong` }])).toThrow()
    expect(() => validate([testResult, { ...log, size: log.size + 1 }])).toThrow()
  })

  test("round-trips an exact v2 add/modify/delete implementation manifest and rejects invalid topology", () => {
    const exactManifest = {
      schemaVersion: 2 as const,
      workflowID,
      revision: 3,
      snapshotRef: "snapshot:design-r3",
      workspaceSha256: "9".repeat(64),
      changes: [
        { change: "added" as const, path: "src/added.ts", afterSha256: "1".repeat(64) },
        {
          change: "modified" as const,
          path: "src/app.ts",
          beforeSha256: "2".repeat(64),
          afterSha256: "3".repeat(64),
        },
        { change: "deleted" as const, path: "src/deleted.ts", beforeSha256: "4".repeat(64) },
      ],
    }
    const commit = WorkflowImplementationArtifact.commit(workflowID, location, exactManifest)
    expect(WorkflowImplementationArtifact.decode(commit, workflowID, location)).toEqual(
      Schema.decodeUnknownSync(Manifest)(exactManifest),
    )
    for (const invalid of [
      { ...exactManifest, changes: [{ change: "added", path: "src/app.ts", beforeSha256: hash, afterSha256: hash }] },
      {
        ...exactManifest,
        changes: [{ change: "modified", path: "src/app.ts", beforeSha256: hash, afterSha256: hash }],
      },
      { ...exactManifest, changes: [{ change: "deleted", path: "src/app.ts", afterSha256: hash }] },
      { ...exactManifest, changes: [] },
      {
        ...exactManifest,
        changes: [
          { change: "added", path: "src/App.ts", afterSha256: "1".repeat(64) },
          { change: "added", path: "src/app.ts", afterSha256: "2".repeat(64) },
        ],
      },
    ]) {
      expect(() => WorkflowImplementationArtifact.commit(workflowID, location, invalid)).toThrow()
    }
  })

  test("derives manifest hashes and add/modify/delete topology only from trusted Snapshot entries", () => {
    const derive = Reflect.get(WorkflowImplementationArtifact, "derive") as
      | ((input: {
          workflowID: Workflow.ID
          revision: number
          snapshotRef: Snapshot.ID
          before: readonly Snapshot.Entry[]
          after: readonly Snapshot.Entry[]
        }) => unknown)
      | undefined
    expect(derive).toBeFunction()
    if (!derive) return
    const before = Snapshot.canonicalEntries([
      { path: RelativePath.make("deleted.ts"), type: "file", sha256: "1".repeat(64), size: 1 },
      { path: RelativePath.make("modified.ts"), type: "file", sha256: "2".repeat(64), size: 2 },
      { path: RelativePath.make("same.ts"), type: "file", sha256: "3".repeat(64), size: 3 },
    ])
    const after = Snapshot.canonicalEntries([
      { path: RelativePath.make("added.ts"), type: "file", sha256: "4".repeat(64), size: 4 },
      { path: RelativePath.make("modified.ts"), type: "file", sha256: "5".repeat(64), size: 5 },
      { path: RelativePath.make("same.ts"), type: "file", sha256: "3".repeat(64), size: 3 },
    ])
    expect(
      derive({ workflowID, revision: 3, snapshotRef: Snapshot.ID.make("snapshot:design-r3"), before, after }),
    ).toEqual({
      schemaVersion: 2,
      workflowID,
      revision: 3,
      snapshotRef: "snapshot:design-r3",
      workspaceSha256: Snapshot.workspaceSha256(after),
      changes: [
        { change: "added", path: "added.ts", afterSha256: "4".repeat(64) },
        { change: "deleted", path: "deleted.ts", beforeSha256: "1".repeat(64) },
        {
          change: "modified",
          path: "modified.ts",
          beforeSha256: "2".repeat(64),
          afterSha256: "5".repeat(64),
        },
      ],
    })
    expect(() =>
      derive({
        workflowID,
        revision: 3,
        snapshotRef: Snapshot.ID.make("snapshot:design-r3"),
        before: [],
        after: [],
      }),
    ).toThrow()
    expect(() =>
      derive({
        workflowID,
        revision: 3,
        snapshotRef: Snapshot.ID.make("snapshot:design-r3"),
        before,
        after: [{ ...after[0], sha256: "caller supplied" }] as readonly Snapshot.Entry[],
      }),
    ).toThrow()
  })

  test("round-trips owner-bound decomposition, implementation, test, and delivery artifacts", () => {
    const planCommit = WorkflowDecompositionArtifact.commit(workflowID, location, plan)
    expect(WorkflowDecompositionArtifact.decode(planCommit, workflowID, location) as unknown).toEqual(plan)

    const manifestCommit = WorkflowImplementationArtifact.commit(workflowID, location, manifest)
    expect(manifestCommit.uri).not.toContain("D:")
    const durableManifest = WorkflowImplementationArtifact.decode(manifestCommit, workflowID, location)
    expect(durableManifest.changes[0]).toEqual(manifest.changes[0])

    const testResult = passingTest(WorkflowImplementationArtifact.hash(durableManifest))
    const testCommit = WorkflowTestArtifact.commit(workflowID, location, testResult)
    const durableTest = WorkflowTestArtifact.decode(testCommit, workflowID, location)
    expect(durableTest.tests[0].argv).toEqual(["bun", "test"])

    const review = passingReview()
    const delivery = {
      schemaVersion: 1 as const,
      workflowID,
      revision: 3,
      implementationSha256: WorkflowImplementationArtifact.hash(durableManifest),
      testSha256: WorkflowTestArtifact.hash(durableTest),
      visualReviewSha256: WorkflowDeliveryArtifact.hashVisualReview(review),
      summary: "Release page implemented and verified.",
    }
    const deliveryCommit = WorkflowDeliveryArtifact.commit(workflowID, location, delivery)
    const durableDelivery = WorkflowDeliveryArtifact.decode(deliveryCommit, workflowID, location)
    expect(() =>
      WorkflowDeliveryArtifact.validateDelivery({
        delivery: durableDelivery,
        manifest: durableManifest,
        test: durableTest,
        review,
      }),
    ).not.toThrow()
  })

  test("rejects wrong owner, location, revision, hash, size, kind, MIME, URI, and metadata fields", () => {
    const commit = WorkflowImplementationArtifact.commit(workflowID, location, manifest)
    expect(() => WorkflowImplementationArtifact.decode(commit, otherWorkflowID, location)).toThrow()
    expect(() => WorkflowImplementationArtifact.decode(commit, workflowID, otherLocation)).toThrow()
    expect(() =>
      WorkflowImplementationArtifact.decode({ ...commit, sha256: "f".repeat(64) }, workflowID, location),
    ).toThrow()
    expect(() =>
      WorkflowImplementationArtifact.decode({ ...commit, size: commit.size + 1 }, workflowID, location),
    ).toThrow()
    expect(() =>
      WorkflowImplementationArtifact.decode({ ...commit, kind: "workflow.prose" }, workflowID, location),
    ).toThrow()
    expect(() =>
      WorkflowImplementationArtifact.decode({ ...commit, mime: "text/plain" }, workflowID, location),
    ).toThrow()
    expect(() =>
      WorkflowImplementationArtifact.decode({ ...commit, uri: "workflow://artifact/elsewhere" }, workflowID, location),
    ).toThrow()
    expect(() =>
      WorkflowImplementationArtifact.decode(
        { ...commit, metadata: { ...commit.metadata, commentary: "trust me" } },
        workflowID,
        location,
      ),
    ).toThrow()
  })

  test("rejects cross-workflow and revision tampering even when an attacker rehashes metadata", () => {
    const commit = WorkflowTestArtifact.commit(workflowID, location, passingTest(hash))
    expect(() =>
      WorkflowTestArtifact.decode(forge(commit, { workflowID: otherWorkflowID }), workflowID, location),
    ).toThrow()
    expect(() => WorkflowTestArtifact.decode(forge(commit, { revision: 2 }), workflowID, location)).toThrow()
  })

  test("rejects delivery references that are stale, mismatched, or not passing", () => {
    const implementationSha256 = WorkflowImplementationArtifact.hash(manifest)
    const testResult = passingTest(implementationSha256)
    const review = passingReview()
    const delivery = {
      schemaVersion: 1 as const,
      workflowID,
      revision: 3,
      implementationSha256,
      testSha256: WorkflowTestArtifact.hash(testResult),
      visualReviewSha256: WorkflowDeliveryArtifact.hashVisualReview(review),
      summary: "Release page implemented and verified.",
    }
    const durableManifest = Schema.decodeUnknownSync(Manifest)(manifest as unknown)
    const validate = (
      overrides: Record<string, unknown> = {},
      testOverride: unknown = testResult,
      reviewOverride: unknown = review,
    ) =>
      WorkflowDeliveryArtifact.validateDelivery({
        delivery: Schema.decodeUnknownSync(Delivery)({ ...delivery, ...overrides }),
        manifest: durableManifest,
        test: Schema.decodeUnknownSync(Result)(testOverride),
        review: Schema.decodeUnknownSync(VisualReview.Artifact)(reviewOverride),
      })

    expect(() => validate({ revision: 2 })).toThrow()
    expect(() => validate({ implementationSha256: "0".repeat(64) })).toThrow()
    expect(() => validate({ testSha256: "0".repeat(64) })).toThrow()
    expect(() => validate({ visualReviewSha256: "0".repeat(64) })).toThrow()
    expect(() =>
      validate({}, { ...testResult, verdict: "fail", tests: [{ ...testResult.tests[0], exitCode: 1 }] }),
    ).toThrow()
    expect(() =>
      validate({}, testResult, {
        ...review,
        verdict: "fail",
        score: 80,
        findings: [
          {
            id: "spacing",
            severity: "major",
            viewport: "desktop",
            selector: "main",
            region: "content",
            category: "spacing",
            expected: "24px",
            actual: "16px",
            evidenceImageIDs: ["reference-desktop", "implementation-desktop"],
            repair: "Use 24px spacing",
            requiresRecapture: true,
          },
        ],
      }),
    ).toThrow()
  })

  test("rejects prose and secret-bearing durable inputs", () => {
    expect(() => WorkflowImplementationArtifact.commit(workflowID, location, "Implemented everything")).toThrow()
    expect(() =>
      WorkflowDecompositionArtifact.commit(workflowID, location, {
        ...plan,
        tasks: [{ ...plan.tasks[0], description: `Bearer ${"x".repeat(24)}` }],
      }),
    ).toThrow()
  })
})
