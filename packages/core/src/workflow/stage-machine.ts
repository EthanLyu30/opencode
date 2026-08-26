export * as WorkflowStageMachine from "./stage-machine"

import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Data, Effect, Schema } from "effect"
import { Hash } from "../util/hash"
import { WorkflowBudget } from "./budget"
import { WorkflowGraph } from "./graph"

export const OUTCOME_ARTIFACT_KIND = "workflow.role.outcome"
export const OUTCOME_ARTIFACT_MIME = "application/vnd.opencode.workflow-role-outcome+json"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
export const OutcomeBinding = Schema.Struct({
  bindingVersion: Schema.Literal(1),
  outcome: WorkflowRole.Outcome,
  contractFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  contextDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  requiredArtifactSetSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
}).annotate({ identifier: "WorkflowStageMachine.OutcomeBinding", ...exact })
export interface OutcomeBinding extends Schema.Schema.Type<typeof OutcomeBinding> {}

export type State =
  | { readonly status: "active"; readonly role: WorkflowRole.Role; readonly revision: number }
  | { readonly status: "completed"; readonly revision: number }

export class InvalidOutcome extends Data.TaggedError("WorkflowStageMachine.InvalidOutcome")<{
  readonly code:
    | "invalid_artifact"
    | "hash_mismatch"
    | "invalid_metadata"
    | "role_mismatch"
    | "revision_mismatch"
    | "already_completed"
    | "missing_outcome"
    | "duplicate_outcome"
    | "stage_role_mismatch"
    | "unexpected_skip"
    | "missing_skip"
    | "invalid_skip"
}> {}

export const initial = (): State => ({ status: "active", role: "design", revision: 0 })

export type VisualRepairDecision =
  | { readonly type: "repair"; readonly revision: number }
  | { readonly type: "approval"; readonly reason: "max_revisions" | "budget_exhausted" }

/** Central authority for every visual-review repair edge. */
export function decideVisualRepair(input: {
  readonly revision: number
  readonly maxRevisions: number
  readonly budget: Workflow.Budget
  readonly usage: Workflow.Usage
}): VisualRepairDecision {
  if (WorkflowBudget.evaluate({ budget: input.budget, usage: input.usage, notified: 0, elapsedMs: 0 }).exhausted)
    return { type: "approval", reason: "budget_exhausted" }
  if (input.revision >= input.maxRevisions) return { type: "approval", reason: "max_revisions" }
  return { type: "repair", revision: input.revision + 1 }
}

export function encodeOutcome(input: WorkflowRole.Outcome | OutcomeBinding) {
  if (Schema.is(OutcomeBinding)(input)) {
    return JSON.stringify({
      bindingVersion: input.bindingVersion,
      outcome: {
        schemaVersion: input.outcome.schemaVersion,
        role: input.outcome.role,
        verdict: input.outcome.verdict,
        revision: input.outcome.revision,
      },
      contractFingerprint: input.contractFingerprint,
      contextDigest: input.contextDigest,
      requiredArtifactSetSha256: input.requiredArtifactSetSha256,
    })
  }
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    role: input.role,
    verdict: input.verdict,
    revision: input.revision,
  })
}

export const decodeOutcome = Effect.fn("WorkflowStageMachine.decodeOutcome")(function* (
  artifact: Workflow.ArtifactCommit,
) {
  if (artifact.kind !== OUTCOME_ARTIFACT_KIND || artifact.mime !== OUTCOME_ARTIFACT_MIME)
    return yield* new InvalidOutcome({ code: "invalid_artifact" })

  const binding = Schema.is(OutcomeBinding)(artifact.metadata)
    ? Schema.decodeUnknownSync(OutcomeBinding)(artifact.metadata)
    : undefined
  const outcome =
    binding?.outcome ??
    (yield* Schema.decodeUnknownEffect(WorkflowRole.Outcome)(artifact.metadata).pipe(
      Effect.mapError(() => new InvalidOutcome({ code: "invalid_metadata" })),
    ))
  if (Hash.sha256(encodeOutcome(binding ?? outcome)) !== artifact.sha256)
    return yield* new InvalidOutcome({ code: "hash_mismatch" })
  return outcome
})

