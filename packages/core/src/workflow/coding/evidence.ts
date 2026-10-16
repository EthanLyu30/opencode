export * as CodingEvidence from "./evidence"

import { Message } from "@opencode-ai/llm"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { WorkflowCodingArtifact } from "@opencode-ai/schema/workflow-coding-artifact"
import { Responses } from "@opencode-ai/schema/responses"
import { Cause, Context, Data, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { Snapshot } from "../../snapshot"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowDecompositionArtifact } from "../artifacts/decomposition"
import { WorkflowImplementationArtifact } from "../artifacts/implementation"
import { WorkflowRoleExecution } from "../execution/role"
import { WorkflowRoleContract } from "../execution/contract"
import { WorkflowWorkspaceMaterialization } from "../workspace-materialization"
import { CodingArtifacts } from "./artifacts"
import { CodingAuthority } from "./authority"
import { CodingChecks } from "./checks"
import { CodingContract } from "./contract"
import { CodingHostPlan } from "./host-plan"
import { CodingStageMachine } from "./stage-machine"
import { Hash } from "../../util/hash"

export class EvidenceFailure extends Data.TaggedError("CodingEvidence.EvidenceFailure")<{
  readonly code: string
  readonly message: string
}> {}
export interface Preparation extends WorkflowRoleExecution.Preparation {
  readonly codingChecks?: CodingArtifacts.CheckRecord
}
export interface Receipt {
  readonly kind: "workflow.coding-receipt.v1"
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly attempt: number
  readonly leaseOwner: string
  readonly contractFingerprint: string
  readonly contextDigest: string
  readonly requiredArtifactSetSha256: string
  readonly outcomeSha256: string
  readonly authority: CodingContract.Authority
}
export interface SettleInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly contract: CodingContract.Contract
  readonly semantic: CodingContract.RoleResult
  readonly priorArtifacts: readonly Workflow.Artifact[]
  readonly settledToolEvidence: readonly Workflow.ArtifactCommit[]
  readonly providerUsage: Responses.Usage
  readonly executionUsage: Workflow.Usage
  readonly preparation?: Preparation
}
export interface Settlement {
  readonly artifacts: readonly Workflow.ArtifactCommit[]
  readonly receipt: Receipt
}
export interface Interface {
  readonly prepare: (input: WorkflowRoleExecution.PrepareInput) => Effect.Effect<Preparation, EvidenceFailure>
  readonly settle: (input: SettleInput) => Effect.Effect<Settlement, EvidenceFailure>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/CodingEvidence") {}
const fail = (code: string) =>
  new EvidenceFailure({ code, message: "Coding admission, source or host evidence is invalid" })
const checked = <A>(f: () => A) => Effect.try({ try: f, catch: () => fail("invalid_coding_evidence") })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const checks = yield* CodingChecks.Service
    const authority = yield* CodingAuthority.Service
    return Service.of(make(checks, authority))
  }),
)
export const failClosedLayer = layer.pipe(
  Layer.provide(CodingChecks.failClosedLayer),
  Layer.provide(CodingAuthority.failClosedLayer),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [CodingChecks.node, CodingAuthority.node] })

