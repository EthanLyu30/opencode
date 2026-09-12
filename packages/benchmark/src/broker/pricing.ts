import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { Decimal, HttpsUrl, IsoDateTime, ModelID } from "../schema"
import type { BrokerProvider } from "./grant"

const exact = { onExcessProperty: "error" as const }

const PriceRevision = Schema.Struct({
  provider: Schema.Literals(["kimi", "deepseek"]),
  model: ModelID,
  rateClass: Schema.Literals(["standard", "peak", "off_peak"]),
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
  readonly model: typeof ModelID.Type
  readonly rateClass: "standard" | "peak" | "off_peak"
  readonly currency: "CNY" | "USD"
  readonly inputMicrosPerMillion: bigint
  readonly cachedInputMicrosPerMillion: bigint
  readonly outputMicrosPerMillion: bigint
  readonly reasoningMicrosPerMillion: bigint
  readonly sha256: string
}

export interface PriceBook {
  readonly entries: readonly CompiledPrice[]
  readonly forRequest: (provider: BrokerProvider, model: string, at: string) => CompiledPrice
  readonly bySha256: (sha256: string) => CompiledPrice
}

export interface ProviderUsage {
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
}

export function compilePriceBook(input: readonly unknown[]): PriceBook {
  if (!Array.isArray(input)) throw new TypeError("BROKER_PRICE_BOOK_INVALID")
  const compile = (value: unknown): CompiledPrice => {
    const decoded = Schema.decodeUnknownSync(PriceRevision)(value, exact)
    if (
      (decoded.provider === "kimi" &&
        (decoded.model !== "kimi-k3" || decoded.rateClass !== "standard" || decoded.currency !== "CNY")) ||
      (decoded.provider === "deepseek" &&
        (decoded.model === "kimi-k3" || decoded.rateClass === "standard" || decoded.currency !== "USD"))
    ) {
      throw new TypeError("BROKER_PRICE_PROVIDER_INVALID")
    }
    const authority = {
      provider: decoded.provider,
      model: decoded.model,
      rateClass: decoded.rateClass,
      currency: decoded.currency,
      sourceUrl: decoded.sourceUrl,
      capturedAt: decoded.capturedAt,
      inputMicrosPerMillion: decoded.inputMicrosPerMillion,
      cachedInputMicrosPerMillion: decoded.cachedInputMicrosPerMillion,
      outputMicrosPerMillion: decoded.outputMicrosPerMillion,
      reasoningMicrosPerMillion: decoded.reasoningMicrosPerMillion,
    }
    const result = Object.freeze({
      provider: decoded.provider,
      model: decoded.model,
      rateClass: decoded.rateClass,
      currency: decoded.currency,
      inputMicrosPerMillion: positiveBigInt(decoded.inputMicrosPerMillion),
      cachedInputMicrosPerMillion: positiveBigInt(decoded.cachedInputMicrosPerMillion),
      outputMicrosPerMillion: positiveBigInt(decoded.outputMicrosPerMillion),
      reasoningMicrosPerMillion: positiveBigInt(decoded.reasoningMicrosPerMillion),
      sha256: sha256Text(canonicalJson(authority)),
    })
    return result
  }
  const entries = input.map(compile)
  const expected = new Set([
    "kimi:kimi-k3:standard",
    "deepseek:deepseek-v4-pro:peak",
    "deepseek:deepseek-v4-pro:off_peak",
    "deepseek:deepseek-v4-flash:peak",
    "deepseek:deepseek-v4-flash:off_peak",
  ])
  const byRoute = new Map(entries.map((entry) => [priceKey(entry.provider, entry.model, entry.rateClass), entry]))
  const byHash = new Map(entries.map((entry) => [entry.sha256, entry]))
  if (
    entries.length !== expected.size ||
    byRoute.size !== entries.length ||
    byHash.size !== entries.length ||
    [...expected].some((key) => !byRoute.has(key))
  ) {
    throw new TypeError("BROKER_PRICE_BOOK_INVALID")
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    forRequest(provider: BrokerProvider, model: string, at: string) {
      const rateClass = provider === "kimi" ? "standard" : isDeepSeekPeak(at) ? "peak" : "off_peak"
      const price = byRoute.get(priceKey(provider, model, rateClass))
      if (!price) throw new TypeError("BROKER_PRICE_ROUTE_INVALID")
      return price
    },
    bySha256(sha256: string) {
      const price = byHash.get(sha256)
      if (!price) throw new TypeError("BROKER_PRICE_REVISION_MISMATCH")
      return price
    },
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

function priceKey(provider: BrokerProvider, model: string, rateClass: string): string {
  return `${provider}:${model}:${rateClass}`
}

function isDeepSeekPeak(value: string): boolean {
  const time = new Date(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(time.getTime())) {
    throw new TypeError("BROKER_PRICE_TIME_INVALID")
  }
  const day = time.getUTCDay()
  const hour = time.getUTCHours()
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
}
