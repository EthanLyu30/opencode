export * as WorkflowProductionEvidence from "./production-evidence"

import { Message } from "@opencode-ai/llm"
import { VisualReview } from "@opencode-ai/schema/visual-review"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { WorkflowTestArtifact as WorkflowTestArtifactSchema } from "@opencode-ai/schema/workflow-test-artifact"
import { Cause, Effect, Layer, Schema } from "effect"
import { Snapshot } from "../../snapshot"
import { Hash } from "../../util/hash"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowDecompositionArtifact } from "../artifacts/decomposition"
import { WorkflowDeliveryArtifact } from "../artifacts/delivery"
import { WorkflowDesignArtifact } from "../artifacts/design"
import { WorkflowImplementationArtifact } from "../artifacts/implementation"
import { WorkflowTestArtifact } from "../artifacts/test"
import { WorkflowTestLogArtifact } from "../artifacts/test-log"
import { WorkflowVisualReviewArtifact } from "../artifacts/visual-review"
import { WorkflowProductionHostPlan } from "../production-host-plan"
import { WorkflowSecretGuard } from "../secret-guard"
import { WorkflowVisualHost } from "../visual-host"
import { WorkflowWorkspaceMaterialization } from "../workspace-materialization"
import { WorkflowRoleContract } from "./contract"
import { WorkflowRoleExecution } from "./role"
import * as WorkflowRoleBinding from "./role-binding"

export interface FunctionalTestRequest {
  readonly workflowID: WorkflowRoleExecution.ResolverInput["workflow"]["id"]
  readonly stageID: WorkflowRoleExecution.ResolverInput["stage"]["id"]
  readonly revision: number
  readonly location: WorkflowRoleExecution.ResolverInput["location"]
  readonly argv: WorkflowProductionHostPlan.FunctionalTest["argv"]
  readonly cwd: "."
  readonly policySha256: string
  readonly configSha256: string
  readonly materialization: WorkflowWorkspaceMaterialization.Lease
}

export interface Dependencies {
  readonly captureSnapshot: (
    location: WorkflowRoleExecution.ResolverInput["location"],
  ) => Effect.Effect<Snapshot.ID | undefined, unknown>
  readonly snapshotEntries: (
    location: WorkflowRoleExecution.ResolverInput["location"],
    snapshot: Snapshot.ID,
  ) => Effect.Effect<readonly Snapshot.Entry[], unknown>
  readonly materializeWorkspace: (input: {
    readonly workflowID: WorkflowRoleExecution.ResolverInput["workflow"]["id"]
    readonly stageID: WorkflowRoleExecution.ResolverInput["stage"]["id"]
    readonly revision: number
    readonly location: WorkflowRoleExecution.ResolverInput["location"]
    readonly manifestSha256: string
    readonly workspaceSha256: string
  }) => Effect.Effect<WorkflowWorkspaceMaterialization.Lease, unknown>
  readonly runFunctionalTest: (
    input: FunctionalTestRequest,
  ) => Effect.Effect<{ readonly exitCode: number; readonly log: string }, unknown>
  readonly visualHost: WorkflowVisualHost.Interface
}

export function layer(dependencies: Dependencies): Layer.Layer<WorkflowRoleExecution.Service> {
  return Layer.succeed(WorkflowRoleExecution.Service, WorkflowRoleExecution.Service.of(make(dependencies)))
}

export function make(dependencies: Dependencies): WorkflowRoleExecution.Interface {
  return {
    prepare: (input) => failClosed(prepare(dependencies, input)),
    resolve: (input) => failClosed(resolve(dependencies, input)),
  }
}

