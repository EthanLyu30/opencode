import { describe, expect, test } from "bun:test"
import { WorkflowDecompositionArtifact } from "@opencode-ai/core/workflow/artifacts/decomposition"
import { WorkflowDeliveryArtifact } from "@opencode-ai/core/workflow/artifacts/delivery"
import { WorkflowImplementationArtifact } from "@opencode-ai/core/workflow/artifacts/implementation"
import { WorkflowTestArtifact } from "@opencode-ai/core/workflow/artifacts/test"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { VisualReview } from "@opencode-ai/schema/visual-review"
import { Delivery } from "@opencode-ai/schema/workflow-delivery-artifact"
import { Manifest } from "@opencode-ai/schema/workflow-implementation-artifact"
import { Result } from "@opencode-ai/schema/workflow-test-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"

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
