import { describe, expect, test } from "bun:test"
import { mintGrant, revokeGrant, verifyGrant } from "../../src/broker/grant"

const now = 1_800_000_000_000

describe("Task24 broker grants", () => {
  test("mints only a random secret plus a nonsecret hash authority", () => {
    const minted = mintGrant({
      campaignID: "campaign-a",
      runID: "run-a",
      allowed: [
        { provider: "kimi", model: "kimi-k3", protocol: "chat_completions" },
        { provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses" },
      ],
      expiresAt: now + 60_000,
      maximumCalls: 3,
    })

    expect(minted.grant.length).toBeGreaterThanOrEqual(43)
    expect(minted.authority.grantSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(minted.authority)).not.toContain(minted.grant)
    expect(verifyGrant(minted.authority, minted.grant, now + 1, minted.authority.allowed[0])).toBe(true)
    expect(verifyGrant(minted.authority, `${minted.grant}x`, now + 1, minted.authority.allowed[0])).toBe(false)
  })

  test("fails closed for expiry, a disallowed route, and revocation", () => {
    const minted = mintGrant({
      campaignID: "campaign-a",
      runID: "run-a",
      allowed: [{ provider: "kimi", model: "kimi-k3", protocol: "chat_completions" }],
      expiresAt: now + 10,
      maximumCalls: 1,
    })
    expect(
      verifyGrant(minted.authority, minted.grant, now + 11, {
        provider: "kimi",
        model: "kimi-k3",
        protocol: "chat_completions",
      }),
    ).toBe(false)
    expect(
      verifyGrant(minted.authority, minted.grant, now, {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        protocol: "responses",
      }),
    ).toBe(false)
    expect(verifyGrant(revokeGrant(minted.authority), minted.grant, now, minted.authority.allowed[0])).toBe(false)
  })
})
