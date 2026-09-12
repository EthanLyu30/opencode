import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { BrokerLedger } from "../../src/broker/ledger"
import { compilePriceBook } from "../../src/broker/pricing"
import { Task24Root } from "../../src/root"
import { priceFixture } from "./price-fixture"

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length > 0) {
    const target = path.resolve(cleanup.pop()!)
    const parent = path.resolve(Task24Root.fixed, "tmp") + path.sep
    if (!target.startsWith(parent)) throw new TypeError("Unsafe broker test cleanup")
    await fs.rm(target, { recursive: true, force: true })
  }
})

const prices = compilePriceBook(priceFixture)

describe("Task24 broker ledger", () => {
  test("survives restart, settles once, and preserves an append-only hash chain without bodies", async () => {
    const directory = path.join(Task24Root.ensure().tmp, `broker-ledger-${crypto.randomUUID()}`)
    cleanup.push(directory)
    await fs.mkdir(directory)
    const database = path.join(directory, "ledger.sqlite")
    const first = BrokerLedger.open({ database, prices, ceilings: { CNY: 10_000n, USD: 10_000n } })
    first.reserve({
      requestID: "request-1",
      campaignID: "campaign-a",
      runID: "run-a",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      protocol: "responses",
      route: "/v1/deepseek/responses",
      requestBytes: 123,
      requestSha256: "a".repeat(64),
      inputTokenBound: 200,
      maximumOutputTokens: 50,
      priceSha256: prices.forRequest("deepseek", "deepseek-v4-pro", "2026-09-14T01:30:00.000Z").sha256,
      at: "2026-09-14T01:30:00.000Z",
    })
    first.close()

    const second = BrokerLedger.open({ database, prices, ceilings: { CNY: 10_000n, USD: 10_000n } })
    const record = second.settle({
      requestID: "request-1",
      resultClass: "completed",
      responseBytes: 456,
      responseSha256: "b".repeat(64),
      terminalType: "response.completed",
      usage: { inputTokens: 12, cachedInputTokens: 5, outputTokens: 8, reasoningTokens: 3 },
      at: "2026-09-12T12:01:00.000Z",
    })
    expect(second.settle({ ...record, requestID: "request-1" })).toEqual(record)
    const rows = second.records()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.previousSha256).toBe("0".repeat(64))
    expect(rows[0]?.recordSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(rows[0]?.priceSha256).toBe(
      prices.forRequest("deepseek", "deepseek-v4-pro", "2026-09-14T01:30:00.000Z").sha256,
    )
    expect(JSON.stringify(rows)).not.toContain("CANARY_PROMPT_SOURCE_CODE")
    second.close()
  })

  test("rejects a reservation with the wrong sealed price revision", async () => {
    const directory = path.join(Task24Root.ensure().tmp, `broker-ledger-${crypto.randomUUID()}`)
    cleanup.push(directory)
    await fs.mkdir(directory)
    const ledger = BrokerLedger.open({
      database: path.join(directory, "ledger.sqlite"),
      prices,
      ceilings: { CNY: 1_000n, USD: 1_000n },
    })
    expect(() =>
      ledger.reserve({
        requestID: "wrong-price",
        campaignID: "campaign-a",
        runID: "run-a",
        provider: "kimi",
        model: "kimi-k3",
        protocol: "chat_completions",
        route: "/v1/kimi/chat/completions",
        requestBytes: 10,
        requestSha256: "a".repeat(64),
        inputTokenBound: 10,
        maximumOutputTokens: 10,
        priceSha256: "f".repeat(64),
        at: "2026-09-12T12:00:00.000Z",
      }),
    ).toThrow(/price/i)
    ledger.close()
  })
})
