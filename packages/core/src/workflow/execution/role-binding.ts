import { Message } from "@opencode-ai/llm"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { DateTime, Schema } from "effect"
import { Hash } from "../../util/hash"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowDecompositionArtifact } from "../artifacts/decomposition"
import { WorkflowDeliveryArtifact } from "../artifacts/delivery"
import { WorkflowDesignArtifact } from "../artifacts/design"
import { WorkflowImplementationArtifact } from "../artifacts/implementation"
import { WorkflowTestArtifact } from "../artifacts/test"
import { WorkflowTestLogArtifact } from "../artifacts/test-log"
import { WorkflowVisualReviewArtifact } from "../artifacts/visual-review"
import { WorkflowStageMachine } from "../stage-machine"
import { WorkflowProductionHostPlan } from "../production-host-plan"
import { WorkflowVisualHost } from "../visual-host"
import { WorkflowRoleContract } from "./contract"
import type { DecodedPriorArtifact } from "./role"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const Sha256 = DesignArtifact.Sha256
const ArtifactDigest = Schema.Struct({
  kind: Schema.NonEmptyString,
  uri: Schema.NonEmptyString,
  mime: Schema.NonEmptyString,
  sha256: Sha256,
  size: Schema.Number,
})
const MediaDigest = Schema.Struct({
  mediaType: Schema.NonEmptyString,
  sha256: Sha256,
  size: Schema.Number,
  filename: Schema.optional(Schema.String),
})
const ContractAuthority = Schema.Struct({
  authorityVersion: Schema.Literal(1),
  role: WorkflowRole.Role,
  revision: Schema.Number,
  route: Schema.Struct({
    role: WorkflowRole.Role,
    providerID: Schema.String,
    modelID: Schema.String,
    protocol: WorkflowRole.Protocol,
    reasoningEffort: WorkflowRole.ReasoningEffort,
    requiredCapabilities: Schema.Array(Schema.String),
  }),
  promptVersion: Schema.NonEmptyString,
  systemSha256: Sha256,
  messageSource: Schema.Literals(["default", "trusted"]),
  messagesSha256: Sha256,
  media: Schema.Array(MediaDigest),
  outputIdentifier: Schema.NonEmptyString,
  responseSchemaSha256: Sha256,
  permissionsSha256: Sha256,
  inputArtifacts: Schema.Array(ArtifactDigest),
  contextDigest: Sha256,
}).annotate({ identifier: "WorkflowRoleExecution.ContractAuthority", ...exact })

const ReceiptFields = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  workflowID: Workflow.ID,
  stageID: Workflow.StageID,
  role: WorkflowRole.Role,
  revision: Schema.Number,
  contractFingerprint: Sha256,
  contextDigest: Sha256,
  requiredArtifactSetSha256: Sha256,
  dependencyArtifactSetSha256: Schema.optional(Sha256),
  outcomeSha256: Sha256,
  authority: ContractAuthority,
})
export const Receipt = ReceiptFields.check(
  Schema.makeFilter<typeof ReceiptFields.Type>((receipt) =>
    Buffer.byteLength(WorkflowBusinessArtifact.encode(receipt)) <= 128 * 1024
      ? undefined
      : "Role receipt must not exceed 128 KiB",
  ),
).annotate({ identifier: "WorkflowRoleExecution.Receipt", ...exact })
export interface Receipt extends Schema.Schema.Type<typeof Receipt> {}

export interface ValidateSettlementInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly priorArtifacts: ReadonlyArray<Workflow.Artifact>
  readonly artifacts: ReadonlyArray<Workflow.Artifact | Workflow.ArtifactCommit>
  readonly receipt?: unknown
  readonly trustedMessages?: readonly Message[]
  readonly dependencies?: readonly Workflow.Artifact[]
}