function prepare(
  dependencies: Dependencies,
  input: WorkflowRoleExecution.PrepareInput,
): Effect.Effect<WorkflowRoleExecution.Preparation, WorkflowRoleExecution.EvidenceFailure> {
  return Effect.scoped(
    Effect.gen(function* () {
      const role = yield* decodeRole(input.stage.type)
      if (role !== "test" && role !== "visual_review") return Object.freeze({})
      const plan = yield* decodeHostPlan(input.workflow)
      yield* verifyHostPlan(plan)
      const prior = yield* decodePrior(input.workflow, input.location, input.priorArtifacts)
      const manifest = yield* exactManifest(prior, input.workflow.id, input.location, input.revision)
      const implementationSha256 = WorkflowImplementationArtifact.hash(manifest)

      if (role === "test") {
        const materialization = yield* dependencies
          .materializeWorkspace({
            workflowID: input.workflow.id,
            stageID: input.stage.id,
            revision: input.revision,
            location: input.location,
            manifestSha256: implementationSha256,
            workspaceSha256: manifest.workspaceSha256,
          })
          .pipe(
            Effect.mapError(() =>
              evidenceFailure("workspace_stale", "Exact implementation materialization is unavailable"),
            ),
          )
        yield* Effect.try({
          try: () =>
            WorkflowWorkspaceMaterialization.assertAuthority(materialization, {
              workflowID: input.workflow.id,
              stageID: input.stage.id,
              revision: input.revision,
              location: input.location,
              manifestSha256: implementationSha256,
              workspaceSha256: manifest.workspaceSha256,
            }),
          catch: () => evidenceFailure("workspace_stale", "Exact implementation materialization is invalid"),
        })
        const executed = yield* dependencies
          .runFunctionalTest({
            workflowID: input.workflow.id,
            stageID: input.stage.id,
            revision: input.revision,
            location: input.location,
            argv: plan.functionalTest.argv,
            cwd: plan.functionalTest.cwd,
            policySha256: plan.functionalTest.policySha256,
            configSha256: plan.functionalTest.configSha256,
            materialization,
          })
          .pipe(Effect.mapError(() => evidenceFailure("functional_test_unavailable", "Frozen functional test failed")))
        if (
          !Number.isSafeInteger(executed.exitCode) ||
          typeof executed.log !== "string" ||
          Buffer.byteLength(executed.log) > WorkflowTestArtifactSchema.MAX_LOG_BYTES
        ) {
          return yield* evidenceFailure("invalid_test_evidence", "Functional test result is not bounded")
        }
        yield* safe(executed.log, "invalid_test_evidence", "Functional test log is unsafe")
        const message = Message.user(
          JSON.stringify({
            template: "workflow-role/test-host-facts@1",
            workflowID: input.workflow.id,
            revision: input.revision,
            implementationSha256,
            argv: plan.functionalTest.argv,
            cwd: plan.functionalTest.cwd,
            exitCode: executed.exitCode,
            log: executed.log,
          }),
        )
        const authority = preparationAuthority(role, input.revision, {
          implementationSha256,
          argv: plan.functionalTest.argv,
          cwd: plan.functionalTest.cwd,
          exitCode: executed.exitCode,
          logSha256: WorkflowBusinessArtifact.hash(executed.log),
        })
        return Object.freeze({
          messages: Object.freeze([message]),
          authority,
          test: Object.freeze({
            argv: Object.freeze([...plan.functionalTest.argv]),
            cwd: plan.functionalTest.cwd,
            exitCode: executed.exitCode,
            log: executed.log,
            implementationSha256,
          }),
        })
      }

      yield* requireCurrentWorkspace(dependencies, input.location, manifest.workspaceSha256)

      const specArtifact = uniquePrior(prior, WorkflowDesignArtifact.SPEC_KIND)
      const referenceArtifact = uniquePrior(prior, WorkflowDesignArtifact.REFERENCE_APP_KIND)
      if (!specArtifact || !referenceArtifact)
        return yield* evidenceFailure("visual_host_unavailable", "Visual review requires durable design authority")
      const spec = WorkflowDesignArtifact.decodeSpec(specArtifact.commit, input.workflow.id)
      const referenceApp = WorkflowDesignArtifact.decodeReferenceApp(referenceArtifact.commit, input.workflow.id)
      if (referenceApp.readySelector !== spec.referenceApp.readySelector)
        return yield* evidenceFailure("invalid_visual_authority", "Reference selector differs from the durable design")
      const referenceDependencies =
        input.revision === 0
          ? []
          : yield* reusableReferences(dependencies.visualHost, input.workflow.id, prior, spec, referenceApp)
      const referencePreview =
        referenceDependencies.length === 0
          ? yield* dependencies.visualHost
              .materializeReference({ workflowID: input.workflow.id, referenceApp })
              .pipe(Effect.mapError((error) => evidenceFailure(error.code, error.message)))
          : undefined
      const implementationPreview = yield* dependencies.visualHost
        .prepareImplementation({ workflowID: input.workflow.id, revision: input.revision, plan: plan.preview })
        .pipe(Effect.mapError((error) => evidenceFailure(error.code, error.message)))
      if (implementationPreview.identity.sourceSha256 !== implementationSha256)
        return yield* evidenceFailure(
          "invalid_visual_authority",
          "Implementation preview source differs from its manifest",
        )
      const newImages: WorkflowVisualReviewArtifact.CapturedImage[] = []
      const screenshots = yield* Effect.forEach(spec.referenceApp.viewports, (viewport, index) =>
        Effect.gen(function* () {
          const reference = yield* referencePreview === undefined
            ? Effect.try({
                try: () =>
                  WorkflowVisualReviewArtifact.decodeScreenshot(
                    referenceDependencies[index]?.commit ??
                      (() => {
                        throw new Error("Reference dependency order is incomplete")
                      })(),
                    input.workflow.id,
                  ),
                catch: () => evidenceFailure("invalid_visual_authority", "Reference dependency order is incomplete"),
              })
            : dependencies.visualHost.capture({ preview: referencePreview, stageID: input.stage.id, viewport }).pipe(
                Effect.mapError((error) => evidenceFailure(error.code, error.message)),
                Effect.map((captured) =>
                  WorkflowVisualReviewArtifact.capturedImage({
                    workflowID: input.workflow.id,
                    kind: "reference",
                    viewport: viewport.name,
                    revision: 0,
                    bytes: captured.bytes,
                    evidenceReceipt: captured.receipt,
                  }),
                ),
              )
          const implementation = yield* dependencies.visualHost
            .capture({ preview: implementationPreview, stageID: input.stage.id, viewport })
            .pipe(Effect.mapError((error) => evidenceFailure(error.code, error.message)))
          const implementationImage = WorkflowVisualReviewArtifact.capturedImage({
            workflowID: input.workflow.id,
            kind: "implementation",
            viewport: viewport.name,
            revision: input.revision,
            bytes: implementation.bytes,
            evidenceReceipt: implementation.receipt,
          })
          if (referencePreview !== undefined) newImages.push(reference)
          newImages.push(implementationImage)
          return [reference, implementationImage] as const
        }),
      )
      const images = screenshots.flat()
      const commits = Object.freeze(newImages.map(WorkflowVisualReviewArtifact.commitScreenshot))
      const dependencyArtifacts = referenceDependencies.map((dependency) => dependency.artifact)
      const dependencyArtifactSetSha256 =
        dependencyArtifacts.length === 0 ? undefined : WorkflowRoleBinding.artifactSetDigest(dependencyArtifacts)
      const authority = preparationAuthority(
        role,
        input.revision,
        {
          captures: images.map((image) => ({
            kind: image.kind,
            evidenceID: image.evidenceReceipt?.evidenceID,
            receiptSha256: WorkflowBusinessArtifact.hash(image.evidenceReceipt),
          })),
          dependencies: dependencyArtifacts.map((artifact) => ({
            id: artifact.id,
            stageID: artifact.stageID,
            sha256: artifact.sha256,
            timeCreated: artifact.timeCreated,
          })),
        },
        images.flatMap((image) => (image.evidenceReceipt === undefined ? [] : [image.evidenceReceipt])),
        dependencyArtifactSetSha256,
      )
      return Object.freeze({
        messages: Object.freeze([WorkflowVisualReviewArtifact.reviewMessage(spec, images)]),
        authority,
        artifacts: commits,
        ...(dependencyArtifacts.length === 0 ? {} : { dependencies: Object.freeze(dependencyArtifacts) }),
      })
    }),
  )
}

