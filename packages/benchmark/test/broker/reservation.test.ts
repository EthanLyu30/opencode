import { describe, expect, test } from "bun:test"
import { compilePriceBook, settlePrice, worstCasePrice } from "../../src/broker/pricing"
import { ReservationBook } from "../../src/broker/reservation"

const priceInput = [
  {
    provider: "kimi",
    model: "kimi-k3",
    rateClass: "standard",
    currency: "CNY",
    sourceUrl: "https://example.test/kimi-price",
    capturedAt: "2026-09-12T12:00:00.000Z",
    inputMicrosPerMillion: "1000000",
    cachedInputMicrosPerMillion: "100000",
    outputMicrosPerMillion: "3000000",
    reasoningMicrosPerMillion: "4000000",
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    rateClass: "peak",
    currency: "USD",
    sourceUrl: "https://example.test/deepseek-price",
    capturedAt: "2026-09-12T12:00:00.000Z",
    inputMicrosPerMillion: "2000000",
    cachedInputMicrosPerMillion: "200000",
    outputMicrosPerMillion: "5000000",
    reasoningMicrosPerMillion: "6000000",
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    rateClass: "off_peak",
    currency: "USD",
    sourceUrl: "https://example.test/deepseek-price",
    capturedAt: "2026-09-12T12:00:00.000Z",
    inputMicrosPerMillion: "1000000",
    cachedInputMicrosPerMillion: "100000",
    outputMicrosPerMillion: "2500000",
    reasoningMicrosPerMillion: "3000000",
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    rateClass: "peak",
    currency: "USD",
    sourceUrl: "https://example.test/deepseek-price",
    capturedAt: "2026-09-12T12:00:00.000Z",
    inputMicrosPerMillion: "500000",
    cachedInputMicrosPerMillion: "50000",
    outputMicrosPerMillion: "1000000",
    reasoningMicrosPerMillion: "1000000",
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    rateClass: "off_peak",
    currency: "USD",
    sourceUrl: "https://example.test/deepseek-price",
    capturedAt: "2026-09-12T12:00:00.000Z",
    inputMicrosPerMillion: "250000",
    cachedInputMicrosPerMillion: "25000",
    outputMicrosPerMillion: "500000",
    reasoningMicrosPerMillion: "500000",
  },
] as const
const prices = compilePriceBook(priceInput)

describe("Task24 broker reservations", () => {
  test("prices cached input and reasoning output without double counting", () => {
    const kimi = prices.forRequest("kimi", "kimi-k3", "2026-09-12T12:00:00.000Z")
    const deepseekPeak = prices.forRequest("deepseek", "deepseek-v4-pro", "2026-09-14T01:30:00.000Z")
    const deepseekOffPeak = prices.forRequest("deepseek", "deepseek-v4-pro", "2026-09-14T04:30:00.000Z")
    expect(
      settlePrice(kimi, {
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 6,
        reasoningTokens: 2,
      }),
    ).toBe(27n)
    expect(worstCasePrice(deepseekPeak, { inputTokens: 100, maximumOutputTokens: 20 })).toBe(320n)
    expect(worstCasePrice(deepseekOffPeak, { inputTokens: 100, maximumOutputTokens: 20 })).toBe(160n)
    expect(prices.forRequest("deepseek", "deepseek-v4-pro", "2026-09-14T01:30:00Z")).toBe(deepseekPeak)
    expect(prices.bySha256(deepseekPeak.sha256)).toBe(deepseekPeak)
  })

  test("rejects missing or duplicate model/rate revisions", () => {
    expect(() => compilePriceBook([])).toThrow(/price/i)
    expect(() => compilePriceBook([priceInput[0], priceInput[0]])).toThrow(/price/i)
  })

  test("atomically rejects parallel reservations beyond the ceiling and allows exact exhaustion", async () => {
    const book = new ReservationBook({ CNY: 100n, USD: 100n })
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => book.reserve("r1", "CNY", 60n)),
      Promise.resolve().then(() => book.reserve("r2", "CNY", 60n)),
    ])

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(book.snapshot("CNY").reserved).toBe(60n)
    book.settle(attempts[0]?.status === "fulfilled" ? "r1" : "r2", 60n)
    expect(book.snapshot("CNY").settled).toBe(60n)
    expect(() => book.reserve("exact", "CNY", 40n)).not.toThrow()
    expect(book.snapshot("CNY").available).toBe(0n)
  })

  test("charges the full reservation for cancellation, provider failure, or unknown usage", () => {
    const book = new ReservationBook({ CNY: 1_000n, USD: 1_000n })
    for (const id of ["cancelled", "upstream-4xx", "malformed-sse", "missing-usage"] as const) {
      book.reserve(id, "USD", 100n)
      book.forfeit(id)
    }
    expect(book.snapshot("USD")).toEqual({ ceiling: 1_000n, reserved: 0n, settled: 400n, available: 600n })
  })
})
