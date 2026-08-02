export * as WorkflowRetry from "./retry"

import { LLMError } from "@opencode-ai/llm"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowSecretGuard } from "./secret-guard"

export type Decision =
  | { readonly type: "retry"; readonly notBefore: number }
  | { readonly type: "fail" }
  | { readonly type: "approval" }

export function decide(input: {
  readonly failure: Workflow.Failure
  readonly attempt: number
  readonly maxAttempts: number
  readonly now: number
  readonly randomUnit: number
}): Decision {
  if (input.failure.category === "ambiguous") return { type: "approval" }
  if (input.failure.category !== "transient" || input.attempt >= input.maxAttempts) return { type: "fail" }
  if (input.failure.retryAfterMs !== undefined) {
    return { type: "retry", notBefore: input.now + Math.min(input.failure.retryAfterMs, 60_000) }
  }
  const base = Math.min(1_000 * 2 ** (input.attempt - 1), 60_000)
  const jitter = 0.8 + Math.min(1, Math.max(0, input.randomUnit)) * 0.4
  return { type: "retry", notBefore: input.now + Math.round(base * jitter) }
}

export function fromLLMError(error: LLMError): Workflow.Failure {
  const tag = error.reason._tag
  const category =
    tag === "Authentication"
      ? "authentication"
      : tag === "QuotaExceeded"
        ? "quota"
        : tag === "InvalidRequest"
          ? "invalid_request"
          : error.retryable || isTransportTimeout(error)
            ? "transient"
            : "unknown"
  const code =
    tag === "RateLimit"
      ? "rate_limit"
      : tag === "ProviderInternal"
        ? "provider_internal"
        : tag === "Transport" && isTransportTimeout(error)
          ? "transport_timeout"
          : tag === "Authentication"
            ? "authentication"
            : tag === "QuotaExceeded"
              ? "quota"
              : tag === "InvalidRequest"
                ? "invalid_request"
                : "unknown"

  return {
    category,
    code,
    message: WorkflowSecretGuard.sanitizeText(error.message),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  }
}

function isTransportTimeout(error: LLMError) {
  if (error.reason._tag !== "Transport") return false
  return (
    error.reason.kind?.toLowerCase().includes("timeout") === true || /timed?\s*out|timeout/i.test(error.reason.message)
  )
}
