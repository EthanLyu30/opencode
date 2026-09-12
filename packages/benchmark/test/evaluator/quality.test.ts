import { describe, expect, test } from "bun:test"
import { scoreQuality } from "../../src/evaluator/quality"
import { scoreAccessibility } from "../../src/evaluator/accessibility"
import { evidence } from "./helpers"

describe("Task24 fixed quality and accessibility evaluation", () => {
  test("scores only the fixed quality checks and ignores code volume", () => {
    const result = scoreQuality({
      checks: [
        { id: "typecheck", passed: true },
        { id: "lint", passed: true },
        { id: "structure", passed: false },
        { id: "dependency-policy", passed: true },
      ],
      evidence: [evidence("quality")],
    })
    expect(result.points).toBe(7.5)
  })

  test("makes critical Axe and required responsive failures explicit", () => {
    const result = scoreAccessibility({
      axeViolations: [{ id: "color-contrast", impact: "critical" }],
      keyboardCheckpoints: [{ id: "checkout", required: true, passed: true }],
      responsiveCheckpoints: [{ id: "mobile-nav", required: true, passed: false }],
      overflowPassed: true,
      clippingPassed: true,
      evidence: [evidence("accessibility")],
    })
    expect(result.points).toBe(3)
    expect(result.requiredPassed).toBe(false)
    expect(result.failures).toEqual(["axe:color-contrast", "responsive:mobile-nav"])
  })
})