function resolve(
  dependencies: Dependencies,
  input: WorkflowRoleExecution.ResolverInput,
): Effect.Effect<WorkflowRoleExecution.ResolverOutput, WorkflowRoleExecution.EvidenceFailure> {
  return Effect.gen(function* () {
    const role = yield* decodeRole(input.stage.type)
    if (input.semantic.outcome.role !== role)
      return yield* evidenceFailure("invalid_role_evidence", "Semantic role differs from persisted authority")
    if (role === "design") {
      const payload = yield* decode(WorkflowRoleContract.DesignPayload, input.semantic.payload)
      return {
        artifacts: [
          WorkflowDesignArtifact.commitSpec(input.workflow.id, payload.spec),
          WorkflowDesignArtifact.commitReferenceApp(input.workflow.id, payload.spec, payload.sources),
        ],
      }
    }
    if (role === "decompose") {
      const payload = yield* decode(WorkflowRoleContract.DecomposePayload, input.semantic.payload)
      const baseline = yield* dependencies
        .captureSnapshot(input.location)
        .pipe(Effect.mapError(() => evidenceFailure("snapshot_required", "Baseline Snapshot capture failed")))
      if (baseline === undefined)
        return yield* evidenceFailure("snapshot_required", "A mandatory baseline Snapshot is unavailable")
      yield* dependencies
        .snapshotEntries(input.location, baseline)
        .pipe(Effect.mapError(() => evidenceFailure("snapshot_required", "Baseline Snapshot tree is unavailable")))
      return {
        artifacts: [
          WorkflowDecompositionArtifact.commit(input.workflow.id, input.location, {
            schemaVersion: 1,
            workflowID: input.workflow.id,
            revision: input.revision,
            snapshotRef: baseline,
            acceptanceCriteria: payload.acceptanceCriteria,
            tasks: payload.tasks,
          }),
        ],
      }
    }
    if (role === "implement" || role === "repair") {
      yield* decode(
        role === "implement" ? WorkflowRoleContract.ImplementPayload : WorkflowRoleContract.RepairPayload,
        input.semantic.payload,
      )
      const plan = uniquePrior(input.priorArtifacts, WorkflowDecompositionArtifact.KIND)
      if (!plan) return yield* evidenceFailure("snapshot_required", "Implementation requires a durable baseline plan")
      const decomposition = WorkflowDecompositionArtifact.decode(plan.commit, input.workflow.id, input.location)
      const before = yield* dependencies
        .snapshotEntries(input.location, Snapshot.ID.make(decomposition.snapshotRef))
        .pipe(Effect.mapError(() => evidenceFailure("snapshot_required", "Baseline Snapshot tree is unavailable")))
      const current = yield* dependencies
        .captureSnapshot(input.location)
        .pipe(Effect.mapError(() => evidenceFailure("snapshot_required", "Current Snapshot capture failed")))
      if (current === undefined)
        return yield* evidenceFailure("snapshot_required", "Current Snapshot capture is unavailable")
      const after = yield* dependencies
        .snapshotEntries(input.location, current)
        .pipe(Effect.mapError(() => evidenceFailure("snapshot_required", "Current Snapshot tree is unavailable")))
      const manifest = yield* Effect.try({
        try: () =>
          WorkflowImplementationArtifact.derive({
            workflowID: input.workflow.id,
            revision: input.revision,
            snapshotRef: Snapshot.ID.make(decomposition.snapshotRef),
            before,
            after,
          }),
        catch: () => evidenceFailure("invalid_implementation_manifest", "Implementation manifest derivation failed"),
      })
      return { artifacts: [WorkflowImplementationArtifact.commit(input.workflow.id, input.location, manifest)] }
    }
    if (role === "test") {
      yield* decode(WorkflowRoleContract.TestPayload, input.semantic.payload)
      const test = input.preparation?.test
      if (!test) return yield* evidenceFailure("invalid_test_evidence", "Functional test preparation is missing")
      const log = WorkflowTestLogArtifact.commitExact(input.workflow.id, input.stage.id, input.revision, test.log)
      const verdict = test.exitCode === 0 ? ("pass" as const) : ("fail" as const)
      const result = {
        schemaVersion: 2 as const,
        workflowID: input.workflow.id,
        stageID: input.stage.id,
        revision: input.revision,
        implementationSha256: test.implementationSha256,
        verdict,
        tests: [
          {
            name: "admission-frozen",
            argv: test.argv,
            cwd: test.cwd,
            exitCode: test.exitCode,
            log: { uri: log.uri, sha256: log.sha256, size: log.size },
          },
        ],
        preview: {
          workflowID: input.workflow.id,
          revision: input.revision,
          implementationSha256: test.implementationSha256,
          uri: `workflow://preview/${input.workflow.id}/r${input.revision}/${test.implementationSha256}`,
        },
      }
      return {
        artifacts: [WorkflowTestArtifact.commitExact(input.workflow.id, input.stage.id, input.location, result), log],
      }
    }
    if (role === "visual_review") {
      const proposal = yield* decode(WorkflowRoleContract.VisualPayload, input.semantic.payload)
      const screenshots = input.preparation?.artifacts
      if (!screenshots || screenshots.length === 0)
        return yield* evidenceFailure("invalid_visual_authority", "Visual screenshot preparation is missing")
      const dependencyArtifacts = input.preparation?.dependencies ?? []
      const decoded = [...dependencyArtifacts.map(toCommit), ...screenshots].map((artifact) =>
        WorkflowVisualReviewArtifact.decodeScreenshot(artifact, input.workflow.id),
      )
      const specArtifact = uniquePrior(input.priorArtifacts, WorkflowDesignArtifact.SPEC_KIND)
      if (!specArtifact)
        return yield* evidenceFailure("invalid_visual_authority", "Visual review design authority is missing")
      const spec = WorkflowDesignArtifact.decodeSpec(specArtifact.commit, input.workflow.id)
      const manifest = yield* exactManifest(input.priorArtifacts, input.workflow.id, input.location, input.revision)
      const plan = yield* decodeHostPlan(input.workflow)
      yield* verifyHostPlan(plan)
      yield* Effect.try({
        try: () =>
          validatePreparedScreenshotAuthority({
            workflowID: input.workflow.id,
            stageID: input.stage.id,
            revision: input.revision,
            screenshots,
            dependencies: dependencyArtifacts,
            authority: input.preparation?.authority,
            implementationSha256: WorkflowImplementationArtifact.hash(manifest),
            implementationConfigSha256: plan.preview.configSha256,
            referenceIdentity: WorkflowVisualHost.referenceIdentity(
              input.workflow.id,
              WorkflowDesignArtifact.decodeReferenceApp(
                uniquePrior(input.priorArtifacts, WorkflowDesignArtifact.REFERENCE_APP_KIND)?.commit ??
                  (() => {
                    throw new Error("missing reference")
                  })(),
                input.workflow.id,
              ),
            ),
            readySelector: spec.referenceApp.readySelector,
          }),
        catch: () =>
          evidenceFailure("invalid_visual_authority", "Current screenshot receipt authority is invalid or drifted"),
      })
      const images = spec.referenceApp.viewports.flatMap((viewport) => {
        const reference = decoded.filter(
          (image) => image.kind === "reference" && image.viewport === viewport.name && image.revision === 0,
        )
        const implementation = decoded.filter(
          (image) =>
            image.kind === "implementation" && image.viewport === viewport.name && image.revision === input.revision,
        )
        if (reference.length !== 1 || implementation.length !== 1)
          throw new Error("Visual review viewport authority is incomplete")
        return [reference[0], implementation[0]]
      })
      if (images.length !== decoded.length)
        return yield* evidenceFailure("invalid_visual_authority", "Visual review screenshot authority has extras")
      const evidence = images.map(({ bytes: _, evidenceReceipt: __, ...image }) => image)
      const findings = proposal.findings.map((finding) => ({
        ...finding,
        selector: "body",
        evidenceImageIDs: evidence.filter((image) => image.viewport === finding.viewport).map((image) => image.id),
      }))
      const review = yield* decode(VisualReview.Artifact, {
        schemaVersion: 1,
        revision: input.revision,
        verdict: proposal.verdict,
        score: proposal.score,
        limits: {
          maxRevisions: VisualReview.MAX_VISUAL_REVISIONS,
          maxTokens: input.execution.workflowBudget.maxTokens ?? 1,
          maxTurns: input.execution.workflowBudget.maxTurns ?? 1,
          maxToolCalls: input.execution.workflowBudget.maxToolCalls ?? 1,
        },
        usage: {
          tokens: input.execution.executionUsage.tokens,
          turns: input.execution.executionUsage.turns,
          toolCalls: input.execution.executionUsage.toolCalls,
        },
        evidence,
        findings,
      })
      return {
        artifacts: [...screenshots, WorkflowVisualReviewArtifact.commitReview(input.workflow.id, review)],
        ...(dependencyArtifacts.length === 0 ? {} : { dependencies: dependencyArtifacts }),
      }
    }

    const payload = yield* decode(WorkflowRoleContract.DeliverPayload, input.semantic.payload)
    const manifest = yield* exactManifest(input.priorArtifacts, input.workflow.id, input.location, input.revision)
    const testArtifact = uniqueRevision(input.priorArtifacts, WorkflowTestArtifact.KIND, input.revision)
    const reviewArtifact = uniqueRevision(
      input.priorArtifacts,
      WorkflowVisualReviewArtifact.REVIEW_KIND,
      input.revision,
    )
    if (!testArtifact || !reviewArtifact)
      return yield* evidenceFailure("delivery_evidence_stale", "Delivery requires same-revision test and review")
    const test = WorkflowTestArtifact.decodeExact(
      testArtifact.commit,
      input.workflow.id,
      testArtifact.artifact.stageID,
      input.location,
    )
    const review = WorkflowVisualReviewArtifact.decodeReview(reviewArtifact.commit, input.workflow.id)
    yield* requireCurrentWorkspace(dependencies, input.location, manifest.workspaceSha256)
    yield* Effect.try({
      try: () =>
        WorkflowRoleBinding.validateDeliveryEvidenceChain(
          input.workflow,
          input.location,
          input.revision,
          input.priorArtifacts.map((artifact) => artifact.artifact),
        ),
      catch: () => evidenceFailure("delivery_evidence_stale", "Delivery evidence dependency chain is incomplete"),
    })
    yield* requireCurrentWorkspace(dependencies, input.location, manifest.workspaceSha256)
    const delivery = {
      schemaVersion: 1 as const,
      workflowID: input.workflow.id,
      revision: input.revision,
      implementationSha256: WorkflowImplementationArtifact.hash(manifest),
      testSha256: WorkflowTestArtifact.hash(test),
      visualReviewSha256: WorkflowDeliveryArtifact.hashVisualReview(review),
      summary: payload.summary,
    }
    yield* Effect.try({
      try: () => WorkflowDeliveryArtifact.validateDelivery({ delivery, manifest, test, review }),
      catch: () => evidenceFailure("delivery_evidence_stale", "Delivery evidence is stale or not passing"),
    })
    return { artifacts: [WorkflowDeliveryArtifact.commit(input.workflow.id, input.location, delivery)] }
  })
}

