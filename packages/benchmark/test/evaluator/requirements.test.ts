import { describe, expect, test } from "bun:test"
import { scoreRequirements } from "../../src/evaluator/requirements"
import { evidence } from "./helpers"

describe("Task24 requirement evaluation", () => {
  test("scores declared assertions and artifacts without rewarding undeclared output", () => {
    const result = scoreRequirements({
      assertions: [
        { id: "empty-state", mandatory: true, passed: true, weight: 2 },
        { id: "bonus-export", mandatory: false, passed: false, weight: 1 },
      ],
      artifacts: [{ id: "design-spec", mandatory: true, present: true, weight: 1 }],
      evidence: [evidence("requirements")],
    })
    expect(result.points).toBe(7.5)
    expect(result.mandatoryPassed).toBe(true)
  })

  test("fails mandatory qualification when a required artifact is missing", () => {
    const result = scoreRequirements({
      assertions: [{ id: "empty-state", mandatory: true, passed: true, weight: 1 }],
      artifacts: [{ id: "design-spec", mandatory: true, present: false, weight: 1 }],
      evidence: [evidence("requirements")],
    })
    expect(result.points).toBe(5)
    expect(result.mandatoryPassed).toBe(false)
    expect(result.failedMandatory).toEqual(["artifact:design-spec"])
  })
})
