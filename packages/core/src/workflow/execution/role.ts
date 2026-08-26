export * as WorkflowRoleExecution from "./role"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { VisualReview } from "@opencode-ai/schema/visual-review"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { WorkflowTestArtifact as WorkflowTestArtifactSchema } from "@opencode-ai/schema/workflow-test-artifact"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { Hash } from "../../util/hash"
import { makeGlobalNode } from "../../effect/app-node"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowDecompositionArtifact } from "../artifacts/decomposition"
import { WorkflowDeliveryArtifact } from "../artifacts/delivery"
import { WorkflowDesignArtifact } from "../artifacts/design"
import { WorkflowImplementationArtifact } from "../artifacts/implementation"
import { WorkflowTestArtifact } from "../artifacts/test"
import { WorkflowVisualReviewArtifact } from "../artifacts/visual-review"
import { WorkflowStageMachine } from "../stage-machine"
import { WorkflowRoleContract } from "./contract"

export const TEST_LOG_KIND = "workflow.test.log"
export const TEST_LOG_MIME = "text/plain; charset=utf-8"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const Sha256 = DesignArtifact.Sha256
export const Receipt = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  workflowID: Workflow.ID,
  stageID: Workflow.StageID,
  role: WorkflowRole.Role,
  revision: Schema.Number,
  contractFingerprint: Sha256,
  contextDigest: Sha256,
  requiredArtifactSetSha256: Sha256,
  outcomeSha256: Sha256,
}).annotate({ identifier: "WorkflowRoleExecution.Receipt", ...exact })
export interface Receipt extends Schema.Schema.Type<typeof Receipt> {}

const TestLogPayload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: Schema.Number,
  encoding: Schema.Literal("utf8"),
  content: Schema.String.check(
    Schema.makeFilter<string>((content) =>
      Buffer.byteLength(content, "utf8") <= WorkflowTestArtifactSchema.MAX_LOG_BYTES
        ? undefined
        : `Test log must not exceed ${WorkflowTestArtifactSchema.MAX_LOG_BYTES} bytes`,
    ),
  ),
}).annotate({ identifier: "WorkflowRoleExecution.TestLogPayload", ...exact })

export interface DecodedPriorArtifact {
  readonly kind: string
  readonly commit: Workflow.ArtifactCommit
  readonly value: unknown
}

export interface ResolverInput {
  readonly workflow: {
    readonly id: Workflow.ID
    readonly type: string
  }
  readonly stage: {
    readonly id: Workflow.StageID
    readonly role: WorkflowRole.Role
  }
  readonly revision: number
  readonly location: Location.Ref
  readonly priorArtifacts: readonly DecodedPriorArtifact[]
  readonly semantic: WorkflowRoleContract.RoleResult
  readonly settledToolEvidence: readonly Workflow.ArtifactCommit[]
  readonly admission: {
    readonly workflowInput: Readonly<Record<string, unknown>>
    readonly stageInput: Readonly<Record<string, unknown>>
  }
  readonly contextDigest: string
}

export interface ResolverOutput {
  readonly artifacts: readonly Workflow.ArtifactCommit[]
}

export interface Interface {
  readonly resolve: (input: ResolverInput) => Effect.Effect<ResolverOutput, EvidenceFailure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkflowRoleEvidenceResolver") {}

export class EvidenceFailure extends Data.TaggedError("WorkflowRoleExecution.EvidenceFailure")<{
  readonly code: string
  readonly message: string
}> {}

export const failClosedLayer = Layer.succeed(
  Service,
  Service.of({
    resolve: () =>
      Effect.fail(
        new EvidenceFailure({
          code: "role_evidence_unavailable",
          message: "The production role evidence resolver is not installed",
        }),
      ),
  }),
)

export const deterministicLayer = Layer.succeed(
  Service,
  Service.of({
    resolve: (input) => Effect.try({ try: () => deterministicResolve(input), catch: resolverFailure }),
  }),
)

export const node = makeGlobalNode({ service: Service, layer: failClosedLayer, deps: [] })

export interface SettleInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly contract: WorkflowRoleContract.Contract
  readonly semantic: WorkflowRoleContract.RoleResult
  readonly priorArtifacts: ReadonlyArray<Workflow.Artifact>
  readonly settledToolEvidence: ReadonlyArray<Workflow.ArtifactCommit>
}

