import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { DateTime, Effect } from "effect"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { WorkflowStageMachine } from "@opencode-ai/core/workflow/stage-machine"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"

const budget: Workflow.Budget = {
  maxTokens: 120_000,
  maxTurns: 24,
  maxToolCalls: 80,
  maxAttempts: 3,
  maxDurationMs: 3_600_000,
}

const outcome = (role: WorkflowRole.Role, verdict: string, revision: number): Workflow.Artifact => {
  const metadata = { schemaVersion: 1, role, verdict, revision }
  return Workflow.Artifact.make({
    id: Workflow.ArtifactID.make(`wfa_state_${role}_${revision}`),
    workflowID: Workflow.ID.make("wfl_model_state"),
    stageID: Workflow.StageID.make(`wfs_state_${role}_${revision}`),
    kind: WorkflowStageMachine.OUTCOME_ARTIFACT_KIND,
    uri: `artifact://wfl_model_state/${role}/${revision}.json`,
    mime: WorkflowStageMachine.OUTCOME_ARTIFACT_MIME,
    sha256: createHash("sha256").update(JSON.stringify(metadata)).digest("hex"),
    size: JSON.stringify(metadata).length,
    metadata,
    timeCreated: DateTime.makeUnsafe(revision + 1),
  })
}

describe("workflow model state-machine conformance", () => {
  test("the persisted happy path selects only kimi-k3 chat and native DeepSeek Responses routes", async () => {
    const expected: ReadonlyArray<readonly [string, string, string, string]> = [
      ["design", "kimi", "kimi-k3", "openai-chat"],
      ["decompose", "kimi", "kimi-k3", "openai-chat"],
      ["implement", "deepseek", "deepseek-v4-flash", "openai-responses"],
      ["test", "deepseek", "deepseek-v4-flash", "openai-responses"],
      ["visual_review", "kimi", "kimi-k3", "openai-chat"],
      ["deliver", "deepseek", "deepseek-v4-flash", "openai-responses"],
    ]
    const verdicts = ["ready", "ready", "ready", "pass", "pass", "complete"]
    const actual: Array<readonly [string, string, string, string]> = []
    let state = WorkflowStageMachine.initial()

    for (const [index, expectedRoute] of expected.entries()) {
      if (state.status !== "active") throw new Error(`Expected active workflow at step ${index}`)
      const route = WorkflowRouting.resolve({ role: state.role, budget })
      actual.push([state.role, route.providerID, route.modelID, route.model.route.protocol])
      state = await WorkflowStageMachine.advance(state, outcome(state.role, verdicts[index], state.revision)).pipe(
        Effect.runPromise,
      )
      expect(actual[index]).toEqual(expectedRoute)
    }

    expect(state).toEqual({ status: "completed", revision: 0 })
    expect(actual).toEqual([...expected])
  })

  test("a repair transition remains on native DeepSeek Responses before returning to test", async () => {
    const repair = await WorkflowStageMachine.advance(
      { status: "active", role: "visual_review", revision: 0 },
      outcome("visual_review", "revise", 0),
    ).pipe(Effect.runPromise)
    if (repair.status !== "active") throw new Error("Expected repair state")
    const route = WorkflowRouting.resolve({ role: repair.role, budget })
    const afterRepair = await WorkflowStageMachine.advance(repair, outcome("repair", "ready", 1)).pipe(
      Effect.runPromise,
    )

    expect([route.providerID, route.modelID, route.model.route.protocol]).toEqual([
      "deepseek",
      "deepseek-v4-flash",
      "openai-responses",
    ])
    expect(afterRepair).toEqual({ status: "active", role: "test", revision: 1 })
  })
})
