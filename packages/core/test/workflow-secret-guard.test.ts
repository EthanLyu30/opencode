import { describe, expect, test } from "bun:test"
import { WorkflowSecretGuard } from "@opencode-ai/core/workflow/secret-guard"

describe("WorkflowSecretGuard", () => {
  test.each([
    [{ apiKey: "sk-test-secret" }, "apiKey"],
    [{ headers: { Authorization: "Bearer live-secret" } }, "Authorization"],
    [{ uri: "https://example.test/file?token=live-secret" }, "token"],
    [{ password: "s3cr3t" }, "password"],
    [{ secret: "s3cr3t" }, "secret"],
    [{ access_token: "s3cr3t" }, "access_token"],
    [{ refresh_token: "s3cr3t" }, "refresh_token"],
    [{ cookie: "session=abc" }, "cookie"],
    [{ "set-cookie": "session=abc" }, "set-cookie"],
  ])("rejects sensitive persisted input %#", (value, field) => {
    expect(() => WorkflowSecretGuard.assertSafe(value)).toThrow(field)
  })

  test("rejects sensitive query params in url fields", () => {
    expect(() => WorkflowSecretGuard.assertSafe({ endpoint: "https://api.test/v1?key=abc&signature=xyz" })).toThrow()
  })

  test("allows safe values", () => {
    expect(() =>
      WorkflowSecretGuard.assertSafe({ name: "test", count: 42, enabled: true, items: ["a", "b"] }),
    ).not.toThrow()
  })

  test("sanitizes failure text without retaining the secret", () => {
    const value = WorkflowSecretGuard.sanitizeText("request failed: Bearer live-secret and sk-test-secret")
    expect(value).toBe("request failed: Bearer [REDACTED] and [REDACTED]")
  })

  test("sanitizes api key in text", () => {
    expect(WorkflowSecretGuard.sanitizeText("key: sk-abc123def456")).toBe("key: [REDACTED]")
  })

  test("rejects every repeated direct secret without regular expression state leaking", () => {
    expect(() => WorkflowSecretGuard.assertSafe("Bearer repeated-secret")).toThrow()
    expect(() => WorkflowSecretGuard.assertSafe("Bearer repeated-secret")).toThrow()
  })

  test("rejects cycles with a typed persistence error at the repeated path", () => {
    const value: Record<string, unknown> = {}
    value.self = value

    try {
      WorkflowSecretGuard.assertSafe(value)
      throw new Error("expected unsafe persistence error")
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowSecretGuard.UnsafePersistenceError)
      if (!(error instanceof WorkflowSecretGuard.UnsafePersistenceError)) throw error
      expect(error.path).toBe("$.self")
    }
  })

  test.each([undefined, 1n, () => "not json"])("rejects non-json persisted input %#", (value) => {
    expect(() => WorkflowSecretGuard.assertSafe(value)).toThrow(WorkflowSecretGuard.UnsafePersistenceError)
  })
})