export interface Settlement {
  readonly artifacts: readonly Workflow.ArtifactCommit[]
  readonly receipt: Receipt
}

export const settle = Effect.fn("WorkflowRoleExecution.settle")(function* (input: SettleInput) {
  const resolver = yield* Service
  const location = input.workflow.location
  if (location === undefined)
    return yield* new EvidenceFailure({
      code: "workflow_location_required",
      message: "Role evidence requires Location",
    })
  if (input.contract.role !== input.stage.type)
    return yield* new EvidenceFailure({ code: "role_contract_mismatch", message: "Role contract does not match stage" })
  const semantic = yield* Effect.try({
    try: () => WorkflowRoleContract.decode(input.contract, input.semantic),
    catch: () => new EvidenceFailure({ code: "invalid_role_result", message: "Role result is invalid" }),
  })
  const contextDigest = WorkflowRoleContract.inputContextDigest({
    workflow: input.workflow,
    stage: input.stage,
    priorArtifacts: input.priorArtifacts,
  })
  if (contextDigest !== input.contract.contextDigest)
    return yield* new EvidenceFailure({
      code: "role_context_mismatch",
      message: "Role contract does not match its persisted input context",
    })
  const priorArtifacts = yield* Effect.try({
    try: () => decodePriorArtifacts(input.workflow.id, location, input.priorArtifacts),
    catch: () => new EvidenceFailure({ code: "invalid_prior_artifact", message: "Prior role artifact is invalid" }),
  })
  const resolved = yield* resolver.resolve({
    workflow: { id: input.workflow.id, type: input.workflow.type },
    stage: { id: input.stage.id, role: input.contract.role },
    revision: input.contract.revision,
    location,
    priorArtifacts,
    semantic,
    settledToolEvidence: input.settledToolEvidence,
    admission: { workflowInput: input.workflow.input, stageInput: input.stage.input },
    contextDigest,
  })
  yield* Effect.try({
    try: () =>
      validateBusinessArtifacts(
        input.workflow,
        input.stage,
        resolved.artifacts,
        input.priorArtifacts,
        semantic.outcome,
      ),
    catch: () => new EvidenceFailure({ code: "invalid_role_evidence", message: "Role business evidence is invalid" }),
  })
  const requiredArtifactSetSha256 = artifactSetDigest(resolved.artifacts)
  const binding = WorkflowStageMachine.OutcomeBinding.make({
    bindingVersion: 1,
    outcome: semantic.outcome,
    contractFingerprint: input.contract.contractFingerprint,
    contextDigest,
    requiredArtifactSetSha256,
  })
  const body = WorkflowStageMachine.encodeOutcome(binding)
  const outcome = Workflow.ArtifactCommit.make({
    kind: WorkflowStageMachine.OUTCOME_ARTIFACT_KIND,
    uri: `workflow://${input.stage.workflowID}/stages/${input.stage.id}/role-outcome.json`,
    mime: WorkflowStageMachine.OUTCOME_ARTIFACT_MIME,
    sha256: Hash.sha256(body),
    size: Buffer.byteLength(body),
    metadata: binding,
  })
  const receipt = Receipt.make({
    receiptVersion: 1,
    workflowID: input.workflow.id,
    stageID: input.stage.id,
    role: input.contract.role,
    revision: input.contract.revision,
    contractFingerprint: input.contract.contractFingerprint,
    contextDigest,
    requiredArtifactSetSha256,
    outcomeSha256: outcome.sha256,
  })
  return { artifacts: Object.freeze([...resolved.artifacts, outcome]), receipt }
})

