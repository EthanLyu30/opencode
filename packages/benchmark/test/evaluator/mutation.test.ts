import { describe, expect, test } from "bun:test"
import { scoreFunctionalAssertions } from "../../src/evaluator/functional"
import { evaluatePolicy } from "../../src/evaluator/policy"
import { composeVisualScore } from "../../src/evaluator/visual"
import { evidence } from "./helpers"

describe("Task24 single-variable evaluator mutations", () => {
  test("one geometry mutation changes only its sealed visual contribution", () => {
    const exact = composeVisualScore({
      ssim: 100,
      pixelColor: 100,
      domGeometry: 100,
      typographyStyle: 100,
      responsiveInteraction: 100,
    })
    const mutated = composeVisualScore({
      ssim: 100,
      pixelColor: 100,
      domGeometry: 75,
      typographyStyle: 100,
      responsiveInteraction: 100,
    })
    expect(exact - mutated).toBe(6.25)
  })

  test("one mandatory function mutation changes score and qualification", () => {
    const exact = scoreFunctionalAssertions({
      assertions: [{ id: "checkout", mandatory: true, passed: true, weight: 1 }],
      evidence: [evidence("function-mutation")],
    })
    const mutated = scoreFunctionalAssertions({
      assertions: [{ id: "checkout", mandatory: true, passed: false, weight: 1 }],
      evidence: [evidence("function-mutation")],
    })
    expect(exact).toMatchObject({ points: 45, mandatoryPassed: true })
    expect(mutated).toMatchObject({ points: 0, mandatoryPassed: false })
  })

  test("one policy mutation produces the preregistered hard disqualification", () => {
    const exact = evaluatePolicy({ events: [], evidence: [evidence("policy-mutation")] })
    const mutated = evaluatePolicy({
      events: [{ code: "evaluator-tampering" }],
      evidence: [evidence("policy-mutation")],
    })
    expect(exact).toMatchObject({ qualified: true, zeroDiagnosticScore: false })
    expect(mutated).toMatchObject({ qualified: false, zeroDiagnosticScore: true })
  })
})
