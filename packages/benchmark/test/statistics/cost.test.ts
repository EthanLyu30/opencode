import { describe, expect, test } from "bun:test"
import { calculateCampaignCost } from "../../src/statistics/cost"

describe("Task24 provider-native cost", () => {
  test("preserves native ledgers and converts only for comparison", () => {
    expect(
      calculateCampaignCost({
        kimiCnyMicros: 1_000_000n,
        deepseekUsdMicros: 1_000_000n,
        cnyPerUsdMicros: 7_200_000n,
        qualifiedSuccesses: 4,
        controlCostPerSuccessCnyMicros: 1_000_000n,
      }),
    ).toEqual({
      kimiCnyMicros: "1000000",
      deepseekUsdMicros: "1000000",
      totalCnyMicros: "8200000",
      costPerQualifiedSuccessCnyMicros: "2050000",
      costRatio: 2.05,
    })
  })

  test("reports null cost per success for an all-failure arm", () => {
    expect(
      calculateCampaignCost({
        kimiCnyMicros: 0n,
        deepseekUsdMicros: 1_000_000n,
        cnyPerUsdMicros: 7_200_000n,
        qualifiedSuccesses: 0,
        controlCostPerSuccessCnyMicros: 1_000_000n,
      }).costPerQualifiedSuccessCnyMicros,
    ).toBeNull()
  })
})
