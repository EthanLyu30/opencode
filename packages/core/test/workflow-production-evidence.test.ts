import { describe, expect, test } from "bun:test"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { VisualReview } from "@opencode-ai/schema/visual-review"
import { Workflow } from "@opencode-ai/schema/workflow"
import { AbsolutePath, RelativePath } from "@opencode-ai/schema/schema"
import { DateTime, Effect, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowProductionHostPlan } from "@opencode-ai/core/workflow/production-host-plan"
import { WorkflowProductionEvidence } from "@opencode-ai/core/workflow/execution/production-evidence"
import * as WorkflowRoleBinding from "@opencode-ai/core/workflow/execution/role-binding"
import { WorkflowRoleExecution } from "@opencode-ai/core/workflow/execution/role"
import { WorkflowDesignArtifact } from "@opencode-ai/core/workflow/artifacts/design"
import { WorkflowImplementationArtifact } from "@opencode-ai/core/workflow/artifacts/implementation"
import { WorkflowTestArtifact } from "@opencode-ai/core/workflow/artifacts/test"
import { WorkflowTestLogArtifact } from "@opencode-ai/core/workflow/artifacts/test-log"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { tmpdir } from "./fixture/tmpdir"

const workflowID = Workflow.ID.make("wfl_production_evidence")
const source = "<!doctype html><html><body><main>Reference</main></body></html>"
const sourceSha256 = new Bun.CryptoHasher("sha256").update(source).digest("hex")
const spec = DesignArtifact.Spec.make({
  schemaVersion: 1,
  goals: ["Render the approved reference"],
  routes: [{ path: "/", goal: "Show the reference" }],
  layoutConstraints: ["Keep the main content visible"],
  componentTree: [{ id: "root", component: "main", children: [] }],
  states: [{ name: "ready", description: "Ready" }],
  typography: [{ token: "body", family: "sans-serif", weight: 400, sizePx: 16, lineHeight: 1.5 }],
  colors: [{ token: "background", value: "#ffffff" }],
  responsiveRules: [
    { viewport: "desktop", width: 1280, height: 720, rules: ["Desktop"] },
    { viewport: "mobile", width: 390, height: 844, rules: ["Mobile"] },
  ],
  accessibilityRules: ["Use landmarks"],
  acceptanceCriteria: ["Reference renders"],
  projectStack: ["HTML"],
  referenceApp: {
    entrypoint: "index.html",
    readySelector: "main",
    files: [{ path: "index.html", sha256: sourceSha256, size: Buffer.byteLength(source) }],
    viewports: [
      { name: "desktop", width: 1280, height: 720 },
      { name: "mobile", width: 390, height: 844 },
    ],
  },
})