export function make(checks: CodingChecks.Interface, authority: CodingAuthority.Interface): Interface {
  const authorize = (workflow: Workflow.Info) =>
    authority.require(workflow).pipe(Effect.mapError(() => fail("coding_admission_required")))
  const current = (workflow: Workflow.Info, workspaceSha256: string) =>
    Effect.gen(function* () {
      const snapshot = yield* checks.captureSnapshot(workflow.location!)
      const entries = yield* checks.snapshotEntries(workflow.location!, snapshot)
      if (Snapshot.workspaceSha256(entries) !== workspaceSha256) return yield* fail("coding_source_drift")
    }).pipe(Effect.mapError(() => fail("coding_source_drift")))
  const service: Interface = {
    prepare: (input) =>
      Effect.gen(function* () {
        yield* authorize(input.workflow)
        const plan = yield* checked(() => hostPlan(input.workflow))
        yield* checked(() => CodingHostPlan.verifyCurrentConfiguration(plan))
        const revision = yield* checked(() =>
          CodingArtifacts.revisionOf(input.workflow, input.stage, input.priorArtifacts),
        )
        if (input.revision !== revision) return yield* fail("coding_revision_mismatch")
        const prior = yield* checked(() => decodePrior(input.workflow, input.priorArtifacts))
        if (input.stage.type !== "test" && input.stage.type !== "code_review" && input.stage.type !== "deliver")
          return {
            messages: [
              Message.user(
                WorkflowBusinessArtifact.encode({
                  workflow: input.workflow.input,
                  role: input.stage.type,
                  revision,
                  artifacts: prior,
                }),
              ),
            ],
          }
        const implementation = yield* checked(() => manifestAt(input.workflow, input.priorArtifacts, revision))
        yield* current(input.workflow, implementation.workspaceSha256)
        if (input.stage.type !== "test") {
          yield* checked(() => finalChecks(input.workflow, input.priorArtifacts, revision))
          return {
            messages: [
              Message.user(
                WorkflowBusinessArtifact.encode({
                  workflow: input.workflow.input,
                  role: input.stage.type,
                  revision,
                  artifacts: prior,
                }),
              ),
            ],
          }
        }
        const sealedSnapshot = yield* checks
          .sealWorkspace({
            workflowID: input.workflow.id,
            stageID: input.stage.id,
            revision,
            location: input.location,
            manifestSha256: WorkflowImplementationArtifact.hash(implementation),
            workspaceSha256: implementation.workspaceSha256,
          })
          .pipe(Effect.mapError(() => fail("coding_snapshot_unavailable")))
        yield* checked(() =>
          WorkflowWorkspaceMaterialization.assertAuthority(sealedSnapshot, {
            workflowID: input.workflow.id,
            stageID: input.stage.id,
            revision,
            location: input.location,
            manifestSha256: WorkflowImplementationArtifact.hash(implementation),
            workspaceSha256: implementation.workspaceSha256,
          }),
        )
        const record = yield* checks
          .run({ workflow: input.workflow, stage: input.stage, revision, sealedSnapshot, plan })
          .pipe(Effect.mapError(() => fail("coding_checks_unavailable")))
        if (
          record.snapshotRef !== sealedSnapshot.snapshotRef ||
          record.sealedAuthoritySha256 !== sealedSnapshot.authoritySha256
        )
          return yield* fail("coding_snapshot_mismatch")
        yield* checked(() => validateRecord(record, input.workflow, input.stage, implementation))
        yield* current(input.workflow, implementation.workspaceSha256)
        return {
          codingChecks: record,
          messages: [
            Message.user(
              WorkflowBusinessArtifact.encode({
                workflow: input.workflow.input,
                role: "test",
                revision,
                artifacts: prior,
                hostChecks: record,
                verdict: CodingArtifacts.checksPassed(record.checks, plan) ? "pass" : "revise",
              }),
            ),
          ],
        }
      }),
    settle: (input) =>
      Effect.gen(function* () {
        yield* authorize(input.workflow)
        const semantic = yield* checked(() => CodingContract.decode(input.contract, input.semantic))
        const role = semantic.outcome.role
        const revision = semantic.outcome.revision
        const plan = yield* checked(() => hostPlan(input.workflow))
        yield* checked(() => CodingHostPlan.verifyCurrentConfiguration(plan))
        if (
          !Schema.is(Responses.Usage)(input.providerUsage) ||
          !Schema.is(Workflow.Usage)(input.executionUsage) ||
          input.contract.contextDigest !==
            WorkflowRoleContract.inputContextDigest({
              workflow: input.workflow,
              stage: input.stage,
              priorArtifacts: input.priorArtifacts,
            })
        )
          return yield* fail("coding_contract_mismatch")
        if (input.settledToolEvidence.some((item) => item.kind !== "tool-continuation"))
          return yield* fail("reserved_coding_artifact")
        yield* checked(() => decodePrior(input.workflow, input.priorArtifacts))
        const artifacts = yield* Effect.gen(function* () {
          if (role === "design")
            return [
              CodingArtifacts.commit("plan", input.workflow.id, input.workflow.location!, {
                schemaVersion: 1,
                workflowID: input.workflow.id,
                revision,
                ...semantic.payload,
                checkPlanSha256: plan.sha256,
              }),
            ]
          if (role === "decompose") {
            const payload = Schema.decodeUnknownSync(WorkflowRoleContract.DecomposePayload)(semantic.payload)
            validateDecomposition(payload)
            const baseline = yield* checks
              .captureSnapshot(input.workflow.location!)
              .pipe(Effect.mapError(() => fail("coding_snapshot_unavailable")))
            yield* checks
              .snapshotEntries(input.workflow.location!, baseline)
              .pipe(Effect.mapError(() => fail("coding_snapshot_unavailable")))
            return [
              WorkflowDecompositionArtifact.commit(input.workflow.id, input.workflow.location!, {
                schemaVersion: 1,
                workflowID: input.workflow.id,
                revision,
                snapshotRef: baseline,
                ...payload,
              }),
            ]
          }
          if (role === "implement" || role === "repair") {
            const decomposition = WorkflowDecompositionArtifact.decode(
              CodingArtifacts.toCommit(unique(input.priorArtifacts, WorkflowDecompositionArtifact.KIND)),
              input.workflow.id,
              input.workflow.location!,
            )
            const before = yield* checks
              .snapshotEntries(input.workflow.location!, Snapshot.ID.make(decomposition.snapshotRef))
              .pipe(Effect.mapError(() => fail("coding_snapshot_unavailable")))
            const snapshot = yield* checks
              .captureSnapshot(input.workflow.location!)
              .pipe(Effect.mapError(() => fail("coding_snapshot_unavailable")))
            const after = yield* checks
              .snapshotEntries(input.workflow.location!, snapshot)
              .pipe(Effect.mapError(() => fail("coding_snapshot_unavailable")))
            return [
              WorkflowImplementationArtifact.commit(
                input.workflow.id,
                input.workflow.location!,
                WorkflowImplementationArtifact.derive({
                  workflowID: input.workflow.id,
                  revision,
                  snapshotRef: Snapshot.ID.make(decomposition.snapshotRef),
                  before,
                  after,
                }),
              ),
            ]
          }
          const implementation = manifestAt(input.workflow, input.priorArtifacts, revision)
          yield* current(input.workflow, implementation.workspaceSha256)
          if (role === "test") {
            const record = input.preparation?.codingChecks
            if (!record) return yield* fail("coding_host_checks_required")
            validateRecord(record, input.workflow, input.stage, implementation)
            if ((semantic.outcome.verdict === "pass") !== CodingArtifacts.checksPassed(record.checks, plan))
              return yield* fail("forged_coding_test_verdict")
            return [CodingArtifacts.commit("checks", input.workflow.id, input.workflow.location!, record)]
          }
          const tested = finalChecks(input.workflow, input.priorArtifacts, revision)
          if (role === "code_review")
            return [
              CodingArtifacts.commit("review", input.workflow.id, input.workflow.location!, {
                schemaVersion: 1,
                workflowID: input.workflow.id,
                revision,
                implementationSha256: WorkflowImplementationArtifact.hash(implementation),
                testSha256: tested.artifact.sha256,
                ...semantic.payload,
              }),
            ]
          const reviewed = reviewAt(input.workflow, input.priorArtifacts, revision)
          const delivery = Schema.decodeUnknownSync(WorkflowCodingArtifact.Delivery)({
            schemaVersion: 1,
            workflowID: input.workflow.id,
            revision,
            implementationSha256: WorkflowImplementationArtifact.hash(implementation),
            testSha256: tested.artifact.sha256,
            codeReviewSha256: reviewed.artifact.sha256,
            summary: semantic.payload.summary,
          })
          validateDelivery(delivery, {
            revision,
            implementationSha256: WorkflowImplementationArtifact.hash(implementation),
            testSha256: tested.artifact.sha256,
            codeReviewSha256: reviewed.artifact.sha256,
            testsPassed: true,
            review: reviewed.value,
          })
          return [CodingArtifacts.commit("delivery", input.workflow.id, input.workflow.location!, delivery)]
        })
        const requiredArtifactSetSha256 = artifactSetDigest(artifacts)
        const binding = CodingStageMachine.OutcomeBinding.make({
          bindingVersion: 1,
          outcome: semantic.outcome,
          contractFingerprint: input.contract.contractFingerprint,
          contextDigest: input.contract.contextDigest,
          requiredArtifactSetSha256,
        })
        const body = CodingStageMachine.encodeOutcome(binding)
        const outcome = Workflow.ArtifactCommit.make({
          kind: CodingStageMachine.OUTCOME_ARTIFACT_KIND,
          uri: `workflow://${input.workflow.id}/stages/${input.stage.id}/coding-outcome.json`,
          mime: CodingStageMachine.OUTCOME_ARTIFACT_MIME,
          sha256: Hash.sha256(body),
          size: Buffer.byteLength(body),
          metadata: binding,
        })
        const receipt: Receipt = {
          kind: "workflow.coding-receipt.v1",
          workflowID: input.workflow.id,
          stageID: input.stage.id,
          attempt: input.stage.attempt,
          leaseOwner: input.stage.leaseOwner ?? "",
          contractFingerprint: input.contract.contractFingerprint,
          contextDigest: input.contract.contextDigest,
          requiredArtifactSetSha256,
          outcomeSha256: outcome.sha256,
          authority: input.contract.authority,
        }
        const result = { artifacts: [...artifacts, outcome], receipt }
        yield* checked(() =>
          validateSettlement({
            workflow: input.workflow,
            stage: input.stage,
            priorArtifacts: input.priorArtifacts,
            ...result,
            ...(input.preparation?.messages === undefined ? {} : { trustedMessages: input.preparation.messages }),
          }),
        )
        return result
      }),
  }
  const guarded = <A>(effect: Effect.Effect<A, EvidenceFailure>) =>
    effect.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        const error = Cause.squash(cause)
        return Effect.fail(error instanceof EvidenceFailure ? error : fail("invalid_coding_evidence"))
      }),
    )
  return { prepare: (input) => guarded(service.prepare(input)), settle: (input) => guarded(service.settle(input)) }
}