function requireCurrentWorkspace(
  dependencies: Dependencies,
  location: WorkflowRoleExecution.ResolverInput["location"],
  expected: string,
) {
  return Effect.gen(function* () {
    const current = yield* dependencies
      .captureSnapshot(location)
      .pipe(Effect.mapError(() => evidenceFailure("workspace_stale", "Current workspace Snapshot failed")))
    const currentSnapshot = yield* current === undefined
      ? Effect.fail(evidenceFailure("workspace_stale", "Current workspace Snapshot is unavailable"))
      : Effect.succeed(current)
    const entries = yield* dependencies
      .snapshotEntries(location, currentSnapshot)
      .pipe(Effect.mapError(() => evidenceFailure("workspace_stale", "Current workspace tree is unavailable")))
    if (Snapshot.workspaceSha256(entries) !== expected)
      yield* evidenceFailure("workspace_stale", "Current workspace differs from the implementation manifest")
  })
}

function exactManifest(
  prior: readonly WorkflowRoleExecution.DecodedPriorArtifact[],
  workflowID: WorkflowRoleExecution.ResolverInput["workflow"]["id"],
  location: WorkflowRoleExecution.ResolverInput["location"],
  revision: number,
) {
  const artifact = uniqueRevision(prior, WorkflowImplementationArtifact.KIND, revision)
  if (!artifact)
    return Effect.fail(evidenceFailure("invalid_implementation_manifest", "Exact same-revision manifest is required"))
  return Effect.try({
    try: () => WorkflowImplementationArtifact.decodeExact(artifact.commit, workflowID, location),
    catch: () => evidenceFailure("invalid_implementation_manifest", "Exact implementation manifest is invalid"),
  })
}

