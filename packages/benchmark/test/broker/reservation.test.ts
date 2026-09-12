import { describe, expect, test } from "bun:test"
import { compilePriceBook, settlePrice, worstCasePrice } from "../../src/broker/pricing"
import { ReservationBook } from "../../src/broker/reservation"

const prices = compilePriceBook({
  kimi: {
    provider: "kimi",
    currency: "CNY",
    sourceUrl: "https://example.test/kimi-price",
    capturedAt: "2026-09-12T12:00:00.000Z",
    inputMicrosPerMillion: "1000000",
    cachedInputMicrosPerMillion: "100000",
    outputMicrosPerMillion: "3000000",
    reasoningMicrosPerMillion: "4000000",
  },
  deepseek: {
    provider: "deepseek",
    currency: "USD",
    sourceUrl: "https://example.test/deepseek-price",
    capturedAt: "2026-09-12T12:00:00.000Z",
    inputMicrosPerMillion: "2000000",
    cachedInputMicrosPerMillion: "200000",
    outputMicrosPerMillion: "5000000",
    reasoningMicrosPerMillion: "6000000",
  },
})

describe("Task24 broker reservations", () => {
  test("prices cached input and reasoning output without double counting", () => {
    expect(
      settlePrice(prices.kimi, {
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 6,
        reasoningTokens: 2,
      }),
    ).toBe(27n)
    expect(worstCasePrice(prices.deepseek, { inputTokens: 100, maximumOutputTokens: 20 })).toBe(320n)
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
