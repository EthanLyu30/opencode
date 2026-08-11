import { describe, expect, test } from "bun:test"
import { WorkflowStageMachine } from "@opencode-ai/core/workflow/stage-machine"
import { Workflow } from "@opencode-ai/schema/workflow"
import { DateTime, Effect } from "effect"
import { createHash } from "node:crypto"

const artifact = (
  metadata: Record<string, unknown>,
  input?: {
    readonly kind?: string
    readonly mime?: string
    readonly sha256?: string
    readonly stageID?: Workflow.StageID
  },
): Workflow.Artifact =>
  Workflow.Artifact.make({
    id: Workflow.ArtifactID.make("wfa_outcome"),
    workflowID: Workflow.ID.make("wfl_machine"),
    stageID: input?.stageID ?? Workflow.StageID.make("wfs_machine"),
    kind: input?.kind ?? WorkflowStageMachine.OUTCOME_ARTIFACT_KIND,
    uri: "artifact://wfl_machine/outcome.json",
    mime: input?.mime ?? WorkflowStageMachine.OUTCOME_ARTIFACT_MIME,
    sha256: input?.sha256 ?? createHash("sha256").update(JSON.stringify(metadata)).digest("hex"),
    size: 64,
    metadata,
    timeCreated: DateTime.makeUnsafe(1),
  })

const outcome = (role: string, verdict: string, revision: number) =>
  artifact({ schemaVersion: 1, role, verdict, revision })

const stage = (role: string, ordinal: number): Workflow.Stage =>
  Workflow.Stage.make({
    id: Workflow.StageID.make(`wfs_machine_${ordinal}`),
    workflowID: Workflow.ID.make("wfl_machine"),
    type: role,
    ordinal,
    status: "succeeded",
    attempt: 1,
    maxAttempts: 3,
    recoveryPolicy: "restart_safe",
    idempotencyKey: `machine/${ordinal}`,
    input: {},
    time: {
      created: DateTime.makeUnsafe(1),
      updated: DateTime.makeUnsafe(1),
      completed: DateTime.makeUnsafe(2),
    },
  })

const stageOutcome = (stage: Workflow.Stage, role: string, verdict: string, revision = 0) =>
  artifact(
    { schemaVersion: 1, role, verdict, revision },
    {
      stageID: stage.id,
      sha256: createHash("sha256")
        .update(JSON.stringify({ schemaVersion: 1, role, verdict, revision }))
        .digest("hex"),
    },
  )

describe("WorkflowStageMachine", () => {
  test("advances the default role chain only from validated outcome artifacts", async () => {
    const completed = await Effect.gen(function* () {
      const design = yield* WorkflowStageMachine.advance(WorkflowStageMachine.initial(), outcome("design", "ready", 0))
      expect(design).toEqual({ status: "active", role: "decompose", revision: 0 })
      const decomposed = yield* WorkflowStageMachine.advance(design, outcome("decompose", "ready", 0))
      const implemented = yield* WorkflowStageMachine.advance(decomposed, outcome("implement", "ready", 0))
      const tested = yield* WorkflowStageMachine.advance(implemented, outcome("test", "pass", 0))
      const reviewed = yield* WorkflowStageMachine.advance(tested, outcome("visual_review", "pass", 0))
      return yield* WorkflowStageMachine.advance(reviewed, outcome("deliver", "complete", 0))
    }).pipe(Effect.runPromise)

    expect(completed).toEqual({ status: "completed", revision: 0 })
  })

  test("routes failed tests and visual reviews while tracking repair revisions", async () => {
    const afterTestRepair = await WorkflowStageMachine.advance(
      { status: "active", role: "test", revision: 0 },
      outcome("test", "revise", 0),
    ).pipe(Effect.runPromise)
    expect(afterTestRepair).toEqual({ status: "active", role: "repair", revision: 1 })

    const afterRepair = await WorkflowStageMachine.advance(afterTestRepair, outcome("repair", "ready", 1)).pipe(
      Effect.runPromise,
    )
    expect(afterRepair).toEqual({ status: "active", role: "test", revision: 1 })

    const afterVisualRepair = await WorkflowStageMachine.advance(
      { status: "active", role: "visual_review", revision: 1 },
      outcome("visual_review", "revise", 1),
    ).pipe(Effect.runPromise)
    expect(afterVisualRepair).toEqual({ status: "active", role: "repair", revision: 2 })
  })

  test("replays persisted role outcomes as the authority for the next role", async () => {
    const stages = [stage("design", 0), stage("decompose", 1), stage("implement", 2)]
    const state = await WorkflowStageMachine.replay({
      stages,
      artifacts: [
        stageOutcome(stages[0], "design", "ready"),
        stageOutcome(stages[1], "decompose", "ready"),
        stageOutcome(stages[2], "implement", "ready"),
      ],
    }).pipe(Effect.runPromise)

    expect(state).toEqual({ status: "active", role: "test", revision: 0 })
  })

  test.each([
    ["missing", [] as Workflow.Artifact[], "missing_outcome"],
    [
      "duplicate",
      [stageOutcome(stage("design", 0), "design", "ready"), stageOutcome(stage("design", 0), "design", "ready")],
      "duplicate_outcome",
    ],
  ] as const)("rejects %s persisted outcomes", async (_name, artifacts, code) => {
    const error = await WorkflowStageMachine.replay({ stages: [stage("design", 0)], artifacts }).pipe(
      Effect.flip,
      Effect.runPromise,
    )
    expect(error.code).toBe(code)
  })

  test("binds each persisted outcome to the declared stage role", async () => {
    const declared = stage("deliver", 0)
    const error = await WorkflowStageMachine.replay({
      stages: [declared],
      artifacts: [stageOutcome(declared, "design", "ready")],
    }).pipe(Effect.flip, Effect.runPromise)

    expect(error.code).toBe("stage_role_mismatch")
  })

  test.each([
    [artifact({ role: "design", verdict: "ready", revision: 0 }), "invalid_metadata"],
    [outcome("decompose", "ready", 0), "role_mismatch"],
    [outcome("design", "ready", 1), "revision_mismatch"],
    [outcome("design", "ready", 0), "invalid_artifact"],
    [
      artifact({ schemaVersion: 1, role: "design", verdict: "ready", revision: 0 }, { sha256: "f".repeat(64) }),
      "hash_mismatch",
    ],
  ] as const)("rejects invalid transition input %#", async (candidate, code) => {
    const selected =
      code === "invalid_artifact"
        ? artifact(candidate.metadata, { kind: "model.text", mime: candidate.mime })
        : candidate
    const error = await WorkflowStageMachine.advance(WorkflowStageMachine.initial(), selected).pipe(
      Effect.flip,
      Effect.runPromise,
    )
    expect(error.code).toBe(code)
  })
})