function uniqueRevision(
  artifacts: readonly WorkflowRoleExecution.DecodedPriorArtifact[],
  kind: string,
  revision: number,
) {
  const matches = artifacts.filter(
    (artifact) =>
      artifact.kind === kind &&
      artifact.value !== null &&
      typeof artifact.value === "object" &&
      Reflect.get(artifact.value, "revision") === revision,
  )
  return matches.length === 1 ? matches[0] : undefined
}

function uniquePrior(artifacts: readonly WorkflowRoleExecution.DecodedPriorArtifact[], kind: string) {
  const matches = artifacts.filter((artifact) => artifact.kind === kind)
  return matches.length === 1 ? matches[0] : undefined
}

function preparationAuthority(
  role: WorkflowRole.Role,
  revision: number,
  value: unknown,
  evidenceReceipts: readonly WorkflowVisualHost.EvidenceReceipt[] = [],
  dependencyArtifactSetSha256?: string,
): WorkflowRoleExecution.PreparationAuthority {
  return Object.freeze({
    preparationVersion: 1,
    role,
    revision,
    sha256: WorkflowBusinessArtifact.hash(value),
    evidence: Object.freeze(
      evidenceReceipts.map((receipt) =>
        Object.freeze({
          evidenceID: receipt.evidenceID,
          receiptSha256: WorkflowBusinessArtifact.hash(receipt),
          coordinates: receipt.coordinates,
        }),
      ),
    ),
    ...(dependencyArtifactSetSha256 === undefined ? {} : { dependencyArtifactSetSha256 }),
  })
}

