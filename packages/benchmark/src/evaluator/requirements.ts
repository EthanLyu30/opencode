import { validateEvidenceReferences, type EvidenceReference } from "./evidence"

export interface RequirementResult {
  readonly points: number
  readonly mandatoryPassed: boolean
  readonly failedMandatory: readonly string[]
  readonly evidence: readonly EvidenceReference[]
}

interface WeightedCheck {
  readonly id: string
  readonly mandatory: boolean
  readonly weight: number
}

interface RequirementAssertion extends WeightedCheck {
  readonly passed: boolean
}

interface ArtifactAssertion extends WeightedCheck {
  readonly present: boolean
}

export function scoreRequirements(input: {
  readonly assertions: readonly RequirementAssertion[]
  readonly artifacts: readonly ArtifactAssertion[]
  readonly evidence: readonly EvidenceReference[]
}): RequirementResult {
  if (input.assertions.length + input.artifacts.length === 0) {
    throw new TypeError("TASK24_REQUIREMENTS_EMPTY")
  }
  const identities = new Set<string>()
  const checks = [
    ...input.assertions.map((item) => ({ ...validate(item, "requirement", identities), passed: item.passed })),
    ...input.artifacts.map((item) => ({ ...validate(item, "artifact", identities), passed: item.present })),
  ]
  if (checks.some((item) => typeof item.passed !== "boolean")) throw new TypeError("TASK24_REQUIREMENT_INVALID")
  const total = checks.reduce((sum, item) => sum + item.weight, 0)
  const earned = checks.reduce((sum, item) => sum + (item.passed ? item.weight : 0), 0)
  const failedMandatory = checks.filter((item) => item.mandatory && !item.passed).map((item) => item.identity)
  return Object.freeze({
    points: round((earned / total) * 10),
    mandatoryPassed: failedMandatory.length === 0,
    failedMandatory: Object.freeze(failedMandatory),
    evidence: validateEvidenceReferences(input.evidence),
  })
}

function validate(value: WeightedCheck, kind: "requirement" | "artifact", identities: Set<string>) {
  const identity = kind === "artifact" ? `artifact:${value.id}` : value.id
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.id) ||
    typeof value.mandatory !== "boolean" ||
    !Number.isFinite(value.weight) ||
    value.weight <= 0 ||
    identities.has(identity)
  ) {
    throw new TypeError("TASK24_REQUIREMENT_INVALID")
  }
  identities.add(identity)
  return { identity, mandatory: value.mandatory, weight: value.weight }
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
