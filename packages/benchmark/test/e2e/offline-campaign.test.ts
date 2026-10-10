import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { startBroker } from "../../src/broker/server"
import { compilePriceBook } from "../../src/broker/pricing"
import { createFakeProvider, fakeRequest } from "../../src/offline/fake-provider"
import { Task24Root } from "../../src/root"
import { planCampaignRuns, type CampaignPlanSource } from "../../src/run/plan"
import type { ArmRoute } from "../../src/arms/types"
import { priceFixture } from "../broker/price-fixture"

const routes: Readonly<Record<"A" | "B" | "C" | "D" | "E", readonly ArmRoute[]>> = {
  A: [
    { role: "design", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "max" },
    { role: "decompose", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "high" },
    { role: "implement", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "max" },
    { role: "test", provider: "deepseek", model: "deepseek-v4-flash", protocol: "responses", effort: "high" },
    { role: "visual_review", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "max" },
    { role: "repair", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "max" },
    { role: "deliver", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "high" },
  ],
  B: [{ role: "all", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "max" }],
  C: [{ role: "all", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "max" }],
  D: [{ role: "all", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "max" }],
  E: [{ role: "all", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "max" }],
}

describe("Task24 offline five-arm campaign", () => {
  test("balances all five arms with the sealed repeat policy", () => {
    const campaign = {
      id: "offline-fixture",
      preregistration: { primaryRepeats: 2, upstreamRepeats: 1, seed: "offline-balanced-seed" },
      tasks: [{ id: "task-a" }, { id: "task-b" }],
    } satisfies CampaignPlanSource
    const runs = planCampaignRuns(campaign, "offline")
    expect(runs).toHaveLength(16)
    expect(
      Object.fromEntries(["A", "B", "C", "D", "E"].map((arm) => [arm, runs.filter((run) => run.armID === arm).length])),
    ).toEqual({
      A: 4,
      B: 4,
      C: 4,
      D: 2,
      E: 2,
    })
    expect(new Set(runs.map((run) => run.runID)).size).toBe(runs.length)
  })

  test("passes every workflow role and both direct protocols through a zero-credit broker", async () => {
    const directory = path.join(Task24Root.ensure().tmp, `offline-e2e-${crypto.randomUUID()}`)
    await fs.mkdir(directory)
    const fake = createFakeProvider()
    const broker = await startBroker({
      database: path.join(directory, "ledger.sqlite"),
      campaignID: "offline-e2e",
      runID: "run-e2e",
      expiresAt: Date.now() + 60_000,
      maximumCalls: 11,
      ceilings: { CNY: 100_000_000n, USD: 100_000_000n },
      prices: compilePriceBook(priceFixture),
      providerKeys: { kimi: "sk-TASK24_FAKE_KIMI", deepseek: "sk-TASK24_FAKE_DEEPSEEK" },
      upstream: fake.upstream,
    })
    try {
      let responseText = ""
      for (const armID of ["A", "B", "C", "D", "E"] as const) {
        for (const route of routes[armID]) {
          const endpoint = route.provider === "kimi" ? "/v1/kimi/chat/completions" : "/v1/deepseek/responses"
          const response = await fetch(`${broker.origin}${endpoint}`, {
            method: "POST",
            headers: { authorization: `Bearer ${broker.grant}`, "content-type": "application/json" },
            body: JSON.stringify(fakeRequest(route)),
          })
          expect(response.status).toBe(200)
          responseText += await response.text()
        }
      }
      expect(fake.calls()).toHaveLength(11)
      expect(fake.calls().filter((call) => call.protocol === "chat_completions")).toHaveLength(5)
      expect(fake.calls().filter((call) => call.protocol === "responses")).toHaveLength(6)
      expect(responseText).toContain("apply_patch")
      expect(broker.ledger.records()).toHaveLength(11)
      expect(broker.ledger.records().every((record) => record.resultClass === "completed" && record.usage)).toBe(true)
      expect(JSON.stringify(broker.ledger.records())).not.toContain("TASK24_OFFLINE_FAKE_INPUT")
    } finally {
      await broker[Symbol.asyncDispose]()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
