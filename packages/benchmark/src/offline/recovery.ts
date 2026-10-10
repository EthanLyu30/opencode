import fs from "node:fs/promises"
import path from "node:path"
import { BrokerLedger } from "../broker/ledger"
import { compilePriceBook } from "../broker/pricing"
import { canonicalJson } from "../campaign/canonical"
import { sealCampaign } from "../campaign/seal"
import { sha256File } from "../hash"
import { RunStore } from "../run/store"
import type { Task24Layout } from "../root"
import { Task24Root } from "../root"
import type { Task24CrashPoint } from "../run/crash-hook"
import type { SealedCampaign } from "../schema"
import { publishImmutable } from "./atomic"
import { runWorkflowRecovery, verifyWorkflowRecoveryEvidence } from "./workflow-recovery"

export interface RecoveryCaseResult {
  readonly caseID: Task24CrashPoint
  readonly outcome: "completed" | "adjudication_required" | "published"
  readonly execution: "exact-offline-command"
  readonly duplicateDispatches: 0
  readonly conflictingResults: 0
  readonly evidenceFile: string
  readonly evidenceSha256: string
}

const points: readonly Task24CrashPoint[] = [
  "during_materialization", "after_reservation", "mid_stream", "after_terminal_usage",
  "during_workflow_recovery", "during_capture", "during_evaluation_publication", "during_report_write",
]

export async function verifyRecoveryMatrix(results: readonly RecoveryCaseResult[], campaign: SealedCampaign, root: string): Promise<void> {
  if (results.length !== points.length || new Set(results.map((result) => result.caseID)).size !== points.length) {
    throw new TypeError("TASK24_RECOVERY_MATRIX_INCOMPLETE")
  }
  for (const point of points) {
    const result = results.find((item) => item.caseID === point)
    const file = path.join(root, `${point}.json`)
    if (!result || result.execution !== "exact-offline-command" || result.evidenceFile !== file || await sha256File(file) !== result.evidenceSha256) {
      throw new TypeError("TASK24_RECOVERY_EVIDENCE_IDENTITY_INVALID")
    }
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"))
    if (point === "during_workflow_recovery") {
      const { sha256: _sha256, ...body } = campaign
      if (!record(value) || typeof value.campaignID !== "string") throw new TypeError("TASK24_WORKFLOW_RECOVERY_EVIDENCE_INVALID")
      await verifyWorkflowRecoveryEvidence(value, sealCampaign({ ...body, id: value.campaignID }))
      continue
    }
    if (!record(value) || value.caseID !== point || value.execution !== "exact-offline-command" ||
      !record(value.crashMarker) || value.crashMarker.point !== point || !Number.isSafeInteger(value.crashMarker.pid) ||
      canonicalJson(value.binaryLocks) !== canonicalJson(campaign.binaries) ||
      !Array.isArray(value.beforeLedger) || !Array.isArray(value.afterLedger) ||
      (value.beforeLedger.length > 0 && canonicalJson(value.beforeLedger) !== canonicalJson(value.afterLedger)) ||
      value.outcome !== result.outcome || value.duplicateDispatches !== 0 || value.conflictingResults !== 0 ||
      typeof value.resultRoot !== "string" || typeof value.runID !== "string" || typeof value.campaignID !== "string") {
      throw new TypeError("TASK24_RECOVERY_EVIDENCE_CONTENT_INVALID")
    }
    if (!/^recovery-[a-f0-9]{32}-[a-z_]+$/.test(value.campaignID) || !value.campaignID.endsWith(`-${point}`)) {
      throw new TypeError("TASK24_RECOVERY_CAMPAIGN_INVALID")
    }
    const { sha256: _sha256, ...body } = campaign
    const scoped = sealCampaign({ ...body, id: value.campaignID })
    const layout = Task24Root.ensure()
    if (value.campaignSha256 !== scoped.sha256 || value.resultRoot !== path.join(layout.runs, "offline", scoped.sha256)) {
      throw new TypeError("TASK24_RECOVERY_ROOT_INVALID")
    }
    const ledger = BrokerLedger.open({ database: path.join(value.resultRoot, "ledgers", `${value.runID}.sqlite`),
      prices: compilePriceBook(campaign.pricing), ceilings: { CNY: 10_000_000_000n, USD: 10_000_000_000n } })
    try {
      if (canonicalJson(ledger.records()) !== canonicalJson(value.afterLedger)) throw new TypeError("TASK24_RECOVERY_LEDGER_CHANGED")
      if (canonicalJson(ledger.reservations()) !== canonicalJson(value.afterReservations) ||
        canonicalJson(value.beforeReservations) !== canonicalJson(value.afterReservations) &&
        Array.isArray(value.beforeReservations) && value.beforeReservations.length > 0) throw new TypeError("TASK24_RECOVERY_RESERVATION_CHANGED")
    } finally { ledger.close() }
    const store = RunStore.open(path.join(value.resultRoot, "scheduler", "offline.sqlite"))
    try {
      if (store.getRun(value.runID)?.state !== value.finalState || canonicalJson(store.adjudications(value.runID)) !== canonicalJson(value.adjudications)) {
        throw new TypeError("TASK24_RECOVERY_STATE_CHANGED")
      }
    } finally { store.close() }
    const unknown = point === "after_reservation" || point === "mid_stream"
    if (unknown) {
      if (value.finalState !== "failed" || value.restartExitCode !== 1 || value.replayExitCode !== 1 || value.afterLedger.length !== 0 ||
        !Array.isArray(value.afterReservations) || value.afterReservations.length !== 1 || !record(value.afterReservations[0]) || value.afterReservations[0].state !== "active" ||
        !Array.isArray(value.adjudications) || value.adjudications.length !== 1) throw new TypeError("TASK24_RECOVERY_UNKNOWN_INVALID")
    } else if (value.finalState !== "completed" || value.restartExitCode !== 0 || value.replayExitCode !== 0 ||
      typeof value.publicationSha256 !== "string") throw new TypeError("TASK24_RECOVERY_COMPLETED_INVALID")
    if (!unknown) {
      const publication = point === "during_report_write" ? path.join(layout.reports, "offline", scoped.sha256, "summary.json") : path.join(value.resultRoot, "summary.json")
      if (await sha256File(publication) !== value.publicationSha256) throw new TypeError("TASK24_RECOVERY_PUBLICATION_CHANGED")
    }
  }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }

