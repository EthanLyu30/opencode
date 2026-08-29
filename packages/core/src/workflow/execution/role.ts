export * as WorkflowRoleExecution from "./role"

import { Location } from "@opencode-ai/schema/location"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Message } from "@opencode-ai/llm"
import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { Hash } from "../../util/hash"
import { WorkflowStageMachine } from "../stage-machine"
import { WorkflowTestLogArtifact } from "../artifacts/test-log"
import { WorkflowRoleContract } from "./contract"
import * as WorkflowRoleBinding from "./role-binding"
import { resolve as deterministicResolve } from "./role-fake"

export const TEST_LOG_KIND = WorkflowTestLogArtifact.KIND
export const TEST_LOG_MIME = WorkflowTestLogArtifact.MIME
export const Receipt = WorkflowRoleBinding.Receipt
export type Receipt = WorkflowRoleBinding.Receipt
export type ValidateSettlementInput = WorkflowRoleBinding.ValidateSettlementInput
export const requiredKinds = WorkflowRoleBinding.requiredKinds
export const validateSettlement = WorkflowRoleBinding.validateSettlement
export const validateLegacyOutcome = WorkflowRoleBinding.validateLegacyOutcome
export const artifactSetDigest = WorkflowRoleBinding.artifactSetDigest

export interface DecodedPriorArtifact {
  readonly kind: string
  readonly artifact: Workflow.Artifact
  readonly commit: Workflow.ArtifactCommit
  readonly value: unknown
}

export interface ResolverInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
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
  readonly execution: {
    readonly workflowUsage: Workflow.Usage
    readonly workflowBudget: Workflow.Budget
    readonly executionUsage: Workflow.Usage
    readonly providerUsage: Responses.Usage
  }
  readonly preparation?: Preparation
}

export interface ResolverOutput {
  readonly artifacts: readonly Workflow.ArtifactCommit[]
  readonly dependencies?: readonly Workflow.Artifact[]
}

export interface Interface {
  readonly prepare: (input: PrepareInput) => Effect.Effect<Preparation, EvidenceFailure>
  readonly resolve: (input: ResolverInput) => Effect.Effect<ResolverOutput, EvidenceFailure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkflowRoleEvidenceResolver") {}

export class EvidenceFailure extends Data.TaggedError("WorkflowRoleExecution.EvidenceFailure")<{
  readonly code: string
  readonly message: string
}> {}

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const PreparationEvidence = Schema.Struct({
  evidenceID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  receiptSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  coordinates: Schema.Struct({
    schemaVersion: Schema.Literal(1),
    workflowID: Workflow.ID,
    stageID: Workflow.StageID,
    kind: Schema.Literals(["reference", "implementation"]),
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    viewport: DesignArtifact.Viewport,
    configSha256: DesignArtifact.Sha256,
    sourceSha256: DesignArtifact.Sha256,
    readySelectorSha256: DesignArtifact.Sha256,
  }).annotate({ identifier: "WorkflowRoleExecution.PreparationEvidenceCoordinates", ...exact }),
}).annotate({ identifier: "WorkflowRoleExecution.PreparationEvidence", ...exact })
export const PreparationAuthority = Schema.Struct({
  preparationVersion: Schema.Literal(1),
  role: WorkflowRole.Role,
  revision: Schema.Number,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  evidence: Schema.Array(PreparationEvidence),
  dependencyArtifactSetSha256: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
}).annotate({ identifier: "WorkflowRoleExecution.PreparationAuthority", ...exact })
export interface PreparationAuthority extends Schema.Schema.Type<typeof PreparationAuthority> {}

export interface Preparation {
  readonly messages?: readonly Message[]
  readonly authority?: PreparationAuthority
  /** Trusted in-memory commits used by settlement; never persisted in a checkpoint. */
  readonly artifacts?: readonly Workflow.ArtifactCommit[]
  /** Exact read-only durable Artifacts consumed by this stage but owned by earlier stages. */
  readonly dependencies?: readonly Workflow.Artifact[]
  readonly test?: {
    readonly argv: readonly string[]
    readonly cwd: string
    readonly exitCode: number
    readonly log: string
    readonly implementationSha256: string
  }
}

export interface PrepareInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly revision: number
  readonly location: Location.Ref
  readonly priorArtifacts: readonly Workflow.Artifact[]
  readonly admission: {
    readonly workflowInput: Readonly<Record<string, unknown>>
    readonly stageInput: Readonly<Record<string, unknown>>
  }
  readonly checkpoint?: Readonly<Record<string, unknown>>
}

const emptyPreparation = Object.freeze({})