export function requiredKinds(role: WorkflowRole.Role): readonly string[] {
  if (role === "design") return [WorkflowDesignArtifact.SPEC_KIND, WorkflowDesignArtifact.REFERENCE_APP_KIND]
  if (role === "decompose") return [WorkflowDecompositionArtifact.KIND]
  if (role === "implement" || role === "repair") return [WorkflowImplementationArtifact.KIND]
  if (role === "test") return [WorkflowTestArtifact.KIND, TEST_LOG_KIND]
  if (role === "visual_review")
    return [
      WorkflowVisualReviewArtifact.REVIEW_KIND,
      WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND,
      WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND,
    ]
  return [WorkflowDeliveryArtifact.KIND]
}

export interface ValidateSettlementInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly priorArtifacts: ReadonlyArray<Workflow.Artifact>
  readonly artifacts: ReadonlyArray<Workflow.Artifact | Workflow.ArtifactCommit>
  readonly receipt?: unknown
}

export function validateSettlement(input: ValidateSettlementInput): void {
  const role = Schema.decodeUnknownSync(WorkflowRole.Role)(input.stage.type)
  if (input.workflow.type !== "visual-build") {
    const outcomes = input.artifacts.filter((artifact) => artifact.kind === WorkflowStageMachine.OUTCOME_ARTIFACT_KIND)
    if (outcomes.length !== 1) throw new Error("Legacy role settlement requires one outcome")
    validateLegacyOutcome(outcomes[0])
    return
  }
  const receipt = Schema.decodeUnknownSync(Receipt)(input.receipt)
  if (
    receipt.workflowID !== input.workflow.id ||
    receipt.stageID !== input.stage.id ||
    receipt.role !== role ||
    receipt.revision !== revisionOf(input.stage)
  )
    throw new Error("Role receipt does not match the persisted stage")
  const contextDigest = WorkflowRoleContract.inputContextDigest({
    workflow: input.workflow,
    stage: input.stage,
    priorArtifacts: input.priorArtifacts,
  })
  if (receipt.contextDigest !== contextDigest) throw new Error("Role receipt input context mismatch")
  for (const artifact of input.artifacts) validateArtifactOwner(artifact, input.workflow.id, input.stage.id)
  const outcomes = input.artifacts.filter((artifact) => artifact.kind === WorkflowStageMachine.OUTCOME_ARTIFACT_KIND)
  if (outcomes.length !== 1) throw new Error("Role settlement requires exactly one outcome binding")
  const outcome = outcomes[0]
  const binding = WorkflowStageMachine.decodeOutcomeBinding(outcome)
  const encodedOutcome = WorkflowStageMachine.encodeOutcome(binding)
  if (
    binding.outcome.role !== role ||
    binding.outcome.revision !== revisionOf(input.stage) ||
    binding.contractFingerprint !== receipt.contractFingerprint ||
    binding.contextDigest !== receipt.contextDigest ||
    binding.requiredArtifactSetSha256 !== receipt.requiredArtifactSetSha256 ||
    outcome.sha256 !== receipt.outcomeSha256 ||
    outcome.uri !== `workflow://${input.workflow.id}/stages/${input.stage.id}/role-outcome.json` ||
    outcome.size !== Buffer.byteLength(encodedOutcome)
  )
    throw new Error("Role outcome binding does not match its receipt")
  const business = input.artifacts.filter(
    (artifact) => artifact.kind !== WorkflowStageMachine.OUTCOME_ARTIFACT_KIND && artifact.kind !== "tool-continuation",
  )
  validateBusinessArtifacts(input.workflow, input.stage, business, input.priorArtifacts, binding.outcome)
  if (artifactSetDigest(business) !== receipt.requiredArtifactSetSha256)
    throw new Error("Role business artifact set does not match its binding")
}

export function validateLegacyOutcome(artifact: Workflow.Artifact | Workflow.ArtifactCommit): void {
  if (Schema.is(WorkflowStageMachine.OutcomeBinding)(artifact.metadata))
    throw new Error("Bound role outcomes are not legacy outcomes")
  const outcome = Schema.decodeUnknownSync(WorkflowRole.Outcome)(artifact.metadata)
  if (
    artifact.kind !== WorkflowStageMachine.OUTCOME_ARTIFACT_KIND ||
    artifact.mime !== WorkflowStageMachine.OUTCOME_ARTIFACT_MIME ||
    artifact.sha256 !== Hash.sha256(WorkflowStageMachine.encodeOutcome(outcome))
  )
    throw new Error("Legacy role outcome is invalid")
}