/** Kills the real CLI tree and restarts the same command against its durable files. */
export async function runRecoveryMatrix(layout: Task24Layout, evidenceRoot?: string): Promise<readonly RecoveryCaseResult[]> {
  const nonce = crypto.randomUUID().replaceAll("-", "")
  const root = path.join(layout.tmp, `offline-recovery-${nonce}`)
  const evidence = evidenceRoot ?? path.join(layout.runs, `offline-recovery-${nonce}`)
  if (!path.resolve(evidence).startsWith(path.resolve(layout.runs) + path.sep)) throw new TypeError("TASK24_RECOVERY_EVIDENCE_OUTSIDE_RUNS")
  await fs.mkdir(root)
  await fs.mkdir(evidence, { recursive: true })
  const base = sealCampaign(JSON.parse(await fs.readFile(path.join(layout.runs, "preregistration.candidate.json"), "utf8")))
  const prices = compilePriceBook(base.pricing)
  const results: RecoveryCaseResult[] = []
  try {
    for (const point of points) {
      const probeID = `recovery-${nonce}-${point}`
      const { sha256: _sha256, ...body } = base
      const campaign = sealCampaign({ ...body, id: probeID })
      if (point === "during_workflow_recovery") {
        results.push(await runWorkflowRecovery(layout, campaign, path.join(evidence, `${point}.json`)))
        continue
      }
      const resultRoot = path.join(layout.runs, "offline", campaign.sha256)
      const command = point === "during_report_write" ? "report" : "run"
      if (command === "report") await runCommand(layout, root, probeID, "run")
      const crashed = await runCommand(layout, root, probeID, command, point)
      if (!crashed.marker) throw new TypeError(`TASK24_RECOVERY_CHECKPOINT_NOT_REACHED:${point}`)
      const database = path.join(resultRoot, "scheduler", "offline.sqlite")
      const store = RunStore.open(database)
      let firstRun: NonNullable<ReturnType<typeof store.getRun>>
      try {
        const first = store.listRuns(campaign.id).toSorted((a, b) => a.orderIndex - b.orderIndex)[0]
        if (!first) throw new TypeError("TASK24_RECOVERY_RUN_MISSING")
        firstRun = first
      } finally { store.close() }
      const ledgerFile = path.join(resultRoot, "ledgers", `${firstRun.runID}.sqlite`)
      const readLedger = async () => {
        if (!(await Bun.file(ledgerFile).exists())) return []
        const ledger = BrokerLedger.open({ database: ledgerFile, prices, ceilings: { CNY: 10_000_000_000n, USD: 10_000_000_000n } })
        try { return ledger.records() } finally { ledger.close() }
      }
      const readReservations = async () => {
        if (!(await Bun.file(ledgerFile).exists())) return []
        const ledger = BrokerLedger.open({ database: ledgerFile, prices, ceilings: { CNY: 10_000_000_000n, USD: 10_000_000_000n } })
        try { return ledger.reservations() } finally { ledger.close() }
      }
      const before = await readLedger()
      const beforeReservations = await readReservations()
      const unknown = point === "after_reservation" || point === "mid_stream"
      if (unknown && (before.length !== 0 || beforeReservations.length !== 1 || beforeReservations[0]?.state !== "active")) throw new TypeError(`TASK24_RECOVERY_RESERVATION_NOT_DURABLE:${point}`)
      if (!["during_materialization", "after_reservation", "mid_stream"].includes(point) && before.length === 0) {
        throw new TypeError(`TASK24_RECOVERY_EXACT_BINARY_NOT_EXERCISED:${point}`)
      }
      const restarted = await runCommand(layout, root, probeID, command)
      const after = await readLedger()
      const afterReservations = await readReservations()
      const resumedStore = RunStore.open(database)
      let finalState: string
      let adjudications: ReturnType<typeof resumedStore.adjudications>
      try {
        finalState = resumedStore.getRun(firstRun.runID)?.state ?? "missing"
        adjudications = resumedStore.adjudications(firstRun.runID)
      } finally { resumedStore.close() }
      if (unknown) {
        if (restarted.exit !== 1 || !restarted.stderr.includes("TASK24_OFFLINE_RECOVERY_TERMINAL") || finalState !== "failed" || adjudications.length !== 1) {
          throw new TypeError(`TASK24_RECOVERY_UNKNOWN_REDISPATCHED:${point}`)
        }
      } else if (restarted.exit !== 0 || finalState !== "completed") {
        throw new TypeError(`TASK24_RECOVERY_RESTART_FAILED:${point}:${restarted.stderr.slice(-2048)}`)
      }
      if (before.length > 0 && canonicalJson(before) !== canonicalJson(after)) throw new TypeError(`TASK24_RECOVERY_DUPLICATE_OR_MUTATED_DISPATCH:${point}`)
      if (beforeReservations.length > 0 && canonicalJson(beforeReservations) !== canonicalJson(afterReservations)) throw new TypeError(`TASK24_RECOVERY_DUPLICATE_RESERVATION:${point}`)
      const publishedFile = command === "report" ? path.join(layout.reports, "offline", campaign.sha256, "summary.json") : path.join(resultRoot, "summary.json")
      const publicationSha256 = unknown ? null : await sha256File(publishedFile)
      const replayed = await runCommand(layout, root, probeID, command)
      if (replayed.exit !== restarted.exit || canonicalJson(await readLedger()) !== canonicalJson(after) ||
        canonicalJson(await readReservations()) !== canonicalJson(afterReservations) ||
        (!unknown && await sha256File(publishedFile) !== publicationSha256)) throw new TypeError(`TASK24_RECOVERY_REPLAY_CONFLICT:${point}`)
      const evidenceFile = path.join(evidence, `${point}.json`)
      const outcome = unknown ? "adjudication_required" : command === "report" ? "published" : "completed"
      await publishImmutable(evidenceFile, canonicalJson({
        schemaVersion: 1, caseID: point, execution: "exact-offline-command", campaignID: campaign.id,
        campaignSha256: campaign.sha256, runID: firstRun.runID, binaryLocks: campaign.binaries,
        crashMarker: crashed.marker, finalState, adjudications, beforeLedger: before, afterLedger: after,
        beforeReservations, afterReservations,
        restartExitCode: restarted.exit, replayExitCode: replayed.exit, publicationSha256,
        resultRoot, outcome, duplicateDispatches: 0, conflictingResults: 0,
      }) + "\n")
      results.push(Object.freeze({ caseID: point, execution: "exact-offline-command", outcome,
        duplicateDispatches: 0, conflictingResults: 0, evidenceFile, evidenceSha256: await sha256File(evidenceFile) }))
    }
    return Object.freeze(results)
  } finally { await removeOwnedTree(layout.tmp, root) }
}

