import { describe, expect, test } from "bun:test"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Workflow } from "@opencode-ai/schema/workflow"
import { DateTime, Effect, Schema } from "effect"
import { CodingArtifacts } from "../src/workflow/coding/artifacts"
import { CodingEvidence } from "../src/workflow/coding/evidence"
import { CodingHostPlan } from "../src/workflow/coding/host-plan"
import { WorkflowBusinessArtifact } from "../src/workflow/artifacts/business"
import { WorkflowDecompositionArtifact } from "../src/workflow/artifacts/decomposition"
import { WorkflowExecutor } from "../src/workflow/executor"
import { WorkflowModelExecution } from "../src/workflow/execution/model"
import { WorkflowAdmission } from "../src/workflow/admission"
import { codingFixture } from "./fixtures/workflow-coding"
import { tmpdir } from "./fixture/tmpdir"
import { codingEvidenceFixture } from "./fixtures/workflow-coding-evidence"

const hash = "a".repeat(64)
const planPayload = {
  schemaVersion: 1,
  workflowID: "wfl_coding_contract",
  revision: 0,
  objective: "Fix sum",
  constraints: [],
  interfaces: ["sum(a,b)"],
  files: ["sum.ts"],
  risks: [],
  acceptanceCriteria: ["sum tests pass"],
  checkPlanSha256: hash,
}
describe("Coding artifacts and evidence lineage", () => {
  test("engineering plan is independently hashed and bound to Location and owner", () => {
    const { workflow } = codingFixture()
    const commit = CodingArtifacts.commit("plan", workflow.id, workflow.location!, planPayload)
    expect(CodingArtifacts.decode("plan", commit, workflow.id, workflow.location!)).toEqual(
      Schema.decodeUnknownSync(CodingArtifacts.schemas.plan)(planPayload),
    )
    expect(commit.sha256).toBe(WorkflowBusinessArtifact.hash(commit.metadata.payload))
    expect(() =>
      CodingArtifacts.decode("plan", { ...commit, sha256: "f".repeat(64) }, workflow.id, workflow.location!),
    ).toThrow()
    expect(() => CodingArtifacts.decode("plan", commit, Workflow.ID.make("wfl_foreign"), workflow.location!)).toThrow()
    expect(() =>
      CodingArtifacts.decode(
        "plan",
        commit,
        workflow.id,
        Location.Ref.make({ directory: AbsolutePath.make("D:/elsewhere") }),
      ),
    ).toThrow()
  })
  test("decomposition rejects cycles and unknown dependency IDs without changing legacy decoder", () => {
    const { workflow } = codingFixture()
    const task = (id: string, dependsOn: string[]) => ({
      id,
      title: id,
      description: "Fix",
      acceptanceCriteria: ["test"],
      files: ["sum.ts"],
      dependsOn,
    })
    for (const tasks of [[task("a", ["missing"])], [task("a", ["b"]), task("b", ["a"])]]) {
      const commit = () =>
        WorkflowDecompositionArtifact.commit(workflow.id, workflow.location!, {
          schemaVersion: 1,
          workflowID: workflow.id,
          revision: 0,
          snapshotRef: "baseline",
          acceptanceCriteria: ["test"],
          tasks,
        })
      expect(() =>
        CodingEvidence.validateDecomposition(
          WorkflowDecompositionArtifact.decode(commit(), workflow.id, workflow.location!),
        ),
      ).toThrow()
    }
    expect(() => CodingEvidence.validateDecomposition({ tasks: [task("a", []), task("b", ["a"])] })).not.toThrow()
  })
  test("mandatory test evidence requires observed nonempty tests, no errors and actual exit zero", async () => {
    await using tmp = await tmpdir()
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    const plan = CodingHostPlan.freeze({ authority: "admission", location, checks: { cwd: ".", test: "bun-test" } })
    const checks = [
      {
        id: "test",
        status: "executed",
        argv: ["bun", "--no-env-file", "test"],
        cwd: ".",
        exitCode: 0,
        timedOut: false,
        observedTests: 1,
        failedTests: 0,
        reportSha256: hash,
        log: "1 pass",
        logSha256: WorkflowBusinessArtifact.hash("1 pass"),
        ownerSha256: hash,
      },
      { id: "build", status: "not-applicable" },
      { id: "typecheck", status: "not-applicable" },
    ]
    expect(CodingArtifacts.checksPassed(checks, plan)).toBe(true)
    for (const change of [
      { observedTests: 0 },
      { exitCode: 1 },
      { timedOut: true },
      { failedTests: 1 },
      { reportSha256: undefined },
    ])
      expect(CodingArtifacts.checksPassed([{ ...checks[0], ...change }, ...checks.slice(1)], plan)).toBe(false)
    expect(() =>
      CodingArtifacts.validateChecks([{ ...checks[0], argv: ["cmd", "/c", "echo pass"] }, ...checks.slice(1)], plan),
    ).toThrow()
    expect(() =>
      CodingArtifacts.validateChecks([{ id: "test", status: "not-applicable" }, ...checks.slice(1)], plan),
    ).toThrow()
  })
  test("passing review cannot contain unresolved blockers or duplicate findings", () => {
    const { workflow } = codingFixture()
    const finding = { id: "bug", path: "sum.ts", severity: "important", blocking: true, summary: "wrong sum" }
    const review = {
      schemaVersion: 1,
      workflowID: workflow.id,
      revision: 1,
      implementationSha256: hash,
      testSha256: hash,
      verdict: "pass",
      findings: [finding],
    }
    expect(() => CodingArtifacts.commit("review", workflow.id, workflow.location!, review)).toThrow()
    expect(() =>
      CodingArtifacts.commit("review", workflow.id, workflow.location!, {
        ...review,
        verdict: "revise",
        findings: [finding, finding],
      }),
    ).toThrow()
  })
  test("delivery requires same-revision implementation, passing checks and passing code review", () => {
    const delivery = {
      schemaVersion: 1,
      workflowID: "wfl_coding_contract",
      revision: 1,
      implementationSha256: hash,
      testSha256: hash,
      codeReviewSha256: hash,
      summary: "Fixed",
    }
    const evidence = {
      revision: 1,
      implementationSha256: hash,
      testSha256: hash,
      codeReviewSha256: hash,
      testsPassed: true,
      review: { verdict: "pass", findings: [] },
    }
    expect(() => CodingEvidence.validateDelivery(delivery, evidence)).not.toThrow()
    for (const change of [
      { revision: 0 },
      { implementationSha256: "f".repeat(64) },
      { testsPassed: false },
      { review: { verdict: "revise", findings: [] } },
      { review: { verdict: "pass", findings: [{ blocking: true }] } },
    ])
      expect(() => CodingEvidence.validateDelivery(delivery, { ...evidence, ...change })).toThrow()
  })
  test("missing coding receipt and forged old visual receipt fail final settlement", () => {
    const { workflow, stage } = codingFixture()
    const input = { workflow, stage, priorArtifacts: [], artifacts: [] }
    expect(() => CodingEvidence.validateSettlement(input)).toThrow()
    expect(() =>
      CodingEvidence.validateSettlement({ ...input, receipt: { receiptVersion: 2, role: "design" } }),
    ).toThrow()
  })
  test("generic create cannot admit a coding graph with serialized frozen fields", () => {
    const { workflow } = codingFixture()
    expect(() =>
      WorkflowAdmission.prepare(
        {
          type: "coding-build",
          input: workflow.input,
          budget: workflow.budget,
          stages: [
            {
              type: "design",
              ordinal: 0,
              maxAttempts: 3,
              recoveryPolicy: "restart_safe",
              idempotencyKey: "coding-build/design/r0",
              input: { revision: 0 },
            },
          ],
        },
        {
          workflowID: workflow.id,
          timestamp: DateTime.makeUnsafe(0),
          stages: [
            {
              id: Workflow.StageID.make("wfs_forged"),
              type: "design",
              ordinal: 0,
              maxAttempts: 3,
              recoveryPolicy: "restart_safe",
              idempotencyKey: "coding-build/design/r0",
              input: { revision: 0 },
            },
          ],
        },
      ),
    ).toThrow()
  })
  test("missing durable coding admission prevents provider dispatch", async () => {
    const { workflow, stage } = codingFixture()
    let calls = 0
    const result = await Effect.gen(function* () {
      const executor = yield* WorkflowExecutor.Service
      return yield* executor.execute({
        workflow,
        stage,
        stages: [stage],
        artifacts: [],
        lease: { owner: "worker", attempt: 1, expiresAt: DateTime.makeUnsafe(1000) },
        saveCheckpoint: () => Effect.void,
      })
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkflowExecutor.roleLayer),
      Effect.provide(
        WorkflowModelExecution.layerWith(() => {
          calls++
          return Effect.die("provider must not run")
        }),
      ),
      Effect.result,
      Effect.runPromise,
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.failure.code).toBe("coding_admission_required")
    expect(calls).toBe(0)
  })
  test("host evidence resolves the full early-success chain and rejects stale lease/source", async () => {
    await using tmp = await tmpdir()
    const fixture = codingEvidenceFixture(tmp.path)
    await fixture.run("design", 0, 0, {
      objective: "Fix sum",
      constraints: [],
      interfaces: ["sum(a,b)"],
      files: ["sum.ts"],
      risks: [],
      acceptanceCriteria: ["sum works"],
    })
    const decomposed = await fixture.run("decompose", 0, 1, {
      acceptanceCriteria: ["sum works"],
      tasks: [
        {
          id: "sum",
          title: "Fix",
          description: "Fix sum",
          acceptanceCriteria: ["test"],
          files: ["sum.ts"],
          dependsOn: [],
        },
      ],
    })
    expect(JSON.stringify(decomposed.preparation.messages)).toContain("sum(a,b)")
    fixture.source("export const sum = (a,b) => a+b")
    await fixture.run("implement", 0, 2, { summary: "Implemented" })
    fixture.pass(false)
    await expect(fixture.run("test", 0, 3, { summary: "Claim success" }, "pass")).rejects.toThrow()
    fixture.pass(true)
    const tested = await fixture.run("test", 0, 3, { summary: "Tests pass" }, "pass")
    expect(tested.preparation.codingChecks?.checks[0]?.status).toBe("executed")
    const review = await fixture.run("code_review", 0, 4, { verdict: "pass", findings: [] }, "pass")
    for (const change of [{ attempt: 2 }, { leaseOwner: "other-worker" }])
      expect(() =>
        CodingEvidence.validateSettlement({
          workflow: fixture.workflow,
          stage: { ...review.stage, ...change },
          priorArtifacts: fixture.artifacts.slice(0, -review.durable.length),
          artifacts: review.durable,
          receipt: review.receipt,
          trustedMessages: review.preparation.messages,
        }),
      ).toThrow()
    fixture.source("export const sum = () => 'drift'")
    await expect(fixture.run("deliver", 1, 8, { summary: "Done" }, "complete")).rejects.toThrow()
    fixture.source("export const sum = (a,b) => a+b")
    const delivery = await fixture.run("deliver", 1, 8, { summary: "Done" }, "complete")
    const value = CodingArtifacts.decode(
      "delivery",
      CodingArtifacts.toCommit(delivery.durable[0]!),
      fixture.workflow.id,
      fixture.workflow.location!,
    )
    expect(value.revision).toBe(0)
    expect("visualReviewSha256" in value).toBe(false)
    expect(value.codeReviewSha256).toBe(review.durable[0]!.sha256)
  })
  test("cyclic provider decomposition fails as typed evidence, not an executor defect", async () => {
    await using tmp = await tmpdir()
    const fixture = codingEvidenceFixture(tmp.path)
    const task = (id: string, dependsOn: string[]) => ({
      id,
      title: "Fix",
      description: "Fix",
      acceptanceCriteria: ["test"],
      files: ["sum.ts"],
      dependsOn,
    })
    const error = await fixture
      .run("decompose", 0, 1, { acceptanceCriteria: ["test"], tasks: [task("a", ["b"]), task("b", ["a"])] })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(error).toBeInstanceOf(CodingEvidence.EvidenceFailure)
  })
})
