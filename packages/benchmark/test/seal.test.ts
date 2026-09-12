import { describe, expect, test } from "bun:test"
import { canonicalJson } from "../src/campaign/canonical"
import { sealCampaign, verifyCampaign } from "../src/campaign/seal"

const sha = (digit: string) => digit.repeat(64)

const primary = Array.from({ length: 12 }, (_, index) => ({
  id: `primary-${index + 1}`,
  kind: "primary" as const,
  stratum: (["private", "design2code", "swebench-multimodal"] as const)[Math.floor(index / 4)]!,
  family: index % 2 === 0 ? "greenfield" : "repair",
  bundleSha256: sha(((index + 1) % 10).toString()),
  goldSha256: sha(((index + 2) % 10).toString()),
}))

const guardrails = Array.from({ length: 4 }, (_, index) => ({
  id: `guardrail-${index + 1}`,
  kind: "guardrail" as const,
  stratum: "guardrail" as const,
  family: ["debugging", "data", "backend", "refactor"][index]!,
  bundleSha256: sha(((index + 3) % 10).toString()),
  goldSha256: sha(((index + 4) % 10).toString()),
}))

const workflowRoutes = [
  ["design", "kimi", "kimi-k3", "chat_completions", "max"],
  ["decompose", "kimi", "kimi-k3", "chat_completions", "high"],
  ["implement", "deepseek", "deepseek-v4-pro", "responses", "max"],
  ["test", "deepseek", "deepseek-v4-flash", "responses", "high"],
  ["visual_review", "kimi", "kimi-k3", "chat_completions", "max"],
  ["repair", "deepseek", "deepseek-v4-pro", "responses", "max"],
  ["deliver", "deepseek", "deepseek-v4-pro", "responses", "high"],
].map(([role, provider, model, protocol, effort]) => ({ role, provider, model, protocol, effort }))

const direct = (
  provider: "kimi" | "deepseek",
  model: "kimi-k3" | "deepseek-v4-pro",
  protocol: "chat_completions" | "responses",
) => [{ role: "all", provider, model, protocol, effort: "max" }]

const fixture = () => ({
  schemaVersion: 1 as const,
  id: "task24-fixture",
  createdAt: "2026-09-12T12:00:00.000Z",
  preregistration: {
    primaryTaskCount: 12,
    guardrailTaskCount: 4,
    primaryRepeats: 2,
    upstreamRepeats: 1,
    upstreamSecondPassThresholdPoints: 5,
    bootstrapResamples: 10_000,
    minimumEffectPoints: 10,
    visualQualifiedThreshold: 75,
    viewportFloor: 65,
    costRatioLimit: 2,
    maxConcurrency: 1,
    seed: "task24-fixed-seed",
    budget: {
      aggregateInputTokens: 200_000,
      aggregateOutputTokens: 40_000,
      maxToolCalls: 120,
      maxRetries: 3,
      maxDurationMs: 3_600_000,
    },
  },
  binaries: {
    modified: {
      version: "0.0.0-dev-20260912",
      commit: sha("a"),
      sha256: sha("b"),
      sourceUrl: "https://github.com/EthanLyu30/opencode",
    },
    upstream: {
      version: "v1.18.30",
      commit: sha("c"),
      sha256: sha("d"),
      sourceUrl: "https://github.com/anomalyco/opencode",
    },
  },
  sources: [
    {
      id: "opencode-upstream",
      kind: "git",
      url: "https://github.com/anomalyco/opencode",
      revision: sha("c"),
      sha256: sha("e"),
      license: "MIT",
    },
  ],
  tasks: [...primary.map((task) => ({ ...task })), ...guardrails.map((task) => ({ ...task }))],
  arms: [
    { id: "A", runtime: "modified", mode: "workflow", routes: workflowRoutes },
    { id: "B", runtime: "modified", mode: "direct", routes: direct("deepseek", "deepseek-v4-pro", "responses") },
    { id: "C", runtime: "modified", mode: "direct", routes: direct("kimi", "kimi-k3", "chat_completions") },
    { id: "D", runtime: "upstream", mode: "direct", routes: direct("deepseek", "deepseek-v4-pro", "responses") },
    { id: "E", runtime: "upstream", mode: "direct", routes: direct("kimi", "kimi-k3", "chat_completions") },
  ],
  pricing: {
    kimi: {
      provider: "kimi",
      currency: "CNY",
      sourceUrl: "https://platform.kimi.com/",
      capturedAt: "2026-09-12T12:00:00.000Z",
      inputMicrosPerMillion: "1000000",
      cachedInputMicrosPerMillion: "100000",
      outputMicrosPerMillion: "3000000",
      reasoningMicrosPerMillion: "3000000",
    },
    deepseek: {
      provider: "deepseek",
      currency: "USD",
      sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
      capturedAt: "2026-09-12T12:00:00.000Z",
      inputMicrosPerMillion: "1000000",
      cachedInputMicrosPerMillion: "100000",
      outputMicrosPerMillion: "3000000",
      reasoningMicrosPerMillion: "3000000",
    },
  },
  exchangeRate: {
    base: "CNY",
    quote: "USD",
    decimalRate: "0.14000000",
    sourceUrl: "https://example.test/exchange-rate",
    capturedAt: "2026-09-12T12:00:00.000Z",
  },
  toolchain: {
    bunVersion: "1.3.14",
    nodeVersion: "24.7.0",
    playwrightVersion: "1.59.1",
    chromiumRevision: "1234567",
    operatingSystem: "Windows 11 10.0.26100",
    sha256: sha("f"),
  },
  evaluator: {
    version: "task24-evaluator-v1",
    sha256: sha("1"),
    diagnosticWeights: { functional: 45, visual: 30, requirements: 10, quality: 10, accessibilityResponsive: 5 },
    visualWeights: { ssim: 35, pixelColor: 20, domGeometry: 25, typographyStyle: 10, responsiveInteraction: 10 },
  },
})

