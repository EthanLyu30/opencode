import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { Sha256 } from "../schema"
import { directRoot } from "../corpus/evaluation-bundle"
import { verifyFinalizedCorpus, type FinalizedCorpus } from "../corpus/evaluation-finalize"
import {
  makeCalibrationSchedule,
  semanticMeasurementSha256,
  matchesCalibrationOutcome,
  type CalibrationReport,
} from "./calibration"
import { type Gate, type HostManifest, type EngineSession } from "./contracts"
import { revalidateSession } from "./preflight"
import { restoreEngineReceipt, type EngineReceipt } from "./engine-evidence"
import { authorizeLinuxHost, verifyLinuxResultProof } from "./evaluation-host"
import { restoreCapabilityReceipt, type CapabilityReceipt } from "./capability"
import { publishImmutable } from "../offline/atomic"
import { bindEvidenceFile, verifyEvidenceFile, type EvidenceReference } from "../evaluator/evidence"

const Index = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  manifestSha256: Sha256,
  engineSha256: Sha256,
  capabilitySha256: Schema.Array(Sha256),
  corpusSha256: Sha256,
  calibrationSha256: Sha256,
})
export type ReadinessIndex = typeof Index.Type
export async function readControllerJson(file: string): Promise<unknown> {
  await directRoot(path.dirname(file))
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024)
    throw new TypeError("TASK24_CONTROLLER_JSON_FILE")
  return JSON.parse(await fs.readFile(file, "utf8"))
}
export function decodeReadinessIndex(value: unknown) {
  const index = Schema.decodeUnknownSync(Index)(value, { onExcessProperty: "error" })
  if (index.capabilitySha256.length !== 5 || new Set(index.capabilitySha256).size !== 5)
    throw new TypeError("TASK24_READINESS_CAPABILITIES")
  return index
}
/** No process, pull or container creation is permitted by this verifier. */
export async function verifyLinuxReadiness(input: {
  root: string
  manifest: HostManifest
  session?: EngineSession
  index?: ReadinessIndex
}): Promise<
  Gate<{
    engine: EngineReceipt
    capabilities: readonly CapabilityReceipt[]
    corpus: CalibrationReport
    evidence: readonly EvidenceReference[]
  }>