export function artifactSetDigest(artifacts: ReadonlyArray<Workflow.Artifact | Workflow.ArtifactCommit>): string {
  return WorkflowBusinessArtifact.hash(WorkflowRoleContract.canonicalArtifacts(artifacts))
}

function validateBusinessArtifacts(
  workflow: Workflow.Info,
  stage: Workflow.Stage,
  artifacts: ReadonlyArray<Workflow.Artifact | Workflow.ArtifactCommit>,
  priorArtifacts: ReadonlyArray<Workflow.Artifact>,
  outcome: WorkflowRole.Outcome,
): void {
  const location = workflow.location
  if (location === undefined) throw new Error("Role business evidence requires Location")
  const role = Schema.decodeUnknownSync(WorkflowRole.Role)(stage.type)
  const revision = revisionOf(stage)
  if (outcome.role !== role || outcome.revision !== revision)
    throw new Error("Role outcome does not match its business evidence context")
  if (artifacts.some((artifact) => artifact.kind === WorkflowStageMachine.OUTCOME_ARTIFACT_KIND))
    throw new Error("Outcome artifacts are not business evidence")
  const allowed = new Set(requiredKinds(role))
  if (artifacts.some((artifact) => artifact.kind === "tool-continuation" || !allowed.has(artifact.kind)))
    throw new Error("Role business evidence contains an unexpected artifact")
  for (const artifact of artifacts) validateArtifactOwner(artifact, workflow.id, stage.id)
  const count = (kind: string) => artifacts.filter((artifact) => artifact.kind === kind)

  if (role === "design") {
    const specs = count(WorkflowDesignArtifact.SPEC_KIND)
    const references = count(WorkflowDesignArtifact.REFERENCE_APP_KIND)
    if (specs.length !== 1 || references.length !== 1 || artifacts.length !== 2)
      throw new Error("Design evidence requires one specification and one reference app")
    const spec = WorkflowDesignArtifact.decodeSpec(toCommit(specs[0]), workflow.id)
    const reference = WorkflowDesignArtifact.decodeReferenceApp(toCommit(references[0]), workflow.id)
    if (
      reference.entrypoint !== spec.referenceApp.entrypoint ||
      reference.readySelector !== spec.referenceApp.readySelector
    )
      throw new Error("Reference app does not match the design specification")
    return
  }

  if (role === "decompose") {
    const plans = count(WorkflowDecompositionArtifact.KIND)
    if (plans.length !== 1 || artifacts.length !== 1) throw new Error("Decompose evidence requires one plan")
    const plan = WorkflowDecompositionArtifact.decode(toCommit(plans[0]), workflow.id, location)
    if (plan.revision !== revision) throw new Error("Decomposition revision mismatch")
    return
  }

  if (role === "implement" || role === "repair") {
    const manifests = count(WorkflowImplementationArtifact.KIND)
    if (manifests.length !== 1 || artifacts.length !== 1)
      throw new Error("Implementation evidence requires one manifest")
    const manifest = WorkflowImplementationArtifact.decode(toCommit(manifests[0]), workflow.id, location)
    if (manifest.revision !== revision) throw new Error("Implementation revision mismatch")
    return
  }

  if (role === "test") {
    const results = count(WorkflowTestArtifact.KIND)
    const logs = count(TEST_LOG_KIND)
    if (results.length !== 1 || logs.length === 0 || artifacts.length !== 1 + logs.length)
      throw new Error("Test evidence requires one result and every durable log")
    const result = WorkflowTestArtifact.decode(toCommit(results[0]), workflow.id, location)
    if (result.revision !== revision) throw new Error("Test result revision mismatch")
    if (outcome.role !== "test" || outcome.verdict !== (result.verdict === "pass" ? "pass" : "revise"))
      throw new Error("Test outcome does not match the durable test result")
    const references = new Map(result.tests.map((record) => [record.log.uri, record.log]))
    if (references.size !== result.tests.length || references.size !== logs.length)
      throw new Error("Test logs must map one-to-one to test records")
    for (const log of logs) {
      const decoded = decodeTestLog(log, workflow.id, revision)
      const reference = references.get(log.uri)
      if (!reference || reference.sha256 !== log.sha256 || reference.size !== log.size || decoded === undefined)
        throw new Error("Test log does not match its result reference")
    }
    return
  }

  if (role === "visual_review") {
    const reviews = count(WorkflowVisualReviewArtifact.REVIEW_KIND)
    const screenshots = artifacts.filter(
      (artifact) =>
        artifact.kind === WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND ||
        artifact.kind === WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND,
    )
    if (reviews.length !== 1 || screenshots.length === 0 || artifacts.length !== 1 + screenshots.length)
      throw new Error("Visual review evidence requires one review and its exact screenshot set")
    const review = WorkflowVisualReviewArtifact.decodeReview(toCommit(reviews[0]), workflow.id)
    if (review.revision !== revision) throw new Error("Visual review revision mismatch")
    if (outcome.role !== "visual_review" || outcome.verdict !== (review.verdict === "pass" ? "pass" : "revise"))
      throw new Error("Visual review outcome does not match the durable review")
    const images = screenshots.map((artifact) =>
      WorkflowVisualReviewArtifact.decodeScreenshot(toCommit(artifact), workflow.id),
    )
    const expected = review.evidence.map(imageIdentity).sort()
    const actual = images.map(({ bytes: _, evidenceReceipt: __, ...image }) => imageIdentity(image)).sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Visual review screenshot set mismatch")
    return
  }

  const deliveries = count(WorkflowDeliveryArtifact.KIND)
  if (deliveries.length !== 1 || artifacts.length !== 1) throw new Error("Delivery evidence requires one artifact")
  const delivery = WorkflowDeliveryArtifact.decode(toCommit(deliveries[0]), workflow.id, location)
  if (delivery.revision !== revision) throw new Error("Delivery revision mismatch")
  const prior = decodePriorArtifacts(workflow.id, location, priorArtifacts)
  const manifestCommit = latestCommit(prior, WorkflowImplementationArtifact.KIND)
  const testCommit = latestCommit(prior, WorkflowTestArtifact.KIND)
  const reviewCommit = latestCommit(prior, WorkflowVisualReviewArtifact.REVIEW_KIND)
  if (!manifestCommit || !testCommit || !reviewCommit) throw new Error("Delivery is missing prior evidence")
  const manifest = WorkflowImplementationArtifact.decode(manifestCommit, workflow.id, location)
  const test = WorkflowTestArtifact.decode(testCommit, workflow.id, location)
  const review = WorkflowVisualReviewArtifact.decodeReview(reviewCommit, workflow.id)
  WorkflowDeliveryArtifact.validateDelivery({
    delivery,
    manifest,
    test,
    review,
  })
}