describe("Workflow production evidence", () => {
  test("fails closed when decompose cannot capture a mandatory baseline Snapshot", async () => {
    const service = WorkflowProductionEvidence.make({
      captureSnapshot: () => Effect.succeed(undefined),
      snapshotEntries: () => Effect.die("unused"),
      runFunctionalTest: () => Effect.die("unused"),
      visualHost: unavailableVisualHost(),
    })
    const fixture = await workflowFixture()
    const stage = roleStage("decompose", fixture.workflow)
    const failure = await Effect.runPromise(
      service
        .resolve({
          workflow: fixture.workflow,
          stage,
          revision: 0,
          location: fixture.location,
          priorArtifacts: [],
          semantic: {
            contractVersion: 1,
            outcome: { schemaVersion: 1, role: "decompose", verdict: "ready", revision: 0 },
            payload: {
              acceptanceCriteria: ["Match the reference"],
              tasks: [
                {
                  id: "page",
                  title: "Build page",
                  description: "Build it",
                  acceptanceCriteria: ["It renders"],
                  dependsOn: [],
                  files: ["src/app.ts"],
                },
              ],
            },
          },
          settledToolEvidence: [],
          admission: { workflowInput: fixture.workflow.input, stageInput: stage.input },
          contextDigest: "a".repeat(64),
          execution: {
            workflowUsage: fixture.workflow.usage,
            workflowBudget: fixture.workflow.budget,
            executionUsage: fixture.workflow.usage,
            providerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
        })
        .pipe(Effect.flip),
    )
    expect(failure).toBeInstanceOf(WorkflowRoleExecution.EvidenceFailure)
    expect(failure.code).toBe("snapshot_required")
  })

  test("prepares exact ordered paired media and reuses staged reference evidence without recapture", async () => {
    const fixture = await workflowFixture()
    const designStage = roleStage("design", fixture.workflow)
    const implementationStage = roleStage("implement", fixture.workflow)
    const reviewStage = roleStage("visual_review", fixture.workflow)
    const design = persisted(WorkflowDesignArtifact.commitSpec(workflowID, spec), designStage, "spec")
    const reference = persisted(
      WorkflowDesignArtifact.commitReferenceApp(workflowID, spec, [{ path: "index.html", content: source }]),
      designStage,
      "reference",
    )
    const entries = Snapshot.canonicalEntries([
      { path: RelativePath.make("index.html"), type: "file", sha256: sourceSha256, size: Buffer.byteLength(source) },
    ])
    const manifestValue = WorkflowImplementationArtifact.derive({
      workflowID,
      revision: 0,
      snapshotRef: Snapshot.ID.make("baseline"),
      before: [],
      after: entries,
    })
    const manifest = persisted(
      WorkflowImplementationArtifact.commit(workflowID, fixture.location, manifestValue),
      implementationStage,
      "manifest",
    )
    let captures = 0
    const evidenceStore = WorkflowVisualHost.makeFakeEvidenceStore()
    const prepared = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const service = WorkflowProductionEvidence.make({
            captureSnapshot: () => Effect.succeed(Snapshot.ID.make("current")),
            snapshotEntries: () => Effect.succeed(entries),
            runFunctionalTest: () => Effect.die("unused"),
            visualHost: host,
          })
          const input = {
            workflow: fixture.workflow,
            stage: reviewStage,
            revision: 0,
            location: fixture.location,
            priorArtifacts: [design, reference, manifest],
            admission: { workflowInput: fixture.workflow.input, stageInput: reviewStage.input },
          }
          const first = yield* service.prepare(input)
          const second = yield* service.prepare(input)
          return { first, second }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHost.fakeLayer({
            evidenceStore,
            captureBytes: (input) => {
              captures++
              return WorkflowVisualHost.deterministicPng(input.viewport)
            },
            resolveImplementationContract: () => ({
              implementationSha256: WorkflowImplementationArtifact.hash(manifestValue),
              readySelector: "main",
            }),
          }),
        ),
      ),
    )
    const media = prepared.first.messages?.flatMap((message) => message.content).filter((part) => part.type === "media")
    expect(media?.map((part) => part.metadata)).toEqual([
      { imageID: expect.any(String), kind: "reference", viewport: "desktop", revision: 0 },
      { imageID: expect.any(String), kind: "implementation", viewport: "desktop", revision: 0 },
      { imageID: expect.any(String), kind: "reference", viewport: "mobile", revision: 0 },
      { imageID: expect.any(String), kind: "implementation", viewport: "mobile", revision: 0 },
    ])
    expect(prepared.second.authority).toEqual(prepared.first.authority)
    expect(captures).toBe(4)
  })

  test("grants a later revision the exact durable reference dependency without re-owning or recapturing it", async () => {
    const fixture = await workflowFixture()
    const designStage = roleStage("design", fixture.workflow)
    const implementationStage0 = roleStage("implement", fixture.workflow, 0)
    const reviewStage0 = roleStage("visual_review", fixture.workflow, 0)
    const implementationStage1 = roleStage("repair", fixture.workflow, 1)
    const reviewStage1 = roleStage("visual_review", fixture.workflow, 1)
    const design = persisted(WorkflowDesignArtifact.commitSpec(workflowID, spec), designStage, "spec")
    const reference = persisted(
      WorkflowDesignArtifact.commitReferenceApp(workflowID, spec, [{ path: "index.html", content: source }]),
      designStage,
      "reference",
    )
    const entries0 = Snapshot.canonicalEntries([
      { path: RelativePath.make("index.html"), type: "file", sha256: sourceSha256, size: Buffer.byteLength(source) },
    ])
    const entries1 = Snapshot.canonicalEntries([
      { path: RelativePath.make("index.html"), type: "file", sha256: "b".repeat(64), size: 1 },
    ])
    const manifestValue0 = WorkflowImplementationArtifact.derive({
      workflowID,
      revision: 0,
      snapshotRef: Snapshot.ID.make("baseline"),
      before: [],
      after: entries0,
    })
    const manifestValue1 = WorkflowImplementationArtifact.derive({
      workflowID,
      revision: 1,
      snapshotRef: Snapshot.ID.make("baseline"),
      before: [],
      after: entries1,
    })
    const manifest0 = persisted(
      WorkflowImplementationArtifact.commit(workflowID, fixture.location, manifestValue0),
      implementationStage0,
      "manifest-0",
    )
    const manifest1 = persisted(
      WorkflowImplementationArtifact.commit(workflowID, fixture.location, manifestValue1),
      implementationStage1,
      "manifest-1",
    )
    let captures = 0
    const evidenceStore = WorkflowVisualHost.makeFakeEvidenceStore()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          let currentEntries = entries0
          const service = WorkflowProductionEvidence.make({
            captureSnapshot: () => Effect.succeed(Snapshot.ID.make("current")),
            snapshotEntries: () => Effect.succeed(currentEntries),
            runFunctionalTest: () => Effect.die("unused"),
            visualHost: host,
          })
          const first = yield* service.prepare({
            workflow: fixture.workflow,
            stage: reviewStage0,
            revision: 0,
            location: fixture.location,
            priorArtifacts: [design, reference, manifest0],
            admission: { workflowInput: fixture.workflow.input, stageInput: reviewStage0.input },
          })
          const referenceDependencies = (first.artifacts ?? [])
            .filter((commit) => commit.kind === WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND)
            .map((commit, index) => persisted(commit, reviewStage0, `reference-${index}`))
          for (const artifact of referenceDependencies) {
            const image = WorkflowVisualReviewArtifact.decodeScreenshot(toCommit(artifact), workflowID)
            if (image.evidenceReceipt === undefined) throw new Error("missing receipt")
            yield* host.commitEvidence({ receipt: image.evidenceReceipt, artifact })
            yield* host.releaseEvidence({ receipt: image.evidenceReceipt, artifact })
          }
          currentEntries = entries1
          const second = yield* service.prepare({
            workflow: fixture.workflow,
            stage: reviewStage1,
            revision: 1,
            location: fixture.location,
            priorArtifacts: [design, reference, manifest0, ...referenceDependencies, manifest1],
            admission: { workflowInput: fixture.workflow.input, stageInput: reviewStage1.input },
          })
          const settled = yield* service.resolve({
            workflow: fixture.workflow,
            stage: reviewStage1,
            revision: 1,
            location: fixture.location,
            priorArtifacts: WorkflowRoleBinding.decodePriorArtifacts(fixture.workflow, fixture.location, [
              design,
              reference,
              manifest0,
              ...referenceDependencies,
              manifest1,
            ]),
            semantic: {
              contractVersion: 1,
              outcome: { schemaVersion: 1, role: "visual_review", verdict: "pass", revision: 1 },
              payload: { verdict: "pass", score: 100, findings: [] },
            },
            settledToolEvidence: [],
            admission: { workflowInput: fixture.workflow.input, stageInput: reviewStage1.input },
            contextDigest: "a".repeat(64),
            execution: {
              workflowUsage: fixture.workflow.usage,
              workflowBudget: fixture.workflow.budget,
              executionUsage: fixture.workflow.usage,
              providerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            },
            preparation: second,
          })
          return { second, settled, referenceDependencies }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHost.fakeLayer({
            evidenceStore,
            captureBytes: (input) => {
              captures++
              return WorkflowVisualHost.deterministicPng(input.viewport)
            },
            resolveImplementationContract: (input) => ({
              implementationSha256: WorkflowImplementationArtifact.hash(
                input.revision === 0 ? manifestValue0 : manifestValue1,
              ),
              readySelector: "main",
            }),
          }),
        ),
      ),
    )
    expect(result.second.dependencies).toEqual(result.referenceDependencies)
    expect(result.second.artifacts?.map((artifact) => artifact.kind)).toEqual([
      WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND,
      WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND,
    ])
    expect(
      result.second.messages?.flatMap((message) => message.content).filter((part) => part.type === "media").length,
    ).toBe(4)
    expect(captures).toBe(6)
    expect(result.settled.dependencies).toEqual(result.referenceDependencies)
    expect(result.settled.artifacts.map((artifact) => artifact.kind)).toEqual([
      WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND,
      WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND,
      WorkflowVisualReviewArtifact.REVIEW_KIND,
    ])
    const settledReview = WorkflowVisualReviewArtifact.decodeReview(result.settled.artifacts[2], workflowID)
    expect(settledReview.evidence.map((image) => [image.kind, image.viewport, image.revision])).toEqual([
      ["reference", "desktop", 0],
      ["implementation", "desktop", 1],
      ["reference", "mobile", 0],
      ["implementation", "mobile", 1],
    ])

    const reloadedDependencies = result.referenceDependencies.map((artifact) =>
      Schema.decodeUnknownSync(Workflow.Artifact)(Schema.encodeSync(Workflow.Artifact)(artifact)),
    )
    expect(() =>
      WorkflowRoleBinding.validateDependencies(
        fixture.workflow,
        reviewStage1,
        reloadedDependencies,
        result.referenceDependencies,
      ),
    ).not.toThrow()
  })

  test("refuses delivery when the live workspace changes immediately before settlement", async () => {
    const fixture = await workflowFixture()
    const implementationStage = roleStage("implement", fixture.workflow)
    const testStage = roleStage("test", fixture.workflow)
    const reviewStage = roleStage("visual_review", fixture.workflow)
    const deliveryStage = roleStage("deliver", fixture.workflow)
    const entries = Snapshot.canonicalEntries([
      { path: RelativePath.make("index.html"), type: "file", sha256: sourceSha256, size: Buffer.byteLength(source) },
    ])
    const changedEntries = Snapshot.canonicalEntries([
      { path: RelativePath.make("index.html"), type: "file", sha256: "c".repeat(64), size: 1 },
    ])
    const manifestValue = WorkflowImplementationArtifact.derive({
      workflowID,
      revision: 0,
      snapshotRef: Snapshot.ID.make("baseline"),
      before: [],
      after: entries,
    })
    const manifest = persisted(
      WorkflowImplementationArtifact.commit(workflowID, fixture.location, manifestValue),
      implementationStage,
      "delivery-manifest",
    )
    const log = WorkflowTestLogArtifact.commitExact(workflowID, testStage.id, 0, "tests passed\n")
    const implementationSha256 = WorkflowImplementationArtifact.hash(manifestValue)
    const testResult = {
      schemaVersion: 2 as const,
      workflowID,
      stageID: testStage.id,
      revision: 0,
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
        revision: 0,
        implementationSha256,
        uri: `workflow://preview/${workflowID}/r0/${implementationSha256}`,
      },
    }
    const testArtifact = persisted(
      WorkflowTestArtifact.commitExact(workflowID, testStage.id, fixture.location, testResult),
      testStage,
      "delivery-test",
    )
    const png = WorkflowVisualHost.deterministicPng({ name: "desktop", width: 1280, height: 720 })
    const { bytes: _referenceBytes, ...referenceEvidence } = WorkflowVisualReviewArtifact.capturedImage({
      workflowID,
      kind: "reference",
      viewport: "desktop",
      revision: 0,
      bytes: png,
    })
    const { bytes: _implementationBytes, ...implementationEvidence } = WorkflowVisualReviewArtifact.capturedImage({
      workflowID,
      kind: "implementation",
      viewport: "desktop",
      revision: 0,
      bytes: png,
    })
    const reviewValue = VisualReview.Artifact.make({
      schemaVersion: 1,
      revision: 0,
      verdict: "pass",
      score: 100,
      limits: { maxRevisions: 5, maxTokens: 1000, maxTurns: 2, maxToolCalls: 3 },
      usage: { tokens: 0, turns: 0, toolCalls: 0 },
      evidence: [referenceEvidence, implementationEvidence],
      findings: [],
    })
    const review = persisted(
      WorkflowVisualReviewArtifact.commitReview(workflowID, reviewValue),
      reviewStage,
      "delivery-review",
    )
    let captures = 0
    const service = WorkflowProductionEvidence.make({
      captureSnapshot: () => {
        captures++
        return Effect.succeed(Snapshot.ID.make("stale-current"))
      },
      snapshotEntries: () => Effect.succeed(changedEntries),
      runFunctionalTest: () => Effect.die("unused"),
      visualHost: unavailableVisualHost(),
    })
    const failure = await Effect.runPromise(
      service
        .resolve({
          workflow: fixture.workflow,
          stage: deliveryStage,
          revision: 0,
          location: fixture.location,
          priorArtifacts: WorkflowRoleBinding.decodePriorArtifacts(fixture.workflow, fixture.location, [
            manifest,
            testArtifact,
            review,
          ]),
          semantic: {
            contractVersion: 1,
            outcome: { schemaVersion: 1, role: "deliver", verdict: "complete", revision: 0 },
            payload: { summary: "Delivery ready." },
          },
          settledToolEvidence: [],
          admission: { workflowInput: fixture.workflow.input, stageInput: deliveryStage.input },
          contextDigest: "a".repeat(64),
          execution: {
            workflowUsage: fixture.workflow.usage,
            workflowBudget: fixture.workflow.budget,
            executionUsage: fixture.workflow.usage,
            providerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
        })
        .pipe(Effect.flip),
    )
    expect(failure).toBeInstanceOf(WorkflowRoleExecution.EvidenceFailure)
    expect(failure.code).toBe("workspace_stale")
    expect(captures).toBe(1)
  })
})

