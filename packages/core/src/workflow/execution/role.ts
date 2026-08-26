export * as WorkflowRoleExecution from "./role"

import { Location } from "@opencode-ai/schema/location"
import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
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
  readonly executionUsage: Workflow.Usage
  readonly providerUsage: Responses.Usage
}

export interface Settlement {
  readonly artifacts: readonly Workflow.ArtifactCommit[]
  readonly receipt: Receipt
}

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
  })
  yield* Effect.try({
    try: () =>
      WorkflowRoleBinding.validateBusinessArtifacts(
        input.workflow,
        input.stage,
        resolved.artifacts,
        input.priorArtifacts,
        semantic.outcome,
      ),
    catch: () => new EvidenceFailure({ code: "invalid_role_evidence", message: "Role business evidence is invalid" }),
  })
  const requiredArtifactSetSha256 = WorkflowRoleBinding.artifactSetDigest(resolved.artifacts)
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
    authority: input.contract.authority,
  })
  return { artifacts: Object.freeze([...resolved.artifacts, outcome]), receipt }
})

function resolverFailure(error: unknown): EvidenceFailure {
  return error instanceof EvidenceFailure
    ? error
    : new EvidenceFailure({
        code: "role_evidence_invalid",
        message: error instanceof Error ? error.message : "Role evidence resolution failed",
      })
}
