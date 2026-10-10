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
  if (!record(value) || !Array.isArray(value.evidence) || !record(value.score) || !Array.isArray(value.score.evidenceHashes)) {
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
  return validateEvidenceReferences(value.map((item: unknown) => {
    if (!record(item) || typeof item.kind !== "string" || typeof item.relativePath !== "string" ||
      typeof item.sha256 !== "string" || typeof item.bytes !== "number") throw new TypeError("TASK24_EVIDENCE_REFERENCE_INVALID")
    return evidenceReference({ kind: item.kind, relativePath: item.relativePath, sha256: item.sha256, bytes: item.bytes })
  }))
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
