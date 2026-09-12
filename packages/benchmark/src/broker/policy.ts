import type { GrantRoute } from "./grant"

export interface AuthorizedRequest extends GrantRoute {
  readonly route: "/v1/kimi/chat/completions" | "/v1/deepseek/responses"
  readonly maximumOutputTokens: number
}

export class BrokerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
    this.name = "BrokerRequestError"
  }
}

export function authorizeRequest(pathname: string, body: unknown): AuthorizedRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BrokerRequestError(400, "BROKER_REQUEST_BODY_INVALID")
  }
  const model = Reflect.get(body, "model")
  const stream = Reflect.get(body, "stream")
  if (stream !== true) throw new BrokerRequestError(400, "BROKER_STREAM_REQUIRED")
  if (pathname === "/v1/kimi/chat/completions") {
    if (model !== "kimi-k3") throw new BrokerRequestError(400, "BROKER_ROUTE_MODEL_INVALID")
    const completion = Reflect.get(body, "max_completion_tokens")
    const compatible = Reflect.get(body, "max_tokens")
    if (completion !== undefined && compatible !== undefined) {
      throw new BrokerRequestError(400, "BROKER_MAX_OUTPUT_TOKENS_AMBIGUOUS")
    }
    return Object.freeze({
      route: pathname,
      provider: "kimi",
      model,
      protocol: "chat_completions",
      maximumOutputTokens: positiveInt(completion ?? compatible),
    })
  }
  if (pathname === "/v1/deepseek/responses") {
    if (model !== "deepseek-v4-pro" && model !== "deepseek-v4-flash") {
      throw new BrokerRequestError(400, "BROKER_ROUTE_MODEL_INVALID")
    }
    return Object.freeze({
      route: pathname,
      provider: "deepseek",
      model,
      protocol: "responses",
      maximumOutputTokens: positiveInt(Reflect.get(body, "max_output_tokens")),
    })
  }
  throw new BrokerRequestError(404, "BROKER_ROUTE_NOT_FOUND")
}

export function conservativeInputTokens(requestBytes: number): number {
  if (!Number.isSafeInteger(requestBytes) || requestBytes < 0) throw new TypeError("BROKER_REQUEST_SIZE_INVALID")
  return requestBytes + 256
}

function positiveInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BrokerRequestError(400, "BROKER_MAX_OUTPUT_TOKENS_REQUIRED")
  }
  return value
}
