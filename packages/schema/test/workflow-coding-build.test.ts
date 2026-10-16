import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { WorkflowCodingBuild } from "../src/workflow-coding-build"
import { WorkflowCodingArtifact } from "../src/workflow-coding-artifact"
import { WorkflowRole } from "../src/workflow-role"

const hash = "a".repeat(64)
const request = {
  prompt: "Fix the library function without creating a page",
  budget: { maxTokens: 20000, maxAttempts: 27 },
  coding: { maxRevisions: 1, maxTokens: 12000, maxTurns: 12, maxToolCalls: 24 },
  checks: { cwd: ".", test: "bun-test" },
  delivery: "background",
}
const plan = {
  schemaVersion: 1,
  workflowID: "wfl_coding_contract",
  revision: 0,
  objective: "Handle an empty input",
  constraints: ["Keep the public API"],
  interfaces: ["sum(values: number[]): number"],
  files: ["src/sum.ts"],
  risks: [],
  acceptanceCriteria: ["An empty input returns zero"],
  checkPlanSha256: hash,
}
const review = {
  schemaVersion: 1,
  workflowID: "wfl_coding_contract",
  revision: 1,
  implementationSha256: hash,
  testSha256: "b".repeat(64),
  verdict: "pass",
  findings: [],
}

describe("Coding workflow contracts", () => {
  test("admits a library request without any visual input", () => {
    expect(Schema.decodeUnknownSync(WorkflowCodingBuild.CreateInput)(request as unknown) as unknown).toEqual(request)
    expect(Schema.decodeUnknownSync(WorkflowCodingArtifact.Plan)(plan as unknown) as unknown).toEqual(plan)
    expect(Schema.is(WorkflowCodingBuild.Role)("code_review")).toBe(true)
    expect(Schema.is(WorkflowRole.Role)("code_review")).toBe(false)
  })

  test.each([0, 10])("allows the bounded revision endpoint %i", (maxRevisions) => {
    expect(
      Schema.decodeUnknownSync(WorkflowCodingBuild.CreateInput)({
        ...request,
        coding: { ...request.coding, maxRevisions },
      }).coding.maxRevisions,
    ).toBe(maxRevisions)
  })

  test.each([-1, 11, 1.5])("rejects invalid revision allowance %p", (maxRevisions) => {
    expect(() =>
      Schema.decodeUnknownSync(WorkflowCodingBuild.CreateInput)({
        ...request,
        coding: { ...request.coding, maxRevisions },
      }),
    ).toThrow()
  })

  test("omits undefined optional checks while encoding", () => {
    expect(
      Schema.encodeSync(WorkflowCodingBuild.Checks)({
        cwd: ".",
        test: "bun-test",
        build: undefined,
        typecheck: undefined,
      }),
    ).toEqual({ cwd: ".", test: "bun-test" })
  })

  test.each(["visual", "preview", "providerID", "modelID", "baseURL", "workflow.coding-host-plan.v1"])(
    "rejects unauthorized request field %s",
    (key) => {
      expect(() => Schema.decodeUnknownSync(WorkflowCodingBuild.CreateInput)({ ...request, [key]: {} })).toThrow()
    },
  )

  test.each(["../escape", "D:/foreign", "src/../lib", "src//lib", "CON"])("rejects check cwd %s", (cwd) => {
    expect(() => Schema.decodeUnknownSync(WorkflowCodingBuild.Checks)({ ...request.checks, cwd })).toThrow()
  })

  test("rejects arbitrary commands and duplicated/colliding plan paths", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkflowCodingBuild.Checks)({ cwd: ".", test: "powershell -Command 1" }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowCodingArtifact.Plan)({ ...plan, files: ["src/a.ts", "src/A.ts"] }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowCodingArtifact.Plan)({ ...plan, files: ["src/a", "src/a/b.ts"] }),
    ).toThrow()
  })

  test("cannot declare a passing review while retaining blocking findings", () => {
    expect(Schema.decodeUnknownSync(WorkflowCodingArtifact.Review)(review as unknown) as unknown).toEqual(review)
    const finding = {
      id: "empty-input",
      path: "src/sum.ts",
      severity: "important",
      blocking: true,
      summary: "Empty input throws",
    }
    expect(() => Schema.decodeUnknownSync(WorkflowCodingArtifact.Review)({ ...review, findings: [finding] })).toThrow()
    expect(
      Schema.decodeUnknownSync(WorkflowCodingArtifact.Review)({ ...review, verdict: "revise", findings: [finding] })
        .verdict,
    ).toBe("revise")
    expect(() => Schema.decodeUnknownSync(WorkflowCodingArtifact.Review)({ ...review, verdict: "revise" })).toThrow()
  })

  test("coding delivery binds code review without manufacturing visual evidence", () => {
    const delivery = {
      schemaVersion: 1,
      workflowID: "wfl_coding_contract",
      revision: 1,
      implementationSha256: hash,
      testSha256: "b".repeat(64),
      codeReviewSha256: "c".repeat(64),
      summary: "Fixed and checked",
    }
    expect(Schema.decodeUnknownSync(WorkflowCodingArtifact.Delivery)(delivery as unknown) as unknown).toEqual(delivery)
    expect(() =>
      Schema.decodeUnknownSync(WorkflowCodingArtifact.Delivery)({ ...delivery, visualReviewSha256: hash }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowCodingArtifact.Delivery)({ ...delivery, summary: "x".repeat(4097) }),
    ).toThrow()
  })

  test("exposes unique domain-qualified current-contract identifiers", () => {
    const identifiers = [
      WorkflowCodingBuild.Role,
      WorkflowCodingBuild.Limits,
      WorkflowCodingBuild.Checks,
      WorkflowCodingBuild.CreateInput,
      WorkflowCodingBuild.Admission,
      WorkflowCodingArtifact.Plan,
      WorkflowCodingArtifact.Review,
      WorkflowCodingArtifact.Delivery,
    ].map((value) => value.ast.annotations?.identifier)
    expect(identifiers.every((value) => typeof value === "string" && value.startsWith("WorkflowCoding"))).toBe(true)
    expect(new Set(identifiers).size).toBe(8)
  })
})
