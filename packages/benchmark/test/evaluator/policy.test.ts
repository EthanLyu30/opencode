import { describe, expect, test } from "bun:test"
import { evaluatePolicy } from "../../src/evaluator/policy"
import { evidence } from "./helpers"

describe("Task24 policy disqualification", () => {
  test.each([
    "hidden-gold-access",
    "external-network",
    "evaluator-tampering",
    "build-script-substitution",
    "prompt-leakage",
    "credential-probing",
    "fabricated-evidence",
  ] as const)("classifies %s as a hard score-zero violation", (code) => {
    const result = evaluatePolicy({ events: [{ code }], evidence: [evidence("policy")] })
    expect(result.qualified).toBe(false)
    expect(result.zeroDiagnosticScore).toBe(true)
    expect(result.disqualifications).toEqual([`POLICY_${code.toUpperCase().replaceAll("-", "_")}`])
  })

  test("makes a ceiling violation unqualified without rewriting diagnostic quality", () => {
    const result = evaluatePolicy({ events: [{ code: "token-ceiling" }], evidence: [evidence("policy")] })
    expect(result.qualified).toBe(false)
    expect(result.zeroDiagnosticScore).toBe(false)
  })

  test("rejects caller-invented policy categories", () => {
    expect(() => evaluatePolicy({ events: [{ code: "harmless" as never }], evidence: [evidence("policy")] })).toThrow(
      "TASK24_POLICY_EVENT_INVALID",
    )
  })
})