export function requiredKinds(role: WorkflowRole.Role): readonly string[] {
  if (role === "design") return [WorkflowDesignArtifact.SPEC_KIND, WorkflowDesignArtifact.REFERENCE_APP_KIND]
  if (role === "decompose") return [WorkflowDecompositionArtifact.KIND]
  if (role === "implement" || role === "repair") return [WorkflowImplementationArtifact.KIND]
  if (role === "test") return [WorkflowTestArtifact.KIND, WorkflowTestLogArtifact.KIND]
  if (role === "visual_review")
    return [
      WorkflowVisualReviewArtifact.REVIEW_KIND,
      WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND,
      WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND,
    ]
  return [WorkflowDeliveryArtifact.KIND]
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
  if (WorkflowRoleContract.fingerprintAuthority(receipt.authority) !== receipt.contractFingerprint)
    throw new Error("Role contract authority fingerprint is invalid")
  WorkflowRoleContract.verifyAuthority({
    authority: receipt.authority,
    workflow: input.workflow,
    stage: input.stage,
    priorArtifacts: input.priorArtifacts,
    ...(input.trustedMessages === undefined ? {} : { trustedMessages: input.trustedMessages }),
  })
  const contextDigest = WorkflowRoleContract.inputContextDigest({
    workflow: input.workflow,
    stage: input.stage,
    priorArtifacts: input.priorArtifacts,
  })
  if (receipt.contextDigest !== contextDigest) throw new Error("Role receipt input context mismatch")
  for (const artifact of input.artifacts) validateArtifactOwner(artifact, input.workflow, input.stage)
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
    binding.dependencyArtifactSetSha256 !== receipt.dependencyArtifactSetSha256 ||
    outcome.sha256 !== receipt.outcomeSha256 ||
    outcome.uri !== `workflow://${input.workflow.id}/stages/${input.stage.id}/role-outcome.json` ||
    outcome.size !== Buffer.byteLength(encodedOutcome)
  )
    throw new Error("Role outcome binding does not match its receipt")
  const business = input.artifacts.filter(
    (artifact) => artifact.kind !== WorkflowStageMachine.OUTCOME_ARTIFACT_KIND && artifact.kind !== "tool-continuation",
  )
  const dependencies = input.dependencies ?? []
  validateDependencies(input.workflow, input.stage, dependencies, input.priorArtifacts)
  const dependencyDigest = dependencies.length === 0 ? undefined : artifactSetDigest(dependencies)
  if (dependencyDigest !== receipt.dependencyArtifactSetSha256)
    throw new Error("Role dependency artifact set does not match its binding")
  for (const media of receipt.authority.media) {
    if (![...business, ...dependencies].some((artifact) => mediaBackedByArtifact(media, artifact, input.workflow.id)))
      throw new Error("Role contract authority media is not backed by trusted business evidence")
  }
  validateBusinessArtifacts(input.workflow, input.stage, business, input.priorArtifacts, binding.outcome, dependencies)
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

