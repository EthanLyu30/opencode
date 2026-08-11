export * as WorkflowStageMachine from "./stage-machine"

import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Data, Effect, Schema } from "effect"
import { Hash } from "../util/hash"
import { WorkflowBudget } from "./budget"

export const OUTCOME_ARTIFACT_KIND = "workflow.role.outcome"
export const OUTCOME_ARTIFACT_MIME = "application/vnd.opencode.workflow-role-outcome+json"

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

export function encodeOutcome(outcome: WorkflowRole.Outcome) {
  return JSON.stringify({
    schemaVersion: outcome.schemaVersion,
    role: outcome.role,
    verdict: outcome.verdict,
    revision: outcome.revision,
  })
}

export const advance = Effect.fn("WorkflowStageMachine.advance")(function* (
  state: State,
  artifact: Workflow.ArtifactCommit,
) {
  if (state.status === "completed") return yield* new InvalidOutcome({ code: "already_completed" })
  if (artifact.kind !== OUTCOME_ARTIFACT_KIND || artifact.mime !== OUTCOME_ARTIFACT_MIME)
    return yield* new InvalidOutcome({ code: "invalid_artifact" })

  const outcome = yield* Schema.decodeUnknownEffect(WorkflowRole.Outcome)(artifact.metadata).pipe(
    Effect.mapError(() => new InvalidOutcome({ code: "invalid_metadata" })),
  )
  if (Hash.sha256(encodeOutcome(outcome)) !== artifact.sha256)
    return yield* new InvalidOutcome({ code: "hash_mismatch" })
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
  const stages = input.stages
    .filter(
      (stage) =>
        Schema.is(WorkflowRole.Role)(stage.type) &&
        (input.beforeOrdinal === undefined || stage.ordinal < input.beforeOrdinal),
    )
    .sort((left, right) => left.ordinal - right.ordinal)

  for (const stage of stages) {
    if (state.status === "active" && stage.type !== state.role)
      return yield* new InvalidOutcome({ code: "stage_role_mismatch" })
    const outcomes = input.artifacts.filter(
      (artifact) => artifact.stageID === stage.id && artifact.kind === OUTCOME_ARTIFACT_KIND,
    )
    if (outcomes.length === 0) return yield* new InvalidOutcome({ code: "missing_outcome" })
    if (outcomes.length > 1) return yield* new InvalidOutcome({ code: "duplicate_outcome" })
    state = yield* advance(state, outcomes[0])
  }
  return state
})

function active(role: WorkflowRole.Role, revision: number): State {
  return { status: "active", role, revision }
}
