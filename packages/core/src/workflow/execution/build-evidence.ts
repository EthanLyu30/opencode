export * as BuildEvidence from "./build-evidence"

import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { Effect, Schema } from "effect"
import { CodingEvidence } from "../coding/evidence"
import { CodingGraph } from "../coding/graph"
import { CodingStageMachine } from "../coding/stage-machine"
import { WorkflowGraph } from "../graph"
import { WorkflowStageMachine } from "../stage-machine"
import { WorkflowRoleExecution } from "./role"

export type Receipt = WorkflowRoleExecution.Receipt | CodingEvidence.Receipt
export function isRole(workflow: Pick<Workflow.Info, "type">, role: string): boolean {
  return workflow.type === "coding-build"
    ? Schema.is(WorkflowCodingBuild.Role)(role)
    : Schema.is(WorkflowRole.Role)(role)
}
export const outcomeKind = (workflow: Pick<Workflow.Info, "type">) =>
  workflow.type === "coding-build"
    ? CodingStageMachine.OUTCOME_ARTIFACT_KIND
    : WorkflowStageMachine.OUTCOME_ARTIFACT_KIND
export function validateSettlement(input: WorkflowRoleExecution.ValidateSettlementInput): void {
  return input.workflow.type === "coding-build"
    ? CodingEvidence.validateSettlement(input)
    : WorkflowRoleExecution.validateSettlement(input)
}
export const replay = (
  workflow: Pick<Workflow.Info, "type">,
  input: WorkflowStageMachine.ReplayInput,
): Effect.Effect<
  CodingStageMachine.State | WorkflowStageMachine.State,
  CodingStageMachine.InvalidOutcome | WorkflowStageMachine.InvalidOutcome
> => (workflow.type === "coding-build" ? CodingStageMachine.replay(input) : WorkflowStageMachine.replay(input))

export const branch = Effect.fn("BuildEvidence.branch")(function* (input: {
  readonly workflow: Pick<Workflow.Info, "type">
  readonly stages: readonly Workflow.Stage[]
  readonly stage: Workflow.Stage
  readonly artifacts: readonly Workflow.Artifact[]
  readonly outcome: Workflow.ArtifactCommit
}) {
  if (input.workflow.type === "coding-build") {
    const state = yield* CodingStageMachine.replay({
      stages: input.stages,
      artifacts: input.artifacts,
      beforeOrdinal: input.stage.ordinal,
    })
    yield* CodingStageMachine.advance(state, input.outcome)
    const outcome = yield* CodingStageMachine.decodeOutcome(input.outcome)
    return yield* Effect.try({
      try: () => CodingGraph.unreachableAfter({ stages: input.stages, stageID: input.stage.id, outcome }),
      catch: () => new CodingStageMachine.InvalidOutcome({ code: "invalid_skip" }),
    })
  }
  const state = yield* WorkflowStageMachine.replay({
    stages: input.stages,
    artifacts: input.artifacts,
    beforeOrdinal: input.stage.ordinal,
  })
  yield* WorkflowStageMachine.advance(state, input.outcome)
  const outcome = yield* WorkflowStageMachine.decodeOutcome(input.outcome)
  return yield* Effect.try({
    try: () => WorkflowGraph.unreachableAfter({ stages: input.stages, stageID: input.stage.id, outcome }),
    catch: () => new WorkflowStageMachine.InvalidOutcome({ code: "invalid_skip" }),
  })
})
/** Projection already has durable artifacts; it revalidates the profile's exact branch proof. */
export const unreachableAfter = Effect.fn("BuildEvidence.unreachableAfter")(function* (input: {
  readonly workflow: Pick<Workflow.Info, "type">
  readonly stages: readonly Workflow.Stage[]
  readonly stageID: Workflow.StageID
  readonly artifact: Workflow.ArtifactCommit
}) {
  if (input.workflow.type === "coding-build") {
    const outcome = yield* CodingStageMachine.decodeOutcome(input.artifact)
    return CodingGraph.unreachableAfter({ stages: input.stages, stageID: input.stageID, outcome })
  }
  const outcome = yield* WorkflowStageMachine.decodeOutcome(input.artifact)
  return WorkflowGraph.unreachableAfter({ stages: input.stages, stageID: input.stageID, outcome })
})
