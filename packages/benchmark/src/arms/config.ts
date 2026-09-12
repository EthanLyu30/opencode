import type { ArmRoute } from "./types"

export function buildDirectConfig(route: Omit<ArmRoute, "role">, brokerOrigin: string, maximumOutputTokens: number) {
  validateOrigin(brokerOrigin)
  if (!Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens <= 0) {
    throw new TypeError("TASK24_DIRECT_OUTPUT_LIMIT_INVALID")
  }
  const validDeepSeek =
    route.provider === "deepseek" &&
    route.model === "deepseek-v4-pro" &&
    route.protocol === "responses" &&
    route.effort === "max"
  const validKimi =
    route.provider === "kimi" &&
    route.model === "kimi-k3" &&
    route.protocol === "chat_completions" &&
    route.effort === "max"
  if (!validDeepSeek && !validKimi) throw new TypeError("TASK24_DIRECT_ROUTE_INVALID")
  const providerID = `task24-${route.provider}` as const
  const npm = route.provider === "deepseek" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible"
  const api = `${brokerOrigin}/v1/${route.provider}`
  return Object.freeze({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [providerID],
    provider: {
      [providerID]: {
        name: route.provider === "deepseek" ? "Task24 DeepSeek" : "Task24 Kimi",
        npm,
        api,
        env: ["TASK24_BROKER_GRANT"],
        models: {
          [route.model]: {
            name: route.model,
            reasoning: true,
            tool_call: true,
            attachment: true,
            limit: { context: 262_144, output: maximumOutputTokens },
            variants: { max: { reasoningEffort: "max" } },
          },
        },
      },
    },
  })
}

function validateOrigin(value: string): void {
  const parsed = new URL(value)
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port.length === 0 ||
    parsed.origin !== value ||
    parsed.pathname !== "/"
  ) {
    throw new TypeError("TASK24_BROKER_ORIGIN_INVALID")
  }
}