function validatePreparedScreenshotAuthority(input: {
  readonly workflowID: WorkflowRoleExecution.ResolverInput["workflow"]["id"]
  readonly stageID: WorkflowRoleExecution.ResolverInput["stage"]["id"]
  readonly revision: number
  readonly screenshots: readonly WorkflowRoleExecution.ResolverOutput["artifacts"][number][]
  readonly dependencies: readonly WorkflowRoleExecution.PrepareInput["priorArtifacts"][number][]
  readonly authority?: WorkflowRoleExecution.PreparationAuthority
  readonly implementationSha256: string
  readonly implementationConfigSha256: string
  readonly referenceIdentity: WorkflowVisualHost.PreviewIdentity
  readonly readySelector: string
}) {
  const authority = Schema.decodeUnknownSync(WorkflowRoleExecution.PreparationAuthority)(input.authority)
  if (authority.role !== "visual_review" || authority.revision !== input.revision)
    throw new Error("Visual preparation authority does not match the current stage")
  const current = input.screenshots.map((artifact) =>
    WorkflowVisualReviewArtifact.decodeScreenshot(artifact, input.workflowID),
  )
  const dependencies = input.dependencies.map((artifact) => ({
    artifact,
    image: WorkflowVisualReviewArtifact.decodeScreenshot(toCommit(artifact), input.workflowID),
  }))
  const rawReceipts = [
    ...dependencies.map(({ image }) => image.evidenceReceipt),
    ...current.map((image) => image.evidenceReceipt),
  ]
  if (rawReceipts.some((receipt) => receipt === undefined) || rawReceipts.length !== authority.evidence.length)
    throw new Error("Visual preparation receipts are missing or excessive")
  const receipts = rawReceipts.filter((receipt): receipt is WorkflowVisualHost.EvidenceReceipt => receipt !== undefined)
  const ids = new Set<string>()
  for (const image of current) {
    const receipt = image.evidenceReceipt!
    const expected =
      image.kind === "implementation"
        ? {
            stageID: input.stageID,
            revision: input.revision,
            configSha256: input.implementationConfigSha256,
            sourceSha256: input.implementationSha256,
            readySelectorSha256: Hash.sha256(input.readySelector),
          }
        : {
            stageID: input.stageID,
            revision: 0,
            configSha256: input.referenceIdentity.configSha256,
            sourceSha256: input.referenceIdentity.sourceSha256,
            readySelectorSha256: input.referenceIdentity.readySelectorSha256,
          }
    if (
      receipt.coordinates.workflowID !== input.workflowID ||
      receipt.coordinates.stageID !== expected.stageID ||
      receipt.coordinates.kind !== image.kind ||
      receipt.coordinates.revision !== expected.revision ||
      receipt.coordinates.configSha256 !== expected.configSha256 ||
      receipt.coordinates.sourceSha256 !== expected.sourceSha256 ||
      receipt.coordinates.readySelectorSha256 !== expected.readySelectorSha256
    )
      throw new Error("Current screenshot receipt differs from frozen preview identity")
  }
  for (const { artifact, image } of dependencies) {
    const receipt = image.evidenceReceipt!
    if (
      image.kind !== "reference" ||
      image.revision !== 0 ||
      receipt.coordinates.stageID !== artifact.stageID ||
      receipt.coordinates.configSha256 !== input.referenceIdentity.configSha256 ||
      receipt.coordinates.sourceSha256 !== input.referenceIdentity.sourceSha256 ||
      receipt.coordinates.readySelectorSha256 !== input.referenceIdentity.readySelectorSha256
    )
      throw new Error("Reference dependency receipt differs from original frozen identity")
  }
  for (const receipt of receipts) {
    if (ids.has(receipt.evidenceID)) throw new Error("Visual preparation receipt is duplicated")
    ids.add(receipt.evidenceID)
    const matches = authority.evidence.filter(
      (candidate) =>
        candidate.evidenceID === receipt.evidenceID &&
        candidate.receiptSha256 === WorkflowBusinessArtifact.hash(receipt) &&
        WorkflowBusinessArtifact.encode(candidate.coordinates) === WorkflowBusinessArtifact.encode(receipt.coordinates),
    )
    if (matches.length !== 1) throw new Error("Visual preparation receipt is absent or drifted")
  }
  const dependencyDigest =
    input.dependencies.length === 0 ? undefined : WorkflowRoleBinding.artifactSetDigest(input.dependencies)
  if (dependencyDigest !== authority.dependencyArtifactSetSha256)
    throw new Error("Visual preparation dependency authority drifted")
}

