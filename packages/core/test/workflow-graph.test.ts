import { describe, expect, test } from "bun:test"
import { WorkflowGraph } from "@opencode-ai/core/workflow/graph"
import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { DateTime } from "effect"

const responseID = Responses.ID.make("resp_visual_graph")

const expand = (maxRevisions: number) => WorkflowGraph.expandVisualBuild({ maxRevisions, maxAttempts: 3, responseID })

const project = (maxRevisions: number) =>
  expand(maxRevisions).map((input, index) =>
    Workflow.Stage.make({
      ...input,
      id: Workflow.StageID.make(`wfs_visual_graph_${index}`),
      workflowID: Workflow.ID.make("wfl_visual_graph"),
      status: "pending",
      attempt: 0,
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
    }),
  )

describe("WorkflowGraph", () => {
  test.each([
    [0, ["design", "decompose", "implement", "test", "visual_review", "deliver"]],
    [1, ["design", "decompose", "implement", "test", "visual_review", "repair", "test", "visual_review", "deliver"]],
    [
      2,
      [
        "design",
        "decompose",
        "implement",
        "test",
        "visual_review",
        "repair",
        "test",
        "visual_review",
        "repair",
        "test",
        "visual_review",
        "deliver",
      ],
    ],
  ] as const)("preallocates the complete visual graph for %d revisions", (maxRevisions, types) => {
    const stages = expand(maxRevisions)

    expect(stages.map((stage) => stage.type)).toEqual([...types])
    expect(stages.map((stage) => stage.ordinal)).toEqual(types.map((_, index) => index))
    expect(new Set(stages.map((stage) => stage.idempotencyKey)).size).toBe(stages.length)
    expect(
      stages.every(
        (stage) =>
          typeof stage.input.revision === "number" &&
          stage.idempotencyKey.includes(`${stage.type}/r${stage.input.revision}`),
      ),
    ).toBe(true)
    expect(stages.find((stage) => stage.type === "deliver")?.input.responseID).toBe(responseID)
    expect(stages.filter((stage) => stage.type !== "deliver").every((stage) => !("responseID" in stage.input))).toBe(
      true,
    )
    expect(Object.isFrozen(stages)).toBe(true)
  })

  test("derives only the branch made unreachable by a validated role outcome", () => {
    const stages = project(2)
    const test0 = stages.find((stage) => stage.type === "test" && stage.input.revision === 0)!
    const review0 = stages.find((stage) => stage.type === "visual_review" && stage.input.revision === 0)!

    expect(
      WorkflowGraph.unreachableAfter({
        stages,
        stageID: test0.id,
        outcome: WorkflowRole.Outcome.make({ schemaVersion: 1, role: "test", verdict: "revise", revision: 0 }),
      }),
    ).toEqual([review0.id])
    expect(
      WorkflowGraph.unreachableAfter({
        stages,
        stageID: test0.id,
        outcome: WorkflowRole.Outcome.make({ schemaVersion: 1, role: "test", verdict: "pass", revision: 0 }),
      }),
    ).toEqual([])
    expect(
      WorkflowGraph.unreachableAfter({
        stages,
        stageID: review0.id,
        outcome: WorkflowRole.Outcome.make({
          schemaVersion: 1,
          role: "visual_review",
          verdict: "revise",
          revision: 0,
        }),
      }),
    ).toEqual([])
    expect(
      WorkflowGraph.unreachableAfter({
        stages,
        stageID: review0.id,
        outcome: WorkflowRole.Outcome.make({
          schemaVersion: 1,
          role: "visual_review",
          verdict: "pass",
          revision: 0,
        }),
      }),
    ).toEqual(
      stages
        .filter(
          (stage) =>
            (stage.input.revision === 1 || stage.input.revision === 2) &&
            (stage.type === "repair" || stage.type === "test" || stage.type === "visual_review"),
        )
        .map((stage) => stage.id),
    )
  })
})