export function validateBusinessArtifacts(
  workflow: Workflow.Info,
  stage: Workflow.Stage,
  artifacts: ReadonlyArray<Workflow.Artifact | Workflow.ArtifactCommit>,
  priorArtifacts: ReadonlyArray<Workflow.Artifact>,
  outcome: WorkflowRole.Outcome,
  dependencies: ReadonlyArray<Workflow.Artifact> = [],
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
  for (const artifact of artifacts) validateArtifactOwner(artifact, workflow, stage)
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
    const logs = count(WorkflowTestLogArtifact.KIND)
    if (results.length !== 1 || logs.length === 0 || artifacts.length !== 1 + logs.length)
      throw new Error("Test evidence requires one result and every durable log")
    const result = WorkflowTestArtifact.decode(toCommit(results[0]), workflow.id, location)
    if (result.revision !== revision) throw new Error("Test result revision mismatch")
    if (result.schemaVersion === 2 && result.stageID !== stage.id) throw new Error("Test result stage mismatch")
    if (outcome.role !== "test" || outcome.verdict !== (result.verdict === "pass" ? "pass" : "revise"))
      throw new Error("Test outcome does not match the durable test result")
    const references = new Map(result.tests.map((record) => [record.log.uri, record.log]))
    if (references.size !== result.tests.length || references.size !== logs.length)
      throw new Error("Test logs must map one-to-one to test records")
    for (const log of logs) {
      const decoded =
        result.schemaVersion === 2
          ? WorkflowTestLogArtifact.decodeExact(log, workflow.id, stage.id, revision)
          : WorkflowTestLogArtifact.decode(log, workflow.id, revision)
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
    const decodedImages = [...dependencies, ...screenshots].map((artifact) =>
      WorkflowVisualReviewArtifact.decodeScreenshot(toCommit(artifact), workflow.id),
    )
    const specArtifact = priorArtifacts.filter((artifact) => artifact.kind === WorkflowDesignArtifact.SPEC_KIND)
    if (specArtifact.length !== 1) throw new Error("Visual review requires one durable design specification")
    const spec = WorkflowDesignArtifact.decodeSpec(toCommit(specArtifact[0]), workflow.id)
    let productionPlan: WorkflowProductionHostPlan.Plan | undefined
    try {
      productionPlan = WorkflowProductionHostPlan.fromWorkflow(workflow)
    } catch {
      productionPlan = undefined
    }
    if (productionPlan !== undefined) {
      const referenceArtifact = priorArtifacts.filter(
        (artifact) => artifact.kind === WorkflowDesignArtifact.REFERENCE_APP_KIND,
      )
      const manifestArtifact = priorArtifacts.filter((artifact) => {
        if (artifact.kind !== WorkflowImplementationArtifact.KIND) return false
        try {
          return (
            WorkflowImplementationArtifact.decodeExact(toCommit(artifact), workflow.id, location).revision === revision
          )
        } catch {
          return false
        }
      })
      if (referenceArtifact.length !== 1 || manifestArtifact.length !== 1)
        throw new Error("Visual review frozen implementation authority is missing or ambiguous")
      WorkflowProductionHostPlan.verifyCurrentConfiguration(productionPlan)
      const manifest = WorkflowImplementationArtifact.decodeExact(toCommit(manifestArtifact[0]), workflow.id, location)
      const referenceIdentity = WorkflowVisualHost.referenceIdentity(
        workflow.id,
        WorkflowDesignArtifact.decodeReferenceApp(toCommit(referenceArtifact[0]), workflow.id),
      )
      for (const artifact of screenshots) {
        const image = WorkflowVisualReviewArtifact.decodeScreenshot(toCommit(artifact), workflow.id)
        const receipt = image.evidenceReceipt
        if (receipt === undefined || receipt.coordinates.stageID !== stage.id)
          throw new Error("Current visual screenshot receipt belongs to a different stage")
        if (
          image.kind === "implementation" &&
          (receipt.coordinates.revision !== revision ||
            receipt.coordinates.configSha256 !== productionPlan.preview.configSha256 ||
            receipt.coordinates.sourceSha256 !== WorkflowImplementationArtifact.hash(manifest) ||
            receipt.coordinates.readySelectorSha256 !== Hash.sha256(spec.referenceApp.readySelector))
        )
          throw new Error("Current implementation screenshot receipt differs from frozen authority")
        if (
          image.kind === "reference" &&
          (receipt.coordinates.revision !== 0 ||
            receipt.coordinates.configSha256 !== referenceIdentity.configSha256 ||
            receipt.coordinates.sourceSha256 !== referenceIdentity.sourceSha256 ||
            receipt.coordinates.readySelectorSha256 !== referenceIdentity.readySelectorSha256)
        )
          throw new Error("Current reference screenshot receipt differs from frozen authority")
      }
    }
    const images = spec.referenceApp.viewports.flatMap((viewport) => {
      const reference = decodedImages.filter(
        (image) => image.kind === "reference" && image.viewport === viewport.name && image.revision === 0,
      )
      const implementation = decodedImages.filter(
        (image) => image.kind === "implementation" && image.viewport === viewport.name && image.revision === revision,
      )
      if (reference.length !== 1 || implementation.length !== 1)
        throw new Error("Visual review viewport pair is missing or duplicated")
      return [reference[0], implementation[0]]
    })
    if (
      images.length !== decodedImages.length ||
      JSON.stringify(review.evidence.map(imageIdentity)) !==
        JSON.stringify(images.map(({ bytes: _, evidenceReceipt: __, ...image }) => imageIdentity(image)))
    )
      throw new Error("Visual review screenshot order or viewport set mismatch")
    return
  }

  const deliveries = count(WorkflowDeliveryArtifact.KIND)
  if (deliveries.length !== 1 || artifacts.length !== 1) throw new Error("Delivery evidence requires one artifact")
  const delivery = WorkflowDeliveryArtifact.decode(toCommit(deliveries[0]), workflow.id, location)
  if (delivery.revision !== revision) throw new Error("Delivery revision mismatch")
  const chain = validateDeliveryEvidenceChain(workflow, location, revision, priorArtifacts)
  WorkflowDeliveryArtifact.validateDelivery({ delivery, ...chain })
}