function reusableReferences(
  visualHost: WorkflowVisualHost.Interface,
  workflowID: WorkflowRoleExecution.PrepareInput["workflow"]["id"],
  prior: readonly WorkflowRoleExecution.DecodedPriorArtifact[],
  spec: ReturnType<typeof WorkflowDesignArtifact.decodeSpec>,
  referenceApp: ReturnType<typeof WorkflowDesignArtifact.decodeReferenceApp>,
) {
  return Effect.gen(function* () {
    const candidates = prior.filter(
      (artifact) => artifact.kind === WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND,
    )
    if (candidates.length !== spec.referenceApp.viewports.length)
      return yield* evidenceFailure(
        "invalid_visual_authority",
        "Later visual revisions require one exact durable reference per viewport",
      )
    const identity = yield* Effect.try({
      try: () => WorkflowVisualHost.referenceIdentity(workflowID, referenceApp),
      catch: () => evidenceFailure("invalid_visual_authority", "Durable reference identity is invalid"),
    })
    const ordered = spec.referenceApp.viewports.map((viewport) => {
      const matches = candidates.filter((candidate) => {
        const image = WorkflowVisualReviewArtifact.decodeScreenshot(candidate.commit, workflowID)
        const receipt = image.evidenceReceipt
        return (
          image.kind === "reference" &&
          image.revision === 0 &&
          image.viewport === viewport.name &&
          receipt !== undefined &&
          receipt.coordinates.stageID === candidate.artifact.stageID &&
          receipt.coordinates.viewport.name === viewport.name &&
          receipt.coordinates.viewport.width === viewport.width &&
          receipt.coordinates.viewport.height === viewport.height &&
          receipt.coordinates.configSha256 === identity.configSha256 &&
          receipt.coordinates.sourceSha256 === identity.sourceSha256 &&
          receipt.coordinates.readySelectorSha256 === identity.readySelectorSha256
        )
      })
      if (matches.length !== 1) throw new Error("Reference dependency identity is missing or ambiguous")
      return matches[0]
    })
    const ledger = yield* visualHost
      .reconcileEvidence({ workflowID, active: [], abandoned: [], committed: [] })
      .pipe(Effect.mapError((error) => evidenceFailure(error.code, error.message)))
    for (const dependency of ordered) {
      const image = WorkflowVisualReviewArtifact.decodeScreenshot(dependency.commit, workflowID)
      const receipt = image.evidenceReceipt
      if (receipt === undefined)
        return yield* evidenceFailure("invalid_visual_authority", "Reference dependency receipt is missing")
      const summary = [...ledger.committed, ...ledger.released].filter(
        (candidate) => candidate.evidenceID === receipt.evidenceID,
      )
      const binding = WorkflowVisualHost.evidenceArtifactBinding({ receipt, artifact: dependency.artifact })
      if (
        summary.length !== 1 ||
        summary[0]?.artifact === undefined ||
        WorkflowBusinessArtifact.encode(summary[0].artifact) !== WorkflowBusinessArtifact.encode(binding)
      )
        return yield* evidenceFailure(
          "invalid_visual_authority",
          "Reference dependency is missing, ambiguous, foreign, or identity-drifted",
        )
    }
    return Object.freeze(ordered)
  }).pipe(
    Effect.catch((error) =>
      error instanceof WorkflowRoleExecution.EvidenceFailure
        ? Effect.fail(error)
        : Effect.fail(evidenceFailure("invalid_visual_authority", "Reference dependency validation failed")),
    ),
  )
}

