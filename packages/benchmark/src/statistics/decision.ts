export type CampaignDecision =
  | "demonstrated"
  | "not demonstrated"
  | "promising but inconclusive"
  | "quality gain at disproportionate cost"
  | "incomplete"

export interface DecisionInput {
  readonly complete: boolean
  readonly effect: number
  readonly lower95: number
  readonly upper95: number
  readonly familyEffects: Readonly<Record<string, number>>
  readonly treatmentFunctionalRate: number
  readonly controlFunctionalRate: number
  readonly securityIncidents: number
  readonly equalBudgets: boolean
  readonly treatmentCostPerSuccess: number | null
  readonly controlCostPerSuccess: number | null
}

export interface DecisionResult {
  readonly decision: CampaignDecision
  readonly rules: readonly { readonly id: string; readonly passed: boolean }[]
}

export function decideCampaign(input: DecisionInput): DecisionResult {
  validate(input)
  const rules = Object.freeze([
    rule("CAMPAIGN_COMPLETE", input.complete),
    rule("GAIN_AT_LEAST_10PP", input.effect >= 0.1),
    rule("INTERVAL_LOWER_ABOVE_ZERO", input.lower95 > 0),
    rule(
      "NO_FAMILY_REGRESSION",
      Object.values(input.familyEffects).every((effect) => effect >= 0),
    ),
    rule("FUNCTIONAL_WITHIN_5PP", input.treatmentFunctionalRate >= input.controlFunctionalRate - 0.05),
    rule("ZERO_SECURITY_INCIDENTS", input.securityIncidents === 0),
    rule("EQUAL_BUDGETS", input.equalBudgets),
    rule(
      "COST_WITHIN_2X",
      input.treatmentCostPerSuccess !== null &&
        input.controlCostPerSuccess !== null &&
        input.treatmentCostPerSuccess <= input.controlCostPerSuccess * 2,
    ),
  ])
  if (!input.complete) return Object.freeze({ decision: "incomplete", rules })
  const passed = new Map(rules.map((item) => [item.id, item.passed]))
  const all = rules.every((item) => item.passed)
  if (all) return Object.freeze({ decision: "demonstrated", rules })
  const onlyCostFails = rules.every((item) => item.id === "COST_WITHIN_2X" || item.passed)
  if (onlyCostFails) return Object.freeze({ decision: "quality gain at disproportionate cost", rules })
  const intervalOnly =
    passed.get("GAIN_AT_LEAST_10PP") === true &&
    passed.get("INTERVAL_LOWER_ABOVE_ZERO") === false &&
    rules.every((item) => item.id === "INTERVAL_LOWER_ABOVE_ZERO" || item.passed)
  if (intervalOnly) return Object.freeze({ decision: "promising but inconclusive", rules })
  return Object.freeze({ decision: "not demonstrated", rules })
}

export function decideUpstreamSecondPass(input: {
  readonly upstreamFirstPassRate: number
  readonly bestForkControlRate: number
}): "activate" | "skip" {
  if (!fraction(input.upstreamFirstPassRate) || !fraction(input.bestForkControlRate)) {
    throw new TypeError("TASK24_UPSTREAM_TRIGGER_INPUT_INVALID")
  }
  return input.upstreamFirstPassRate >= input.bestForkControlRate - 0.05 ? "activate" : "skip"
}

function validate(input: DecisionInput): void {
  if (
    typeof input.complete !== "boolean" ||
    ![input.effect, input.lower95, input.upper95, input.treatmentFunctionalRate, input.controlFunctionalRate].every(
      Number.isFinite,
    ) ||
    input.lower95 > input.upper95 ||
    input.treatmentFunctionalRate < 0 ||
    input.treatmentFunctionalRate > 1 ||
    input.controlFunctionalRate < 0 ||
    input.controlFunctionalRate > 1 ||
    !Number.isSafeInteger(input.securityIncidents) ||
    input.securityIncidents < 0 ||
    typeof input.equalBudgets !== "boolean" ||
    Object.keys(input.familyEffects).length === 0 ||
    !Object.values(input.familyEffects).every(Number.isFinite) ||
    !validCost(input.treatmentCostPerSuccess) ||
    !validCost(input.controlCostPerSuccess)
  ) {
    throw new TypeError("TASK24_DECISION_INPUT_INVALID")
  }
}

function validCost(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= 0)
}

function fraction(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

function rule(id: string, passed: boolean) {
  return Object.freeze({ id, passed })
}
