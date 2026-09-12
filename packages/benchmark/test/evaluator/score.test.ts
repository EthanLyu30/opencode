import { describe, expect, test } from "bun:test"
import golden from "../fixtures/evaluator/golden-scores.json"
import { canonicalJson } from "../../src/campaign/canonical"
import { makeBlindedAuditPackage } from "../../src/evaluator/evidence"
import { evaluateScore } from "../../src/evaluator/score"
import { evidence } from "./helpers"

describe("Task24 diagnostic and qualified-success scoring", () => {
  test("reproduces golden exact, drift, failure, and tampering outcomes", () => {
    expect(score().diagnosticTotal).toBe(golden.exact.diagnosticTotal)
    expect(score().qualifiedSuccess).toBe(golden.exact.qualifiedSuccess)

    const spacing = score({ visualComposite: golden.spacingDrift.visualComposite })
    expect(spacing.diagnosticTotal).toBe(golden.spacingDrift.diagnosticTotal)
    expect(spacing.qualifiedSuccess).toBe(golden.spacingDrift.qualifiedSuccess)

    const palette = score({ visualComposite: golden.wrongPalette.visualComposite })
    expect(palette.diagnosticTotal).toBe(golden.wrongPalette.diagnosticTotal)
    expect(palette.qualifiedSuccess).toBe(golden.wrongPalette.qualifiedSuccess)

    const typography = score({ visualComposite: golden.typographyDrift.visualComposite })
    expect(typography.diagnosticTotal).toBe(golden.typographyDrift.diagnosticTotal)
    expect(typography.qualifiedSuccess).toBe(golden.typographyDrift.qualifiedSuccess)

    const mobile = score({
      visualComposite: golden.missingMobile.visualComposite,
      viewportScores: [100, 100, 60],
    })
    expect(mobile.diagnosticTotal).toBe(golden.missingMobile.diagnosticTotal)
    expect(mobile.qualifiedSuccess).toBe(golden.missingMobile.qualifiedSuccess)

    const interaction = score({ visualComposite: golden.brokenInteraction.visualComposite })
    expect(interaction.diagnosticTotal).toBe(golden.brokenInteraction.diagnosticTotal)
    expect(interaction.qualifiedSuccess).toBe(golden.brokenInteraction.qualifiedSuccess)

    const functional = score({ functionalPoints: 0, functionalMandatory: false })
    expect(functional.diagnosticTotal).toBe(golden.functionalFailure.diagnosticTotal)
    expect(functional.qualifiedSuccess).toBe(false)

    const accessibility = score({ accessibilityPoints: 0, accessibilityPassed: false })
    expect(accessibility.diagnosticTotal).toBe(golden.accessibilityFailure.diagnosticTotal)
    expect(accessibility.qualifiedSuccess).toBe(false)

    for (const policyCode of ["prompt-leakage", "evaluator-tampering", "build-script-substitution"] as const) {
      const result = score({ policyCode })
      expect(result.diagnosticTotal).toBe(0)
      expect(result.qualifiedSuccess).toBe(false)
    }
  })

  test("enforces overall and per-viewport visual gates independently of diagnostic score", () => {
    expect(score({ visualComposite: 74.999 }).disqualifications).toContain("VISUAL_COMPOSITE_BELOW_75")
    expect(score({ viewportScores: [100, 100, 64.999] }).disqualifications).toContain("VISUAL_VIEWPORT_BELOW_65")
  })

  test("binds every component to sorted evidence and serializes byte-identically", () => {
    const left = score()
    const right = score()
    expect(left.evidenceHashes).toEqual([...left.evidenceHashes].toSorted())
    expect(canonicalJson(left)).toBe(canonicalJson(right))
  })

  test("exports only 70–79 visual cases into a deterministic blinded audit package", () => {
    const result = makeBlindedAuditPackage(
      [
        {
          runID: "run-a",
          taskLabel: "dashboard",
          visualComposite: 69,
          referenceSha256: "a".repeat(64),
          candidateSha256: "b".repeat(64),
        },
        {
          runID: "run-b",
          taskLabel: "checkout",
          visualComposite: 75,
          referenceSha256: "c".repeat(64),
          candidateSha256: "d".repeat(64),
        },
        {
          runID: "run-c",
          taskLabel: "travel",
          visualComposite: 80,
          referenceSha256: "e".repeat(64),
          candidateSha256: "f".repeat(64),
        },
      ],
      "task24-sealed-seed",
    )
    expect(result.cases).toHaveLength(1)
    expect(result.cases[0]).not.toHaveProperty("runID")
    expect(result.cases[0]).not.toHaveProperty("armID")
    expect(result.cases[0]?.label).toMatch(/^case-[a-f0-9]{12}$/)
  })
})

function score(
  overrides: Partial<{
    visualComposite: number
    viewportScores: number[]
    functionalPoints: number
    functionalMandatory: boolean
    accessibilityPoints: number
    accessibilityPassed: boolean
    policyCode: "prompt-leakage" | "evaluator-tampering" | "build-script-substitution"
  }> = {},
) {
  const refs = [evidence("component", "a")]
  return evaluateScore({
    identity: {
      schemaVersion: 1,
      runID: "run-001",
      armID: "A",
      binarySha256: "1".repeat(64),
      evaluatorSha256: "2".repeat(64),
      taskSha256: "3".repeat(64),
      goldSha256: "4".repeat(64),
      evaluatedAt: "2026-09-12T00:00:00.000Z",
    },
    buildPassed: true,
    functional: {
      points: overrides.functionalPoints ?? 45,
      mandatoryPassed: overrides.functionalMandatory ?? true,
      failedMandatory: [],
      evidence: refs,
    },
    visual: {
      composite: overrides.visualComposite ?? 100,
      viewportScores: overrides.viewportScores ?? [100, 100, 100],
      points: (overrides.visualComposite ?? 100) * 0.3,
      evidence: refs,
    },
    requirements: { points: 10, mandatoryPassed: true, failedMandatory: [], evidence: refs },
    quality: { points: 10, evidence: refs },
    accessibility: {
      points: overrides.accessibilityPoints ?? 5,
      requiredPassed: overrides.accessibilityPassed ?? true,
      failures: [],
      evidence: refs,
    },
    policy: {
      qualified: overrides.policyCode === undefined,
      zeroDiagnosticScore: overrides.policyCode !== undefined,
      disqualifications: overrides.policyCode
        ? [`POLICY_${overrides.policyCode.toUpperCase().replaceAll("-", "_")}`]
        : [],
      evidence: refs,
    },
    ceilingsPassed: true,
    humanEdited: false,
  })
}