async function runCommand(layout: Task24Layout, root: string, probeID: string, command: "run" | "report", point?: Task24CrashPoint) {
  const marker = path.join(root, `checkpoint-${crypto.randomUUID()}.json`)
  const cli = path.resolve(import.meta.dir, "../cli.ts")
  const child = Bun.spawn([process.execPath, cli, command, "--stage", "offline"], {
    cwd: root, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: {
      PATH: `${path.dirname(process.execPath)};C:\\Windows\\System32;C:\\Windows`,
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: root, TMP: root, TMPDIR: root,
      XDG_CONFIG_HOME: path.join(layout.cache, "recovery-config"), XDG_DATA_HOME: path.join(layout.cache, "recovery-data"),
      XDG_CACHE_HOME: path.join(layout.cache, "recovery-cache"), BUN_INSTALL_CACHE_DIR: path.join(layout.cache, "bun"), npm_config_cache: path.join(layout.cache, "npm"),
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_PRUNE: "1",
      TASK24_INTERNAL_CRASH_TEST: "task24-owned-v1", TASK24_INTERNAL_RECOVERY_PROBE: probeID,
      ...(point ? { TASK24_INTERNAL_CRASH_AT: point, TASK24_INTERNAL_CRASH_MARKER: marker } : {}),
    },
  })
  let exited = false
  void child.exited.then(() => { exited = true })
  const out = boundedText(child.stdout)
  const error = boundedText(child.stderr)
  const deadline = Date.now() + 1_800_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const kill = async () => {
    const stopped = Bun.spawn(["C:\\Windows\\System32\\taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true,
    })
    return stopped.exited
  }
  try {
    if (point) {
      while (!(await Bun.file(marker).exists())) {
        if (exited) throw new TypeError(`TASK24_RECOVERY_CHILD_EXITED:${point}:${(await error).slice(-2048)}`)
        if (Date.now() >= deadline) throw new TypeError(`TASK24_RECOVERY_CHECKPOINT_TIMEOUT:${point}`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (await kill() !== 0) throw new TypeError("TASK24_RECOVERY_TREE_TERMINATION_FAILED")
    }
    const exit = await Promise.race([child.exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TypeError("TASK24_RECOVERY_COMMAND_TIMEOUT")), 1_800_000)
    })])
    return { exit, stdout: await out, stderr: await error,
      marker: point ? JSON.parse(await fs.readFile(marker, "utf8")) as unknown : undefined }
  } finally {
    if (timer) clearTimeout(timer)
    if (!exited) { await kill(); await child.exited }
  }
}

async function boundedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes <= 256 * 1024) chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

async function removeOwnedTree(parent: string, target: string): Promise<void> {
  const resolvedTarget = path.resolve(target)
  if (!resolvedTarget.startsWith(path.resolve(parent) + path.sep)) throw new TypeError("TASK24_RECOVERY_CLEANUP_UNSAFE")
  Bun.gc(true)
  for (let attempt = 0; ; attempt++) {
    try { await fs.rm(resolvedTarget, { recursive: true, force: true }); return } catch (cause) {
      if (attempt >= 29 || !(cause instanceof Error && "code" in cause && cause.code === "EBUSY")) throw cause
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}
