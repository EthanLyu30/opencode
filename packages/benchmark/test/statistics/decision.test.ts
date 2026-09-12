import { describe, expect, test } from "bun:test"
import { decideCampaign, decideUpstreamSecondPass, type DecisionInput } from "../../src/statistics/decision"

describe("Task24 preregistered decision engine", () => {
  const cases: readonly [string, Partial<DecisionInput>, string][] = [
    ["clear win", {}, "demonstrated"],
    ["clear loss", { effect: -0.1, lower95: -0.2 }, "not demonstrated"],
    ["interval crossing zero", { lower95: -0.01 }, "promising but inconclusive"],
    ["gain below ten points", { effect: 0.099 }, "not demonstrated"],
    ["one family regression", { familyEffects: { dashboard: 0.2, checkout: -0.01 } }, "not demonstrated"],
    ["functional regression", { treatmentFunctionalRate: 0.84 }, "not demonstrated"],
    ["security incident", { securityIncidents: 1 }, "not demonstrated"],
    ["unequal budget", { equalBudgets: false }, "not demonstrated"],
    ["cost above two times", { treatmentCostPerSuccess: 201 }, "quality gain at disproportionate cost"],
    ["missing run", { complete: false }, "incomplete"],
  ]
  test.each(cases)("classifies %s", (_name, patch, expected) => {
    expect(decideCampaign({ ...base(), ...patch }).decision).toBe(expected)
  })

  test("returns every preregistered rule without editorial override", () => {
    const result = decideCampaign(base())
    expect(result.rules.map((rule) => rule.id)).toEqual([
      "CAMPAIGN_COMPLETE",
      "GAIN_AT_LEAST_10PP",
      "INTERVAL_LOWER_ABOVE_ZERO",
      "NO_FAMILY_REGRESSION",
      "FUNCTIONAL_WITHIN_5PP",
      "ZERO_SECURITY_INCIDENTS",
      "EQUAL_BUDGETS",
      "COST_WITHIN_2X",
    ])
    expect(result.rules.every((rule) => rule.passed)).toBe(true)
  })

  test("applies the D/E second-pass trigger mechanically at five percentage points", () => {
    expect(decideUpstreamSecondPass({ upstreamFirstPassRate: 0.84, bestForkControlRate: 0.9 })).toBe("skip")
    expect(decideUpstreamSecondPass({ upstreamFirstPassRate: 0.85, bestForkControlRate: 0.9 })).toBe("activate")
    expect(decideUpstreamSecondPass({ upstreamFirstPassRate: 0.95, bestForkControlRate: 0.9 })).toBe("activate")
  })
})

function base(): DecisionInput {
  return {
    complete: true,
    effect: 0.2,
    lower95: 0.05,
    upper95: 0.35,
    familyEffects: { dashboard: 0.2, checkout: 0.1 },
    treatmentFunctionalRate: 0.9,
    controlFunctionalRate: 0.9,
    securityIncidents: 0,
    equalBudgets: true,
    treatmentCostPerSuccess: 150,
    controlCostPerSuccess: 100,
  }
}
