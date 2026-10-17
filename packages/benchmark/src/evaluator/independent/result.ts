import { canonicalJson } from "../../campaign/canonical"
import { decodeEvaluationIdentity, freeze, type EvaluationIdentityV2 } from "../../corpus/evaluation-profile"
import { sha256Text } from "../../hash"
import { scoreFunctionalAssertions } from "../functional"
import { evidenceHashes, validateEvidenceReferences, type EvidenceReference } from "../evidence"
import { evaluatePolicy } from "../policy"
import { scoreQuality, type QualityCheckID } from "../quality"
import { scoreRequirements } from "../requirements"
import { evaluateScore } from "../score"
import { aggregateVisualViewports, composeVisualScore } from "../visual"
import type { FunctionalFacts } from "./functional"
import { requireFixtureObservation, type BuildManifest, type BuildObservation } from "./host"
import type { VisualFacts } from "./visual"

export type EvaluationFacts = Readonly<{
  kind: "primary" | "guardrail"
  identity: EvaluationIdentityV2
  assurance: "fixture" | "linux-attested"
  source: { candidateSha256: string; configSha256: string }
  build:
    | { status: "passed"; manifest: BuildManifest; evidence: readonly EvidenceReference[] }
    | { status: "candidate_failure"; proof: BuildObservation; evidence: readonly EvidenceReference[] }
  functional: FunctionalFacts | null
  visual: VisualFacts | null
  requirements: Parameters<typeof scoreRequirements>[0]
  quality: {
    checks: readonly { id: QualityCheckID; status: "passed" | "failed" | "not_available" }[]
    evidence: readonly EvidenceReference[]
  }
  policy: Parameters<typeof evaluatePolicy>[0]
  runtime: { ceilingsPassed: boolean; humanEdited: boolean; evidence: readonly EvidenceReference[] }
}>
type CommonResult = Readonly<{
  schemaVersion: 2
  identity: EvaluationIdentityV2
  assurance: "fixture"
  semanticSha256: string
  evidenceHashes: readonly string[]
  evidence: readonly EvidenceReference[]
  functional: number | null
  requirements: number
  quality: number
  qualityChecks: EvaluationFacts["quality"]["checks"]
  disqualifications: readonly string[]
}>
type Primary = CommonResult &
  Readonly<{
    kind: "primary"
    measurementStatus: "complete" | "candidate_failure"
    qualifiedSuccess: boolean
    visual: number | null
    visualComposite: number | null
    viewportScores: readonly number[] | null
    diagnosticTotal: number | null
    accessibilityResponsive: number | null
    unmeasuredReason: string | null
  }>
type Guardrail = CommonResult &
  Readonly<{
    kind: "guardrail"
    functionalQualified: boolean
    visual: null
    visualComposite: null
    viewportScores: null
    diagnosticTotal: null
  }>
