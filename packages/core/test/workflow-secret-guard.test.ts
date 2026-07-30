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
    expect(() =>
      WorkflowSecretGuard.assertSafe({ endpoint: "https://api.test/v1?key=abc&signature=xyz" }),
    ).toThrow()
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
})
