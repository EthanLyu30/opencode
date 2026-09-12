export interface CampaignCost {
  readonly kimiCnyMicros: string
  readonly deepseekUsdMicros: string
  readonly totalCnyMicros: string
  readonly costPerQualifiedSuccessCnyMicros: string | null
  readonly costRatio: number | null
}

export function calculateCampaignCost(input: {
  readonly kimiCnyMicros: bigint
  readonly deepseekUsdMicros: bigint
  readonly cnyPerUsdMicros: bigint
  readonly qualifiedSuccesses: number
  readonly controlCostPerSuccessCnyMicros: bigint | null
}): CampaignCost {
  if (
    input.kimiCnyMicros < 0n ||
    input.deepseekUsdMicros < 0n ||
    input.cnyPerUsdMicros <= 0n ||
    !Number.isSafeInteger(input.qualifiedSuccesses) ||
    input.qualifiedSuccesses < 0 ||
    (input.controlCostPerSuccessCnyMicros !== null && input.controlCostPerSuccessCnyMicros <= 0n)
  ) {
    throw new TypeError("TASK24_COST_INPUT_INVALID")
  }
  const deepseekCny = divideRounded(input.deepseekUsdMicros * input.cnyPerUsdMicros, 1_000_000n)
  const total = input.kimiCnyMicros + deepseekCny
  const perSuccess = input.qualifiedSuccesses === 0 ? null : divideRounded(total, BigInt(input.qualifiedSuccesses))
  const ratio =
    perSuccess === null || input.controlCostPerSuccessCnyMicros === null
      ? null
      : round(Number(perSuccess) / Number(input.controlCostPerSuccessCnyMicros))
  return Object.freeze({
    kimiCnyMicros: input.kimiCnyMicros.toString(),
    deepseekUsdMicros: input.deepseekUsdMicros.toString(),
    totalCnyMicros: total.toString(),
    costPerQualifiedSuccessCnyMicros: perSuccess?.toString() ?? null,
    costRatio: ratio,
  })
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
