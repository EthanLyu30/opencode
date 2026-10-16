import { describe, expect, test } from "bun:test"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Responses } from "@opencode-ai/schema/responses"
import { DateTime, Effect } from "effect"
import { createHash } from "node:crypto"
import { CodingGraph } from "../src/workflow/coding/graph"
import { CodingStageMachine } from "../src/workflow/coding/stage-machine"

const workflowID = Workflow.ID.make("wfl_coding_graph")
function stages(maxRevisions = 1) {
  return CodingGraph.expand({ maxRevisions, maxAttempts: 3, responseID: Responses.ID.make("resp_coding_graph") }).map(
    (input, index) =>
      Workflow.Stage.make({
        ...input,
        id: Workflow.StageID.make(`wfs_coding_graph_${index}`),
        workflowID,
        status: "succeeded",
        attempt: 1,
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      }),
  )
}
function artifact(stage: Workflow.Stage, verdict?: string, revision = Number(stage.input.revision)) {
  const outcome = {
    schemaVersion: 1,
    role: stage.type,
    revision,
    verdict:
      verdict ??
      (stage.type === "deliver"
        ? "complete"
        : stage.type === "test" || stage.type === "code_review"
          ? "pass"
          : "ready"),
  }
  const binding = {
    bindingVersion: 1,
    outcome,
    contractFingerprint: "a".repeat(64),
    contextDigest: "b".repeat(64),
    requiredArtifactSetSha256: "c".repeat(64),
  }
  const body = JSON.stringify(binding)
  return Workflow.Artifact.make({
    id: Workflow.ArtifactID.create(),
    workflowID,
    stageID: stage.id,
    kind: "workflow.coding.outcome",
    mime: "application/vnd.opencode.workflow-coding-outcome+json",
    uri: `workflow://${workflowID}/stages/${stage.id}/coding-outcome.json`,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: Buffer.byteLength(body),
    metadata: binding,
    timeCreated: DateTime.makeUnsafe(0),
  })
}
describe("CodingGraph and semantic replay", () => {
  test("declares exact bounded independent coding role sequences", () => {
    expect(stages(0).map((stage) => stage.type)).toEqual([
      "design",
      "decompose",
      "implement",
      "test",
      "code_review",
      "deliver",
    ])
    expect(stages().map((stage) => stage.type)).toEqual([
      "design",
      "decompose",
      "implement",
      "test",
      "code_review",
      "repair",
      "test",
      "code_review",
      "deliver",
    ])
    expect(stages(10)).toHaveLength(36)
    expect(stages().map((stage) => stage.idempotencyKey)).toEqual([
      "coding-build/design/r0",
      "coding-build/decompose/r0",
      "coding-build/implement/r0",
      "coding-build/test/r0",
      "coding-build/code_review/r0",
      "coding-build/repair/r1",
      "coding-build/test/r1",
      "coding-build/code_review/r1",
      "coding-build/deliver/r1",
    ])
    for (const maxRevisions of [-1, 11, 0.5]) expect(() => stages(maxRevisions)).toThrow()
  })
  test("early passing review skips all repair cycles and delivers actual revision zero", async () => {
    const declared = stages()
    const skipped = CodingGraph.unreachableAfter({
      stages: declared,
      stageID: declared[4].id,
      outcome: { schemaVersion: 1, role: "code_review", verdict: "pass", revision: 0 },
    })
    expect(skipped).toEqual(declared.slice(5, 8).map((stage) => stage.id))
    const history = declared.map((stage) =>
      skipped.includes(stage.id) ? { ...stage, status: "skipped" as const } : stage,
    )
    const artifacts = history
      .filter((stage) => stage.status !== "skipped")
      .map((stage) => artifact(stage, undefined, 0))
    expect(await CodingStageMachine.replay({ stages: history, artifacts }).pipe(Effect.runPromise)).toEqual({
      status: "completed",
      revision: 0,
    })
  })
  test("failed real-check verdict skips review then repairs and retests", async () => {
    const declared = stages()
    const history = declared.map((stage, index) => (index === 4 ? { ...stage, status: "skipped" as const } : stage))
    const artifacts = history
      .filter((stage) => stage.status !== "skipped")
      .map((stage) => artifact(stage, stage.ordinal === 3 ? "revise" : undefined))
    expect(
      CodingGraph.unreachableAfter({
        stages: declared,
        stageID: declared[3].id,
        outcome: { schemaVersion: 1, role: "test", verdict: "revise", revision: 0 },
      }),
    ).toEqual([declared[4].id])
    expect(await CodingStageMachine.replay({ stages: history, artifacts }).pipe(Effect.runPromise)).toEqual({
      status: "completed",
      revision: 1,
    })
  })
  test("review-driven repair requires that revision's test and new review", async () => {
    const declared = stages()
    const artifacts = declared.map((stage) => artifact(stage, stage.ordinal === 4 ? "revise" : undefined))
    expect(await CodingStageMachine.replay({ stages: declared, artifacts }).pipe(Effect.runPromise)).toEqual({
      status: "completed",
      revision: 1,
    })
    await expect(
      CodingStageMachine.replay({
        stages: declared,
        artifacts: artifacts.filter((item) => item.stageID !== declared[6].id),
      }).pipe(Effect.runPromise),
    ).rejects.toThrow()
  })
  test("zero/max revision exhaustion cannot reach successful delivery", async () => {
    for (const max of [0, 10]) {
      const declared = stages(max)
      const artifacts = declared.map((stage) => artifact(stage, stage.type === "code_review" ? "revise" : undefined))
      await expect(CodingStageMachine.replay({ stages: declared, artifacts }).pipe(Effect.runPromise)).rejects.toThrow()
    }
  })
  test("duplicate, tampered and cross-revision outcomes fail closed", async () => {
    const declared = stages(0)
    const artifacts = declared.map((stage) => artifact(stage))
    for (const invalid of [
      [...artifacts, artifacts[0]],
      [{ ...artifacts[0], sha256: "f".repeat(64) }, ...artifacts.slice(1)],
      [artifact(declared[0], "ready", 1), ...artifacts.slice(1)],
    ])
      await expect(
        CodingStageMachine.replay({ stages: declared, artifacts: invalid }).pipe(Effect.runPromise),
      ).rejects.toThrow()
  })
  test("unauthorized or missing skips and old visual outcomes are rejected", async () => {
    const declared = stages()
    const artifacts = declared.map((stage) => artifact(stage))
    await expect(CodingStageMachine.replay({ stages: declared, artifacts }).pipe(Effect.runPromise)).rejects.toThrow()
    await expect(
      CodingStageMachine.replay({ stages: [{ ...declared[0], status: "skipped" }], artifacts: [] }).pipe(
        Effect.runPromise,
      ),
    ).rejects.toThrow()
    await expect(
      CodingStageMachine.decodeOutcome({ ...artifacts[0], kind: "workflow.role.outcome" }).pipe(Effect.runPromise),
    ).rejects.toThrow()
  })
})
