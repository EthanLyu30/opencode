import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { DateTime, Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Credential } from "@opencode-ai/core/credential"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { WorkflowModelExecution } from "@opencode-ai/core/workflow/execution/model"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { WorkflowStageMachine } from "@opencode-ai/core/workflow/stage-machine"
import { Location } from "@opencode-ai/schema/location"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { testEffect } from "./lib/effect"

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

let credentialReads = 0
const placementIt = testEffect(
  AppNodeBuilder.build(WorkflowModelExecution.node, [
    [
      Credential.node,
      Layer.mock(Credential.Service, {
        list: () => Effect.sync(() => credentialReads++).pipe(Effect.as([])),
      }),
    ],
  ]),
)

const modelInput = (placement: Pick<Workflow.Info, "location" | "sessionID"> = {}) => {
  const workflow = Workflow.Info.make({
    id: Workflow.ID.make("wfl_model_placement"),
    type: "development",
    status: "running",
    input: { brief: "Check placement" },
    budget,
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
    agent: AgentV2.ID.make("build"),
    ...placement,
    version: 1,
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  })
  const stage = Workflow.Stage.make({
    id: Workflow.StageID.make("wfs_model_placement"),
    workflowID: workflow.id,
    type: "design",
    ordinal: 0,
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    recoveryPolicy: "restart_safe",
    idempotencyKey: "model-placement/design",
    input: {},
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  })
  return {
    workflow,
    stage,
    stages: [stage],
    artifacts: [],
    lease: { owner: "worker", attempt: 1, expiresAt: DateTime.makeUnsafe(60_000) },
    saveCheckpoint: () => Effect.void,
    route: WorkflowRouting.resolve({ role: "design", budget }),
  }
}

describe("workflow model state-machine conformance", () => {
  placementIt.effect("requires persisted workflow Location before credential or provider work", () =>
    Effect.gen(function* () {
      credentialReads = 0
      const models = yield* WorkflowModelExecution.Service
      const failure = yield* models.execute(modelInput()).pipe(Effect.flip)

      expect(failure).toMatchObject({
        failure: { category: "transient", code: "workflow_location_required" },
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
      })
      expect(credentialReads).toBe(0)
    }),
  )

  placementIt.effect("requires a real persisted Session before credential or provider work", () =>
    Effect.gen(function* () {
      credentialReads = 0
      const models = yield* WorkflowModelExecution.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make("D:\\missing-workflow-session") })
      const failure = yield* models
        .execute(modelInput({ location, sessionID: SessionV2.ID.make("ses_workflow_missing") }))
        .pipe(Effect.flip)

      expect(failure).toMatchObject({
        failure: { category: "transient", code: "workflow_session_required" },
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
      })
      expect(credentialReads).toBe(0)
    }),
  )

  test("the persisted happy path selects only kimi-k3 chat and native DeepSeek Responses routes", async () => {
    const expected: ReadonlyArray<readonly [string, string, string, string]> = [
      ["design", "kimi", "kimi-k3", "openai-chat"],
      ["decompose", "kimi", "kimi-k3", "openai-chat"],
      ["implement", "deepseek", "deepseek-v4-pro", "openai-responses"],
      ["test", "deepseek", "deepseek-v4-flash", "openai-responses"],
      ["visual_review", "kimi", "kimi-k3", "openai-chat"],
      ["deliver", "deepseek", "deepseek-v4-pro", "openai-responses"],
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
      "deepseek-v4-pro",
      "openai-responses",
    ])
    expect(afterRepair).toEqual({ status: "active", role: "test", revision: 1 })
  })
})
