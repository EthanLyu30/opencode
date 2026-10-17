import { expect, test } from "bun:test"
import { scoreIndependentEvaluation } from "../../src/evaluator/independent/result"
import { evaluationFactsFixture } from "./fixture"
import { candidate } from "./fixture"
import { fixtureObservation } from "../../src/evaluator/independent/host"
test("fixed 75/65 thresholds, consistent aggregate and deterministic semantic identity",()=>{
  expect(scoreIndependentEvaluation(evaluationFactsFixture({viewportScores:[65,80,80]}))).toMatchObject({kind:"primary",qualifiedSuccess:true})
  for(const scores of [[74.999,74.999,74.999],[64.999,100,100]]) expect(scoreIndependentEvaluation(evaluationFactsFixture({viewportScores:scores}))).toMatchObject({qualifiedSuccess:false})
  const facts=evaluationFactsFixture()
  expect(scoreIndependentEvaluation(facts).semanticSha256).toBe(scoreIndependentEvaluation(facts).semanticSha256)
  const bad=structuredClone(facts)
  bad.visual!.result={...bad.visual!.result,composite:75}
  expect(()=>scoreIndependentEvaluation(bad)).toThrow()
  expect(()=>scoreIndependentEvaluation({...facts,visual:null})).toThrow()
  expect(()=>scoreIndependentEvaluation({...facts,assurance:"linux-attested"})).toThrow()
  expect(()=>scoreIndependentEvaluation({...facts,kind:"guardrail"})).toThrow()
})
test("healthy fixture host candidate failure is a measured task failure, not invented visual zero",()=>{
  const f=evaluationFactsFixture()
  const proof=fixtureObservation({identity:f.identity,candidate,profileSha256:f.identity.profileSha256,timeoutMs:30000},{kind:"candidate_failure",reason:"BUILD_EXIT_1"})
  const failure={...f,build:{status:"candidate_failure" as const,proof,evidence:f.build.evidence},functional:null,visual:null}
  expect(scoreIndependentEvaluation(failure)).toMatchObject({kind:"primary",measurementStatus:"candidate_failure",qualifiedSuccess:false,visual:null,diagnosticTotal:null,unmeasuredReason:"not_run_due_to_candidate_failure"})
  expect(()=>scoreIndependentEvaluation({...failure,build:{...failure.build,proof:{...proof}}})).toThrow()
})
test("guardrail has no invented visual scores or qualifiedSuccess; unavailable checks retain penalty",()=>{
  const f=evaluationFactsFixture({kind:"guardrail"})
  const result=scoreIndependentEvaluation(f)
  expect(result).toMatchObject({kind:"guardrail",functionalQualified:true,visual:null,visualComposite:null,viewportScores:null,diagnosticTotal:null})
  expect(result).not.toHaveProperty("qualifiedSuccess")
  const unavailable={...f,quality:{...f.quality,checks:f.quality.checks.map(c=>({...c,status:"not_available" as const}))}}
  expect(scoreIndependentEvaluation(unavailable).quality).toBe(0)
})
