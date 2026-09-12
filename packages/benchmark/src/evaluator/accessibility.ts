import { validateEvidenceReferences, type EvidenceReference } from "./evidence"

type Impact = "minor" | "moderate" | "serious" | "critical" | null

export interface AccessibilityResult {
  readonly points: number
  readonly requiredPassed: boolean
  readonly failures: readonly string[]
  readonly evidence: readonly EvidenceReference[]
}

export function scoreAccessibility(input: {
  readonly axeViolations: readonly { readonly id: string; readonly impact: Impact }[]
  readonly keyboardCheckpoints: readonly { readonly id: string; readonly required: boolean; readonly passed: boolean }[]
  readonly responsiveCheckpoints: readonly {
    readonly id: string
    readonly required: boolean
    readonly passed: boolean
  }[]
  readonly overflowPassed: boolean
  readonly clippingPassed: boolean
  readonly evidence: readonly EvidenceReference[]
}): AccessibilityResult {
  const failures: string[] = []
  let serious = false
  for (const violation of input.axeViolations) {
    checkID(violation.id)
    if (!["minor", "moderate", "serious", "critical", null].includes(violation.impact)) {
      throw new TypeError("TASK24_ACCESSIBILITY_INPUT_INVALID")
    }
    if (violation.impact === "serious" || violation.impact === "critical") {
      serious = true
      failures.push(`axe:${violation.id}`)
    }
  }
  const keyboardRatio = checkpointRatio(input.keyboardCheckpoints, "keyboard", failures)
  const responsiveRatio = checkpointRatio(input.responsiveCheckpoints, "responsive", failures)
  if (typeof input.overflowPassed !== "boolean" || typeof input.clippingPassed !== "boolean") {
    throw new TypeError("TASK24_ACCESSIBILITY_INPUT_INVALID")
  }
  if (!input.overflowPassed) failures.push("overflow")
  if (!input.clippingPassed) failures.push("clipping")
  const points = round(
    (serious ? 0 : 1) +
      keyboardRatio +
      responsiveRatio +
      (input.overflowPassed ? 1 : 0) +
      (input.clippingPassed ? 1 : 0),
  )
  return Object.freeze({
    points,
    requiredPassed: failures.length === 0,
    failures: Object.freeze(failures),
    evidence: validateEvidenceReferences(input.evidence),
  })
}

function checkpointRatio(
  values: readonly { readonly id: string; readonly required: boolean; readonly passed: boolean }[],
  kind: "keyboard" | "responsive",
  failures: string[],
): number {
  if (values.length === 0) throw new TypeError("TASK24_ACCESSIBILITY_INPUT_INVALID")
  const ids = new Set<string>()
  let passed = 0
  for (const value of values) {
    checkID(value.id)
    if (ids.has(value.id) || typeof value.required !== "boolean" || typeof value.passed !== "boolean") {
      throw new TypeError("TASK24_ACCESSIBILITY_INPUT_INVALID")
    }
    ids.add(value.id)
    if (value.passed) passed++
    else if (value.required) failures.push(`${kind}:${value.id}`)
  }
  return passed / values.length
}

function checkID(value: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new TypeError("TASK24_ACCESSIBILITY_INPUT_INVALID")
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