function validateArtifactOwner(
  artifact: Workflow.Artifact | Workflow.ArtifactCommit,
  workflowID: Workflow.ID,
  stageID: Workflow.StageID,
): void {
  if ("workflowID" in artifact && (artifact.workflowID !== workflowID || artifact.stageID !== stageID))
    throw new Error("Artifact belongs to a different workflow or stage")
}

function deterministicResolve(input: ResolverInput): ResolverOutput {
  const role = input.stage.role
  const semantic = input.semantic
  if (semantic.outcome.role !== role) throw new Error("Deterministic evidence role mismatch")
  if (semantic.outcome.role === "design") {
    const { spec, sources } = Schema.decodeUnknownSync(WorkflowRoleContract.DesignPayload)(semantic.payload)
    return {
      artifacts: [
        WorkflowDesignArtifact.commitSpec(input.workflow.id, spec),
        WorkflowDesignArtifact.commitReferenceApp(input.workflow.id, spec, sources),
      ],
    }
  }
  if (semantic.outcome.role === "decompose") {
    const payload = Schema.decodeUnknownSync(WorkflowRoleContract.DecomposePayload)(semantic.payload)
    return {
      artifacts: [
        WorkflowDecompositionArtifact.commit(input.workflow.id, input.location, {
          schemaVersion: 1,
          workflowID: input.workflow.id,
          revision: input.revision,
          snapshotRef: `snapshot:deterministic-${input.contextDigest.slice(0, 24)}`,
          acceptanceCriteria: payload.acceptanceCriteria,
          tasks: payload.tasks,
        }),
      ],
    }
  }
  if (semantic.outcome.role === "implement" || semantic.outcome.role === "repair") {
    Schema.decodeUnknownSync(
      semantic.outcome.role === "implement"
        ? WorkflowRoleContract.ImplementPayload
        : WorkflowRoleContract.RepairPayload,
    )(semantic.payload)
    const planCommit = latestCommit(input.priorArtifacts, WorkflowDecompositionArtifact.KIND)
    const plan =
      planCommit === undefined
        ? undefined
        : WorkflowDecompositionArtifact.decode(planCommit, input.workflow.id, input.location)
    const paths = [...new Set(plan?.tasks.flatMap((task) => task.files) ?? ["src/app.ts"])]
    const changes = paths.map((file) => ({
      path: file,
      afterSha256: WorkflowBusinessArtifact.hash({ file, revision: input.revision, context: input.contextDigest }),
    }))
    const workspaceSha256 = WorkflowBusinessArtifact.hash(changes)
    return {
      artifacts: [
        WorkflowImplementationArtifact.commit(input.workflow.id, input.location, {
          schemaVersion: 1,
          workflowID: input.workflow.id,
          revision: input.revision,
          snapshotRef: plan?.snapshotRef ?? `snapshot:deterministic-${input.contextDigest.slice(0, 24)}`,
          workspaceSha256,
          changes,
        }),
      ],
    }
  }
  if (semantic.outcome.role === "test") {
    Schema.decodeUnknownSync(WorkflowRoleContract.TestPayload)(semantic.payload)
    const manifestCommit = latestCommit(input.priorArtifacts, WorkflowImplementationArtifact.KIND)
    if (!manifestCommit) throw new Error("Deterministic test evidence requires an implementation manifest")
    const manifest = WorkflowImplementationArtifact.decode(manifestCommit, input.workflow.id, input.location)
    const implementationSha256 = WorkflowImplementationArtifact.hash(manifest)
    const pass = input.semantic.outcome.verdict === "pass"
    const content = pass ? "deterministic test pass\n" : "deterministic test failure\n"
    const log = commitTestLog(input.workflow.id, input.revision, content)
    const result = {
      schemaVersion: 1 as const,
      workflowID: input.workflow.id,
      revision: input.revision,
      implementationSha256,
      verdict: pass ? ("pass" as const) : ("fail" as const),
      tests: [
        {
          name: "deterministic",
          argv: ["bun", "test"],
          cwd: ".",
          exitCode: pass ? 0 : 1,
          log: { uri: log.uri, sha256: log.sha256, size: log.size },
        },
      ],
      preview: {
        workflowID: input.workflow.id,
        revision: input.revision,
        implementationSha256,
        uri: `workflow://preview/${input.workflow.id}/r${input.revision}/${implementationSha256}`,
      },
    }
    return { artifacts: [WorkflowTestArtifact.commit(input.workflow.id, input.location, result), log] }
  }
  if (semantic.outcome.role === "visual_review") {
    const proposal = Schema.decodeUnknownSync(WorkflowRoleContract.VisualPayload)(semantic.payload)
    const specCommit = latestCommit(input.priorArtifacts, WorkflowDesignArtifact.SPEC_KIND)
    const spec = specCommit === undefined ? undefined : WorkflowDesignArtifact.decodeSpec(specCommit, input.workflow.id)
    const viewports = spec?.referenceApp.viewports ?? [{ name: "desktop", width: 1, height: 1 }]
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    )
    const images = viewports.flatMap((viewport) => [
      WorkflowVisualReviewArtifact.capturedImage({
        workflowID: input.workflow.id,
        kind: "reference",
        viewport: viewport.name,
        revision: 0,
        bytes: png,
      }),
      WorkflowVisualReviewArtifact.capturedImage({
        workflowID: input.workflow.id,
        kind: "implementation",
        viewport: viewport.name,
        revision: input.revision,
        bytes: png,
      }),
    ])
    const [firstEvidence, ...restEvidence] = images.map(({ bytes: _, evidenceReceipt: __, ...image }) => image)
    if (!firstEvidence) throw new Error("Deterministic visual review requires evidence")
    const evidence = [firstEvidence, ...restEvidence] as const
    const findings = proposal.findings.map((finding) => ({
      ...finding,
      selector: "body",
      evidenceImageIDs: evidence.filter((image) => image.viewport === finding.viewport).map((image) => image.id),
    }))
    const review = Schema.decodeUnknownSync(VisualReview.Artifact)({
      schemaVersion: 1,
      revision: input.revision,
      verdict: proposal.verdict,
      score: proposal.score,
      limits: { maxRevisions: 10, maxTokens: 1, maxTurns: 1, maxToolCalls: 1 },
      usage: { tokens: 0, turns: 0, toolCalls: 0 },
      evidence,
      findings,
    })
    return {
      artifacts: [
        ...images.map(WorkflowVisualReviewArtifact.commitScreenshot),
        WorkflowVisualReviewArtifact.commitReview(input.workflow.id, review),
      ],
    }
  }
  const manifestCommit = latestCommit(input.priorArtifacts, WorkflowImplementationArtifact.KIND)
  const testCommit = latestCommit(input.priorArtifacts, WorkflowTestArtifact.KIND)
  const reviewCommit = latestCommit(input.priorArtifacts, WorkflowVisualReviewArtifact.REVIEW_KIND)
  if (!manifestCommit || !testCommit || !reviewCommit)
    throw new Error("Deterministic delivery evidence requires prior artifacts")
  const manifest = WorkflowImplementationArtifact.decode(manifestCommit, input.workflow.id, input.location)
  const test = WorkflowTestArtifact.decode(testCommit, input.workflow.id, input.location)
  const review = WorkflowVisualReviewArtifact.decodeReview(reviewCommit, input.workflow.id)
  const payload = Schema.decodeUnknownSync(WorkflowRoleContract.DeliverPayload)(semantic.payload)
  return {
    artifacts: [
      WorkflowDeliveryArtifact.commit(input.workflow.id, input.location, {
        schemaVersion: 1,
        workflowID: input.workflow.id,
        revision: input.revision,
        implementationSha256: WorkflowImplementationArtifact.hash(manifest),
        testSha256: WorkflowTestArtifact.hash(test),
        visualReviewSha256: WorkflowDeliveryArtifact.hashVisualReview(review),
        summary: payload.summary,
      }),
    ],
  }
}

