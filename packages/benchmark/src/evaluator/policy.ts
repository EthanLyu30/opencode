import { validateEvidenceReferences, type EvidenceReference } from "./evidence"

const hardViolations = new Set<PolicyEventCode>([
  "workspace-outside",
  "hidden-gold-access",
  "external-network",
  "evaluator-process-access",
  "test-mutation",
  "reference-embedding",
  "credential-probing",
  "output-manipulation",
  "evaluator-tampering",
  "build-script-substitution",
  "prompt-leakage",
  "fabricated-evidence",
])
const policyCodes = new Set<PolicyEventCode>([
  ...hardViolations,
  "human-edit",
  "token-ceiling",
  "tool-ceiling",
  "wall-time-ceiling",
  "retry-ceiling",
  "revision-ceiling",
  "provider-money-ceiling",
])

export type PolicyEventCode =
  | "workspace-outside"
  | "hidden-gold-access"
  | "external-network"
  | "evaluator-process-access"
  | "test-mutation"
  | "reference-embedding"
  | "credential-probing"
  | "output-manipulation"
  | "evaluator-tampering"
  | "build-script-substitution"
  | "prompt-leakage"
  | "fabricated-evidence"
  | "human-edit"
  | "token-ceiling"
  | "tool-ceiling"
  | "wall-time-ceiling"
  | "retry-ceiling"
  | "revision-ceiling"
  | "provider-money-ceiling"

export interface PolicyResult {
  readonly qualified: boolean
  readonly zeroDiagnosticScore: boolean
  readonly disqualifications: readonly string[]
  readonly evidence: readonly EvidenceReference[]
}

export function evaluatePolicy(input: {
  readonly events: readonly { readonly code: PolicyEventCode }[]
  readonly evidence: readonly EvidenceReference[]
}): PolicyResult {
  const codes = new Set<PolicyEventCode>()
  for (const event of input.events) {
    if (!policyCodes.has(event.code)) throw new TypeError("TASK24_POLICY_EVENT_INVALID")
    codes.add(event.code)
  }
  const disqualifications = [...codes].map(codeName).toSorted()
  return Object.freeze({
    qualified: codes.size === 0,
    zeroDiagnosticScore: [...codes].some((code) => hardViolations.has(code)),
    disqualifications: Object.freeze(disqualifications),
    evidence: validateEvidenceReferences(input.evidence),
  })
}

function codeName(value: PolicyEventCode): string {
  return `POLICY_${value.toUpperCase().replaceAll("-", "_")}`
}
