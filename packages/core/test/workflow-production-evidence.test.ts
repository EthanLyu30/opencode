import { describe, expect, test } from "bun:test"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { VisualReview } from "@opencode-ai/schema/visual-review"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
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
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"
import { WorkflowStageMachine } from "@opencode-ai/core/workflow/stage-machine"
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
      materializeWorkspace: () => Effect.die("unused"),
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
            materializeWorkspace: () => Effect.die("unused"),
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

  test("runs the frozen test from materialized Snapshot bytes while the live workspace changes and is restored", async () => {
    const fixture = await workflowFixture()
    const implementationStage = roleStage("implement", fixture.workflow)
    const testStage = roleStage("test", fixture.workflow)
    const materializedRoot = path.join(fixture.tmp.path, "materialized")
    await fs.mkdir(materializedRoot)
    await fs.writeFile(path.join(materializedRoot, "index.html"), source)
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
      "materialized-test-manifest",
    )
    let observed = ""
    const service = WorkflowProductionEvidence.make({
      captureSnapshot: () => Effect.succeed(Snapshot.ID.make("current")),
      snapshotEntries: () => Effect.succeed(entries),
      materializeWorkspace: () =>
        Effect.succeed(
          WorkflowWorkspaceMaterialization.make({
            workflowID,
            stageID: testStage.id,
            revision: 0,
            location: fixture.location,
            snapshotRef: Snapshot.ID.make("current"),
            manifestSha256: WorkflowImplementationArtifact.hash(manifestValue),
            workspaceSha256: manifestValue.workspaceSha256,
            root: AbsolutePath.make(materializedRoot),
          }),
        ),
      runFunctionalTest: (request) =>
        Effect.promise(async () => {
          await fs.writeFile(path.join(fixture.tmp.path, "index.html"), "changed during test\n")
          observed = await fs.readFile(path.join(request.materialization.root, "index.html"), "utf8")
          await fs.writeFile(path.join(fixture.tmp.path, "index.html"), source)
          return { exitCode: 0, log: "pass\n" }
        }),
      visualHost: unavailableVisualHost(),
    } as Parameters<typeof WorkflowProductionEvidence.make>[0])

    await Effect.runPromise(
      service.prepare({
        workflow: fixture.workflow,
        stage: testStage,
        revision: 0,
        location: fixture.location,
        priorArtifacts: [manifest],
        admission: { workflowInput: fixture.workflow.input, stageInput: testStage.input },
      }),
    )

    expect(observed).toBe(source)
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
            materializeWorkspace: () => Effect.die("unused"),
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
          currentEntries = entries1
          const ambiguousFailure = yield* service
            .prepare({
              workflow: fixture.workflow,
              stage: reviewStage1,
              revision: 1,
              location: fixture.location,
              priorArtifacts: [design, reference, manifest0, ...referenceDependencies, manifest1],
              admission: { workflowInput: fixture.workflow.input, stageInput: reviewStage1.input },
            })
            .pipe(Effect.flip)
          for (const artifact of referenceDependencies) {
            const image = WorkflowVisualReviewArtifact.decodeScreenshot(toCommit(artifact), workflowID)
            if (image.evidenceReceipt === undefined) throw new Error("missing receipt")
            yield* host.commitEvidence({ receipt: image.evidenceReceipt, artifact })
            yield* host.releaseEvidence({ receipt: image.evidenceReceipt, artifact })
          }
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
          const original = second.artifacts?.[0]
          if (original === undefined) throw new Error("missing implementation screenshot")
          const decoded = WorkflowVisualReviewArtifact.decodeScreenshot(original, workflowID)
          if (decoded.evidenceReceipt === undefined) throw new Error("missing implementation receipt")
          const forgedReceipt = WorkflowVisualHost.capturedImage(
            {
              ...decoded.evidenceReceipt.coordinates,
              stageID: Workflow.StageID.make("wfs_foreign_visual_receipt"),
            },
            decoded.bytes,
          ).receipt
          const forged = WorkflowVisualReviewArtifact.commitScreenshot(
            WorkflowVisualReviewArtifact.capturedImage({
              workflowID,
              kind: decoded.kind,
              viewport: decoded.viewport,
              revision: decoded.revision,
              bytes: decoded.bytes,
              evidenceReceipt: forgedReceipt,
            }),
          )
          const forgedFailure = yield* service
            .resolve({
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
              preparation: {
                ...second,
                artifacts: [forged, ...(second.artifacts?.slice(1) ?? [])],
              },
            })
            .pipe(Effect.flip)
          return { second, settled, referenceDependencies, forgedFailure, ambiguousFailure }
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
    expect(result.forgedFailure).toMatchObject({ code: "invalid_visual_authority" })
    expect(result.ambiguousFailure).toMatchObject({ code: "reference_evidence_ambiguous" })
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
      materializeWorkspace: () => Effect.die("unused"),
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

  test("exact-resolves every delivery log, ordered screenshot, dependency, review, and outcome binding", async () => {
    const chain = await deliveryChainFixture()
    expect(() =>
      WorkflowRoleBinding.validateDeliveryEvidenceChain(
        chain.fixture.workflow,
        chain.fixture.location,
        0,
        chain.artifacts,
      ),
    ).not.toThrow()

    const mutations = [
      chain.artifacts.filter((artifact) => artifact !== chain.log),
      [
        ...chain.artifacts,
        Workflow.Artifact.make({ ...chain.log, id: Workflow.ArtifactID.make("wfa_production_duplicate_log") }),
      ],
      chain.artifacts.filter((artifact) => artifact !== chain.implementationScreenshot),
      chain.artifacts.map((artifact) =>
        artifact === chain.log
          ? Workflow.Artifact.make({ ...artifact, workflowID: Workflow.ID.make("wfl_foreign_delivery_chain") })
          : artifact,
      ),
      chain.artifacts.map((artifact) =>
        artifact === chain.implementationScreenshot
          ? Workflow.Artifact.make({ ...artifact, sha256: "f".repeat(64) })
          : artifact,
      ),
      chain.artifacts.filter((artifact) => artifact !== chain.testOutcome),
    ]
    for (const artifacts of mutations) {
      expect(() =>
        WorkflowRoleBinding.validateDeliveryEvidenceChain(chain.fixture.workflow, chain.fixture.location, 0, artifacts),
      ).toThrow()
    }
  })
})