function decodePriorArtifacts(
  workflowID: Workflow.ID,
  location: Location.Ref,
  artifacts: ReadonlyArray<Workflow.Artifact>,
): readonly DecodedPriorArtifact[] {
  const decoded: DecodedPriorArtifact[] = []
  for (const artifact of artifacts) {
    const commit = toCommit(artifact)
    if (artifact.kind === WorkflowDesignArtifact.SPEC_KIND)
      decoded.push({ kind: artifact.kind, commit, value: WorkflowDesignArtifact.decodeSpec(commit, workflowID) })
    else if (artifact.kind === WorkflowDesignArtifact.REFERENCE_APP_KIND)
      decoded.push({
        kind: artifact.kind,
        commit,
        value: WorkflowDesignArtifact.decodeReferenceApp(commit, workflowID),
      })
    else if (artifact.kind === WorkflowDecompositionArtifact.KIND)
      decoded.push({
        kind: artifact.kind,
        commit,
        value: WorkflowDecompositionArtifact.decode(commit, workflowID, location),
      })
    else if (artifact.kind === WorkflowImplementationArtifact.KIND)
      decoded.push({
        kind: artifact.kind,
        commit,
        value: WorkflowImplementationArtifact.decode(commit, workflowID, location),
      })
    else if (artifact.kind === WorkflowTestArtifact.KIND)
      decoded.push({ kind: artifact.kind, commit, value: WorkflowTestArtifact.decode(commit, workflowID, location) })
    else if (artifact.kind === WorkflowVisualReviewArtifact.REVIEW_KIND)
      decoded.push({
        kind: artifact.kind,
        commit,
        value: WorkflowVisualReviewArtifact.decodeReview(commit, workflowID),
      })
    else if (
      artifact.kind === WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND ||
      artifact.kind === WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND
    )
      decoded.push({
        kind: artifact.kind,
        commit,
        value: WorkflowVisualReviewArtifact.decodeScreenshot(commit, workflowID),
      })
    else if (artifact.kind === WorkflowDeliveryArtifact.KIND)
      decoded.push({
        kind: artifact.kind,
        commit,
        value: WorkflowDeliveryArtifact.decode(commit, workflowID, location),
      })
    else if (artifact.kind === TEST_LOG_KIND)
      decoded.push({ kind: artifact.kind, commit, value: decodeTestLog(commit, workflowID) })
  }
  return decoded
}

