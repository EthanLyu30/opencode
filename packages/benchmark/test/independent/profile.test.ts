import { expect, test } from "bun:test"
import { decodeTaskExecutionProfile, decodeEvaluationOracle, decodeEvaluationIdentity } from "../../src/corpus/evaluation-profile"
import { independentFixture } from "./fixture"

test("rejects_excess_properties_and_kind_mismatch", async () => {
  const f = await independentFixture("profile")
  try {
    expect(() => decodeTaskExecutionProfile({ ...f.profile, provider: "kimi" })).toThrow()
    expect(() => decodeTaskExecutionProfile({ ...f.profile, key: "secret" })).toThrow()
    expect(() => decodeTaskExecutionProfile({ ...f.profile, schemaVersion: 3 })).toThrow()
    expect(() => decodeTaskExecutionProfile({ ...f.profile, kind: "primary" })).toThrow()
    expect(() => decodeEvaluationOracle({ ...f.oracle, visual: {} })).toThrow()
    expect(() => decodeEvaluationOracle({ ...f.oracle, cases: [{ ...f.oracle.cases[0], expected: [{ comparator: "eval", value: "return true" }] }] })).toThrow()
    expect(Object.isFrozen(decodeTaskExecutionProfile(f.profile).publicInputs)).toBe(true)
    expect(() => decodeEvaluationIdentity({ schemaVersion: 2 })).toThrow()
  } finally { await f.dispose() }
})

test("rejects unsafe and ambiguous paths and nonfinite oracle values", async () => {
  const f = await independentFixture("paths")
  try {
    for (const sourceEntry of ["../escape", "C:/secret", "src/CON.js", "src/a.", "src/a ", "src/a:ads"]) {
      expect(() => decodeTaskExecutionProfile({ ...f.profile, sourceEntry })).toThrow()
    }
    expect(() => decodeEvaluationOracle({ ...f.oracle, cases: [{ ...f.oracle.cases[0], expected: [{ comparator: "number", value: 1, tolerance: Infinity }] }] })).toThrow()
    expect(() => decodeEvaluationOracle({ ...f.oracle, cases: [f.oracle.cases[0], f.oracle.cases[0]] })).toThrow()
  } finally { await f.dispose() }
})
