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

export function usageDelta(current: Workflow.Usage, checkpointed: Workflow.Usage): Workflow.Usage {
  const delta = (field: keyof Workflow.Usage) => {
    const value = current[field] - checkpointed[field]
    if (value < 0) throw new RangeError(`Workflow usage regressed below its checkpoint for ${field}`)
    return value
  }
  return {
    tokens: delta("tokens"),
    turns: delta("turns"),
    toolCalls: delta("toolCalls"),
    attempts: delta("attempts"),
  }
}

export function addUsage(left: Workflow.Usage, right: Workflow.Usage): Workflow.Usage {
  return {
    tokens: left.tokens + right.tokens,
    turns: left.turns + right.turns,
    toolCalls: left.toolCalls + right.toolCalls,
    attempts: left.attempts + right.attempts,
  }
}

export function usageForDecision(
  decision: Decision,
  current: Workflow.Usage,
  checkpointed: Workflow.Usage,
): Workflow.Usage {
  return decision.type === "retry" || decision.type === "approval" ? usageDelta(current, checkpointed) : current
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
    message: workflowMessage(error),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  }
}

function workflowMessage(error: LLMError) {
  const message = WorkflowSecretGuard.sanitizeText(error.message)
  if (!("http" in error.reason) || error.reason.http?.body === undefined) return message
  const status = error.reason.http.response?.status
  if (status !== undefined) return `${error.module}.${error.method}: Provider request failed with HTTP ${status}`
  return `${error.module}.${error.method}: Provider request failed`
}

function isTransportTimeout(error: LLMError) {
  if (error.reason._tag !== "Transport") return false
  return (
    error.reason.kind?.toLowerCase().includes("timeout") === true || /timed?\s*out|timeout/i.test(error.reason.message)
  )
}
