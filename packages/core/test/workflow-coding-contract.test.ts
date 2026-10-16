import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CodingContract } from "../src/workflow/coding/contract"
import { CodingRouting } from "../src/workflow/coding/routing"
import { BuildContract } from "../src/workflow/execution/build-contract"
import { WorkflowRoleContract } from "../src/workflow/execution/contract"
import { WorkflowRouting } from "../src/workflow/routing"
import { codingFixture, codingLegacyFixture } from "./fixtures/workflow-coding"

describe("Coding provider contracts", () => {
  test("uses engineering proposals without accepting host identity or visual payloads", () => {
    const fixture = codingFixture()
    const contract = CodingContract.build({
      ...fixture,
      route: CodingRouting.resolve({ role: "design", budget: fixture.workflow.budget, selection: fixture.selection }),
      priorArtifacts: [],
    })
    const result = {
      contractVersion: 1,
      outcome: { schemaVersion: 1, role: "design", verdict: "ready", revision: 0 },
      payload: {
        objective: "Fix empty input",
        constraints: [],
        interfaces: ["sum(values): number"],
        files: ["src/sum.ts"],
        risks: [],
        acceptanceCriteria: ["empty input returns zero"],
      },
    }
    expect(CodingContract.decode(contract, result).outcome.role).toBe("design")
    expect(() =>
      CodingContract.decode(contract, { ...result, payload: { ...result.payload, workflowID: "wfl_fake" } }),
    ).toThrow()
    expect(() => CodingContract.decode(contract, { ...result, payload: { spec: {}, sources: [] } })).toThrow()
    expect(contract.authority.kind).toBe("workflow.coding-role-contract.v1")
    expect(contract.permissions.some((rule) => rule.action === "edit" && rule.effect === "allow")).toBe(false)
  })

  test("code-review outcomes and semantic findings cannot contradict each other", () => {
    const fixture = codingFixture("code_review", 1)
    const contract = CodingContract.build({
      ...fixture,
      route: CodingRouting.resolve({
        role: "code_review",
        budget: fixture.workflow.budget,
        selection: fixture.selection,
      }),
      priorArtifacts: [],
    })
    const result = {
      contractVersion: 1,
      outcome: { schemaVersion: 1, role: "code_review", verdict: "pass", revision: 1 },
      payload: { verdict: "pass", findings: [] },
    }
    expect(CodingContract.decodeJson(contract, JSON.stringify(result)).outcome.verdict).toBe("pass")
    expect(() => CodingContract.decode(contract, { ...result, outcome: { ...result.outcome, revision: 0 } })).toThrow()
    expect(() =>
      CodingContract.decode(contract, { ...result, payload: { ...result.payload, verdict: "revise" } }),
    ).toThrow()
    expect(() =>
      CodingContract.decode(contract, {
        ...result,
        payload: {
          ...result.payload,
          findings: [{ id: "bug", path: "src/sum.ts", severity: "important", blocking: true, summary: "still wrong" }],
        },
      }),
    ).toThrow()
    expect(() =>
      CodingContract.decode(contract, { ...result, outcome: { ...result.outcome, role: "visual_review" } }),
    ).toThrow()
    expect(() =>
      CodingContract.build({
        ...fixture,
        route: CodingRouting.resolve({ role: "code_review", budget: {}, selection: fixture.selection }),
        priorArtifacts: [],
      }),
    ).toThrow()
  })

  test("host authority binds profile, pinned model, current revision and dependencies", () => {
    const fixture = codingFixture("code_review", 1)
    const contract = BuildContract.build({
      workflow: fixture.workflow,
      stage: fixture.stage,
      route: CodingRouting.resolve({
        role: "code_review",
        budget: fixture.workflow.budget,
        selection: fixture.selection,
      }),
      priorArtifacts: [],
    })
    expect(() =>
      BuildContract.verifyAuthority({
        authority: contract.authority,
        workflow: fixture.workflow,
        stage: fixture.stage,
        priorArtifacts: [],
      }),
    ).not.toThrow()
    expect(() =>
      BuildContract.verifyAuthority({
        authority: contract.authority,
        workflow: { ...fixture.workflow, type: "visual-build" },
        stage: fixture.stage,
        priorArtifacts: [],
      }),
    ).toThrow()
    expect(() =>
      BuildContract.verifyAuthority({
        authority: contract.authority,
        workflow: fixture.workflow,
        stage: { ...fixture.stage, input: { revision: 2 } },
        priorArtifacts: [],
      }),
    ).toThrow()
  })

  test("keeps historical visual contract bytes unchanged through the shared facade", () => {
    const fixture = codingLegacyFixture()
    const input = {
      workflow: fixture.workflow,
      stage: fixture.stage,
      route: WorkflowRouting.resolve({ role: "design", budget: fixture.workflow.budget, selection: fixture.selection }),
      priorArtifacts: [],
    }
    const original = WorkflowRoleContract.build(input)
    const adapted = BuildContract.build(input)
    expect(original.contractFingerprint).toBe("25cd64f08d0bca0fc0bb6f867aeff52845016b8dc926f6a7e126487399af8797")
    expect(adapted).toEqual(original)
    expect(() =>
      BuildContract.verifyAuthority({
        authority: original.authority,
        workflow: fixture.workflow,
        stage: fixture.stage,
        priorArtifacts: [],
      }),
    ).not.toThrow()
  })

  test("approved budget increases do not invalidate an already settled coding provider result", () => {
    const fixture = codingFixture("code_review", 1)
    const make = (workflow: typeof fixture.workflow) =>
      CodingContract.build({
        workflow,
        stage: fixture.stage,
        route: CodingRouting.resolve({ role: "code_review", budget: workflow.budget, selection: fixture.selection }),
        priorArtifacts: [],
      })
    const original = make(fixture.workflow)
    const raised = make({ ...fixture.workflow, budget: { ...fixture.workflow.budget, maxTokens: 30000, maxTurns: 30 } })
    expect(raised.contractFingerprint).toBe(original.contractFingerprint)
    expect(raised.contextDigest).toBe(original.contextDigest)
  })

  test("provider response schema itself restricts code review to its own role", () => {
    const fixture = codingFixture("code_review", 1)
    const contract = CodingContract.build({
      ...fixture,
      route: CodingRouting.resolve({
        role: "code_review",
        budget: fixture.workflow.budget,
        selection: fixture.selection,
      }),
      priorArtifacts: [],
    })
    // This factory only builds service-free JSON schemas; the legacy common type is intentionally broad.
    const accepts = Schema.is(contract.output as Schema.Decoder<unknown>)
    expect(
      accepts({
        contractVersion: 1,
        outcome: { schemaVersion: 1, role: "test", revision: 1, verdict: "pass" },
        payload: { verdict: "pass", findings: [] },
      }),
    ).toBe(false)
  })

  test("duplicate review finding identities cannot drive a repair transition", () => {
    const fixture = codingFixture("code_review", 1)
    const contract = CodingContract.build({
      ...fixture,
      route: CodingRouting.resolve({
        role: "code_review",
        budget: fixture.workflow.budget,
        selection: fixture.selection,
      }),
      priorArtifacts: [],
    })
    const finding = {
      id: "same-bug",
      path: "src/sum.ts",
      severity: "important",
      blocking: true,
      summary: "Fix the bug",
    }
    expect(() => {
      CodingContract.decode(contract, {
        contractVersion: 1,
        outcome: { schemaVersion: 1, role: "code_review", revision: 1, verdict: "revise" },
        payload: { verdict: "revise", findings: [finding, finding] },
      })
    }).toThrow()
  })
})