export const prepare = Effect.fn("CodingEvidence.prepare")(function* (input: WorkflowRoleExecution.PrepareInput) {
  const service = yield* Service
  return yield* service.prepare(input)
})
export const resolve = Effect.fn("CodingEvidence.resolve")(function* (input: SettleInput) {
  const service = yield* Service
  return yield* service.settle(input)
})
export const artifactSetDigest = (artifacts: readonly (Workflow.Artifact | Workflow.ArtifactCommit)[]) =>
  WorkflowBusinessArtifact.hash(WorkflowRoleContract.canonicalArtifacts(artifacts))

export function validateDecomposition(input: {
  readonly tasks: readonly { readonly id: string; readonly dependsOn: readonly string[] }[]
}): void {
  const tasks = new Map(input.tasks.map((task) => [task.id, task]))
  if (tasks.size !== input.tasks.length) throw new Error("Duplicate coding task")
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id) || !tasks.has(id)) throw new Error("Unknown or cyclic coding dependency")
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of tasks.get(id)!.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of tasks.keys()) visit(id)
}
export function validateDelivery(
  delivery: {
    readonly revision: number
    readonly implementationSha256: string
    readonly testSha256: string
    readonly codeReviewSha256: string
  },
  evidence: {
    readonly revision: number
    readonly implementationSha256: string
    readonly testSha256: string
    readonly codeReviewSha256: string
    readonly testsPassed: boolean
    readonly review: { readonly verdict: string; readonly findings: readonly { readonly blocking: boolean }[] }
  },
): void {
  if (
    delivery.revision !== evidence.revision ||
    delivery.implementationSha256 !== evidence.implementationSha256 ||
    delivery.testSha256 !== evidence.testSha256 ||
    delivery.codeReviewSha256 !== evidence.codeReviewSha256 ||
    !evidence.testsPassed ||
    evidence.review.verdict !== "pass" ||
    evidence.review.findings.some((finding) => finding.blocking)
  )
    throw new Error("Coding delivery evidence is stale or blocking")
}
export function validateSettlement(input: WorkflowRoleExecution.ValidateSettlementInput): void {
  if (
    input.workflow.type !== "coding-build" ||
    !input.workflow.location ||
    input.stage.workflowID !== input.workflow.id
  )
    throw new Error("Invalid coding settlement owner")
  const receipt = input.receipt as Receipt | undefined
  if (
    !receipt ||
    receipt.kind !== "workflow.coding-receipt.v1" ||
    receipt.workflowID !== input.workflow.id ||
    receipt.stageID !== input.stage.id ||
    receipt.attempt !== input.stage.attempt ||
    !receipt.leaseOwner ||
    receipt.leaseOwner !== input.stage.leaseOwner ||
    receipt.contractFingerprint !== WorkflowBusinessArtifact.hash(receipt.authority)
  )
    throw new Error("Missing or stale coding receipt")
  CodingContract.verifyAuthority({
    workflow: input.workflow,
    stage: input.stage,
    priorArtifacts: input.priorArtifacts,
    authority: receipt.authority,
    ...(input.trustedMessages === undefined ? {} : { trustedMessages: input.trustedMessages }),
  })
  const contextDigest = WorkflowRoleContract.inputContextDigest({
    workflow: input.workflow,
    stage: input.stage,
    priorArtifacts: input.priorArtifacts,
  })
  if (contextDigest !== receipt.contextDigest || receipt.authority.contextDigest !== contextDigest)
    throw new Error("Coding context mismatch")
  decodePrior(input.workflow, input.priorArtifacts)
  for (const artifact of input.artifacts)
    if ("workflowID" in artifact && (artifact.workflowID !== input.workflow.id || artifact.stageID !== input.stage.id))
      throw new Error("Foreign coding stage artifact")
  const outcomes = input.artifacts.filter((artifact) => artifact.kind === CodingStageMachine.OUTCOME_ARTIFACT_KIND)
  if (outcomes.length !== 1) throw new Error("Exactly one coding outcome is required")
  const binding = CodingStageMachine.decodeOutcomeBinding(outcomes[0])
  if (
    outcomes[0].sha256 !== receipt.outcomeSha256 ||
    outcomes[0].uri !== `workflow://${input.workflow.id}/stages/${input.stage.id}/coding-outcome.json` ||
    binding.contractFingerprint !== receipt.contractFingerprint ||
    binding.contextDigest !== contextDigest ||
    binding.requiredArtifactSetSha256 !== receipt.requiredArtifactSetSha256 ||
    binding.outcome.role !== input.stage.type ||
    binding.outcome.revision !== CodingArtifacts.revisionOf(input.workflow, input.stage, input.priorArtifacts)
  )
    throw new Error("Coding outcome binding mismatch")
  const business = input.artifacts.filter(
    (artifact) => artifact.kind !== CodingStageMachine.OUTCOME_ARTIFACT_KIND && artifact.kind !== "tool-continuation",
  )
  if (business.length !== 1 || artifactSetDigest(business) !== receipt.requiredArtifactSetSha256)
    throw new Error("Coding required artifacts mismatch")
  const role = Schema.decodeUnknownSync(WorkflowCodingBuild.Role)(input.stage.type)
  const revision = binding.outcome.revision
  const plan = hostPlan(input.workflow)
  if (role === "design") {
    const value = CodingArtifacts.decode(
      "plan",
      CodingArtifacts.toCommit(business[0]),
      input.workflow.id,
      input.workflow.location,
    )
    if (value.revision !== revision || value.checkPlanSha256 !== plan.sha256) throw new Error("Coding plan mismatch")
    return
  }
  if (role === "decompose") {
    const value = WorkflowDecompositionArtifact.decode(
      CodingArtifacts.toCommit(business[0]),
      input.workflow.id,
      input.workflow.location,
    )
    validateDecomposition(value)
    if (value.revision !== revision) throw new Error("Coding decomposition revision mismatch")
    return
  }
  const implementation =
    role === "implement" || role === "repair"
      ? WorkflowImplementationArtifact.decodeExact(
          CodingArtifacts.toCommit(business[0]),
          input.workflow.id,
          input.workflow.location,
        )
      : manifestAt(input.workflow, input.priorArtifacts, revision)
  if (implementation.revision !== revision) throw new Error("Coding implementation revision mismatch")
  if (role === "implement" || role === "repair") return
  if (role === "test") {
    const value = CodingArtifacts.decode(
      "checks",
      CodingArtifacts.toCommit(business[0]),
      input.workflow.id,
      input.workflow.location,
    )
    validateRecord(value, input.workflow, input.stage, implementation)
    if ((binding.outcome.verdict === "pass") !== CodingArtifacts.checksPassed(value.checks, plan))
      throw new Error("Forged coding test outcome")
    return
  }
  const tested = finalChecks(input.workflow, input.priorArtifacts, revision)
  if (role === "code_review") {
    const value = CodingArtifacts.decode(
      "review",
      CodingArtifacts.toCommit(business[0]),
      input.workflow.id,
      input.workflow.location,
    )
    if (
      value.revision !== revision ||
      value.implementationSha256 !== WorkflowImplementationArtifact.hash(implementation) ||
      value.testSha256 !== tested.artifact.sha256 ||
      value.verdict !== binding.outcome.verdict
    )
      throw new Error("Coding review lineage mismatch")
    return
  }
  const reviewed = reviewAt(input.workflow, input.priorArtifacts, revision)
  const delivery = CodingArtifacts.decode(
    "delivery",
    CodingArtifacts.toCommit(business[0]),
    input.workflow.id,
    input.workflow.location,
  )
  validateDelivery(delivery, {
    revision,
    implementationSha256: WorkflowImplementationArtifact.hash(implementation),
    testSha256: tested.artifact.sha256,
    codeReviewSha256: reviewed.artifact.sha256,
    testsPassed: true,
    review: reviewed.value,
  })
}