export const failClosedLayer = Layer.succeed(
  Service,
  Service.of({
    prepare: () => Effect.succeed(emptyPreparation),
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
    prepare: () => Effect.succeed(emptyPreparation),
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
  readonly executionUsage: Workflow.Usage
  readonly providerUsage: Responses.Usage
  readonly preparation?: Preparation
}

export interface Settlement {
  readonly artifacts: readonly Workflow.ArtifactCommit[]
  readonly dependencies?: readonly Workflow.Artifact[]
  readonly receipt: Receipt
}

export const prepare = Effect.fn("WorkflowRoleExecution.prepare")(function* (input: PrepareInput) {
  const resolver = yield* Service
  if (
    !Schema.is(Workflow.Info)(input.workflow) ||
    !Schema.is(Workflow.Stage)(input.stage) ||
    input.stage.workflowID !== input.workflow.id ||
    input.workflow.location === undefined ||
    input.workflow.location.directory !== input.location.directory ||
    input.revision !== revisionOf(input.stage)
  ) {
    return yield* new EvidenceFailure({ code: "invalid_role_authority", message: "Preparation authority is invalid" })
  }
  return yield* resolver.prepare(input)
})

export const settle = Effect.fn("WorkflowRoleExecution.settle")(function* (input: SettleInput) {
  const resolver = yield* Service
  if (
    !Schema.is(Workflow.Info)(input.workflow) ||
    !Schema.is(Workflow.Stage)(input.stage) ||
    input.stage.workflowID !== input.workflow.id ||
    !Schema.is(Workflow.Usage)(input.executionUsage) ||
    !Schema.is(Responses.Usage)(input.providerUsage)
  )
    return yield* new EvidenceFailure({
      code: "invalid_role_authority",
      message: "Persisted role authority facts are invalid",
    })
  for (const artifact of input.settledToolEvidence) {
    if (!Schema.is(Workflow.ArtifactCommit)(artifact))
      return yield* new EvidenceFailure({
        code: "invalid_tool_evidence",
        message: "Settled tool evidence is invalid",
      })
    WorkflowRoleContract.assertGenericProviderValue(artifact)
  }
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
    try: () => WorkflowRoleBinding.decodePriorArtifacts(input.workflow, location, input.priorArtifacts),
    catch: () => new EvidenceFailure({ code: "invalid_prior_artifact", message: "Prior role artifact is invalid" }),
  })
  const resolved = yield* resolver.resolve({
    workflow: input.workflow,
    stage: input.stage,
    revision: input.contract.revision,
    location,
    priorArtifacts,
    semantic,
    settledToolEvidence: input.settledToolEvidence,
    admission: { workflowInput: input.workflow.input, stageInput: input.stage.input },
    contextDigest,
    execution: {
      workflowUsage: input.workflow.usage,
      workflowBudget: input.workflow.budget,
      executionUsage: input.executionUsage,
      providerUsage: input.providerUsage,
    },
    ...(input.preparation === undefined ? {} : { preparation: input.preparation }),
  })
  const dependencies = resolved.dependencies ?? []
  yield* Effect.try({
    try: () =>
      WorkflowRoleBinding.validateBusinessArtifacts(
        input.workflow,
        input.stage,
        resolved.artifacts,
        input.priorArtifacts,
        semantic.outcome,
        dependencies,
      ),
    catch: () => new EvidenceFailure({ code: "invalid_role_evidence", message: "Role business evidence is invalid" }),
  })
  yield* Effect.try({
    try: () =>
      WorkflowRoleBinding.validateDependencies(input.workflow, input.stage, dependencies, input.priorArtifacts),
    catch: () => new EvidenceFailure({ code: "invalid_role_evidence", message: "Role dependency evidence is invalid" }),
  })
  const requiredArtifactSetSha256 = WorkflowRoleBinding.artifactSetDigest(resolved.artifacts)
  const dependencyArtifactSetSha256 =
    dependencies.length === 0 ? undefined : WorkflowRoleBinding.artifactSetDigest(dependencies)
  const binding = WorkflowStageMachine.OutcomeBinding.make({
    bindingVersion: 1,
    outcome: semantic.outcome,
    contractFingerprint: input.contract.contractFingerprint,
    contextDigest,
    requiredArtifactSetSha256,
    ...(dependencyArtifactSetSha256 === undefined ? {} : { dependencyArtifactSetSha256 }),
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
    ...(dependencyArtifactSetSha256 === undefined ? {} : { dependencyArtifactSetSha256 }),
    outcomeSha256: outcome.sha256,
    authority: input.contract.authority,
  })
  return {
    artifacts: Object.freeze([...resolved.artifacts, outcome]),
    ...(dependencies.length === 0 ? {} : { dependencies: Object.freeze([...dependencies]) }),
    receipt,
  }
})

function revisionOf(stage: Workflow.Stage): number {
  const revision = stage.input.revision ?? 0
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    throw new EvidenceFailure({ code: "invalid_role_authority", message: "Role revision is invalid" })
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