function toCommit(artifact: Workflow.Artifact | Workflow.ArtifactCommit): Workflow.ArtifactCommit {
  return Workflow.ArtifactCommit.make({
    kind: artifact.kind,
    uri: artifact.uri,
    mime: artifact.mime,
    sha256: artifact.sha256,
    size: artifact.size,
    metadata: artifact.metadata,
  })
}

function latestCommit(artifacts: readonly DecodedPriorArtifact[], kind: string): Workflow.ArtifactCommit | undefined {
  return artifacts.filter((artifact) => artifact.kind === kind).at(-1)?.commit
}

function commitTestLog(workflowID: Workflow.ID, revision: number, content: string): Workflow.ArtifactCommit {
  const owner = WorkflowBusinessArtifact.safeWorkflowID(workflowID)
  const bytes = Buffer.from(content, "utf8")
  const sha256 = Hash.sha256(bytes)
  return Workflow.ArtifactCommit.make({
    kind: TEST_LOG_KIND,
    uri: `workflow://artifact/${owner}/test-log/${sha256}.txt`,
    mime: TEST_LOG_MIME,
    sha256,
    size: bytes.byteLength,
    metadata: {
      payload: TestLogPayload.make({ schemaVersion: 1, workflowID: owner, revision, encoding: "utf8", content }),
    },
  })
}