function decodePrior(
  workflow: WorkflowRoleExecution.PrepareInput["workflow"],
  location: WorkflowRoleExecution.PrepareInput["location"],
  artifacts: readonly WorkflowRoleExecution.PrepareInput["priorArtifacts"][number][],
) {
  return Effect.try({
    try: () => WorkflowRoleBinding.decodePriorArtifacts(workflow, location, artifacts),
    catch: () => evidenceFailure("invalid_prior_artifact", "Prior production evidence is invalid"),
  })
}

function decodeRole(input: unknown) {
  return decode(WorkflowRole.Role, input)
}

function decodeHostPlan(workflow: WorkflowRoleExecution.PrepareInput["workflow"]) {
  return Effect.try({
    try: () => WorkflowProductionHostPlan.fromWorkflow(workflow),
    catch: () => evidenceFailure("preview_configuration_required", "Production host plan is missing or invalid"),
  })
}

function verifyHostPlan(plan: WorkflowProductionHostPlan.Plan) {
  return Effect.try({
    try: () => WorkflowProductionHostPlan.verifyCurrentConfiguration(plan),
    catch: () => evidenceFailure("preview_configuration_required", "Production host configuration changed"),
  })
}

function safe(value: unknown, code: string, message: string) {
  return Effect.try({ try: () => WorkflowSecretGuard.assertSafe(value), catch: () => evidenceFailure(code, message) })
}

function decode<S extends Schema.Decoder<unknown>>(schema: S, input: unknown) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: () => evidenceFailure("invalid_role_evidence", "Production role evidence is invalid"),
  })
}

function evidenceFailure(code: string, message: string) {
  return new WorkflowRoleExecution.EvidenceFailure({ code, message })
}

function failClosed<A>(effect: Effect.Effect<A, WorkflowRoleExecution.EvidenceFailure>) {
  return effect.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause)
      return Effect.fail(
        error instanceof WorkflowRoleExecution.EvidenceFailure
          ? error
          : evidenceFailure("invalid_role_evidence", "Production role evidence is invalid"),
      )
    }),
  )
}

function toCommit(artifact: WorkflowRoleExecution.PrepareInput["priorArtifacts"][number]) {
  return {
    kind: artifact.kind,
    uri: artifact.uri,
    mime: artifact.mime,
    sha256: artifact.sha256,
    size: artifact.size,
    metadata: artifact.metadata,
  }
}
