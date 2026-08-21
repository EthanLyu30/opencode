export * as WorkflowGraph from "./graph"

import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Schema } from "effect"

export interface ExpandInput {
  readonly maxRevisions: number
  readonly maxAttempts: number
  readonly responseID: Responses.ID
}

export class InvalidGraph extends Error {}

export function expandVisualBuild(input: ExpandInput): readonly Workflow.RoleStageInput[] {
  if (!Number.isSafeInteger(input.maxRevisions) || input.maxRevisions < 0) {
    throw new InvalidGraph("maxRevisions must be a non-negative safe integer")
  }
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new InvalidGraph("maxAttempts must be a positive safe integer")
  }

  const role = (type: WorkflowRole.Role, revision: number) => ({
    type,
    maxAttempts: input.maxAttempts,
    recoveryPolicy: "restart_safe" as const,
    idempotencyKey: `visual-build/${type}/r${revision}`,
    input: Object.freeze(type === "deliver" ? { responseID: input.responseID, revision } : { revision }),
  })
  const revisions = Array.from({ length: input.maxRevisions }, (_, index) => index + 1)
  return Object.freeze(
    [
      role("design", 0),
      role("decompose", 0),
      role("implement", 0),
      role("test", 0),
      role("visual_review", 0),
      ...revisions.flatMap((revision) => [
        role("repair", revision),
        role("test", revision),
        role("visual_review", revision),
      ]),
      role("deliver", input.maxRevisions),
    ].map((stage, ordinal) => Object.freeze({ ...stage, ordinal })),
  )
}

export function unreachableAfter(input: {
  readonly stages: readonly Workflow.Stage[]
  readonly stageID: Workflow.StageID
  readonly outcome: WorkflowRole.Outcome
}): readonly Workflow.StageID[] {
  const ordered = input.stages
    .filter((stage) => Schema.is(WorkflowRole.Role)(stage.type))
    .toSorted((left, right) => left.ordinal - right.ordinal)
  const source = ordered.find((stage) => stage.id === input.stageID)
  if (!source || source.type !== input.outcome.role)
    throw new InvalidGraph("Outcome source stage does not match its role")
  if (input.outcome.role !== "test" && input.outcome.role !== "visual_review") return Object.freeze([])
  if (typeof source.input.revision === "number" && source.input.revision !== input.outcome.revision) {
    throw new InvalidGraph("Outcome source stage does not match its revision")
  }

  if (input.outcome.role === "test" && input.outcome.verdict === "revise") {
    const target = ordered.find(
      (stage) =>
        stage.ordinal > source.ordinal &&
        stage.type === "visual_review" &&
        stage.input.revision === input.outcome.revision,
    )
    if (!target) throw new InvalidGraph("Revised test has no declared visual-review branch to skip")
    return Object.freeze([target.id])
  }
  if (input.outcome.role !== "visual_review" || input.outcome.verdict !== "pass") return Object.freeze([])

  return Object.freeze(
    ordered
      .filter(
        (stage) =>
          stage.ordinal > source.ordinal &&
          typeof stage.input.revision === "number" &&
          stage.input.revision > input.outcome.revision &&
          (stage.type === "repair" || stage.type === "test" || stage.type === "visual_review"),
      )
      .map((stage) => stage.id),
  )
}