> {
  try {
    if (!input.session) throw new TypeError("TASK24_READINESS_AUTHORITY_REQUIRED")
    const session = input.session,
      state = await revalidateSession(session)
    if (
      input.root !== state.manifest.roots.evidence ||
      canonicalJson(input.manifest) !== canonicalJson(state.manifest) ||
      input.manifest.phase !== "accept"
    )
      throw new TypeError("TASK24_READINESS_IDENTITY")
    const index = decodeReadinessIndex(
      input.index ?? (await readControllerJson(path.join(input.root, "linux-readiness-input.json"))),
    )
    if (index.manifestSha256 !== input.session.manifestSha256) throw new TypeError("TASK24_READINESS_STALE")
    const engine = await restoreEngineReceipt({
      session: input.session,
      receipt: (await readControllerJson(path.join(input.root, `engine-${index.engineSha256}.json`))) as EngineReceipt,
      expectedSha256: index.engineSha256,
    })
    const authority = authorizeLinuxHost({ manifest: input.manifest, engineReceipt: engine, evidenceRoot: input.root })
    const capabilities = await Promise.all(
      index.capabilitySha256.map(async (sha) =>
        restoreCapabilityReceipt({
          session,
          expectedSha256: sha,
          receipt: {
            ...((await readControllerJson(path.join(input.root, `capability-${sha}.json`))) as Omit<
              CapabilityReceipt,
              "receiptSha256"
            >),
            receiptSha256: sha,
          },
        }),
      ),
    )
    if (
      capabilities
        .map((c) => c.armID)
        .sort()
        .join("") !== "ABCDE"
    )
      throw new TypeError("TASK24_READINESS_ARMS")
    const corpusArtifact = input.manifest.artifacts.find((a) => a.id === "corpus-location")
    if (!corpusArtifact || !corpusArtifact.path) throw new TypeError("TASK24_READINESS_CORPUS_LOCATION")
    const location = Schema.decodeUnknownSync(Schema.Struct({ root: Schema.String }))(
      await readControllerJson(corpusArtifact.path),
      { onExcessProperty: "error" },
    )
    const corpus = (await readControllerJson(path.join(location.root, "finalized-corpus.json"))) as FinalizedCorpus
    await verifyFinalizedCorpus(corpus, authority)
    if (corpus.corpusSha256 !== index.corpusSha256) throw new TypeError("TASK24_READINESS_CORPUS")
    const report = (await readControllerJson(
      path.join(input.root, `calibration-${index.calibrationSha256}.json`),
    )) as CalibrationReport
    const { reportSha256, ...body } = report
    const schedule = makeCalibrationSchedule(corpus.tasks)
    if (
      sha256Text(canonicalJson(body)) !== index.calibrationSha256 ||
      reportSha256 !== index.calibrationSha256 ||
      report.manifestSha256 !== input.session.manifestSha256 ||
      report.corpusSha256 !== corpus.corpusSha256 ||
      !report.corpusEngineReady ||
      report.realEvaluations !== 120 ||
      report.taskCount !== 16 ||
      report.primaryTasks !== 12 ||
      report.guardrailTasks !== 4 ||
      report.distinctControlCount !== 104 ||
      report.unobservedRequiredChecks.length ||
      report.scheduleSha256 !== schedule.scheduleSha256 ||
      report.entries.length !== 120
    )
      throw new TypeError("TASK24_READINESS_CALIBRATION_INCOMPLETE")
    const first = new Map<string, string>()
    const evidence: EvidenceReference[] = []
    for (const [i, e] of report.entries.entries()) {
      if (
        !e.matched ||
        !e.stable ||
        canonicalJson(e.entry) !== canonicalJson(schedule.entries[i]) ||
        e.outcome.kind !== "evaluated" ||
        e.outcome.result.assurance !== "linux-attested"
      )
        throw new TypeError("TASK24_READINESS_CALIBRATION_ROW")
      const r = e.outcome.result
      if (!matchesCalibrationOutcome(e.entry, r)) throw new TypeError("TASK24_READINESS_CALIBRATION_MISMATCH")
      verifyLinuxResultProof(r.linuxProof, authority, r.identity)
      const measurement = semanticMeasurementSha256(r)
      if (
        r.identity.taskID !== e.entry.taskID ||
        measurement !== e.measurementSha256 ||
        (e.entry.repeat === 1 && first.get(e.entry.taskID) !== measurement)
      )
        throw new TypeError("TASK24_READINESS_CALIBRATION_BINDING")
      if (e.entry.control.kind === "correct" && e.entry.repeat === 0) first.set(e.entry.taskID, measurement)
      for (const ref of r.evidence) {
        verifyEvidenceFile(r.linuxProof.evidenceRoot, ref)
        evidence.push({
          ...ref,
          relativePath: path
            .relative(input.root, path.join(r.linuxProof.evidenceRoot, ref.relativePath))
            .replaceAll("\\", "/"),
        })
      }
    }
    for (const check of engine.checks) evidence.push(...check.evidence, check.receipt.evidence)
    for (const c of capabilities) evidence.push(...c.cases.flatMap((v) => v.evidence))
    for (const file of [
      `engine-${engine.receiptSha256}.json`,
      ...capabilities.map((c) => `capability-${c.receiptSha256}.json`),
      `calibration-${reportSha256}.json`,
    ])
      evidence.push(bindEvidenceFile(input.root, path.join(input.root, file), "linux-readiness"))
    await revalidateSession(input.session)
    return {
      kind: "ready",
      value: {
        engine,
        capabilities,
        corpus: report,
        evidence: [...new Map(evidence.map((e) => [e.relativePath, e])).values()],
      },
    }
  } catch (error) {
    const code =
      error instanceof TypeError && /^TASK24_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "TASK24_READINESS_EVIDENCE_MISSING_OR_INVALID"
    return { kind: "blocked", code, missing: [code] }
  }
}
export async function publishLinuxReadiness(input: Parameters<typeof verifyLinuxReadiness>[0]) {
  const result = await verifyLinuxReadiness(input)
  if (result.kind !== "ready") return result
  const body = {
    schemaVersion: 2,
    software_complete: true,
    engine_verified: true,
    capabilities_verified: true,
    corpus_engine_ready: true,
    manifestSha256: input.session!.manifestSha256,
    engineSha256: result.value.engine.receiptSha256,
    capabilitySha256: result.value.capabilities.map((c) => c.receiptSha256),
    calibrationSha256: result.value.corpus.reportSha256,
    evidence: result.value.evidence,
  }
  await publishImmutable(path.join(input.root, "linux-readiness.json"), canonicalJson(body))
  if (canonicalJson(await readControllerJson(path.join(input.root, "linux-readiness.json"))) !== canonicalJson(body))
    throw new TypeError("TASK24_READINESS_PUBLICATION")
  return result
}
