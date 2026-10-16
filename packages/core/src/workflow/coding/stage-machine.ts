export * as CodingStageMachine from "./stage-machine"

import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Data, Effect, Schema } from "effect"
import { Hash } from "../../util/hash"
import { CodingContract } from "./contract"
import { CodingGraph } from "./graph"

export const OUTCOME_ARTIFACT_KIND = "workflow.coding.outcome"
export const OUTCOME_ARTIFACT_MIME = "application/vnd.opencode.workflow-coding-outcome+json"
export const OutcomeBinding = Schema.Struct({
  bindingVersion: Schema.Literal(1),
  outcome: CodingContract.Outcome,
  contractFingerprint: DesignArtifact.Sha256,
  contextDigest: DesignArtifact.Sha256,
  requiredArtifactSetSha256: DesignArtifact.Sha256,
}).annotate({ identifier: "CodingStageMachine.OutcomeBinding", parseOptions: { onExcessProperty: "error" } })
export type OutcomeBinding = typeof OutcomeBinding.Type
export type State =
  | { readonly status: "active"; readonly role: WorkflowCodingBuild.Role; readonly revision: number }
  | { readonly status: "completed"; readonly revision: number }
export class InvalidOutcome extends Data.TaggedError("CodingStageMachine.InvalidOutcome")<{ readonly code: string }> {}
export const initial = (): State => ({ status: "active", role: "design", revision: 0 })
export function encodeOutcome(input: OutcomeBinding): string {
  return JSON.stringify({
    bindingVersion: 1,
    outcome: {
      schemaVersion: 1,
      role: input.outcome.role,
      revision: input.outcome.revision,
      verdict: input.outcome.verdict,
    },
    contractFingerprint: input.contractFingerprint,
    contextDigest: input.contextDigest,
    requiredArtifactSetSha256: input.requiredArtifactSetSha256,
  })
}
export function decodeOutcomeBinding(artifact: Workflow.ArtifactCommit): OutcomeBinding {
  if (artifact.kind !== OUTCOME_ARTIFACT_KIND || artifact.mime !== OUTCOME_ARTIFACT_MIME)
    throw new InvalidOutcome({ code: "invalid_artifact" })
  const binding = Schema.decodeUnknownSync(OutcomeBinding)(artifact.metadata)
  const body = encodeOutcome(binding)
  if (artifact.sha256 !== Hash.sha256(body) || artifact.size !== Buffer.byteLength(body))
    throw new InvalidOutcome({ code: "hash_mismatch" })
  return binding
}
export const decodeOutcome = (artifact: Workflow.ArtifactCommit) =>
  Effect.try({
    try: () => decodeOutcomeBinding(artifact).outcome,
    catch: () => new InvalidOutcome({ code: "invalid_artifact" }),
  })
export const advance = Effect.fn("CodingStageMachine.advance")(function* (
  state: State,
  artifact: Workflow.ArtifactCommit,
) {
  if (state.status === "completed") return yield* new InvalidOutcome({ code: "already_completed" })
  const outcome = yield* decodeOutcome(artifact)
  if (outcome.role !== state.role || outcome.revision !== state.revision)
    return yield* new InvalidOutcome({ code: "role_revision_mismatch" })
  const active = (role: WorkflowCodingBuild.Role, revision = state.revision): State => ({
    status: "active",
    role,
    revision,
  })
  if (outcome.role === "design") return active("decompose")
  if (outcome.role === "decompose") return active("implement")
  if (outcome.role === "implement" || outcome.role === "repair") return active("test")
  if (outcome.role === "test")
    return outcome.verdict === "pass" ? active("code_review") : active("repair", state.revision + 1)
  if (outcome.role === "code_review")
    return outcome.verdict === "pass" ? active("deliver") : active("repair", state.revision + 1)
  return { status: "completed" as const, revision: state.revision }
})
export const replay = Effect.fn("CodingStageMachine.replay")(function* (input: {
  readonly stages: readonly Workflow.Stage[]
  readonly artifacts: readonly Workflow.Artifact[]
  readonly beforeOrdinal?: number
}) {
  let state = initial()
  const ordered = input.stages.toSorted((a, b) => a.ordinal - b.ordinal)
  if (
    ordered.some((stage) => !Schema.is(WorkflowCodingBuild.Role)(stage.type)) ||
    new Set(ordered.map((stage) => stage.ordinal)).size !== ordered.length ||
    new Set(ordered.map((stage) => stage.id)).size !== ordered.length
  )
    return yield* new InvalidOutcome({ code: "invalid_graph" })
  const authorized = new Set<Workflow.StageID>()
  for (const stage of ordered.filter(
    (stage) => input.beforeOrdinal === undefined || stage.ordinal < input.beforeOrdinal,
  )) {
    if (stage.status === "skipped") {
      if (!authorized.delete(stage.id)) return yield* new InvalidOutcome({ code: "unexpected_skip" })
      continue
    }
    if (authorized.has(stage.id)) return yield* new InvalidOutcome({ code: "missing_skip" })
    if (state.status !== "active" || stage.type !== state.role)
      return yield* new InvalidOutcome({ code: "stage_role_mismatch" })
    const outcomes = input.artifacts.filter(
      (artifact) => artifact.stageID === stage.id && artifact.kind === OUTCOME_ARTIFACT_KIND,
    )
    if (outcomes.length !== 1 || outcomes[0].workflowID !== stage.workflowID)
      return yield* new InvalidOutcome({ code: "missing_or_duplicate_outcome" })
    const outcome = yield* decodeOutcome(outcomes[0])
    state = yield* advance(state, outcomes[0])
    const skipped = yield* Effect.try({
      try: () => CodingGraph.unreachableAfter({ stages: ordered, stageID: stage.id, outcome }),
      catch: () => new InvalidOutcome({ code: "invalid_skip" }),
    })
    for (const stageID of skipped) authorized.add(stageID)
  }
  return state
})