async function workflowFixture() {
  const tmp = await tmpdir()
  await fs.writeFile(path.join(tmp.path, "index.html"), source)
  const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
  const preview = PreviewPlan.freeze({ authority: "admission", location })
  const hostPlan = WorkflowProductionHostPlan.freeze({ authority: "admission", location, preview })
  const workflow = Workflow.Info.make({
    id: workflowID,
    type: "visual-build",
    status: "running",
    input: WorkflowProductionHostPlan.withPlan({ brief: "Build it" }, hostPlan),
    budget: { maxTokens: 1000, maxTurns: 4, maxToolCalls: 4, maxAttempts: 2 },
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
    location,
    version: 1,
    time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
  })
  return { tmp, location, workflow }
}

function roleStage(role: string, workflow: Workflow.Info, revision = 0): Workflow.Stage {
  return Workflow.Stage.make({
    id: Workflow.StageID.make(`wfs_production_${role}_${revision}`),
    workflowID: workflow.id,
    type: role,
    ordinal: 1,
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    recoveryPolicy: "restart_safe",
    idempotencyKey: `production/${role}`,
    input: { revision },
    time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
  })
}

function persisted(commit: Workflow.ArtifactCommit, stage: Workflow.Stage, suffix: string): Workflow.Artifact {
  return Workflow.Artifact.make({
    id: Workflow.ArtifactID.make(`wfa_production_${suffix}`),
    workflowID,
    stageID: stage.id,
    ...commit,
    timeCreated: DateTime.makeUnsafe(2),
  })
}

function toCommit(artifact: Workflow.Artifact): Workflow.ArtifactCommit {
  return Workflow.ArtifactCommit.make({
    kind: artifact.kind,
    uri: artifact.uri,
    mime: artifact.mime,
    sha256: artifact.sha256,
    size: artifact.size,
    metadata: artifact.metadata,
  })
}

function unavailableVisualHost(): WorkflowVisualHost.Interface {
  return {
    materializeReference: () => Effect.die("unused"),
    prepareImplementation: () => Effect.die("unused"),
    capture: () => Effect.die("unused"),
    lookupEvidence: () => Effect.die("unused"),
    commitEvidence: () => Effect.die("unused"),
    releaseEvidence: () => Effect.die("unused"),
    abandonEvidence: () => Effect.die("unused"),
    reconcileEvidence: () => Effect.die("unused"),
    recoverExpired: () => Effect.die("unused"),
  }
}
