import { expect, test } from "bun:test"
import { evaluateFunctional } from "../../src/evaluator/independent/functional"
import { decodeEvaluationOracle } from "../../src/corpus/evaluation-profile"
import { evidenceReferenceForBytes } from "../../src/evaluator/evidence"
import { independentFixture } from "./fixture"
const evidence = [evidenceReferenceForBytes("probe","probe.json",Buffer.from("fixture response"))]
test("controller compares values, not candidate pass claims; exact case coverage", async () => {
  const f = await independentFixture("functional")
  try {
    const oracle = decodeEvaluationOracle(f.oracle)
    for (const [value,passed] of [[5,true],[6,false],[2+3,true]] as const) {
      const facts = evaluateFunctional({oracle,observation:{cases:[{id:"sum",outputs:[{kind:"value",value}]}]},evidence})
      expect(facts.mandatoryPassed).toBe(passed)
      expect(facts.executedAssertions).toBe(1)
      expect(JSON.stringify(facts)).not.toContain("expected")
    }
    for (const cases of [[],[{id:"sum",outputs:[]}],[{id:"other",outputs:[{kind:"value",value:5}]}],[{id:"sum",outputs:[{kind:"value",value:5}]},{id:"extra",outputs:[{kind:"value",value:5}]}]]) expect(()=>evaluateFunctional({oracle,observation:{cases},evidence})).toThrow()
  } finally { await f.dispose() }
})
test("ordered method/get observations compare state, throws, tolerance and defensive copy", async () => {
  const f = await independentFixture("state")
  try {
    const operations = [{kind:"method",target:"store.set",args:["a",1]},{kind:"get",target:"store.value",args:[]},{kind:"method",target:"store.bad",args:[]},{kind:"call",target:"fraction",args:[]}]
    const oracle = decodeEvaluationOracle({...f.oracle,cases:[{...f.oracle.cases[0],operations,expected:[{comparator:"deep-equal",value:{a:1}},{comparator:"deep-equal",value:{a:1}},{comparator:"throws",message:"invalid"},{comparator:"number",value:0.3,tolerance:0.00001}]}]})
    const cases = [{id:"sum",outputs:[{kind:"value",value:{a:1}},{kind:"value",value:{a:1}},{kind:"throw",message:"invalid"},{kind:"value",value:0.1+0.2}]}]
    expect(evaluateFunctional({oracle,observation:{cases},evidence}).mandatoryPassed).toBe(true)
    cases[0]!.outputs[0] = {kind:"value",value:{a:2}}
    expect(evaluateFunctional({oracle,observation:{cases},evidence}).mandatoryPassed).toBe(false)
  } finally { await f.dispose() }
})
