import { evidenceHashes, validateEvidenceReferences, type EvidenceReference } from "./evidence"

const shaPattern = /^[a-f0-9]{64}$/

export interface EvaluationIdentity {
  readonly schemaVersion: 1
  readonly runID: string
  readonly armID: string
  readonly binarySha256: string
  readonly evaluatorSha256: string
  readonly taskSha256: string
  readonly goldSha256: string
  readonly evaluatedAt: string
}

interface ScoredComponent {
  readonly points: number
  readonly evidence: readonly EvidenceReference[]
}

interface MandatoryComponent extends ScoredComponent {
  readonly mandatoryPassed: boolean
  readonly failedMandatory: readonly string[]
}

export interface EvaluationResult {
  readonly schemaVersion: 1
  readonly identity: EvaluationIdentity
  readonly qualifiedSuccess: boolean
  readonly disqualifications: readonly string[]
  readonly functional: number
  readonly visual: number
  readonly requirements: number
  readonly quality: number
  readonly accessibilityResponsive: number
  readonly diagnosticTotal: number
  readonly visualComposite: number
  readonly viewportScores: readonly number[]
  readonly evidenceHashes: readonly string[]
}

export function evaluateScore(input: {
  readonly identity: EvaluationIdentity
  readonly buildPassed: boolean
  readonly functional: MandatoryComponent
  readonly visual: ScoredComponent & { readonly composite: number; readonly viewportScores: readonly number[] }
  readonly requirements: MandatoryComponent
  readonly quality: ScoredComponent
  readonly accessibility: ScoredComponent & { readonly requiredPassed: boolean; readonly failures: readonly string[] }
  readonly policy: {
    readonly qualified: boolean
    readonly zeroDiagnosticScore: boolean
    readonly disqualifications: readonly string[]
    readonly evidence: readonly EvidenceReference[]
  }
  readonly ceilingsPassed: boolean
  readonly humanEdited: boolean
}): EvaluationResult {
  validateIdentity(input.identity)
  checkPoints(input.functional.points, 45)
  checkPoints(input.visual.points, 30)
  checkPoints(input.requirements.points, 10)
  checkPoints(input.quality.points, 10)
  checkPoints(input.accessibility.points, 5)
  checkPoints(input.visual.composite, 100)
  if (Math.abs(round(input.visual.composite * 0.3) - input.visual.points) > 0.000001) {
    throw new TypeError("TASK24_VISUAL_POINTS_INVALID")
  }
  if (input.visual.viewportScores.length !== 3) throw new TypeError("TASK24_VISUAL_VIEWPORTS_INVALID")
  for (const score of input.visual.viewportScores) checkPoints(score, 100)
  for (const group of [
    input.functional.evidence,
    input.visual.evidence,
    input.requirements.evidence,
    input.quality.evidence,
    input.accessibility.evidence,
    input.policy.evidence,
  ]) {
    validateEvidenceReferences(group)
  }
  const disqualifications = new Set(input.policy.disqualifications)
  if (!input.buildPassed) disqualifications.add("BUILD_FAILED")
  if (!input.functional.mandatoryPassed) disqualifications.add("FUNCTIONAL_MANDATORY_FAILED")
  if (input.visual.composite < 75) disqualifications.add("VISUAL_COMPOSITE_BELOW_75")
  if (input.visual.viewportScores.some((value) => value < 65)) disqualifications.add("VISUAL_VIEWPORT_BELOW_65")
  if (!input.requirements.mandatoryPassed) disqualifications.add("REQUIREMENTS_MANDATORY_FAILED")
  if (!input.accessibility.requiredPassed) disqualifications.add("ACCESSIBILITY_REQUIRED_FAILED")
  if (!input.ceilingsPassed) disqualifications.add("CEILING_VIOLATION")
  if (input.humanEdited) disqualifications.add("HUMAN_EDIT")
  if (!input.policy.qualified && input.policy.disqualifications.length === 0) {
    throw new TypeError("TASK24_POLICY_RESULT_INVALID")
  }
  const subtotal = round(
    input.functional.points +
      input.visual.points +
      input.requirements.points +
      input.quality.points +
      input.accessibility.points,
  )
  return Object.freeze({
    schemaVersion: 1,
    identity: Object.freeze({ ...input.identity }),
    qualifiedSuccess: disqualifications.size === 0,
    disqualifications: Object.freeze([...disqualifications].toSorted()),
    functional: input.policy.zeroDiagnosticScore ? 0 : input.functional.points,
    visual: input.policy.zeroDiagnosticScore ? 0 : input.visual.points,
    requirements: input.policy.zeroDiagnosticScore ? 0 : input.requirements.points,
    quality: input.policy.zeroDiagnosticScore ? 0 : input.quality.points,
    accessibilityResponsive: input.policy.zeroDiagnosticScore ? 0 : input.accessibility.points,
    diagnosticTotal: input.policy.zeroDiagnosticScore ? 0 : subtotal,
    visualComposite: input.visual.composite,
    viewportScores: Object.freeze([...input.visual.viewportScores]),
    evidenceHashes: evidenceHashes([
      input.functional.evidence,
      input.visual.evidence,
      input.requirements.evidence,
      input.quality.evidence,
      input.accessibility.evidence,
      input.policy.evidence,
    ]),
  })
}

function validateIdentity(value: EvaluationIdentity): void {
  if (
    value.schemaVersion !== 1 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.runID) ||
    !/^[A-E]$/.test(value.armID) ||
    ![value.binarySha256, value.evaluatorSha256, value.taskSha256, value.goldSha256].every((item) =>
      shaPattern.test(item),
    ) ||
    new Date(value.evaluatedAt).toISOString() !== value.evaluatedAt
  ) {
    throw new TypeError("TASK24_EVALUATION_IDENTITY_INVALID")
  }
}

function checkPoints(value: number, maximum: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new TypeError("TASK24_EVALUATION_SCORE_INVALID")
  }
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
