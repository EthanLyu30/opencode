import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { directRoot, ordinaryFiles } from "../../corpus/evaluation-bundle"
import { decodeEvaluationIdentity, freeze, type EvaluationIdentityV2 } from "../../corpus/evaluation-profile"
import { sha256Bytes, sha256Text } from "../../hash"
import { publishImmutable } from "../../offline/atomic"
import { verifyEvidenceFile, type EvidenceReference } from "../evidence"
import { evaluationContext, verifyEvaluationContext, type EvaluationOutcome } from "./index"
import { requireIndependentResult, type IndependentResult } from "./result"
import { linuxResultAuthority, verifyLinuxResultProof, type LinuxAuthority } from "../../sandbox/evaluation-host"

export type IndependentManifest = Readonly<{
  schemaVersion: 2
  identity: EvaluationIdentityV2
  assurance: "fixture" | "linux-attested"
  result: { path: "independent-result.json"; sha256: string; bytes: number }
  evidence: readonly EvidenceReference[]
}>
export type PublishedIndependentEvaluation = Readonly<{ root: string; manifest: IndependentManifest }>
const Evidence = Schema.Struct({
  kind: Schema.NonEmptyString,
  relativePath: Schema.NonEmptyString,
  sha256: Schema.String,
  bytes: Schema.Int,
})
const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  identity: Schema.Unknown,
  assurance: Schema.Literals(["fixture", "linux-attested"]),
  result: Schema.Struct({ path: Schema.Literal("independent-result.json"), sha256: Schema.String, bytes: Schema.Int }),
  evidence: Schema.NonEmptyArray(Evidence),
})
export async function publishIndependentEvaluation(input: {
  root: string
  outcome: EvaluationOutcome
}): Promise<PublishedIndependentEvaluation> {
  const context = evaluationContext(input.outcome)
  if (input.outcome.kind !== "evaluated") throw new TypeError("TASK24_OUTCOME_NOT_EVALUATED")
  requireIndependentResult(input.outcome.result)
  const root = await directRoot(input.root)
  if (root !== path.resolve(context.evidenceRoot)) throw new TypeError("TASK24_PUBLICATION_ROOT_INVALID")
  await verifyEvaluationContext(context)
  for (const ref of input.outcome.result.evidence) verifyEvidenceFile(root, ref)
  const bytes = Buffer.from(canonicalJson(input.outcome.result)),
    manifest = freeze({
      schemaVersion: 2 as const,
      identity: input.outcome.result.identity,
      assurance: input.outcome.result.assurance,
      result: { path: "independent-result.json" as const, sha256: sha256Bytes(bytes), bytes: bytes.length },
      evidence: input.outcome.result.evidence,
    })
  for (const name of ["independent-result.json", "independent-manifest.json"]) {
    try {
      const st = await fs.lstat(path.join(root, name))
      if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) throw new TypeError("TASK24_PUBLICATION_LINK")
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    }
  }
  await publishImmutable(path.join(root, "independent-result.json"), bytes)
  await verifyEvaluationContext(context)
  await publishImmutable(path.join(root, "independent-manifest.json"), canonicalJson(manifest))
  await verifyIndependentEvaluation({
    root,
    manifest,
    ...(input.outcome.result.assurance === "linux-attested"
      ? { authority: linuxResultAuthority(input.outcome.result) }
      : {}),
  })
  return freeze({ root, manifest })
}
export async function verifyIndependentEvaluation(input: {
  root: string
  manifest: IndependentManifest
  authority?: LinuxAuthority
}): Promise<IndependentResult> {
  const root = await directRoot(input.root)
  await ordinaryFiles(root)
  const raw = Schema.decodeUnknownSync(Manifest)(input.manifest, { onExcessProperty: "error" })
  const identity = decodeEvaluationIdentity(raw.identity)
  if (
    canonicalJson(JSON.parse(await fs.readFile(path.join(root, "independent-manifest.json"), "utf8"))) !==
    canonicalJson(input.manifest)
  )
    throw new TypeError("TASK24_PUBLICATION_MANIFEST_DRIFT")
  const bytes = await fs.readFile(path.join(root, raw.result.path))
  if (bytes.length !== raw.result.bytes || sha256Bytes(bytes) !== raw.result.sha256)
    throw new TypeError("TASK24_PUBLICATION_RESULT_DRIFT")
  const result = JSON.parse(bytes.toString("utf8")) as IndependentResult
  if (
    result.schemaVersion !== 2 ||
    result.assurance !== raw.assurance ||
    canonicalJson(result.identity) !== canonicalJson(identity) ||
    canonicalJson(result.evidence) !== canonicalJson(raw.evidence)
  )
    throw new TypeError("TASK24_PUBLICATION_IDENTITY_INVALID")
  if (result.assurance === "linux-attested") verifyLinuxResultProof(result.linuxProof, input.authority, identity)
  else if ("linuxProof" in result) throw new TypeError("TASK24_PUBLICATION_IDENTITY_INVALID")
  const { semanticSha256, ...body } = result
  if (sha256Text(canonicalJson(body)) !== semanticSha256) throw new TypeError("TASK24_PUBLICATION_SEMANTIC_INVALID")
  for (const ref of raw.evidence) verifyEvidenceFile(root, ref)
  return freeze(result)
}
