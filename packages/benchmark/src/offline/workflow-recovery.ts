import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { materializeTask } from "../corpus/materialize"
import { validateTaskBundle } from "../corpus/validate"
import { prepareWorkflowArm } from "../arms/workflow"
import { startBroker } from "../broker/server"
import { BrokerLedger } from "../broker/ledger"
import { compilePriceBook } from "../broker/pricing"
import { canonicalJson } from "../campaign/canonical"
import { bindEvidenceFile, verifyEvidenceFile } from "../evaluator/evidence"
import { decodeRetainedEvidence } from "./evidence"
import { sha256File } from "../hash"
import { Task24Root, type Task24Layout } from "../root"
import type { SealedCampaign } from "../schema"
import { createFakeProvider } from "./fake-provider"
import { publishImmutable } from "./atomic"
import { scanDurableText } from "./security"

/** Restarts the measured production server twice, preserving one active workflow. */
export async function runWorkflowRecovery(layout: Task24Layout, campaign: SealedCampaign, evidenceFile: string) {
  const runID = `workflow-recovery-${crypto.randomUUID().replaceAll("-", "")}`
  const markerRoot = path.join(layout.tmp, runID)
  const markerFile = path.join(markerRoot, "checkpoint.json")
  const resultRoot = path.join(layout.runs, "offline", campaign.sha256)
  const proof = path.join(resultRoot, "workflow-proof")
  await fs.mkdir(markerRoot)
  await fs.mkdir(proof, { recursive: true })
  const bundleRoot = path.join(layout.assets, "tasks", "private-analytics-dashboard")
  const bundle = await validateTaskBundle(bundleRoot)
  const materialized = await materializeTask({ layout, bundleRoot, campaignID: campaign.id, runID })
  const fake = createFakeProvider()
  const prices = compilePriceBook(campaign.pricing)
  const broker = await startBroker({ database: path.join(proof, "broker.sqlite"), campaignID: campaign.id, runID,
    expiresAt: Date.now() + 3_600_000, maximumCalls: 12, prices, ceilings: { CNY: 10_000_000_000n, USD: 10_000_000_000n },
    providerKeys: { kimi: "sk-TASK24_FAKE_KIMI", deepseek: "sk-TASK24_FAKE_DEEPSEEK" }, upstream: fake.upstream })
  let stop: (() => Promise<void>) | undefined
  try {
    const binary = { ...campaign.binaries.modified, runtime: "modified" as const, executable: "D:\\OpenCode-Local\\bin\\opencode-local.exe" }
    if (await sha256File(binary.executable) !== binary.sha256) throw new TypeError("TASK24_WORKFLOW_RECOVERY_BINARY_CHANGED")
    const launch = await prepareWorkflowArm({ armID: "A", campaignID: campaign.id, runID, binary,
      roots: { runRoot: materialized.runRoot, ...materialized.roots }, prompt: bundle.manifest.prompt,
      referenceFiles: [], brokerOrigin: broker.origin, brokerGrant: broker.grant, grantExpiresAt: Date.now() + 3_600_000,
      deterministicOfflineEvidence: true, budget: campaign.preregistration.budget })
    const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = reserve.port
    await reserve.stop(true)
    const origin = `http://127.0.0.1:${port}`
    const headers = { "content-type": "application/json", "idempotency-key": runID,
      "x-opencode-directory": encodeURIComponent(launch.cwd) }
    const request = { prompt: bundle.manifest.prompt, budget: { maxTokens: 20_000, maxTurns: 20, maxToolCalls: 40, maxAttempts: 3, maxDurationMs: 1_800_000 },
      visual: { maxRevisions: 1, maxTokens: 12_000, maxTurns: 12, maxToolCalls: 24 }, delivery: "background" }
    const logs: string[] = []
    const boot = async (index: number, point?: string) => {
      const child = Bun.spawn([launch.executable, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: launch.cwd, env: { ...launch.environment, ...(point ? { TASK24_INTERNAL_CRASH_TEST: "task24-owned-v1",
          TASK24_INTERNAL_WORKFLOW_CRASH_AT: point, TASK24_INTERNAL_WORKFLOW_CRASH_MARKER: markerFile } : {}) },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      })
      const output = drain(child.stdout), error = drain(child.stderr)
      let stopped = false
      stop = async () => {
        if (stopped) return
        stopped = true
        const killed = Bun.spawn(["C:\\Windows\\System32\\taskkill.exe", "/PID", String(child.pid), "/T", "/F"],
          { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true })
        await killed.exited
        await child.exited
        for (const [suffix, body] of [["stdout", await output], ["stderr", await error]]) {
          const file = path.join(proof, `server-${index}.${suffix}`)
          await publishImmutable(file, body || "\n")
          logs.push(file)
        }
      }
      await until(async () => {
        const response = await fetch(`${origin}/api/workflow`, { headers, signal: AbortSignal.timeout(1_000) }).catch(() => undefined)
        return response?.ok === true
      }, 60_000)
      return child.pid
    }
    const admit = async () => json(`${origin}/api/workflow/visual-build`, { method: "POST", headers, body: JSON.stringify(request) })
    await boot(0, "workflow-stage-settled")
    const admitted = await admit()
    const workflowID = admitted.data?.workflow?.id
    if (typeof workflowID !== "string") throw new TypeError("TASK24_WORKFLOW_RECOVERY_ADMISSION_INVALID")
    await until(() => Bun.file(markerFile).exists(), 120_000)
    const seedMarker = JSON.parse(await fs.readFile(markerFile, "utf8"))
    const before = broker.ledger.records()
    if (before.length !== 1 || broker.ledger.disposition() !== "settled") throw new TypeError("TASK24_WORKFLOW_RECOVERY_NOT_QUIESCENT")
    await stop!()
    await fs.rm(markerFile)
    await boot(1, "workflow-recovery-reentry")
    await until(() => Bun.file(markerFile).exists(), 120_000)
    const recoveryMarker = JSON.parse(await fs.readFile(markerFile, "utf8"))
    if (seedMarker.workflowID !== workflowID || recoveryMarker.workflowID !== workflowID || seedMarker.stageID !== recoveryMarker.stageID ||
      canonicalJson(broker.ledger.records()) !== canonicalJson(before)) throw new TypeError("TASK24_WORKFLOW_RECOVERY_AUTHORITY_CHANGED")
    await stop!()
    await fs.rm(markerFile)
    await boot(2)
    const reentered = await admit()
    if (reentered.data?.workflow?.id !== workflowID) throw new TypeError("TASK24_WORKFLOW_RECOVERY_DUPLICATE_ADMISSION")
    let detail: any
    await until(async () => { detail = await json(`${origin}/api/workflow/${workflowID}`, { headers }); return detail.data?.run?.status === "succeeded" }, 180_000)
    const listed = await json(`${origin}/api/workflow`, { headers })
    const after = broker.ledger.records()
    const replayed = await admit()
    if (listed.data?.length !== 1 || replayed.data?.workflow?.id !== workflowID ||
      canonicalJson(broker.ledger.records()) !== canonicalJson(after) || canonicalJson(after.slice(0, before.length)) !== canonicalJson(before) ||
      broker.ledger.disposition() !== "settled" || new Set(fake.calls().map((call) => `${call.workflowRole}/${call.workflowRevision}`)).size !== fake.calls().length ||
      detail.data.stages.some((stage: any) => stage.attempt > 1)) throw new TypeError("TASK24_WORKFLOW_RECOVERY_CONFLICT")
    await stop!()
    stop = undefined
    const database = await snapshotDatabase(materialized.roots.data, proof, workflowID)
    const stateFile = path.join(proof, "workflow.json")
    await publishImmutable(stateFile, canonicalJson({ detail: detail.data, seedMarker, recoveryMarker }) + "\n")
    await scanDurableText(logs, [broker.grant, "sk-TASK24_FAKE_"])
    const evidence = [...logs.map((file) => bindEvidenceFile(proof, file, "workflow-log")),
      bindEvidenceFile(proof, database, "workflow-database"), bindEvidenceFile(proof, stateFile, "workflow-state")]
    await publishImmutable(evidenceFile, canonicalJson({ schemaVersion: 1, caseID: "during_workflow_recovery",
      execution: "exact-offline-command", workflowExecution: "exact-production-workflow-restart", campaignID: campaign.id, campaignSha256: campaign.sha256,
      binaryLocks: campaign.binaries, runID, workflowID, proof, evidence, beforeLedger: before, afterLedger: after,
      outcome: "completed", duplicateDispatches: 0, conflictingResults: 0 }) + "\n")
    return { caseID: "during_workflow_recovery" as const, execution: "exact-offline-command" as const, outcome: "completed" as const,
      duplicateDispatches: 0 as const, conflictingResults: 0 as const, evidenceFile, evidenceSha256: await sha256File(evidenceFile) }
  } finally {
    if (stop) await stop()
    await broker[Symbol.asyncDispose]()
    await fs.rm(markerRoot, { recursive: true, force: true })
  }
}

