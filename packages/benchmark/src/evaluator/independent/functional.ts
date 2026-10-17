import { isDeepStrictEqual } from "node:util"
import { canonicalJson } from "../../campaign/canonical"
import { freeze, type EvaluationOracle } from "../../corpus/evaluation-profile"
import { scoreFunctionalAssertions, type FunctionalAssertion } from "../functional"
import { type EvidenceReference } from "../evidence"
import { decodeProbeResponse } from "./probe"

export type FunctionalFacts = Readonly<{
  assertions: readonly FunctionalAssertion[]
  executedAssertions: number
  mandatoryPassed: boolean
  points: number
  evidence: readonly EvidenceReference[]
}>
export function evaluateFunctional(input: {
  oracle: EvaluationOracle
  observation: unknown
  evidence: readonly EvidenceReference[]
}): FunctionalFacts {
  const response = decodeProbeResponse(Buffer.from(canonicalJson(input.observation)))
  if (response.cases.length !== input.oracle.cases.length) throw new TypeError("TASK24_PROBE_COVERAGE_INVALID")
  const assertions = input.oracle.cases.map((c, index) => {
    const actual = response.cases[index]
    if (!actual || actual.id !== c.id || actual.outputs.length !== c.expected.length)
      throw new TypeError("TASK24_PROBE_COVERAGE_INVALID")
    const passed = c.expected.every((e, i) => {
      const a = actual.outputs[i]!
      if (e.comparator === "throws") return a.kind === "throw" && a.message === e.message
      if (a.kind !== "value") return false
      if (e.comparator === "number") return typeof a.value === "number" && Math.abs(a.value - e.value) <= e.tolerance
      return e.comparator === "equal" ? Object.is(a.value, e.value) : isDeepStrictEqual(a.value, e.value)
    })
    return { id: c.id, mandatory: c.mandatory, weight: c.weight, passed }
  })
  const result = scoreFunctionalAssertions({ assertions, evidence: input.evidence })
  return freeze({
    assertions,
    executedAssertions: assertions.length,
    mandatoryPassed: result.mandatoryPassed,
    points: result.points,
    evidence: result.evidence,
  })
}
