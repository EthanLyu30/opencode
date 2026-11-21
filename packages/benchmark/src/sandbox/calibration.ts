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
function semanticMeasurementBody(result: IndependentResult) {
  return Object.fromEntries(
    Object.entries(result).filter(
      ([k]) => !["identity", "semanticSha256", "evidence", "evidenceHashes", "linuxProof"].includes(k),
    ),
  )
}
export function semanticMeasurementSha256(result: IndependentResult) {
  return sha256Text(canonicalJson(semanticMeasurementBody(result)))
}
/**
 * Browser rasterization can move a score by a few millionths between runs (26.999999 vs 27). Compare
 * repeat measurements at 1e-4 resolution so that jitter does not count as nondeterminism, while a
 * meaningful score change still fails the repeat check.
 */
export function sameCalibrationMeasurement(a: IndependentResult, b: IndependentResult) {
  return (
    canonicalJson(stableMeasurementNumbers(semanticMeasurementBody(a))) ===
    canonicalJson(stableMeasurementNumbers(semanticMeasurementBody(b)))
  )
}
function stableMeasurementNumbers(value: unknown): unknown {
  if (typeof value === "number") return Math.round(value * 10_000) / 10_000
  if (Array.isArray(value)) return value.map(stableMeasurementNumbers)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, stableMeasurementNumbers(v)]),
    )
  return value
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
export function matchesCalibrationOutcome(
  entry: CalibrationEntry,
  r: IndependentResult,
  visualBaseline?: number,
) {
  const functional = r.functional === null ? "not_observed" : r.functional === 45 ? "pass" : "fail"
  const absoluteVisual =
    r.visualComposite !== null &&
    r.visualComposite >= 75 &&
    r.viewportScores !== null &&
    r.viewportScores.every((v) => v >= 65)
  // Correct controls are judged by the absolute visual floor. Intentionally bad controls
  // must also fall below the same task's correct baseline, because task-specific rendering
  // means one absolute threshold cannot separate them.
  const visual =
    r.kind === "guardrail"
      ? null
      : r.visualComposite === null
        ? "not_observed"
        : entry.control.expected.visual === "fail"
          ? absoluteVisual && visualBaseline !== undefined && r.visual !== null && r.visual >= visualBaseline
            ? "pass"
            : "fail"
          : absoluteVisual && !r.disqualifications.some((v) => v.startsWith("VISUAL_"))
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
  options: Readonly<{ concurrency?: number }> = {},
): Promise<CalibrationReport> {
  const { scheduleSha256, ...body } = plan
  if (sha256Text(canonicalJson(body)) !== scheduleSha256) throw new TypeError("TASK24_CALIBRATION_SCHEDULE_DRIFT")
  const concurrency = Math.max(1, Math.min(32, Math.floor(options.concurrency ?? 1)))
  const outcomes: (EvaluationOutcome | undefined)[] = new Array(plan.entries.length)
  async function drain(start: number, end: number) {
    let next = start
    const worker = async () => {
      while (true) {
        const index = next++
        if (index >= end) return
        const entry = plan.entries[index]!
        outcomes[index] = signal.aborted
          ? { kind: "blocked", reason: "CALIBRATION_CANCELLED" }
          : await evaluate(entry, index).catch((error) => {
              console.error(
                "CALIBRATION_DRIVER_FAILURE",
                entry.taskID,
                entry.kind,
                entry.repeat,
                error instanceof Error ? error.message : String(error),
              )
              return { kind: "harness_error" as const, code: "CALIBRATION_DRIVER_FAILURE" }
            })
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(0, end - start)) }, worker))
  }
  const entries: CalibrationReport["entries"][number][] = [],
    unobserved: string[] = [],
    first = new Map<string, IndependentResult>(),
    visualBaselines = new Map<string, number>()
  let realEvaluations = 0
  function record(entry: CalibrationEntry, index: number) {
    const outcome = outcomes[index]!
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
      if (entry.control.kind === "correct" && entry.repeat === 0 && real && r.visual !== null)
        visualBaselines.set(entry.taskID, r.visual)
      matched = matchesCalibrationOutcome(entry, r, visualBaselines.get(entry.taskID))
      measurementSha256 = semanticMeasurementSha256(r)
      const prior = first.get(entry.taskID)
      stable = entry.repeat === 0 || (prior !== undefined && sameCalibrationMeasurement(prior, r))
      if (entry.control.kind === "correct" && entry.repeat === 0) first.set(entry.taskID, r)
    }
    if (!real) unobserved.push(entry.taskID + ":" + entry.control.kind + ":" + entry.repeat)
    entries.push({ entry, outcome, matched, stable, measurementSha256 })
  }
  await drain(0, plan.distinctControlCount)
  for (let index = 0; index < plan.distinctControlCount; index++)
    record(plan.entries[index]!, index)
  await drain(plan.distinctControlCount, plan.entries.length)
  for (let index = plan.distinctControlCount; index < plan.entries.length; index++)
    record(plan.entries[index]!, index)
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
function withCalibrationTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TypeError("TASK24_CALIBRATION_ATTEMPT_TIMEOUT")), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
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
  concurrency?: number
  only?:
    | Readonly<{ taskID: string; kind: string; repeat: 0 | 1 }>
    | readonly Readonly<{ taskID: string; kind: string; repeat: 0 | 1 }>[]
}): Promise<CalibrationReport> {
  const state = requireLinuxAuthority(input.authority)
  await verifyFinalizedCorpus(input.corpus, input.authority)
  const fullPlan = makeCalibrationSchedule(input.corpus.tasks),
    plan = input.only
      ? (() => {
          const targets = Array.isArray(input.only) ? input.only : [input.only]
          const entries = fullPlan.entries.filter((e) =>
            targets.some(
              (target) =>
                e.taskID === target.taskID &&
                e.control.kind === target.kind &&
                e.repeat === target.repeat,
            ),
          )
          if (entries.length !== targets.length) throw new TypeError("TASK24_CALIBRATION_ONLY_MISS")
          const body = {
            taskCount: fullPlan.taskCount,
            primaryTasks: fullPlan.primaryTasks,
            guardrailTasks: fullPlan.guardrailTasks,
            distinctControlCount: entries.filter((e) => e.repeat === 0).length,
            entries,
          }
          return freeze({ ...body, scheduleSha256: sha256Text(canonicalJson(body)) })
        })()
      : fullPlan,
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
        // A capture can stall after its screenshot is written (observed for >1h) while every
        // individual transport timeout has already fired. Bound the whole evaluation and retry
        // once in a fresh evidence root instead of hanging the remaining schedule forever.
        const attempt = async (root: string) => {
          await fs.mkdir(root, { recursive: true })
          const evaluator = await input.evaluator.create({
            identity,
            evidenceRoot: root,
            bundleRoot: task.bundleRoot,
            executionPlan: task.executionPlan,
          })
          try {
            const result = await evaluator.evaluate({
              bundle,
              snapshot,
              identity,
              evidenceRoot: root,
              dependency: dependency.value,
            })
            // The evaluator already re-verifies its context before returning; the calibration-only
            // path skips a second full snapshot hash so slow host scans do not eat the attempt budget.
            if (state.manifest.wsl2?.guestExecution?.calibrationOnly !== true) await verifyCandidate(snapshot)
            if (
              result.kind === "evaluated" &&
              (result.result.identity.candidateSha256 !== snapshot.candidateSha256 ||
                result.result.identity.attemptID !== identity.attemptID)
            )
              throw new TypeError("TASK24_CALIBRATION_CANDIDATE_IDENTITY")
            return result
          } finally {
            // A stuck evaluation may also block disposal; do not let cleanup extend the stall.
            await Promise.race([
              evaluator.dispose().catch(() => {}),
              new Promise<void>((resolve) => setTimeout(resolve, 60_000)),
            ])
          }
        }
        const bounded = async (root: string) => {
          try {
            return await withCalibrationTimeout(attempt(root), 90 * 60_000)
          } catch (cause) {
            if (!(cause instanceof TypeError) || cause.message !== "TASK24_CALIBRATION_ATTEMPT_TIMEOUT") throw cause
            return undefined
          }
        }
        const first = await bounded(evidenceRoot)
        // Harness errors are frequently transient (browser publication, container start). Rebuild
        // once in a fresh evidence root so one flaky attempt does not discard the whole corpus.
        if (first && first.kind !== "harness_error") return first
        const second = await bounded(evidenceRoot + "-retry")
        if (!second) throw new TypeError("TASK24_CALIBRATION_ATTEMPT_TIMEOUT")
        return second
      },
      input.signal,
      input.authority,
      { concurrency: input.concurrency },
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