export async function verifyWorkflowRecoveryEvidence(value: any, campaign: SealedCampaign) {
  const layout = Task24Root.ensure()
  if (value.workflowExecution !== "exact-production-workflow-restart" || value.proof !== path.join(layout.runs, "offline", campaign.sha256, "workflow-proof") ||
    value.campaignSha256 !== campaign.sha256 || value.campaignID !== campaign.id || !Array.isArray(value.evidence) || value.evidence.length !== 8 ||
    canonicalJson(value.binaryLocks) !== canonicalJson(campaign.binaries)) throw new TypeError("TASK24_WORKFLOW_RECOVERY_EVIDENCE_INVALID")
  for (const reference of decodeRetainedEvidence(value.evidence)) verifyEvidenceFile(value.proof, reference)
  const database = new Database(path.join(value.proof, "workflow.sqlite"), { readonly: true })
  try {
    const runs = database.query<{ id: string; status: string }, []>("SELECT id,status FROM workflow_run").all()
    if (runs.length !== 1 || runs[0]?.id !== value.workflowID || runs[0]?.status !== "succeeded" ||
      database.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM workflow_stage WHERE attempt > 1").get()?.total !== 0) throw new TypeError("TASK24_WORKFLOW_RECOVERY_STATE_INVALID")
  } finally { database.close() }
  const ledger = BrokerLedger.open({ database: path.join(value.proof, "broker.sqlite"), prices: compilePriceBook(campaign.pricing), ceilings: { CNY: 10_000_000_000n, USD: 10_000_000_000n } })
  try {
    if (ledger.disposition() !== "settled" || canonicalJson(ledger.records()) !== canonicalJson(value.afterLedger) ||
      canonicalJson(value.afterLedger.slice(0, value.beforeLedger.length)) !== canonicalJson(value.beforeLedger)) throw new TypeError("TASK24_WORKFLOW_RECOVERY_LEDGER_INVALID")
  } finally { ledger.close() }
}

async function snapshotDatabase(root: string, proof: string, workflowID: string): Promise<string> {
  for await (const relative of new Bun.Glob("**/*.{db,sqlite}").scan({ cwd: root, onlyFiles: true })) {
    const file = path.join(root, relative)
    const database = new Database(file, { readonly: true })
    try {
      const run = database.query<{ id: string }, [string]>("SELECT id FROM workflow_run WHERE id=?").get(workflowID)
      if (run) {
        const target = path.join(proof, "workflow.sqlite")
        await publishImmutable(target, database.serialize())
        return target
      }
    } catch { /* Other application databases do not own workflow tables. */ }
    finally { database.close() }
  }
  throw new TypeError("TASK24_WORKFLOW_RECOVERY_DATABASE_MISSING")
}

async function json(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new TypeError(`TASK24_WORKFLOW_RECOVERY_HTTP:${response.status}`)
  return response.json()
}
async function until(check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    if (Date.now() >= deadline) throw new TypeError("TASK24_WORKFLOW_RECOVERY_TIMEOUT")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes < 1024 * 1024) chunks.push(next.value) } }
  finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString("utf8")
}
