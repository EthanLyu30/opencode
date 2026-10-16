export * as CodingGraph from "./graph"

import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { Schema } from "effect"
import type { CodingContract } from "./contract"

export function expand(input: {
  readonly maxRevisions: number
  readonly maxAttempts: number
  readonly responseID: Responses.ID
}): readonly Workflow.StageInput[] {
  if (
    !Number.isSafeInteger(input.maxRevisions) ||
    input.maxRevisions < 0 ||
    input.maxRevisions > 10 ||
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts < 1
  )
    throw new Error("Invalid bounded coding graph")
  const role = (type: WorkflowCodingBuild.Role, revision: number) => ({
    type,
    maxAttempts: input.maxAttempts,
    recoveryPolicy: "restart_safe" as const,
    idempotencyKey: `coding-build/${type}/r${revision}`,
    input: Object.freeze(type === "deliver" ? { revision, responseID: input.responseID } : { revision }),
  })
  return Object.freeze(
    [
      role("design", 0),
      role("decompose", 0),
      role("implement", 0),
      role("test", 0),
      role("code_review", 0),
      ...Array.from({ length: input.maxRevisions }, (_, index) => index + 1).flatMap((revision) => [
        role("repair", revision),
        role("test", revision),
        role("code_review", revision),
      ]),
      role("deliver", input.maxRevisions),
    ].map((stage, ordinal) => Object.freeze({ ...stage, ordinal })),
  )
}

export function unreachableAfter(input: {
  readonly stages: readonly Workflow.Stage[]
  readonly stageID: Workflow.StageID
  readonly outcome: CodingContract.Outcome
}): readonly Workflow.StageID[] {
  const ordered = input.stages.toSorted((a, b) => a.ordinal - b.ordinal)
  if (ordered.some((stage) => !Schema.is(WorkflowCodingBuild.Role)(stage.type))) throw new Error("Not a coding graph")
  const source = ordered.find((stage) => stage.id === input.stageID)
  if (
    !source ||
    source.type !== input.outcome.role ||
    (source.type !== "deliver" && source.input.revision !== input.outcome.revision)
  )
    throw new Error("Coding branch source mismatch")
  if (input.outcome.role === "test" && input.outcome.verdict === "revise") {
    const review = ordered.find(
      (stage) =>
        stage.ordinal > source.ordinal &&
        stage.type === "code_review" &&
        stage.input.revision === input.outcome.revision,
    )
    if (!review) throw new Error("Coding test has no review branch")
    return Object.freeze([review.id])
  }
  if (input.outcome.role !== "code_review" || input.outcome.verdict !== "pass") return Object.freeze([])
  return Object.freeze(
    ordered
      .filter(
        (stage) =>
          stage.ordinal > source.ordinal &&
          Number(stage.input.revision) > input.outcome.revision &&
          ["repair", "test", "code_review"].includes(stage.type),
      )
      .map((stage) => stage.id),
  )
}