export type IndependentResult = Primary | Guardrail
const issuedResults = new WeakSet<object>()
export function requireIndependentResult(result: IndependentResult): void {
  if (!issuedResults.has(result)) throw new TypeError("TASK24_RESULT_UNVALIDATED")
}
export function scoreIndependentEvaluation(facts: EvaluationFacts): IndependentResult {
  const identity = decodeEvaluationIdentity(facts.identity)
  if (
    !["primary", "guardrail"].includes(facts.kind) ||
    facts.assurance !== "fixture" ||
    facts.source.candidateSha256 !== identity.candidateSha256 ||
    typeof facts.runtime.ceilingsPassed !== "boolean" ||
    typeof facts.runtime.humanEdited !== "boolean"
  )
    throw new TypeError("TASK24_FACTS_INVALID")
  const requirements = scoreRequirements(facts.requirements),
    quality = scoreQuality({
      checks: facts.quality.checks.map((c) => {
        if (!["passed", "failed", "not_available"].includes(c.status))
          throw new TypeError("TASK24_QUALITY_STATUS_INVALID")
        return { id: c.id, passed: c.status === "passed" }
      }),
      evidence: facts.quality.evidence,
    }),
    policy = evaluatePolicy(facts.policy)
  const refs = new Map<string, EvidenceReference>()
  for (const group of [
    facts.build.evidence,
    facts.runtime.evidence,
    requirements.evidence,
    quality.evidence,
    policy.evidence,
    ...(facts.functional ? [facts.functional.evidence] : []),
    ...(facts.visual ? [facts.visual.evidence] : []),
  ])
    for (const ref of validateEvidenceReferences(group)) {
      const key = ref.relativePath
      const old = refs.get(key)
      if (old && old.sha256 !== ref.sha256) throw new TypeError("TASK24_EVIDENCE_CONFLICT")
      refs.set(key, ref)
    }
  const evidence = [...refs.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const common = {
    schemaVersion: 2 as const,
    identity,
    assurance: "fixture" as const,
    evidenceHashes: evidenceHashes([evidence]),
    evidence,
    requirements: requirements.points,
    quality: quality.points,
    qualityChecks: facts.quality.checks,
    disqualifications: policy.disqualifications,
  }
  let body: Omit<Primary, "semanticSha256"> | Omit<Guardrail, "semanticSha256">
  if (facts.build.status === "candidate_failure") {
    const proof = facts.build.proof
    requireFixtureObservation(proof)
    if (
      proof.kind !== "candidate_failure" ||
      canonicalJson(proof.identity) !== canonicalJson(identity) ||
      proof.candidate.configSha256 !== facts.source.configSha256 ||
      facts.visual !== null ||
      facts.functional !== null
    )
      throw new TypeError("TASK24_CANDIDATE_FAILURE_PROOF_INVALID")
    if (facts.kind === "guardrail")
      body = {
        ...common,
        kind: "guardrail",
        functional: null,
        functionalQualified: false,
        visual: null,
        visualComposite: null,
        viewportScores: null,
        diagnosticTotal: null,
        disqualifications: [...policy.disqualifications, "BUILD_FAILED"],
      }
    else
      body = {
        ...common,
        kind: "primary",
        measurementStatus: "candidate_failure",
        functional: null,
        qualifiedSuccess: false,
        visual: null,
        visualComposite: null,
        viewportScores: null,
        diagnosticTotal: policy.zeroDiagnosticScore ? 0 : null,
        accessibilityResponsive: null,
        unmeasuredReason: "not_run_due_to_candidate_failure",
        disqualifications: [...policy.disqualifications, "BUILD_FAILED"],
      }
  } else {
    if (
      facts.build.manifest.candidateSha256 !== identity.candidateSha256 ||
      facts.build.manifest.configSha256 !== facts.source.configSha256 ||
      !facts.functional ||
      facts.functional.executedAssertions !== facts.functional.assertions.length ||
      !facts.functional.executedAssertions
    )
      throw new TypeError("TASK24_FACTS_BINDING_INVALID")
    const functional = scoreFunctionalAssertions({
      assertions: facts.functional.assertions,
      evidence: facts.functional.evidence,
    })
    if (
      functional.points !== facts.functional.points ||
      functional.mandatoryPassed !== facts.functional.mandatoryPassed
    )
      throw new TypeError("TASK24_FUNCTIONAL_FACTS_INVALID")
    if (facts.kind === "guardrail") {
      if (facts.visual !== null) throw new TypeError("TASK24_GUARDRAIL_VISUAL_INVALID")
      body = {
        ...common,
        kind: "guardrail",
        functional: policy.zeroDiagnosticScore ? 0 : functional.points,
        functionalQualified:
          functional.mandatoryPassed &&
          requirements.mandatoryPassed &&
          policy.qualified &&
          facts.runtime.ceilingsPassed &&
          !facts.runtime.humanEdited,
        visual: null,
        visualComposite: null,
        viewportScores: null,
        diagnosticTotal: null,
      }
    } else {
      const v = facts.visual
      if (
        !v ||
        canonicalJson(v.identity) !== canonicalJson(identity) ||
        v.buildSha256 !== facts.build.manifest.buildSha256 ||
        v.captures.join(",") !== "mobile,tablet,desktop"
      )
        throw new TypeError("TASK24_VISUAL_FACTS_INVALID")
      for (const view of v.result.viewports)
        if (
          Object.keys(view.components).sort().join(",") !==
            "domGeometry,pixelColor,responsiveInteraction,ssim,typographyStyle" ||
          composeVisualScore(view.components) !== view.composite ||
          Math.abs(view.points - view.composite * 0.3) > 0.000001
        )
          throw new TypeError("TASK24_VISUAL_COMPONENTS_INVALID")
      if (canonicalJson(aggregateVisualViewports(v.result.viewports)) !== canonicalJson(v.result))
        throw new TypeError("TASK24_VISUAL_AGGREGATE_INVALID")
      const score = evaluateScore({
        identity: {
          schemaVersion: 1,
          runID: identity.runID,
          armID: identity.armID,
          binarySha256: identity.binarySha256,
          evaluatorSha256: identity.evaluatorSha256,
          taskSha256: identity.profileSha256,
          goldSha256: identity.oracleSha256,
          evaluatedAt: "2026-10-17T00:00:00.000Z",
        },
        buildPassed: true,
        functional,
        visual: v.result,
        requirements,
        quality,
        accessibility: v.accessibility,
        policy,
        ceilingsPassed: facts.runtime.ceilingsPassed,
        humanEdited: facts.runtime.humanEdited,
      })
      body = {
        ...common,
        kind: "primary",
        measurementStatus: "complete",
        qualifiedSuccess: score.qualifiedSuccess,
        functional: score.functional,
        visual: score.visual,
        requirements: score.requirements,
        quality: score.quality,
        accessibilityResponsive: score.accessibilityResponsive,
        diagnosticTotal: score.diagnosticTotal,
        visualComposite: score.visualComposite,
        viewportScores: score.viewportScores,
        disqualifications: score.disqualifications,
        unmeasuredReason: null,
      }
    }
  }
  const result = freeze({ ...body, semanticSha256: sha256Text(canonicalJson(body)) })
  issuedResults.add(result)
  return result
}
