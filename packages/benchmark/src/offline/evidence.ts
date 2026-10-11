import fs from "node:fs"
import path from "node:path"
import { evidenceReference, validateEvidenceReferences, verifyEvidenceFile } from "../evaluator/evidence"
import { canonicalJson } from "../campaign/canonical"

export async function workspaceDirectoryExists(root: string): Promise<boolean> {
  try {
    const resolved = path.resolve(root)
    const stat = fs.lstatSync(resolved)
    return stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync.native(resolved) === resolved
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false
    throw cause
  }
}

export function verifyEvaluationEvidence(root: string, value: unknown): void {
  if (
    !record(value) ||
    !Array.isArray(value.evidence) ||
    !record(value.score) ||
    !Array.isArray(value.score.evidenceHashes)
  ) {
    throw new TypeError("TASK24_EVALUATION_EVIDENCE_REQUIRED")
  }
  const references = decodeRetainedEvidence(value.evidence)
  const hashes = [...new Set(references.map((reference) => verifyEvidenceFile(root, reference).sha256))].toSorted()
  if (canonicalJson(hashes) !== canonicalJson(value.score.evidenceHashes)) {
    throw new TypeError("TASK24_EVALUATION_EVIDENCE_UNBOUND")
  }
}

export function decodeRetainedEvidence(value: unknown) {
  if (!Array.isArray(value)) throw new TypeError("TASK24_EVALUATION_EVIDENCE_REQUIRED")
  return validateEvidenceReferences(
    value.map((item: unknown) => {
      if (
        !record(item) ||
        typeof item.kind !== "string" ||
        typeof item.relativePath !== "string" ||
        typeof item.sha256 !== "string" ||
        typeof item.bytes !== "number"
      )
        throw new TypeError("TASK24_EVIDENCE_REFERENCE_INVALID")
      return evidenceReference({
        kind: item.kind,
        relativePath: item.relativePath,
        sha256: item.sha256,
        bytes: item.bytes,
      })
    }),
  )
}

// Empty process logs have no file payload to retain, but their digest and exact
// case/path still close the evidence graph. All other evidence remains nonempty.
export function verifySecurityEvidenceCoverage(value: unknown): void {
  if (!record(value) || !Array.isArray(value.exactBinaryChecks) || !Array.isArray(value.emptyLogs)) {
    throw new TypeError("TASK24_SECURITY_COVERAGE_INVALID")
  }
  const cases = [
    ["exact-modified-incomplete", "exact_binary_incomplete"],
    ["exact-upstream-failed", "exact_binary_failed"],
    ["exact-modified-network", "exact_binary_external_network"],
    ["evaluator-sandbox", "evaluator_sandbox_boundary"],
  ] as const
  const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  const expected = new Map<string, { kind: string; sha256?: string; caseID: string }>()
  if (value.exactBinaryChecks.length !== cases.length) throw new TypeError("TASK24_SECURITY_COVERAGE_INVALID")
  for (const [caseID, check] of cases) {
    const matches = value.exactBinaryChecks.filter((item) => record(item) && item.check === check)
    const item = matches[0]
    if (matches.length !== 1 || !record(item)) throw new TypeError("TASK24_SECURITY_COVERAGE_INVALID")
    for (const [file, field] of [
      ["stdout.jsonl", "stdoutSha256"],
      ["stderr.log", "stderrSha256"],
    ] as const) {
      if (typeof item[field] !== "string" || !/^[a-f0-9]{64}$/.test(item[field])) {
        throw new TypeError("TASK24_SECURITY_COVERAGE_INVALID")
      }
      expected.set(`binary-evidence/${caseID}-${file}`, { kind: "security-log", sha256: item[field], caseID })
    }
    if (caseID !== "evaluator-sandbox") {
      expected.set(`binary-evidence/${caseID}-broker.sqlite`, { kind: "security-ledger", caseID })
    }
  }
  for (const reference of decodeRetainedEvidence(value.retainedEvidence)) {
    const slot = expected.get(reference.relativePath)
    if (!slot || slot.kind !== reference.kind || (slot.sha256 !== undefined && slot.sha256 !== reference.sha256)) {
      throw new TypeError("TASK24_SECURITY_COVERAGE_INVALID")
    }
    expected.delete(reference.relativePath)
  }
  for (const receipt of value.emptyLogs) {
    if (!record(receipt) || typeof receipt.relativePath !== "string")
      throw new TypeError("TASK24_SECURITY_COVERAGE_INVALID")
    const slot = expected.get(receipt.relativePath)
    if (
      !slot ||
      slot.kind !== "security-log" ||
      slot.caseID !== receipt.caseID ||
      slot.sha256 !== emptySha256 ||
      receipt.sha256 !== emptySha256 ||
      receipt.bytes !== 0
    )
      throw new TypeError("TASK24_SECURITY_COVERAGE_INVALID")
    expected.delete(receipt.relativePath)
  }
  if (expected.size !== 0) throw new TypeError("TASK24_SECURITY_COVERAGE_INCOMPLETE")
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
