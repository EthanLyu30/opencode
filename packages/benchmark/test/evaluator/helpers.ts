import type { EvidenceReference } from "../../src/evaluator/evidence"

export function evidence(kind: string, suffix = "1"): EvidenceReference {
  return Object.freeze({
    kind,
    relativePath: `${kind}.json`,
    sha256: suffix.padEnd(64, suffix).slice(0, 64),
    bytes: 1,
  })
}
