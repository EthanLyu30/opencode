import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { Decimal, HttpsUrl, IsoDateTime } from "../schema"
import type { BrokerProvider } from "./grant"

const exact = { onExcessProperty: "error" as const }

const PriceRevision = Schema.Struct({
  provider: Schema.Literals(["kimi", "deepseek"]),
  currency: Schema.Literals(["CNY", "USD"]),
  sourceUrl: HttpsUrl,
  capturedAt: IsoDateTime,
  inputMicrosPerMillion: Decimal,
  cachedInputMicrosPerMillion: Decimal,
  outputMicrosPerMillion: Decimal,
  reasoningMicrosPerMillion: Decimal,
})

export interface CompiledPrice {
  readonly provider: BrokerProvider
  readonly currency: "CNY" | "USD"
  readonly inputMicrosPerMillion: bigint
  readonly cachedInputMicrosPerMillion: bigint
  readonly outputMicrosPerMillion: bigint
  readonly reasoningMicrosPerMillion: bigint
  readonly sha256: string
}

export interface PriceBook {
  readonly kimi: CompiledPrice
  readonly deepseek: CompiledPrice
}

export interface ProviderUsage {
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
}

export function compilePriceBook(input: { readonly kimi: unknown; readonly deepseek: unknown }): PriceBook {
  const compile = (value: unknown, provider: BrokerProvider, currency: "CNY" | "USD"): CompiledPrice => {
    const decoded = Schema.decodeUnknownSync(PriceRevision)(value, exact)
    if (decoded.provider !== provider || decoded.currency !== currency)
      throw new TypeError("BROKER_PRICE_PROVIDER_INVALID")
    const authority = {
      provider: decoded.provider,
      currency: decoded.currency,
      sourceUrl: decoded.sourceUrl,
      capturedAt: decoded.capturedAt,
      inputMicrosPerMillion: decoded.inputMicrosPerMillion,
      cachedInputMicrosPerMillion: decoded.cachedInputMicrosPerMillion,
      outputMicrosPerMillion: decoded.outputMicrosPerMillion,
      reasoningMicrosPerMillion: decoded.reasoningMicrosPerMillion,
    }
    const result = Object.freeze({
      provider,
      currency,
      inputMicrosPerMillion: positiveBigInt(decoded.inputMicrosPerMillion),
      cachedInputMicrosPerMillion: positiveBigInt(decoded.cachedInputMicrosPerMillion),
      outputMicrosPerMillion: positiveBigInt(decoded.outputMicrosPerMillion),
      reasoningMicrosPerMillion: positiveBigInt(decoded.reasoningMicrosPerMillion),
      sha256: sha256Text(canonicalJson(authority)),
    })
    return result
  }
  return Object.freeze({
    kimi: compile(input.kimi, "kimi", "CNY"),
    deepseek: compile(input.deepseek, "deepseek", "USD"),
  })
}

export function worstCasePrice(
  price: CompiledPrice,
  input: { readonly inputTokens: number; readonly maximumOutputTokens: number },
): bigint {
  const inputTokens = tokens(input.inputTokens)
  const outputTokens = tokens(input.maximumOutputTokens)
  const outputRate =
    price.outputMicrosPerMillion > price.reasoningMicrosPerMillion
      ? price.outputMicrosPerMillion
      : price.reasoningMicrosPerMillion
  return charge(inputTokens, price.inputMicrosPerMillion) + charge(outputTokens, outputRate)
}

export function settlePrice(price: CompiledPrice, usage: ProviderUsage): bigint {
  validateUsage(usage)
  const cached = BigInt(usage.cachedInputTokens)
  const uncached = BigInt(usage.inputTokens - usage.cachedInputTokens)
  const reasoning = BigInt(usage.reasoningTokens)
  const ordinaryOutput = BigInt(usage.outputTokens - usage.reasoningTokens)
  return (
    charge(uncached, price.inputMicrosPerMillion) +
    charge(cached, price.cachedInputMicrosPerMillion) +
    charge(ordinaryOutput, price.outputMicrosPerMillion) +
    charge(reasoning, price.reasoningMicrosPerMillion)
  )
}

export function validateUsage(usage: ProviderUsage): void {
  for (const value of Object.values(usage)) tokens(value)
  if (usage.cachedInputTokens > usage.inputTokens || usage.reasoningTokens > usage.outputTokens) {
    throw new TypeError("BROKER_USAGE_INVALID")
  }
}

function tokens(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("BROKER_TOKEN_COUNT_INVALID")
  return BigInt(value)
}

function charge(tokenCount: bigint, rate: bigint): bigint {
  if (tokenCount === 0n) return 0n
  return (tokenCount * rate + 999_999n) / 1_000_000n
}

function positiveBigInt(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) throw new TypeError("BROKER_PRICE_INVALID")
  return BigInt(value)
}
