import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { startBroker } from "../../src/broker/server"
import { compilePriceBook } from "../../src/broker/pricing"
import { Task24Root } from "../../src/root"
import { priceFixture } from "./price-fixture"

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length > 0) {
    const target = path.resolve(cleanup.pop()!)
    const parent = path.resolve(Task24Root.fixed, "tmp") + path.sep
    if (!target.startsWith(parent)) throw new TypeError("Unsafe broker server cleanup")
    await fs.rm(target, { recursive: true, force: true })
  }
})

const prices = compilePriceBook(priceFixture)

async function fixture(name: string) {
  return Bun.file(path.join(import.meta.dir, "..", "fixtures", "provider", name)).text()
}

async function broker(
  upstream: (request: Request) => Promise<Response>,
  settings: {
    readonly maximumCalls?: number
    readonly ceilings?: Readonly<{ CNY: bigint; USD: bigint }>
  } = {},
) {
  const directory = path.join(Task24Root.ensure().tmp, `broker-server-${crypto.randomUUID()}`)
  cleanup.push(directory)
  await fs.mkdir(directory)
  return startBroker({
    database: path.join(directory, "ledger.sqlite"),
    campaignID: "campaign-a",
    runID: "run-a",
    expiresAt: Date.now() + 60_000,
    maximumCalls: settings.maximumCalls ?? 20,
    ceilings: settings.ceilings ?? { CNY: 100_000n, USD: 100_000n },
    prices,
    providerKeys: { kimi: "sk-FAKE_KIMI_UPSTREAM_KEY", deepseek: "sk-FAKE_DEEPSEEK_UPSTREAM_KEY" },
    upstream,
  })
}

describe("Task24 loopback broker", () => {
  test("rejects wrong methods, paths, auth, models, and protocols before upstream access", async () => {
    let calls = 0
    const running = await broker(async () => {
      calls++
      return new Response("unexpected")
    })
    try {
      const request = (pathname: string, init: RequestInit = {}) => fetch(`${running.origin}${pathname}`, init)

      expect((await request("/v1/kimi/chat/completions")).status).toBe(405)
      expect((await request("/v1/other", { method: "POST" })).status).toBe(404)
      expect((await request("/v1/kimi/chat/completions", { method: "POST", body: "{}" })).status).toBe(401)
      expect(
        (
          await request("/v1/kimi/chat/completions", {
            method: "POST",
            headers: { authorization: `Bearer ${running.grant}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "deepseek-v4-pro", max_completion_tokens: 10 }),
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await request("/v1/deepseek/responses", {
            method: "POST",
            headers: { authorization: `Bearer ${running.grant}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "deepseek-v4-pro" }),
          })
        ).status,
      ).toBe(400)
      expect(calls).toBe(0)
    } finally {
      await running[Symbol.asyncDispose]()
    }
  })

  test.each([
    ["/v1/kimi/chat/completions", "kimi-k3", "max_completion_tokens", "kimi-chat.sse", "openai-chat"],
    ["/v1/deepseek/responses", "deepseek-v4-pro", "max_output_tokens", "deepseek-responses.sse", "openai-responses"],
  ] as const)(
    "streams %s bytes unchanged and injects only the real upstream credential",
    async (route, model, max, name) => {
      const expected = await fixture(name)
      const seen: Request[] = []
      const running = await broker(async (request) => {
        seen.push(request)
        return new Response(expected, { headers: { "content-type": "text/event-stream" } })
      })
      try {
        const response = await fetch(`${running.origin}${route}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${running.grant}`,
            "content-type": "application/json",
            "x-forged-upstream-header": "must-not-forward",
          },
          body: JSON.stringify({ model, [max]: 20, stream: true, input: "CANARY_PROMPT_SOURCE_CODE" }),
        })

        expect(response.status).toBe(200)
        expect(await response.text()).toBe(expected)
        expect(seen).toHaveLength(1)
        expect(seen[0]?.headers.get("authorization")).toMatch(/^Bearer sk-FAKE_/)
        expect(seen[0]?.headers.get("authorization")).not.toContain(running.grant)
        expect(seen[0]?.headers.get("x-forged-upstream-header")).toBeNull()
        const rows = running.ledger.records()
        expect(rows).toHaveLength(1)
        expect(JSON.stringify(rows)).not.toContain("CANARY_PROMPT_SOURCE_CODE")
        expect(JSON.stringify(rows)).not.toContain("CANARY_RESPONSE_TEXT")
        for (const name of await fs.readdir(path.dirname(running.database))) {
          const persisted = await fs.readFile(path.join(path.dirname(running.database), name))
          expect(persisted.toString("utf8")).not.toContain("CANARY_PROMPT_SOURCE_CODE")
          expect(persisted.toString("utf8")).not.toContain("CANARY_RESPONSE_TEXT")
          expect(persisted.toString("utf8")).not.toContain("sk-FAKE_")
        }
      } finally {
        await running[Symbol.asyncDispose]()
      }
    },
  )

  test("forfeits the reservation on upstream failure without returning provider content", async () => {
    const running = await broker(async () => new Response("CANARY_PROVIDER_FAILURE", { status: 500 }))
    try {
      const response = await fetch(`${running.origin}/v1/deepseek/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${running.grant}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", max_output_tokens: 20, stream: true }),
      })
      expect(response.status).toBe(500)
      expect(await response.text()).toBe("CANARY_PROVIDER_FAILURE")
      expect(running.ledger.records()[0]?.resultClass).toBe("upstream_error")
    } finally {
      await running[Symbol.asyncDispose]()
    }
  })

  test("rejects an invalid grant and hard-budget exhaustion before upstream access", async () => {
    let calls = 0
    const running = await broker(
      async () => {
        calls++
        return new Response("unexpected")
      },
      { ceilings: { CNY: 0n, USD: 0n } },
    )
    try {
      const body = JSON.stringify({ model: "deepseek-v4-pro", max_output_tokens: 20, stream: true })
      const invalid = await fetch(`${running.origin}/v1/deepseek/responses`, {
        method: "POST",
        headers: { authorization: "Bearer not-the-grant", "content-type": "application/json" },
        body,
      })
      expect(invalid.status).toBe(401)
      const exhausted = await fetch(`${running.origin}/v1/deepseek/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${running.grant}`, "content-type": "application/json" },
        body,
      })
      expect(exhausted.status).toBe(402)
      expect(await exhausted.json()).toEqual({ error: { code: "BUDGET_RESERVATION_EXCEEDED" } })
      expect(calls).toBe(0)
    } finally {
      await running[Symbol.asyncDispose]()
    }
  })

  test("enforces the persisted grant call ceiling", async () => {
    let calls = 0
    const expected = await fixture("deepseek-responses.sse")
    const running = await broker(
      async () => {
        calls++
        return new Response(expected, { headers: { "content-type": "text/event-stream" } })
      },
      { maximumCalls: 1 },
    )
    try {
      const invoke = () =>
        fetch(`${running.origin}/v1/deepseek/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${running.grant}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "deepseek-v4-pro", max_output_tokens: 20, stream: true }),
        })
      const first = await invoke()
      expect(first.status).toBe(200)
      await first.text()
      expect((await invoke()).status).toBe(401)
      expect(calls).toBe(1)
    } finally {
      await running[Symbol.asyncDispose]()
    }
  })
})
