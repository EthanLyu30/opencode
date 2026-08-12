import { describe, expect, test } from "bun:test"
import {
  HttpContext,
  HttpRequestDetails,
  HttpResponseDetails,
  LLMError,
  InvalidRequestReason,
  RateLimitReason,
  TransportReason,
} from "@opencode-ai/llm"
import { WorkflowRetry } from "../src/workflow/retry"

describe("WorkflowRetry", () => {
  test.each([
    [{ category: "transient", code: "http_503", message: "busy" }, 1, 3, "retry"],
    [{ category: "transient", code: "http_503", message: "busy" }, 3, 3, "fail"],
    [{ category: "authentication", code: "invalid_key", message: "bad key" }, 1, 3, "fail"],
    [{ category: "quota", code: "quota", message: "quota" }, 1, 3, "fail"],
    [{ category: "ambiguous", code: "lost", message: "unknown result" }, 1, 3, "approval"],
  ] as const)("classifies %#", (failure, attempt, maxAttempts, expected) => {
    expect(WorkflowRetry.decide({ failure, attempt, maxAttempts, now: 1_000, randomUnit: 0.5 }).type).toBe(expected)
  })

  test("honors capped retry-after timing", () => {
    expect(
      WorkflowRetry.decide({
        failure: { category: "transient", code: "rate_limit", message: "wait", retryAfterMs: 7_500 },
        attempt: 1,
        maxAttempts: 3,
        now: 1_000,
        randomUnit: 0,
      }),
    ).toEqual({ type: "retry", notBefore: 8_500 })
  })

  test("settles only post-checkpoint usage for retry and approval decisions", () => {
    const checkpointed = { tokens: 6, turns: 1, toolCalls: 1, attempts: 0 }
    const current = { tokens: 11, turns: 2, toolCalls: 1, attempts: 0 }
    const delta = { tokens: 5, turns: 1, toolCalls: 0, attempts: 0 }

    expect(WorkflowRetry.usageForDecision({ type: "retry", notBefore: 1_000 }, current, checkpointed)).toEqual(delta)
    expect(WorkflowRetry.usageForDecision({ type: "approval" }, current, checkpointed)).toEqual(delta)
    expect(WorkflowRetry.usageForDecision({ type: "fail" }, current, checkpointed)).toEqual(current)
    expect(() => WorkflowRetry.usageDelta(checkpointed, current)).toThrow(
      "Workflow usage regressed below its checkpoint",
    )
  })

  test("uses bounded exponential jitter", () => {
    expect(
      WorkflowRetry.decide({
        failure: { category: "transient", code: "transport", message: "offline" },
        attempt: 2,
        maxAttempts: 3,
        now: 1_000,
        randomUnit: 2,
      }),
    ).toEqual({ type: "retry", notBefore: 3_400 })
  })

  test("adapts LLM errors without persisting raw HTTP diagnostics or secrets", () => {
    const failure = WorkflowRetry.fromLLMError(
      new LLMError({
        module: "route",
        method: "stream",
        reason: new RateLimitReason({
          message: "Bearer live-secret-token must wait",
          retryAfterMs: 7_500,
          http: new HttpContext({
            request: new HttpRequestDetails({
              method: "POST",
              url: "https://example.test",
              headers: { authorization: "Bearer live-secret-token" },
            }),
          }),
        }),
      }),
    )

    expect(failure).toEqual({
      category: "transient",
      code: "rate_limit",
      message: "route.stream: Bearer [REDACTED] must wait",
      retryAfterMs: 7_500,
    })
    expect(JSON.stringify(failure)).not.toContain("authorization")
    expect(JSON.stringify(failure)).not.toContain("live-secret")
  })

  test("treats transport timeouts as transient", () => {
    expect(
      WorkflowRetry.fromLLMError(
        new LLMError({
          module: "route",
          method: "stream",
          reason: new TransportReason({ message: "timed out", kind: "timeout" }),
        }),
      ),
    ).toMatchObject({ category: "transient", code: "transport_timeout" })
  })

  test("retains HTTP status diagnostics but drops provider response bodies at the workflow boundary", () => {
    const sentinel = "TASK20_PROVIDER_BODY_SENTINEL_DO_NOT_STORE"
    const failure = WorkflowRetry.fromLLMError(
      new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: new InvalidRequestReason({
          message: `Provider request failed with HTTP 400: {"error":{"message":"${sentinel}"}}`,
          http: new HttpContext({
            request: new HttpRequestDetails({
              method: "POST",
              url: "https://api.deepseek.test/responses",
              headers: {},
            }),
            response: new HttpResponseDetails({ status: 400, headers: {} }),
            body: `{"error":{"message":"${sentinel}"}}`,
          }),
        }),
      }),
    )

    expect(failure).toEqual({
      category: "invalid_request",
      code: "invalid_request",
      message: "RequestExecutor.execute: Provider request failed with HTTP 400",
    })
    expect(JSON.stringify(failure)).not.toContain(sentinel)
  })
})
