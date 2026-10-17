import { describe, expect, test } from "bun:test"
import { BuildRouting } from "../src/workflow/execution/build-routing"
import { BuildContract } from "../src/workflow/execution/build-contract"
import { WorkflowBudget } from "../src/workflow/budget"
import { codingFixture } from "./fixtures/workflow-coding"

describe("coding budget sublimits", () => {
  for (const [limit, consumed] of [
    ["maxTokens", "tokens"],
    ["maxTurns", "turns"],
    ["maxToolCalls", "toolCalls"],
  ] as const) {
    test(limit + " stops at the coding cap even when the overall budget has room", () => {
      const fixture = codingFixture()
      const workflow = {
        ...fixture.workflow,
        input: {
          ...fixture.workflow.input,
          coding: { maxRevisions: 1, maxTokens: 20000, maxTurns: 20, maxToolCalls: 40, [limit]: 2 },
        },
      }
      const route = BuildRouting.resolve({ workflow, stage: fixture.stage })
      expect(
        WorkflowBudget.evaluate({
          budget: route.budget,
          usage: { ...workflow.usage, [consumed]: 2 },
          notified: 0,
          elapsedMs: 0,
        }).exhausted,
      ).toBe(true)
      expect(
        WorkflowBudget.evaluate({
          budget: route.budget,
          usage: { ...workflow.usage, [consumed]: 1 },
          notified: 0,
          elapsedMs: 0,
        }).exhausted,
      ).toBe(false)
    })
  }
  test("the smaller overall cap and unrelated attempt/duration limits remain authoritative", () => {
    const fixture = codingFixture()
    const workflow = {
      ...fixture.workflow,
      budget: { maxTokens: 3, maxTurns: 4, maxToolCalls: 5, maxAttempts: 6, maxDurationMs: 7000 },
      input: { ...fixture.workflow.input, coding: { maxRevisions: 1, maxTokens: 30, maxTurns: 40, maxToolCalls: 50 } },
    }
    expect(BuildRouting.resolve({ workflow, stage: fixture.stage }).budget).toEqual({
      maxTokens: 3,
      maxTurns: 4,
      maxToolCalls: 5,
      maxAttempts: 6,
      maxDurationMs: 7000,
    })
  })
  test("raising the overall budget cannot raise admitted sublimits or invalidate settled authority", () => {
    const fixture = codingFixture()
    const original = {
      ...fixture.workflow,
      input: { ...fixture.workflow.input, coding: { maxRevisions: 1, maxTokens: 30, maxTurns: 4, maxToolCalls: 5 } },
    }
    const raised = { ...original, budget: { ...original.budget, maxTokens: 40000, maxTurns: 40, maxToolCalls: 80 } }
    const make = (workflow: typeof original) =>
      BuildContract.build({
        workflow,
        stage: fixture.stage,
        route: BuildRouting.resolve({ workflow, stage: fixture.stage }),
        priorArtifacts: [],
      })
    expect(BuildRouting.resolve({ workflow: raised, stage: fixture.stage }).budget).toMatchObject({
      maxTokens: 30,
      maxTurns: 4,
      maxToolCalls: 5,
    })
    const settled = make(original)
    expect(make(raised).contractFingerprint).toBe(settled.contractFingerprint)
    expect(() =>
      BuildContract.verifyAuthority({
        authority: settled.authority,
        workflow: raised,
        stage: fixture.stage,
        priorArtifacts: [],
      }),
    ).not.toThrow()
  })
  test("missing admitted coding limits fail closed rather than falling back to an unlimited route", () => {
    const fixture = codingFixture()
    expect(() =>
      BuildRouting.resolve({
        workflow: { ...fixture.workflow, input: { ...fixture.workflow.input, coding: undefined } },
        stage: fixture.stage,
      }),
    ).toThrow()
  })
})