export function validateDependencies(
  workflow: Workflow.Info,
  stage: Workflow.Stage,
  dependencies: ReadonlyArray<Workflow.Artifact>,
  priorArtifacts: ReadonlyArray<Workflow.Artifact>,
): void {
  if (dependencies.length === 0) return
  if (stage.type !== "visual_review") throw new Error("Only visual review may consume role dependencies")
  const prior = new Map(priorArtifacts.map((artifact) => [artifact.id, artifact] as const))
  const ids = new Set<string>()
  for (const dependency of dependencies) {
    if (!Schema.is(Workflow.Artifact)(dependency) || dependency.workflowID !== workflow.id)
      throw new Error("Role dependency belongs to a different workflow")
    if (dependency.stageID === stage.id || dependency.kind !== WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND)
      throw new Error("Role dependency is not a prior reference screenshot")
    const persisted = prior.get(dependency.id)
    if (
      ids.has(dependency.id) ||
      persisted === undefined ||
      WorkflowBusinessArtifact.encode(Schema.encodeSync(Workflow.Artifact)(persisted)) !==
        WorkflowBusinessArtifact.encode(Schema.encodeSync(Workflow.Artifact)(dependency))
    )
      throw new Error("Role dependency identity is not an exact prior Artifact")
    ids.add(dependency.id)
    const image = WorkflowVisualReviewArtifact.decodeScreenshot(toCommit(dependency), workflow.id)
    if (image.kind !== "reference" || image.revision !== 0 || image.evidenceReceipt === undefined)
      throw new Error("Role dependency is not exact receipt-bound reference evidence")
  }
}