describe("campaign seal", () => {
  test("canonical JSON is stable across object key order and line endings", () => {
    expect(canonicalJson({ z: "a\r\nb", a: 1n })).toBe(canonicalJson({ a: 1n, z: "a\nb" }))
  })

  test("produces the same seal for the same decoded campaign", () => {
    expect(sealCampaign(fixture())).toEqual(sealCampaign(fixture()))
  })

  test("detects any post-seal mutation", () => {
    const sealed = sealCampaign(fixture())
    const mutated = { ...sealed, arms: [...sealed.arms].reverse() }
    expect(verifyCampaign(mutated)).toMatchObject({ ok: false, reason: "CAMPAIGN_HASH_MISMATCH" })
  })

  test("rejects a campaign that does not contain the fixed task corpus", () => {
    expect(() => sealCampaign({ ...fixture(), tasks: fixture().tasks.slice(0, 15) })).toThrow(
      "CAMPAIGN_TASK_COUNT_INVALID",
    )
  })

  test("rejects campaign identifiers that are unsafe as directory names", () => {
    expect(() => sealCampaign({ ...fixture(), id: "../outside" })).toThrow()
  })

  test("rejects task identifiers that could escape a run workspace", () => {
    const unsafe = fixture()
    unsafe.tasks[0]!.id = "..\\outside"
    expect(() => sealCampaign(unsafe)).toThrow()
  })

  test("rejects unsealed extra fields instead of dropping them", () => {
    const sealed = sealCampaign(fixture())
    expect(verifyCampaign({ ...sealed, unexpected: "not-bound-by-the-seal" })).toEqual({
      ok: false,
      reason: "CAMPAIGN_INVALID",
    })
  })

  test("rejects zero provider prices and zero presentation exchange rates", () => {
    const zeroPrice = fixture()
    zeroPrice.pricing.kimi.inputMicrosPerMillion = "0"
    expect(() => sealCampaign(zeroPrice)).toThrow("CAMPAIGN_PRICING_INVALID")

    const zeroExchange = fixture()
    zeroExchange.exchangeRate.decimalRate = "0"
    expect(() => sealCampaign(zeroExchange)).toThrow("CAMPAIGN_EXCHANGE_RATE_INVALID")
  })

  test("binds an explicit positive concurrency ceiling into the campaign seal", () => {
    const higherConcurrency = fixture()
    higherConcurrency.preregistration.maxConcurrency = 2
    expect(sealCampaign(higherConcurrency).preregistration.maxConcurrency).toBe(2)

    const invalid = fixture()
    invalid.preregistration.maxConcurrency = 0
    expect(() => sealCampaign(invalid)).toThrow()
  })
})
