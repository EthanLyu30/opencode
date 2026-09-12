import { describe, expect, test } from "bun:test"
import { assertNoCanaries, redactText, sanitizeUnknown } from "../../src/broker/redaction"

describe("Task24 broker redaction", () => {
  test("redacts keys, bearer grants, prompts, source, tool arguments, and response text", () => {
    const canaries = [
      "sk-FAKE_TASK24_PROVIDER_KEY_123456",
      "Bearer TASK24_BROKER_GRANT_123456789",
      "CANARY_PROMPT_SOURCE_CODE",
      "CANARY_TOOL_ARGUMENT",
      "CANARY_RESPONSE_TEXT",
    ]
    const sanitized = sanitizeUnknown({
      authorization: canaries[1],
      message: canaries.join(" | "),
      nested: [{ source: canaries[2] }, { tool: canaries[3] }, { output: canaries[4] }],
    })
    const text = JSON.stringify(sanitized)
    for (const canary of canaries) expect(text).not.toContain(canary)
    expect(() => assertNoCanaries([text], canaries)).not.toThrow()
    expect(() => assertNoCanaries(["leak CANARY_RESPONSE_TEXT"], canaries)).toThrow(/canary/i)
    expect(redactText(canaries.join(" "))).not.toContain("sk-FAKE")
  })
})
