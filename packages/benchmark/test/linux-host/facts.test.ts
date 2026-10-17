import { expect, test } from "bun:test"
import {
  decodeRequirementPlans,
  compareRequirementPlans,
  validatePolicyObservation,
} from "../../src/sandbox/controller-facts"
import { orchestratorFixture } from "../independent/fixture"
import { compareInteractionAssertions } from "../../src/sandbox/controller-facts"

test("requirements keep every original id/mandatory/weight and are observations, not caller booleans", async () => {
  const f = await orchestratorFixture()
  try {
    const requirements = f.input.bundle.oracle.requirements
    expect(() => decodeRequirementPlans([], requirements)).toThrow()
    expect(() =>
      decodeRequirementPlans([{ id: "public", kind: "case", caseID: "sum", passed: true }], requirements),
    ).toThrow()
    const plans = decodeRequirementPlans([{ id: "public", kind: "case", caseID: "sum" }], requirements)
    expect(
      compareRequirementPlans(plans, requirements, {
        cases: [{ id: "sum", passed: false }],
        dom: [],
        interactions: [],
        files: [],
      }),
    ).toEqual([{ ...requirements[0]!, passed: false }])
    expect(() =>
      compareRequirementPlans(plans, requirements, { cases: [], dom: [], interactions: [], files: [] }),
    ).toThrow()
    expect(() =>
      decodeRequirementPlans(
        [{ id: "public", kind: "dom", selector: "body", count: 1, text: "x", visible: true, script: "eval" }],
        requirements,
      ),
    ).toThrow()
  } finally {
    await f.dispose()
  }
})

test("policy journal must cover actual named observations and never manufactures empty passed events", () => {
  expect(() => validatePolicyObservation({ events: [], checks: [] }, ["external-network"])).toThrow()
  expect(() =>
    validatePolicyObservation(
      { events: [], checks: [{ id: "external-network", observed: true }], humanEdited: false },
      ["external-network"],
    ),
  ).toThrow()
  const record = {
    events: [{ code: "external-network" }],
    observed: ["external-network"],
    humanEdits: 0,
    processEnded: true,
  }
  expect(validatePolicyObservation(record, ["external-network"]).events).toEqual([{ code: "external-network" }])
  expect(() => validatePolicyObservation({ ...record, processEnded: false }, ["external-network"])).toThrow()
})

test("authored interaction assertions are all compared in all three viewports, never inferred from screenshot presence", () => {
  const plans = [
    { id: "enter", observation: "keyboard.enterActivated", value: true },
    { id: "console", observation: "consoleErrors", value: [] },
  ]
  const captures = ["mobile", "tablet", "desktop"].map((viewport) => ({
    viewport,
    values: { "keyboard.enterActivated": true, consoleErrors: [] },
  }))
  expect(compareInteractionAssertions(plans, captures)).toEqual([
    { id: "enter", passed: true },
    { id: "console", passed: true },
  ])
  expect(() => compareInteractionAssertions(plans, captures.slice(1))).toThrow()
  expect(
    compareInteractionAssertions(plans, [
      ...captures.slice(0, 2),
      { viewport: "desktop", values: { "keyboard.enterActivated": false, consoleErrors: [] } },
    ])[0]?.passed,
  ).toBe(false)
})