function hostPlan(workflow: Workflow.Info) {
  if (workflow.type !== "coding-build" || !workflow.location) throw new Error("Coding Location required")
  return CodingHostPlan.decode(workflow.input[CodingHostPlan.RESERVED_INPUT_KEY], workflow.location)
}
function unique(artifacts: readonly Workflow.Artifact[], kind: string, revision?: number): Workflow.Artifact {
  const values = artifacts.filter(
    (artifact) =>
      artifact.kind === kind &&
      (revision === undefined ||
        (artifact.metadata.payload !== null &&
          typeof artifact.metadata.payload === "object" &&
          (Reflect.get(artifact.metadata.payload, "revision") === revision ||
            Reflect.get(
              Reflect.get(artifact.metadata.payload, "value") ??
                Reflect.get(artifact.metadata.payload, "manifest") ??
                {},
              "revision",
            ) === revision))),
  )
  if (values.length !== 1) throw new Error("Missing or ambiguous coding dependency")
  return values[0]
}
function manifestAt(workflow: Workflow.Info, artifacts: readonly Workflow.Artifact[], revision: number) {
  return WorkflowImplementationArtifact.decodeExact(
    CodingArtifacts.toCommit(unique(artifacts, WorkflowImplementationArtifact.KIND, revision)),
    workflow.id,
    workflow.location!,
  )
}
function finalChecks(workflow: Workflow.Info, artifacts: readonly Workflow.Artifact[], revision: number) {
  const artifact = unique(artifacts, CodingArtifacts.kinds.checks, revision)
  const value = CodingArtifacts.decode("checks", CodingArtifacts.toCommit(artifact), workflow.id, workflow.location!)
  const implementation = manifestAt(workflow, artifacts, revision)
  if (
    value.implementationSha256 !== WorkflowImplementationArtifact.hash(implementation) ||
    value.workspaceSha256 !== implementation.workspaceSha256 ||
    value.planSha256 !== hostPlan(workflow).sha256 ||
    value.configSha256 !== hostPlan(workflow).configSha256 ||
    !CodingArtifacts.checksPassed(value.checks, hostPlan(workflow))
  )
    throw new Error("Coding final checks do not pass current implementation")
  return { artifact, value }
}
function reviewAt(workflow: Workflow.Info, artifacts: readonly Workflow.Artifact[], revision: number) {
  const artifact = unique(artifacts, CodingArtifacts.kinds.review, revision)
  const value = CodingArtifacts.decode("review", CodingArtifacts.toCommit(artifact), workflow.id, workflow.location!)
  const tested = finalChecks(workflow, artifacts, revision)
  if (value.testSha256 !== tested.artifact.sha256 || value.implementationSha256 !== tested.value.implementationSha256)
    throw new Error("Coding final review lineage mismatch")
  return { artifact, value }
}
function validateRecord(
  record: CodingArtifacts.CheckRecord,
  workflow: Workflow.Info,
  stage: Workflow.Stage,
  implementation: ReturnType<typeof manifestAt>,
) {
  const value = Schema.decodeUnknownSync(CodingArtifacts.CheckRecord)(record)
  const plan = hostPlan(workflow)
  CodingArtifacts.validateChecks(value.checks, plan)
  const cached = CodingArtifacts.checkpointChecks(stage)
  const measuredLease =
    (value.attempt === stage.attempt && value.leaseOwner === stage.leaseOwner) ||
    (cached !== undefined && WorkflowBusinessArtifact.hash(cached) === WorkflowBusinessArtifact.hash(value))
  if (
    value.workflowID !== workflow.id ||
    value.stageID !== stage.id ||
    !measuredLease ||
    value.revision !== implementation.revision ||
    value.locationSha256 !== WorkflowBusinessArtifact.locationSha256(workflow.location!) ||
    value.planSha256 !== plan.sha256 ||
    value.configSha256 !== plan.configSha256 ||
    value.implementationSha256 !== WorkflowImplementationArtifact.hash(implementation) ||
    value.workspaceSha256 !== implementation.workspaceSha256
  )
    throw new Error("Coding host record authority mismatch")
}
function decodePrior(workflow: Workflow.Info, artifacts: readonly Workflow.Artifact[]) {
  return artifacts.flatMap<{ readonly kind: string; readonly value: unknown }>((artifact) => {
    if (artifact.workflowID !== workflow.id) throw new Error("Foreign coding dependency")
    const commit = CodingArtifacts.toCommit(artifact)
    if (artifact.kind === CodingStageMachine.OUTCOME_ARTIFACT_KIND) {
      CodingStageMachine.decodeOutcomeBinding(commit)
      return []
    }
    if (artifact.kind === "tool-continuation") return []
    if (artifact.kind === WorkflowDecompositionArtifact.KIND) {
      const value = WorkflowDecompositionArtifact.decode(commit, workflow.id, workflow.location!)
      validateDecomposition(value)
      return [{ kind: artifact.kind, value }]
    }
    if (artifact.kind === WorkflowImplementationArtifact.KIND)
      return [
        {
          kind: artifact.kind,
          value: WorkflowImplementationArtifact.decodeExact(commit, workflow.id, workflow.location!),
        },
      ]
    const kind = (Object.keys(CodingArtifacts.kinds) as CodingArtifacts.Kind[]).find(
      (kind) => CodingArtifacts.kinds[kind] === artifact.kind,
    )
    if (!kind) throw new Error("Unexpected coding dependency")
    return [{ kind: artifact.kind, value: CodingArtifacts.decode(kind, commit, workflow.id, workflow.location!) }]
  })
}