function decodeTestLog(
  artifact: Workflow.Artifact | Workflow.ArtifactCommit,
  workflowID: Workflow.ID,
  revision?: number,
): string {
  if (artifact.kind !== TEST_LOG_KIND || artifact.mime !== TEST_LOG_MIME) throw new Error("Invalid test log kind")
  const keys = Reflect.ownKeys(artifact.metadata)
  if (keys.length !== 1 || !Object.hasOwn(artifact.metadata, "payload")) throw new Error("Invalid test log metadata")
  const payload = Schema.decodeUnknownSync(TestLogPayload)(artifact.metadata.payload)
  const owner = WorkflowBusinessArtifact.safeWorkflowID(workflowID)
  const bytes = Buffer.from(payload.content, "utf8")
  const sha256 = Hash.sha256(bytes)
  if (
    payload.workflowID !== owner ||
    (revision !== undefined && payload.revision !== revision) ||
    artifact.uri !== `workflow://artifact/${owner}/test-log/${sha256}.txt` ||
    artifact.sha256 !== sha256 ||
    artifact.size !== bytes.byteLength
  )
    throw new Error("Test log identity mismatch")
  return payload.content
}

function imageIdentity(image: {
  readonly id: string
  readonly workflowID: string
  readonly kind: string
  readonly viewport: string
  readonly revision: number
  readonly uri: string
  readonly mime: string
  readonly sha256: string
  readonly size: number
}): string {
  return WorkflowBusinessArtifact.encode(image)
}

function revisionOf(stage: Workflow.Stage): number {
  const revision = stage.input.revision ?? 0
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    throw new Error("Role stage revision is invalid")
  return revision
}

function resolverFailure(error: unknown): EvidenceFailure {
  return error instanceof EvidenceFailure
    ? error
    : new EvidenceFailure({
        code: "role_evidence_invalid",
        message: error instanceof Error ? error.message : "Role evidence resolution failed",
      })
}