export function validateDeliveryEvidenceChain(
  workflow: Workflow.Info,
  location: Location.Ref,
  revision: number,
  artifacts: ReadonlyArray<Workflow.Artifact>,
): {
  readonly manifest: ReturnType<typeof WorkflowImplementationArtifact.decodeExact>
  readonly test: ReturnType<typeof WorkflowTestArtifact.decodeExact>
  readonly review: ReturnType<typeof WorkflowVisualReviewArtifact.decodeReview>
} {
  if (artifacts.some((artifact) => artifact.workflowID !== workflow.id))
    throw new Error("Delivery evidence contains a foreign Workflow owner")
  const exactly = <A>(values: readonly A[], message: string): A => {
    if (values.length !== 1) throw new Error(message)
    return values[0]
  }
  const manifestArtifact = exactly(
    artifacts.filter((artifact) => {
      if (artifact.kind !== WorkflowImplementationArtifact.KIND) return false
      try {
        return (
          WorkflowImplementationArtifact.decodeExact(toCommit(artifact), workflow.id, location).revision === revision
        )
      } catch {
        return false
      }
    }),
    "Delivery manifest authority is missing or ambiguous",
  )
  const manifest = WorkflowImplementationArtifact.decodeExact(toCommit(manifestArtifact), workflow.id, location)
  const testArtifact = exactly(
    artifacts.filter((artifact) => {
      if (artifact.kind !== WorkflowTestArtifact.KIND) return false
      try {
        return (
          WorkflowTestArtifact.decodeExact(toCommit(artifact), workflow.id, artifact.stageID, location).revision ===
          revision
        )
      } catch {
        return false
      }
    }),
    "Delivery test authority is missing or ambiguous",
  )
  const test = WorkflowTestArtifact.decodeExact(toCommit(testArtifact), workflow.id, testArtifact.stageID, location)
  const logs = artifacts.filter(
    (artifact) => artifact.kind === WorkflowTestLogArtifact.KIND && artifact.stageID === testArtifact.stageID,
  )
  if (logs.length !== test.tests.length) throw new Error("Delivery test-log dependency count differs from its result")
  const resolvedLogs = test.tests.map((record) => {
    const matches = logs.filter(
      (artifact) =>
        artifact.uri === record.log.uri && artifact.sha256 === record.log.sha256 && artifact.size === record.log.size,
    )
    const artifact = exactly(matches, "Delivery test-log dependency is missing or ambiguous")
    WorkflowTestLogArtifact.decodeExact(artifact, workflow.id, testArtifact.stageID, revision)
    return artifact
  })
  if (new Set(resolvedLogs.map((artifact) => artifact.id)).size !== resolvedLogs.length)
    throw new Error("Delivery test-log dependencies are duplicated")

  const reviewArtifact = exactly(
    artifacts.filter((artifact) => {
      if (artifact.kind !== WorkflowVisualReviewArtifact.REVIEW_KIND) return false
      try {
        return WorkflowVisualReviewArtifact.decodeReview(toCommit(artifact), workflow.id).revision === revision
      } catch {
        return false
      }
    }),
    "Delivery visual-review authority is missing or ambiguous",
  )
  const review = WorkflowVisualReviewArtifact.decodeReview(toCommit(reviewArtifact), workflow.id)
  const specArtifact = exactly(
    artifacts.filter((artifact) => artifact.kind === WorkflowDesignArtifact.SPEC_KIND),
    "Delivery design viewport authority is missing or ambiguous",
  )
  const spec = WorkflowDesignArtifact.decodeSpec(toCommit(specArtifact), workflow.id)
  const screenshots = artifacts.filter(
    (artifact) =>
      artifact.kind === WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND ||
      artifact.kind === WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND,
  )
  const used = new Set<Workflow.ArtifactID>()
  const ordered = spec.referenceApp.viewports.flatMap((viewport) =>
    (["reference", "implementation"] as const).map((kind) => {
      const expectedRevision = kind === "reference" ? 0 : revision
      const matches = screenshots.filter((artifact) => {
        try {
          const image = WorkflowVisualReviewArtifact.decodeScreenshot(toCommit(artifact), workflow.id)
          return image.kind === kind && image.viewport === viewport.name && image.revision === expectedRevision
        } catch {
          return false
        }
      })
      const artifact = exactly(matches, "Delivery screenshot dependency is missing or ambiguous")
      if (used.has(artifact.id)) throw new Error("Delivery screenshot dependency is duplicated")
      used.add(artifact.id)
      const image = WorkflowVisualReviewArtifact.decodeScreenshot(toCommit(artifact), workflow.id)
      const receipt = image.evidenceReceipt
      if (
        receipt === undefined ||
        receipt.coordinates.stageID !== artifact.stageID ||
        (kind === "implementation" && artifact.stageID !== reviewArtifact.stageID)
      )
        throw new Error("Delivery screenshot receipt ownership is foreign or drifted")
      return { artifact, image }
    }),
  )
  if (
    ordered.length !== review.evidence.length ||
    ordered.some(({ image }, index) => {
      const expected = review.evidence[index]
      return (
        expected === undefined ||
        expected.id !== image.id ||
        expected.workflowID !== image.workflowID ||
        expected.kind !== image.kind ||
        expected.viewport !== image.viewport ||
        expected.revision !== image.revision ||
        expected.uri !== image.uri ||
        expected.mime !== image.mime ||
        expected.sha256 !== image.sha256 ||
        expected.size !== image.size
      )
    })
  )
    throw new Error("Delivery visual-review evidence order or identity drifted")

  validateOutcomeArtifactSet(
    workflow,
    artifacts,
    manifestArtifact.stageID,
    revision,
    ["implement", "repair"],
    [manifestArtifact],
    [],
  )
  validateOutcomeArtifactSet(
    workflow,
    artifacts,
    testArtifact.stageID,
    revision,
    ["test"],
    [testArtifact, ...resolvedLogs],
    [],
  )
  const reviewBusiness = [
    reviewArtifact,
    ...ordered.map(({ artifact }) => artifact).filter((a) => a.stageID === reviewArtifact.stageID),
  ]
  const reviewDependencies = ordered.map(({ artifact }) => artifact).filter((a) => a.stageID !== reviewArtifact.stageID)
  validateOutcomeArtifactSet(
    workflow,
    artifacts,
    reviewArtifact.stageID,
    revision,
    ["visual_review"],
    reviewBusiness,
    reviewDependencies,
  )
  return { manifest, test, review }
}

function validateOutcomeArtifactSet(
  workflow: Workflow.Info,
  artifacts: readonly Workflow.Artifact[],
  stageID: Workflow.StageID,
  revision: number,
  roles: readonly WorkflowRole.Role[],
  business: readonly Workflow.Artifact[],
  dependencies: readonly Workflow.Artifact[],
) {
  const outcomes = artifacts.filter(
    (artifact) => artifact.stageID === stageID && artifact.kind === WorkflowStageMachine.OUTCOME_ARTIFACT_KIND,
  )
  if (outcomes.length !== 1) throw new Error("Delivery role outcome binding is missing or ambiguous")
  const binding = WorkflowStageMachine.decodeOutcomeBinding(toCommit(outcomes[0]))
  if (
    !roles.includes(binding.outcome.role) ||
    binding.outcome.revision !== revision ||
    binding.requiredArtifactSetSha256 !== artifactSetDigest(business) ||
    binding.dependencyArtifactSetSha256 !== (dependencies.length === 0 ? undefined : artifactSetDigest(dependencies)) ||
    business.some((artifact) => artifact.workflowID !== workflow.id || artifact.stageID !== stageID) ||
    dependencies.some((artifact) => artifact.workflowID !== workflow.id || artifact.stageID === stageID)
  )
    throw new Error("Delivery role outcome binding differs from its exact evidence set")
}

