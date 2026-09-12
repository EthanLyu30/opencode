import { validateEvidenceReferences, type EvidenceReference } from "./evidence"

const fixedChecks = Object.freeze(["typecheck", "lint", "structure", "dependency-policy"] as const)
export type QualityCheckID = (typeof fixedChecks)[number]

export interface QualityResult {
  readonly points: number
  readonly failedChecks: readonly QualityCheckID[]
  readonly evidence: readonly EvidenceReference[]
}

export function scoreQuality(input: {
  readonly checks: readonly { readonly id: QualityCheckID; readonly passed: boolean }[]
  readonly evidence: readonly EvidenceReference[]
}): QualityResult {
  if (input.checks.length !== fixedChecks.length) throw new TypeError("TASK24_QUALITY_CHECKS_INVALID")
  const checks = new Map<QualityCheckID, boolean>()
  for (const check of input.checks) {
    if (!fixedChecks.includes(check.id) || typeof check.passed !== "boolean" || checks.has(check.id)) {
      throw new TypeError("TASK24_QUALITY_CHECKS_INVALID")
    }
    checks.set(check.id, check.passed)
  }
  const failedChecks = fixedChecks.filter((id) => !checks.get(id))
  return Object.freeze({
    points: ((fixedChecks.length - failedChecks.length) / fixedChecks.length) * 10,
    failedChecks: Object.freeze(failedChecks),
    evidence: validateEvidenceReferences(input.evidence),
  })
}