export function decodeOutcomeBinding(artifact: Workflow.ArtifactCommit): OutcomeBinding {
  if (artifact.kind !== OUTCOME_ARTIFACT_KIND || artifact.mime !== OUTCOME_ARTIFACT_MIME)
    throw new Error("Artifact is not a role outcome")
  const binding = Schema.decodeUnknownSync(OutcomeBinding)(artifact.metadata)
  if (Hash.sha256(encodeOutcome(binding)) !== artifact.sha256) throw new Error("Role outcome binding hash mismatch")
  return binding
}

export const advance = Effect.fn("WorkflowStageMachine.advance")(function* (
  state: State,
  artifact: Workflow.ArtifactCommit,
) {
  if (state.status === "completed") return yield* new InvalidOutcome({ code: "already_completed" })
  const outcome = yield* decodeOutcome(artifact)
  if (outcome.role !== state.role) return yield* new InvalidOutcome({ code: "role_mismatch" })
  if (outcome.revision !== state.revision) return yield* new InvalidOutcome({ code: "revision_mismatch" })

  if (outcome.role === "design") return active("decompose", state.revision)
  if (outcome.role === "decompose") return active("implement", state.revision)
  if (outcome.role === "implement") return active("test", state.revision)
  if (outcome.role === "test")
    return outcome.verdict === "pass" ? active("visual_review", state.revision) : active("repair", state.revision + 1)
  if (outcome.role === "visual_review")
    return outcome.verdict === "pass" ? active("deliver", state.revision) : active("repair", state.revision + 1)
  if (outcome.role === "repair") return active("test", state.revision)
  return { status: "completed" as const, revision: state.revision }
})

export interface ReplayInput {
  readonly stages: ReadonlyArray<Workflow.Stage>
  readonly artifacts: ReadonlyArray<Workflow.Artifact>
  readonly beforeOrdinal?: number
}

export const replay = Effect.fn("WorkflowStageMachine.replay")(function* (input: ReplayInput) {
  let state = initial()
  const roleStages = input.stages.filter((stage) => Schema.is(WorkflowRole.Role)(stage.type))
  const stages = roleStages
    .filter((stage) => input.beforeOrdinal === undefined || stage.ordinal < input.beforeOrdinal)
    .sort((left, right) => left.ordinal - right.ordinal)
  const authorizedSkips = new Set<Workflow.StageID>()

  for (const stage of stages) {
    if (stage.status === "skipped") {
      if (!authorizedSkips.delete(stage.id)) return yield* new InvalidOutcome({ code: "unexpected_skip" })
      continue
    }
    if (authorizedSkips.has(stage.id)) return yield* new InvalidOutcome({ code: "missing_skip" })
    if (state.status === "active" && stage.type !== state.role)
      return yield* new InvalidOutcome({ code: "stage_role_mismatch" })
    const outcomes = input.artifacts.filter(
      (artifact) => artifact.stageID === stage.id && artifact.kind === OUTCOME_ARTIFACT_KIND,
    )
    if (outcomes.length === 0) return yield* new InvalidOutcome({ code: "missing_outcome" })
    if (outcomes.length > 1) return yield* new InvalidOutcome({ code: "duplicate_outcome" })
    const outcome = yield* decodeOutcome(outcomes[0])
    state = yield* advance(state, outcomes[0])
    const skipped = yield* Effect.try({
      try: () => WorkflowGraph.unreachableAfter({ stages: roleStages, stageID: stage.id, outcome }),
      catch: () => new InvalidOutcome({ code: "invalid_skip" }),
    })
    for (const stageID of skipped) authorizedSkips.add(stageID)
  }
  if (stages.some((stage) => authorizedSkips.has(stage.id))) return yield* new InvalidOutcome({ code: "missing_skip" })
  return state
})

function active(role: WorkflowRole.Role, revision: number): State {
  return { status: "active", role, revision }
}