function mediaBackedByArtifact(
  media: { readonly mediaType: string; readonly sha256: string; readonly size: number },
  artifact: Workflow.Artifact | Workflow.ArtifactCommit,
  workflowID: Workflow.ID,
): boolean {
  if (artifact.mime !== media.mediaType) return false
  if (
    artifact.kind === WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND ||
    artifact.kind === WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND
  ) {
    try {
      const image = WorkflowVisualReviewArtifact.decodeScreenshot(toCommit(artifact), workflowID)
      return image.sha256 === media.sha256 && image.size === media.size
    } catch {
      return false
    }
  }
  return artifact.sha256 === media.sha256 && artifact.size === media.size
}

export function decodePriorArtifacts(
  workflow: Workflow.Info,
  location: Location.Ref,
  artifacts: ReadonlyArray<Workflow.Artifact>,
): readonly DecodedPriorArtifact[] {
  const decoded: DecodedPriorArtifact[] = []
  for (const artifact of artifacts) {
    if (!Schema.is(Workflow.Artifact)(artifact)) throw new Error("Prior artifact identity is malformed")
    if (
      artifact.workflowID !== workflow.id ||
      DateTime.toEpochMillis(artifact.timeCreated) < DateTime.toEpochMillis(workflow.time.created)
    )
      throw new Error("Prior artifact identity does not belong to the persisted workflow")
    const commit = toCommit(artifact)
    const push = (value: unknown) => decoded.push({ kind: artifact.kind, artifact, commit, value })
    if (artifact.kind === WorkflowDesignArtifact.SPEC_KIND) push(WorkflowDesignArtifact.decodeSpec(commit, workflow.id))
    else if (artifact.kind === WorkflowDesignArtifact.REFERENCE_APP_KIND)
      push(WorkflowDesignArtifact.decodeReferenceApp(commit, workflow.id))
    else if (artifact.kind === WorkflowDecompositionArtifact.KIND)
      push(WorkflowDecompositionArtifact.decode(commit, workflow.id, location))
    else if (artifact.kind === WorkflowImplementationArtifact.KIND)
      push(WorkflowImplementationArtifact.decode(commit, workflow.id, location))
    else if (artifact.kind === WorkflowTestArtifact.KIND)
      push(WorkflowTestArtifact.decode(commit, workflow.id, location))
    else if (artifact.kind === WorkflowVisualReviewArtifact.REVIEW_KIND)
      push(WorkflowVisualReviewArtifact.decodeReview(commit, workflow.id))
    else if (
      artifact.kind === WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND ||
      artifact.kind === WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND
    )
      push(WorkflowVisualReviewArtifact.decodeScreenshot(commit, workflow.id))
    else if (artifact.kind === WorkflowDeliveryArtifact.KIND)
      push(WorkflowDeliveryArtifact.decode(commit, workflow.id, location))
    else if (artifact.kind === WorkflowTestLogArtifact.KIND) push(WorkflowTestLogArtifact.decode(commit, workflow.id))
  }
  return decoded
}

function validateArtifactOwner(
  artifact: Workflow.Artifact | Workflow.ArtifactCommit,
  workflow: Workflow.Info,
  stage: Workflow.Stage,
): void {
  if (!("workflowID" in artifact)) return
  if (
    !Schema.is(Workflow.Artifact)(artifact) ||
    artifact.workflowID !== workflow.id ||
    artifact.stageID !== stage.id ||
    DateTime.toEpochMillis(artifact.timeCreated) < DateTime.toEpochMillis(workflow.time.created) ||
    DateTime.toEpochMillis(artifact.timeCreated) < DateTime.toEpochMillis(stage.time.created)
  )
    throw new Error("Artifact belongs to a different workflow, stage, or time authority")
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
