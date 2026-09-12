import { describe, expect, test } from "bun:test"
import { buildDirectConfig } from "../../src/arms/config"

describe("Task24 isolated direct-arm config", () => {
  test.each([
    ["deepseek", "deepseek-v4-pro", "@ai-sdk/openai", "http://127.0.0.1:43123/v1/deepseek", "responses"],
    ["kimi", "kimi-k3", "@ai-sdk/openai-compatible", "http://127.0.0.1:43123/v1/kimi", "chat_completions"],
  ] as const)("builds a keyless %s-only provider config", (provider, model, npm, api, protocol) => {
    const config = buildDirectConfig({ provider, model, protocol, effort: "max" }, "http://127.0.0.1:43123", 4096)
    const text = JSON.stringify(config)
    const definition = config.provider[`task24-${provider}`]
    expect(config.enabled_providers).toEqual([`task24-${provider}`])
    expect(definition.npm).toBe(npm)
    expect(definition.api).toBe(api)
    expect(definition.env).toEqual(["TASK24_BROKER_GRANT"])
    expect(definition.models[model].variants.max).toBeDefined()
    expect(text).not.toContain("apiKey")
    expect(text).not.toContain("TASK24_BROKER_GRANT_abcdefghijklmnopqrstuvwxyz")
  })

  test("rejects fallback models and mismatched protocols", () => {
    expect(() =>
      Reflect.apply(buildDirectConfig, undefined, [
        { provider: "kimi", model: "kimi-k2.5", protocol: "chat_completions", effort: "max" },
        "http://127.0.0.1:43123",
        4096,
      ]),
    ).toThrow(/route/i)
    expect(() =>
      buildDirectConfig(
        { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat_completions", effort: "max" },
        "http://127.0.0.1:43123",
        4096,
      ),
    ).toThrow(/route/i)
  })
})
