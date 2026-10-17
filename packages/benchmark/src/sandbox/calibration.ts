import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { freeze, decodeEvaluationIdentity } from "../corpus/evaluation-profile"
import { verifyFinalizedCorpus, type FinalizedCorpus } from "../corpus/evaluation-finalize"
import { materializeCalibrationCandidate, type CalibrationCandidate } from "../corpus/evaluation-authoring"
import { loadEvaluationBundle, directRoot } from "../corpus/evaluation-bundle"
import { captureCandidate, verifyCandidate } from "../evaluator/independent/snapshot"
import { requireIndependentResult, type IndependentResult } from "../evaluator/independent/result"
import type { EvaluationOutcome } from "../evaluator/independent"
import type { LinuxEvaluateInput } from "./linux-evaluator"
import { requireLinuxAuthority, verifyLinuxResultProof, type LinuxAuthority } from "./evaluation-host"
import { resolveTaskDependency, type ResolvedImages } from "./dependencies"
import { publishImmutable } from "../offline/atomic"
import type { TaskExecutionProfile, EvaluationIdentityV2 } from "../corpus/evaluation-profile"
const kinds = [
  "correct",
  "alternate-correct",
  "seed",
  "functional-bad",
  "visual-bad",
  "responsive-bad",
  "policy-bad",
] as const
type Control = Pick<CalibrationCandidate, "kind" | "treeSha256" | "expected">
export type CalibrationEntry = Readonly<{
  taskID: string
  kind: "primary" | "guardrail"
  control: Control
  repeat: 0 | 1
}>
export function makeCalibrationSchedule(
  tasks: readonly { taskID: string; kind: "primary" | "guardrail"; controls: readonly Control[] }[],
) {
  if (
    tasks.length !== 16 ||
    new Set(tasks.map((t) => t.taskID)).size !== 16 ||
    tasks.filter((t) => t.kind === "primary").length !== 12 ||
    tasks.filter((t) => t.kind === "guardrail").length !== 4
  )
    throw new TypeError("TASK24_CALIBRATION_TASK_COVERAGE")
  const entries: CalibrationEntry[] = []
  for (const task of tasks) {
    const expected = kinds.filter((k) => task.kind === "primary" || !["visual-bad", "responsive-bad"].includes(k))
    if (
      task.controls.length !== expected.length ||
      new Set(task.controls.map((c) => c.kind)).size !== expected.length ||
      expected.some((k) => !task.controls.some((c) => c.kind === k))
    )
      throw new TypeError("TASK24_CALIBRATION_CONTROL_COVERAGE")
    for (const kind of expected) {
      const control = task.controls.find((c) => c.kind === kind)!
      entries.push({ taskID: task.taskID, kind: task.kind, control, repeat: 0 })
    }
  }
  const distinctControlCount = entries.length
  for (const task of tasks)
    entries.push({
      taskID: task.taskID,
      kind: task.kind,
      control: task.controls.find((c) => c.kind === "correct")!,
      repeat: 1,
    })
  const body = { taskCount: 16, primaryTasks: 12, guardrailTasks: 4, distinctControlCount, entries }
  return freeze({ ...body, scheduleSha256: sha256Text(canonicalJson(body)) })
}
export function semanticMeasurementSha256(result: IndependentResult) {
  return sha256Text(
    canonicalJson(
      Object.fromEntries(
        Object.entries(result).filter(
          ([k]) => !["identity", "semanticSha256", "evidence", "evidenceHashes", "linuxProof"].includes(k),
        ),
      ),
    ),
  )
}
export type CalibrationReport = Readonly<{
  schemaVersion: 2
  manifestSha256: string | null
  corpusSha256: string | null
  taskCount: number
  primaryTasks: number
  guardrailTasks: number
  distinctControlCount: number
  scheduleSha256: string
  realEvaluations: number
  corpusEngineReady: boolean
  unobservedRequiredChecks: readonly string[]
  entries: readonly {
    entry: CalibrationEntry
    outcome: EvaluationOutcome
    matched: boolean
    stable: boolean
    measurementSha256: string | null
  }[]
  reportSha256: string
}>
export function matchesCalibrationOutcome(entry: CalibrationEntry, r: IndependentResult) {
  const functional = r.functional === null ? "not_observed" : r.functional === 45 ? "pass" : "fail"
  const visual =
    r.kind === "guardrail"
      ? null
      : r.visualComposite === null
        ? "not_observed"
        : r.visualComposite >= 75 && r.viewportScores?.every((v) => v >= 65)
          ? "pass"
          : "fail"
  const policy = r.disqualifications.some((v) => v.startsWith("POLICY_")) ? "fail" : "pass"
  return (
    r.kind === entry.kind &&
    functional === entry.control.expected.functional &&
    visual === entry.control.expected.visual &&
    policy === entry.control.expected.policy
  )
}
export async function runCalibrationSchedule(
  plan: ReturnType<typeof makeCalibrationSchedule>,
  evaluate: (entry: CalibrationEntry, index: number) => Promise<EvaluationOutcome>,
  signal: AbortSignal,
  authority?: LinuxAuthority,
): Promise<CalibrationReport> {
  const { scheduleSha256, ...body } = plan
  if (sha256Text(canonicalJson(body)) !== scheduleSha256) throw new TypeError("TASK24_CALIBRATION_SCHEDULE_DRIFT")
  const entries: CalibrationReport["entries"][number][] = [],
    unobserved: string[] = [],
    first = new Map<string, string>()
  let realEvaluations = 0
  for (const [index, entry] of plan.entries.entries()) {
    const outcome = signal.aborted
      ? { kind: "blocked" as const, reason: "CALIBRATION_CANCELLED" }
      : await evaluate(entry, index).catch(() => ({
          kind: "harness_error" as const,
          code: "CALIBRATION_DRIVER_FAILURE",
        }))
    let matched = false,
      stable = false,
      measurementSha256: string | null = null,
      real = false
    if (outcome.kind === "evaluated") {
      const r = outcome.result,
        expected = entry.control.expected
      if (authority && r.assurance === "linux-attested") {
        requireIndependentResult(r)
        verifyLinuxResultProof(r.linuxProof, authority, r.identity)
        if (r.identity.taskID !== entry.taskID) throw new TypeError("TASK24_CALIBRATION_RESULT_IDENTITY")
        real = true
        realEvaluations++
      }
      matched = matchesCalibrationOutcome(entry, r)
      measurementSha256 = semanticMeasurementSha256(r)
      const prior = first.get(entry.taskID)
      stable = entry.repeat === 0 || prior === measurementSha256
      if (entry.control.kind === "correct" && entry.repeat === 0) first.set(entry.taskID, measurementSha256)
    }
    if (!real) unobserved.push(entry.taskID + ":" + entry.control.kind + ":" + entry.repeat)
    entries.push({ entry, outcome, matched, stable, measurementSha256 })
  }
  const report = {
    schemaVersion: 2 as const,
    manifestSha256: authority?.manifestSha256 ?? null,
    corpusSha256: null,
    taskCount: plan.taskCount,
    primaryTasks: plan.primaryTasks,
    guardrailTasks: plan.guardrailTasks,
    distinctControlCount: plan.distinctControlCount,
    scheduleSha256,
    realEvaluations,
    corpusEngineReady:
      realEvaluations === 120 && entries.every((e) => e.matched && e.stable) && unobserved.length === 0,
    unobservedRequiredChecks: unobserved,
    entries,
  }
  return freeze({ ...report, reportSha256: sha256Text(canonicalJson(report)) })
}
export async function calibrateLinuxCorpus(input: {
  corpus: FinalizedCorpus
  authority: LinuxAuthority
  images: ResolvedImages
  evaluator: {
    create(input: {
      identity: EvaluationIdentityV2
      evidenceRoot: string
      bundleRoot: string
      executionPlan: FinalizedCorpus["tasks"][number]["executionPlan"]
    }): Promise<{ evaluate(input: LinuxEvaluateInput): Promise<EvaluationOutcome>; dispose(): Promise<void> }>
  }
  signal: AbortSignal
}): Promise<CalibrationReport> {
  const state = requireLinuxAuthority(input.authority)
  await verifyFinalizedCorpus(input.corpus, input.authority)
  const plan = makeCalibrationSchedule(input.corpus.tasks),
    nonce = randomBytes(16).toString("hex"),
    root = await fs.mkdtemp(path.join(state.manifest.roots.work, "calibration-"))
  try {
    const report = await runCalibrationSchedule(
      plan,
      async (entry, index) => {
        const task = input.corpus.tasks.find((t) => t.taskID === entry.taskID)!,
          sourceRoot = path.join(root, `source-${index}`),
          workRoot = path.join(root, `snapshot-${index}`),
          evidenceRoot = path.join(state.manifest.roots.evidence, `calibration-${nonce}-${index}`)
        await materializeCalibrationCandidate({
          root: task.authoringRoot,
          kind: entry.control.kind,
          destination: sourceRoot,
        })
        await fs.mkdir(evidenceRoot)
        for (const overlay of task.publicOverlays) {
          const bytes = await fs.readFile(path.join(task.bundleRoot, "public", overlay.path))
          if (sha256Text(bytes.toString("utf8")) !== overlay.sha256)
            throw new TypeError("TASK24_CALIBRATION_OVERLAY_DRIFT")
          await fs.mkdir(path.dirname(path.join(sourceRoot, overlay.path)), { recursive: true })
          await fs.writeFile(path.join(sourceRoot, overlay.path), bytes, { flag: "wx" })
        }
        const bundle = await loadEvaluationBundle(task.bundleRoot),
          snapshot = await captureCandidate({ sourceRoot, workRoot, profile: bundle.profile }),
          dependency = resolveTaskDependency({ profile: bundle.profile, images: input.images })
        if (dependency.kind !== "ready") return { kind: "blocked", reason: "DEPENDENCY_UNRESOLVED" }
        const runtime = state.manifest.artifacts.find((a) => a.id === "controller-bun")
        if (!runtime || !("sha256" in runtime)) return { kind: "blocked", reason: "CONTROLLER_RUNTIME_NOT_FROZEN" }
        const identity = decodeEvaluationIdentity({
          schemaVersion: 2,
          campaignID: "linux-oracle-calibration",
          runID: `control-${nonce}-${index}`,
          attemptID: `attempt-${nonce}-${index}`,
          leaseGeneration: 1,
          taskID: entry.taskID,
          armID: "A",
          repeat: entry.repeat,
          campaignSha256: input.corpus.corpusSha256,
          binarySha256: runtime.sha256,
          routeSha256: sha256Text("no-provider-transport"),
          profileSha256: bundle.profileSha256,
          oracleSha256: bundle.oracleSha256,
          seedSha256: bundle.seedSha256,
          candidateSha256: snapshot.candidateSha256,
          evaluatorSha256: state.manifest.sourceSha256,
        })
        const evaluator = await input.evaluator.create({
          identity,
          evidenceRoot,
          bundleRoot: task.bundleRoot,
          executionPlan: task.executionPlan,
        })
        try {
          const result = await evaluator.evaluate({
            bundle,
            snapshot,
            identity,
            evidenceRoot,
            dependency: dependency.value,
          })
          await verifyCandidate(snapshot)
          if (
            result.kind === "evaluated" &&
            (result.result.identity.candidateSha256 !== snapshot.candidateSha256 ||
              result.result.identity.attemptID !== identity.attemptID)
          )
            throw new TypeError("TASK24_CALIBRATION_CANDIDATE_IDENTITY")
          return result
        } finally {
          await evaluator.dispose()
        }
      },
      input.signal,
      input.authority,
    )
    const { reportSha256, ...body } = report,
      complete = { ...body, corpusSha256: input.corpus.corpusSha256 },
      result = freeze({ ...complete, reportSha256: sha256Text(canonicalJson(complete)) })
    await publishImmutable(
      path.join(state.manifest.roots.evidence, `calibration-${result.reportSha256}.json`),
      canonicalJson(result),
    )
    return result
  } finally {
    await directRoot(root)
    if (path.dirname(root) !== state.manifest.roots.work || !path.basename(root).startsWith("calibration-"))
      throw new TypeError("TASK24_CALIBRATION_CLEANUP_ROOT")
    await fs.rm(root, { recursive: true })
  }
}