async function deliveryChainFixture() {
  const fixture = await workflowFixture()
  const designStage = roleStage("design", fixture.workflow)
  const implementationStage = roleStage("implement", fixture.workflow)
  const testStage = roleStage("test", fixture.workflow)
  const reviewStage = roleStage("visual_review", fixture.workflow)
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
    "chain-manifest",
  )
  const logCommit = WorkflowTestLogArtifact.commitExact(workflowID, testStage.id, 0, "tests passed\n")
  const log = persisted(logCommit, testStage, "chain-log")
  const implementationSha256 = WorkflowImplementationArtifact.hash(manifestValue)
  const testValue = {
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
    WorkflowTestArtifact.commitExact(workflowID, testStage.id, fixture.location, testValue),
    testStage,
    "chain-test",
  )
  const screenshots = spec.referenceApp.viewports.flatMap((viewport) =>
    (["reference", "implementation"] as const).map((kind) => {
      const bytes = WorkflowVisualHost.deterministicPng(viewport)
      const receipt = WorkflowVisualHost.capturedImage(
        {
          schemaVersion: 1,
          workflowID,
          stageID: reviewStage.id,
          kind,
          revision: 0,
          viewport,
          configSha256: kind === "reference" ? "1".repeat(64) : "2".repeat(64),
          sourceSha256: kind === "reference" ? "3".repeat(64) : implementationSha256,
          readySelectorSha256: "4".repeat(64),
        },
        bytes,
      ).receipt
      return persisted(
        WorkflowVisualReviewArtifact.commitScreenshot(
          WorkflowVisualReviewArtifact.capturedImage({
            workflowID,
            kind,
            viewport: viewport.name,
            revision: 0,
            bytes,
            evidenceReceipt: receipt,
          }),
        ),
        reviewStage,
        `chain-${kind}-${viewport.name}`,
      )
    }),
  )
  const evidence = screenshots.map((artifact) => {
    const {
      bytes: _,
      evidenceReceipt: __,
      ...image
    } = WorkflowVisualReviewArtifact.decodeScreenshot(toCommit(artifact), workflowID)
    return image
  })
  const firstEvidence = evidence[0]
  if (firstEvidence === undefined) throw new Error("missing visual evidence")
  const reviewValue = VisualReview.Artifact.make({
    schemaVersion: 1,
    revision: 0,
    verdict: "pass",
    score: 100,
    limits: { maxRevisions: 5, maxTokens: 1000, maxTurns: 2, maxToolCalls: 3 },
    usage: { tokens: 0, turns: 0, toolCalls: 0 },
    evidence: [firstEvidence, ...evidence.slice(1)],
    findings: [],
  })
  const review = persisted(
    WorkflowVisualReviewArtifact.commitReview(workflowID, reviewValue),
    reviewStage,
    "chain-review",
  )
  const design = persisted(WorkflowDesignArtifact.commitSpec(workflowID, spec), designStage, "chain-spec")
  const manifestOutcome = boundOutcome(
    implementationStage,
    { schemaVersion: 1, role: "implement", verdict: "ready", revision: 0 },
    [manifest],
    "manifest",
  )
  const testOutcome = boundOutcome(
    testStage,
    { schemaVersion: 1, role: "test", verdict: "pass", revision: 0 },
    [log, testArtifact],
    "test",
  )
  const reviewOutcome = boundOutcome(
    reviewStage,
    { schemaVersion: 1, role: "visual_review", verdict: "pass", revision: 0 },
    [...screenshots, review],
    "review",
  )
  return {
    fixture,
    artifacts: [
      design,
      manifest,
      manifestOutcome,
      log,
      testArtifact,
      testOutcome,
      ...screenshots,
      review,
      reviewOutcome,
    ],
    log,
    implementationScreenshot: screenshots.find(
      (artifact) => artifact.kind === WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND,
    )!,
    testOutcome,
  }
}

function boundOutcome(
  stage: Workflow.Stage,
  outcome: WorkflowRole.Outcome,
  business: readonly Workflow.Artifact[],
  suffix: string,
) {
  const binding = WorkflowStageMachine.OutcomeBinding.make({
    bindingVersion: 1,
    outcome,
    contractFingerprint: "a".repeat(64),
    contextDigest: "b".repeat(64),
    requiredArtifactSetSha256: WorkflowRoleBinding.artifactSetDigest(business),
  })
  const body = WorkflowStageMachine.encodeOutcome(binding)
  return persisted(
    Workflow.ArtifactCommit.make({
      kind: WorkflowStageMachine.OUTCOME_ARTIFACT_KIND,
      uri: `workflow://${workflowID}/stages/${stage.id}/role-outcome.json`,
      mime: WorkflowStageMachine.OUTCOME_ARTIFACT_MIME,
      sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
      size: Buffer.byteLength(body),
      metadata: binding,
    }),
    stage,
    `chain-outcome-${suffix}`,
  )
}

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
