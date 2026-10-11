import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { collectDirectOutput, prepareDirectArm } from "../arms/direct"
import { superviseProcess } from "../arms/process"
import type { BinaryAuthority } from "../arms/types"
import { prepareWorkflowArm, workflowRoutes } from "../arms/workflow"
import { compilePriceBook, type ProviderUsage } from "../broker/pricing"
import { BrokerLedger } from "../broker/ledger"
import { startBroker } from "../broker/server"
import { validateCandidateAtLayout } from "../campaign/candidate"
import { canonicalJson } from "../campaign/canonical"
import { sealCampaign } from "../campaign/seal"
import { materializeTask, treeHash } from "../corpus/materialize"
import { validateTaskBundle } from "../corpus/validate"
import { loadBrowserRelease, makeBrowserRuntime } from "../evaluator/browser-runtime"
import { sha256File, sha256Text } from "../hash"
import { reportCsv } from "../report/csv"
import { reportHtml } from "../report/html"
import { reportJson } from "../report/json"
import { decodeReportModel, type ReportModel, type RunReport } from "../report/model"
import type { Task24Layout } from "../root"
import { Scheduler } from "../run/scheduler"
import { recoverExpiredRuns } from "../run/lease"
import { planCampaignRuns } from "../run/plan"
import { RunStore } from "../run/store"
import { task24CrashCheckpoint } from "../run/crash-hook"
import type { SealedCampaign } from "../schema"
import { aggregateArms } from "../statistics/aggregate"
import { clusteredBootstrap, type RunObservation } from "../statistics/bootstrap"
import { createFakeProvider, type FakeProviderCall } from "./fake-provider"
import { classifyOfflineRejection, expectedOfflineCalls } from "./outcome"
import { runRecoveryMatrix, verifyRecoveryMatrix, type RecoveryCaseResult } from "./recovery"
import { runSecurityAcceptance, scanDurableText, type SecurityAcceptanceResult } from "./security"
import { evaluateOfflineWorkspace, offlineEvaluatorSha256 } from "./evaluator"
import { publishImmutable, recoverAtomicTree } from "./atomic"
import { offlineRuns, offlinePointerName, recoveryProbeID, scopeRecoveryCampaign } from "./probe"
import { decodeRetainedEvidence, verifyEvaluationEvidence, workspaceDirectoryExists } from "./evidence"
import { verifyEvidenceFile } from "../evaluator/evidence"
import { verifyFairnessFingerprint } from "../campaign/fairness"

const modifiedExecutable = "D:\\OpenCode-Local\\bin\\opencode-local.exe"
const benchmarkArmIDs = ["A", "B", "C", "D", "E"] as const

export interface OfflineCampaignSummary {
  readonly schemaVersion: 1
  readonly command: "run"
  readonly stage: "offline"
  readonly campaignID: string
  readonly campaignSha256: string
  readonly runCount: number
  readonly completedRuns: number
  readonly providerCalls: number
  readonly protocolCalls: Readonly<{ chat_completions: number; responses: number }>
  readonly armRuns: Readonly<Record<"A" | "B" | "C" | "D" | "E", number>>
  readonly uniqueWorkspaces: number
  readonly binaryProcesses: number
  readonly binaryExecution: "exact"
  readonly browserCaptures: number
  readonly recovery: readonly RecoveryCaseResult[]
  readonly security: SecurityAcceptanceResult
  readonly resultRoot: string
  readonly reportModel: string
  readonly reportModelSha256: string
  readonly paidProviderCalls: 0
}

export interface OfflineReportSummary {
  readonly schemaVersion: 1
  readonly command: "report"
  readonly stage: "offline"
  readonly campaignID: string
  readonly campaignSha256: string
  readonly root: string
  readonly json: string
  readonly csv: string
  readonly html: string
  readonly pdf: string
  readonly reportModelSha256: string
  readonly hashes: Readonly<Record<"json" | "csv" | "html" | "pdf", string>>
  readonly captures: number
  readonly renderer: "chromium-double-render"
  readonly reproductionSha256: string
}

interface OfflineRunCheckpoint {
  readonly providerCalls: number
  readonly protocolCalls: Readonly<{ chat_completions: number; responses: number }>
  readonly providerTotals: Readonly<{ CNY: string; USD: string }>
  readonly browserCaptures: number
  readonly observation: RunObservation
  readonly reportRun: RunReport
}

export async function preflightOfflineCampaign(layout: Task24Layout) {
  const validation = await validateCandidateAtLayout(layout)
  const campaign = await candidate(layout)
  await assertEvaluatorLock(campaign)
  const runs = offlineRuns(campaign)
  const modified = await binaryStatus(modifiedExecutable, campaign.binaries.modified.sha256)
  const upstream = await binaryStatus(upstreamExecutable(layout), campaign.binaries.upstream.sha256)
  const provisional = isProvisional(campaign)
  if (provisional) throw new TypeError("TASK24_OFFLINE_BINARY_LOCK_PROVISIONAL")
  if (!modified.matches || !upstream.matches) throw new TypeError("TASK24_OFFLINE_BINARY_LOCK_MISMATCH")
  return Object.freeze({
    schemaVersion: 1 as const,
    command: "preflight" as const,
    stage: "offline" as const,
    campaignID: campaign.id,
    campaignSha256: campaign.sha256,
    candidateSha256: validation.candidateSha256,
    taskCount: campaign.tasks.length,
    runCount: runs.length,
    expectedProviderCalls: expectedProviderCalls(campaign, runs),
    maxConcurrency: campaign.preregistration.maxConcurrency,
    paidProviderCalls: 0 as const,
    outboundPolicy: "loopback-fake-provider-only" as const,
    provisionalBinaries: provisional,
    binaries: { modified, upstream },
  })
}

export async function verifyOfflineAcceptanceForSeal(layout: Task24Layout, campaign: SealedCampaign): Promise<void> {
  if (recoveryProbeID()) throw new TypeError("TASK24_RECOVERY_PROBE_CANNOT_SEAL")
  await validateCandidateAtLayout(layout)
  const currentCandidate = await candidate(layout)
  if (currentCandidate.sha256 !== campaign.sha256 || currentCandidate.id !== campaign.id) {
    throw new TypeError("TASK24_OFFLINE_ACCEPTANCE_CANDIDATE_MISMATCH")
  }
  await assertEvaluatorLock(campaign)
  await assertExactBinaries(campaign, layout)
  const runPointerFile = path.join(layout.runs, "offline", offlinePointerName())
  const runPointerValue = await readJson(runPointerFile)
  if (
    !record(runPointerValue) ||
    runPointerValue.campaignID !== campaign.id ||
    runPointerValue.campaignSha256 !== campaign.sha256 ||
    typeof runPointerValue.summarySha256 !== "string"
  ) {
    throw new TypeError("TASK24_OFFLINE_ACCEPTANCE_RUN_POINTER_INVALID")
  }
  const runSummaryFile = path.join(layout.runs, "offline", campaign.sha256, "summary.json")
  if ((await sha256File(runSummaryFile)) !== runPointerValue.summarySha256) {
    throw new TypeError("TASK24_OFFLINE_ACCEPTANCE_RUN_HASH_MISMATCH")
  }
  const runSummary = await readOfflineSummary(runSummaryFile)
  await verifyRunSummary(layout, runSummaryFile, runSummary)
  if (
    runSummary.recovery.length !== 8 ||
    runSummary.recovery.some((item) => item.duplicateDispatches !== 0 || item.conflictingResults !== 0) ||
    runSummary.security.leaks !== 0 ||
    runSummary.security.rejected < 10 ||
    canonicalJson([...runSummary.security.exactBinaryChecks].toSorted()) !==
      canonicalJson(["exact_binary_external_network", "exact_binary_failed", "exact_binary_incomplete"])
  ) {
    throw new TypeError("TASK24_OFFLINE_ACCEPTANCE_SECURITY_OR_RECOVERY_INVALID")
  }
  const expectedSecurityEvidence = path.join(
    layout.runs,
    "offline",
    campaign.sha256,
    "security",
    "security-acceptance.json",
  )
  if (
    path.resolve(runSummary.security.evidenceFile) !== path.resolve(expectedSecurityEvidence) ||
    (await sha256File(expectedSecurityEvidence)) !== runSummary.security.evidenceSha256
  ) {
    throw new TypeError("TASK24_OFFLINE_ACCEPTANCE_SECURITY_EVIDENCE_INVALID")
  }

  const reportPointerFile = path.join(layout.reports, "offline", offlinePointerName())
  const reportPointerValue = await readJson(reportPointerFile)
  if (
    !record(reportPointerValue) ||
    reportPointerValue.campaignSha256 !== campaign.sha256 ||
    typeof reportPointerValue.summarySha256 !== "string"
  ) {
    throw new TypeError("TASK24_OFFLINE_ACCEPTANCE_REPORT_POINTER_INVALID")
  }
  const reportSummaryFile = path.join(layout.reports, "offline", campaign.sha256, "summary.json")
  if ((await sha256File(reportSummaryFile)) !== reportPointerValue.summarySha256) {
    throw new TypeError("TASK24_OFFLINE_ACCEPTANCE_REPORT_HASH_MISMATCH")
  }
  await verifyReportSummary(layout, reportSummaryFile, await readReportSummary(reportSummaryFile))
}

export async function runOfflineCampaign(layout: Task24Layout): Promise<OfflineCampaignSummary> {
  await validateCandidateAtLayout(layout)
  const campaign = await candidate(layout)
  await assertEvaluatorLock(campaign)
  await assertExactBinaries(campaign, layout)
  const resultRoot = path.join(layout.runs, "offline", campaign.sha256)
  const summaryFile = path.join(resultRoot, "summary.json")
  if (await Bun.file(summaryFile).exists()) {
    const summary = await readOfflineSummary(summaryFile)
    await verifyRunSummary(layout, summaryFile, summary)
    await writePointer(
      path.join(layout.runs, "offline", offlinePointerName()),
      runPointer(summary, await sha256File(summaryFile)),
    )
    return summary
  }
  await fs.mkdir(resultRoot, { recursive: true })
  const releaseCampaignLock = await acquireCampaignLock(resultRoot)
  try {
    const ledgerRoot = path.join(resultRoot, "ledgers")
    const evidenceRoot = path.join(resultRoot, "evidence")
    const evaluationRoot = path.join(resultRoot, "evaluations")
    const checkpointRoot = path.join(resultRoot, "checkpoints")
    await Promise.all([
      fs.mkdir(ledgerRoot, { recursive: true }),
      fs.mkdir(evidenceRoot, { recursive: true }),
      fs.mkdir(evaluationRoot, { recursive: true }),
      fs.mkdir(checkpointRoot, { recursive: true }),
    ])
    await recoverAtomicTree(resultRoot)
    const schedulerRoot = path.join(resultRoot, "scheduler")
    await fs.mkdir(schedulerRoot, { recursive: true })
    const database = path.join(schedulerRoot, "offline.sqlite")
    const store = RunStore.open(database)
    const prices = compilePriceBook(campaign.pricing)
    const runs = offlineRuns(campaign)
    const armRuns = { A: 0, B: 0, C: 0, D: 0, E: 0 }
    const observations: RunObservation[] = []
    const reportRuns: RunReport[] = []
    const evidenceHashes: string[] = []
    const providerTotals = { CNY: 0n, USD: 0n }
    const protocolCalls = { chat_completions: 0, responses: 0 }
    const sensitiveValues = new Set<string>(["sk-TASK24_FAKE_KIMI", "sk-TASK24_FAKE_DEEPSEEK"])
    let providerCalls = 0
    let binaryProcesses = 0
    let browserCaptures = 0
    const browserReleaseRoot = await singleBrowserRelease(layout)
    try {
      store.planCampaign({
        campaignID: campaign.id,
        campaignSha256: campaign.sha256,
        stage: "offline",
        maxConcurrency: 1,
        runs,
      })
      await reconcileOfflineRuns({
        layout,
        campaign,
        runs,
        store,
        ledgerRoot,
        evidenceRoot,
        evaluationRoot,
        checkpointRoot,
        browserReleaseRoot,
        prices,
      })
      for (const run of runs) {
        const evidenceFile = path.join(evidenceRoot, `${run.runID}.json`)
        if (!(await Bun.file(evidenceFile).exists())) continue
        applyCheckpoint(
          await readRunCheckpoint(
            evidenceFile,
            path.join(evaluationRoot, run.runID),
            path.join(ledgerRoot, `${run.runID}.sqlite`),
            prices,
            run,
            campaign,
          ),
          {
            armRuns,
            observations,
            reportRuns,
            evidenceHashes,
            providerTotals,
            protocolCalls,
            addProviderCalls: (count) => (providerCalls += count),
            addBinaryProcesses: (count) => (binaryProcesses += count),
            addBrowserCaptures: (count) => (browserCaptures += count),
          },
          await sha256File(evidenceFile),
        )
      }
      const failed = store.listRuns(campaign.id).filter((run) => run.state === "failed")
      if (failed.length > 0) {
        throw new TypeError(`TASK24_OFFLINE_RECOVERY_TERMINAL:${failed.map((run) => run.runID).join(",")}`)
      }
      const ownerID = `task24-offline-${process.pid}-${crypto.randomUUID()}`
      const scheduler = new Scheduler({ store, ownerID, leaseMs: 3_600_000 })
      while (true) {
        const run = await scheduler.claimNext(campaign.id)
        if (!run) break
        scheduler.advance(run.runID, "materializing")
        const bundleRoot = path.join(layout.assets, "tasks", run.taskID)
        const bundle = await validateTaskBundle(bundleRoot)
        sensitiveValues.add(bundle.manifest.prompt)
        const materialized = await materializeTask({
          layout,
          bundleRoot,
          campaignID: offlineWorkspaceCampaign(campaign),
          runID: run.runID,
        })
        scheduler.advance(run.runID, "ready")
        scheduler.advance(run.runID, "reserved")
        const fake = createFakeProvider()
        const broker = await startBroker({
          database: path.join(ledgerRoot, `${run.runID}.sqlite`),
          campaignID: campaign.id,
          runID: run.runID,
          expiresAt: Date.now() + 3_600_000,
          maximumCalls: run.armID === "A" ? 12 : 2,
          ceilings: { CNY: 10_000_000_000n, USD: 10_000_000_000n },
          prices,
          providerKeys: { kimi: "sk-TASK24_FAKE_KIMI", deepseek: "sk-TASK24_FAKE_DEEPSEEK" },
          upstream: fake.upstream,
        })
        try {
          sensitiveValues.add(broker.grant)
          const binary = binaryFor(campaign, layout, run.armID)
          const references = bundle.manifest.publicAssets.map((file) => `assets/${file.path}`)
          const common = {
            armID: run.armID,
            campaignID: campaign.id,
            runID: run.runID,
            binary,
            roots: { runRoot: materialized.runRoot, ...materialized.roots },
            prompt: bundle.manifest.prompt,
            referenceFiles: references,
            brokerOrigin: broker.origin,
            brokerGrant: broker.grant,
            grantExpiresAt: Date.now() + 3_600_000,
            deterministicOfflineEvidence: run.armID === "A",
            budget: campaign.preregistration.budget,
          } as const
          const launch = run.armID === "A" ? await prepareWorkflowArm(common) : await prepareDirectArm(common)
          scheduler.advance(run.runID, "running")
          store.beginAttempt(run.runID, `attempt-${run.runID}`, Date.now())
          const stdoutFile = path.join(evidenceRoot, `${run.runID}.stdout`)
          const stderrFile = path.join(evidenceRoot, `${run.runID}.stderr`)
          const processResult = await superviseProcess({
            executable: launch.executable,
            expectedExecutableSha256: launch.snapshot.executableSha256,
            args: launch.args,
            cwd: launch.cwd,
            environment: launch.environment,
            stdoutFile,
            stderrFile,
            maximumCaptureBytes: 4 * 1024 * 1024,
            maximumDurationMs: Math.min(campaign.preregistration.budget.maxDurationMs, 600_000),
          })
          const stdout = await fs.readFile(stdoutFile, "utf8")
          const calls = fake.calls()
          const postRunTreeSha256 = await treeHash(materialized.roots.repo)
          const rejected = classifyOfflineRejection({
            armID: run.armID,
            kind: bundle.manifest.kind,
            classification: processResult.classification,
            exitCode: processResult.exitCode,
            stdout,
            calls,
            unchanged: materialized.preRunTreeSha256 === postRunTreeSha256,
          })
          const execution =
            rejected ??
            (run.armID === "A"
              ? validateWorkflowBinary(stdout, calls)
              : await validateDirectBinary(stdout, materialized.roots.repo, calls))
          await scanDurableText([stdoutFile, stderrFile], [bundle.manifest.prompt, broker.grant, "sk-TASK24_FAKE_"])
          const ledger = broker.ledger.records()
          if (
            ledger.length !== calls.length ||
            ledger.some((record) => record.resultClass !== "completed" || !record.usage)
          ) {
            throw new TypeError("TASK24_OFFLINE_LEDGER_INCOMPLETE")
          }
          const family = campaign.tasks.find((task) => task.id === run.taskID)?.family
          if (!family) throw new TypeError("TASK24_OFFLINE_TASK_FAMILY_MISSING")
          const processCheckpoint = {
            schemaVersion: 1,
            runID: run.runID,
            taskID: run.taskID,
            armID: run.armID,
            repetition: run.repetition,
            family,
            preRunTreeSha256: materialized.preRunTreeSha256,
            postRunTreeSha256,
            launchSha256: sha256Text(canonicalJson(launch.snapshot)),
            binaryProcess: {
              classification: processResult.classification,
              exitCode: processResult.exitCode,
              executableSha256: processResult.executableSha256,
              durationMs: processResult.durationMs,
              stdoutBytes: processResult.stdoutBytes,
              stderrBytes: processResult.stderrBytes,
              stdoutSha256: await sha256File(stdoutFile),
              stderrSha256: await sha256File(stderrFile),
              ...execution,
            },
            protocolCalls: calls.map((call) => ({
              provider: call.provider,
              model: call.model,
              protocol: call.protocol,
            })),
            ledger,
          }
          const processCheckpointFile = path.join(checkpointRoot, `${run.runID}.process.json`)
          await publishImmutable(processCheckpointFile, canonicalJson(processCheckpoint) + "\n")
          await task24CrashCheckpoint("after_terminal_usage")
          const evaluation = await evaluateOfflineWorkspace({
            layout,
            campaign,
            bundle,
            runID: run.runID,
            armID: run.armID,
            binary,
            roots: materialized.roots,
            preRunTreeSha256: materialized.preRunTreeSha256,
            postRunTreeSha256,
            evaluationRoot: path.join(evaluationRoot, run.runID),
            browserReleaseRoot,
          })
          const observation: RunObservation = Object.freeze({
            taskID: run.taskID,
            family,
            armID: run.armID,
            repeat: run.repetition,
            qualifiedSuccess: evaluation.score.qualifiedSuccess,
            functionalSuccess: evaluation.score.functional === 45,
            diagnosticScore: evaluation.score.diagnosticTotal,
          })
          const usage = totalUsage(ledger.map((record) => record.usage!))
          const reportRun: RunReport = Object.freeze({
            runID: run.runID,
            taskID: run.taskID,
            family,
            armID: run.armID,
            qualifiedSuccess: evaluation.score.qualifiedSuccess,
            functionalSuccess: evaluation.score.functional === 45,
            firstPassFunctionalSuccess: evaluation.score.functional === 45,
            firstPassVisualSuccess:
              evaluation.score.visualComposite >= campaign.preregistration.visualQualifiedThreshold,
            diagnosticScore: evaluation.score.diagnosticTotal,
            visualComposite: evaluation.score.visualComposite,
            durationMs: processResult.durationMs,
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            toolCalls: execution.toolCalls,
            retries: 0,
            revisionLoops: rejected ? 0 : run.armID === "A" ? 1 : 0,
            changedFiles: evaluation.changedFiles,
            recoveryCount: 0,
            costCnyMicros: runCostCny(ledger, campaign.exchangeRate.decimalRate).toString(),
            failureCategory: rejected?.failureCategory ?? null,
          })
          const checkpoint: OfflineRunCheckpoint = Object.freeze({
            providerCalls: calls.length,
            protocolCalls: Object.freeze({
              chat_completions: calls.filter((call) => call.protocol === "chat_completions").length,
              responses: calls.filter((call) => call.protocol === "responses").length,
            }),
            providerTotals: Object.freeze({
              CNY: ledger
                .filter((record) => record.currency === "CNY")
                .reduce((total, record) => total + BigInt(record.chargedMicros), 0n)
                .toString(),
              USD: ledger
                .filter((record) => record.currency === "USD")
                .reduce((total, record) => total + BigInt(record.chargedMicros), 0n)
                .toString(),
            }),
            browserCaptures: evaluation.captures,
            observation,
            reportRun,
          })
          const evidence = {
            ...processCheckpoint,
            processCheckpointSha256: await sha256File(processCheckpointFile),
            evaluation: {
              evidenceSha256: evaluation.evidenceSha256,
              score: evaluation.score,
              changedFiles: evaluation.changedFiles,
              captures: evaluation.captures,
            },
            checkpoint,
          }
          const evidenceBody = canonicalJson(evidence) + "\n"
          const evidenceFile = path.join(evidenceRoot, `${run.runID}.json`)
          await publishImmutable(evidenceFile, evidenceBody)
          const evidenceSha256 = sha256Text(evidenceBody)
          store.finishAttempt(`attempt-${run.runID}`, "completed", Date.now())
          scheduler.advance(run.runID, "evaluating")
          store.recordEvaluation(run.runID, campaign.evaluator.sha256, evidenceSha256, Date.now())
          scheduler.advance(run.runID, "completed")
          scheduler.release(run.runID)
          applyCheckpoint(
            checkpoint,
            {
              armRuns,
              observations,
              reportRuns,
              evidenceHashes,
              providerTotals,
              protocolCalls,
              addProviderCalls: (count) => (providerCalls += count),
              addBinaryProcesses: (count) => (binaryProcesses += count),
              addBrowserCaptures: (count) => (browserCaptures += count),
            },
            evidenceSha256,
          )
        } finally {
          await broker[Symbol.asyncDispose]()
          await removeRunWorkspace(layout, materialized.runRoot)
        }
      }
    } finally {
      store.close()
    }
    if (reportRuns.length !== runs.length) throw new TypeError("TASK24_OFFLINE_RECOVERY_INCOMPLETE")
    const recovery = recoveryProbeID() ? [] : await runRecoveryMatrix(layout, path.join(resultRoot, "recovery"))
    const security = await runSecurityAcceptance(layout, prices, {
      modified: binaryFor(campaign, layout, "C"),
      upstream: binaryFor(campaign, layout, "E"),
      evidenceRoot: path.join(resultRoot, "security"),
    })
    const model = makeReportModel(campaign, observations, reportRuns, evidenceHashes, providerTotals)
    const reportModelFile = path.join(resultRoot, "report-model.json")
    await publishImmutable(reportModelFile, reportJson(model))
    const reportModelSha256 = await sha256File(reportModelFile)
    const summary: OfflineCampaignSummary = Object.freeze({
      schemaVersion: 1,
      command: "run",
      stage: "offline",
      campaignID: campaign.id,
      campaignSha256: campaign.sha256,
      runCount: runs.length,
      completedRuns: reportRuns.length,
      providerCalls,
      protocolCalls: Object.freeze({ ...protocolCalls }),
      armRuns: Object.freeze({ ...armRuns }),
      uniqueWorkspaces: reportRuns.length,
      binaryProcesses,
      binaryExecution: "exact",
      browserCaptures,
      recovery,
      security,
      resultRoot,
      reportModel: reportModelFile,
      reportModelSha256,
      paidProviderCalls: 0,
    })
    await publishImmutable(summaryFile, canonicalJson(summary) + "\n")
    await writePointer(
      path.join(layout.runs, "offline", offlinePointerName()),
      runPointer(summary, await sha256File(summaryFile)),
    )
    await scanDurableText([resultRoot], [...sensitiveValues, "TASK24_OFFLINE_FAKE_INPUT"])
    return summary
  } finally {
    await releaseCampaignLock()
  }
}

export async function publishOfflineReports(layout: Task24Layout): Promise<OfflineReportSummary> {
  const pointer = await readJson(path.join(layout.runs, "offline", offlinePointerName()))
  if (!record(pointer) || typeof pointer.campaignSha256 !== "string" || typeof pointer.summarySha256 !== "string")
    throw new TypeError("TASK24_OFFLINE_POINTER_INVALID")
  const resultRoot = path.join(layout.runs, "offline", pointer.campaignSha256)
  const runSummaryFile = path.join(resultRoot, "summary.json")
  if ((await sha256File(runSummaryFile)) !== pointer.summarySha256)
    throw new TypeError("TASK24_OFFLINE_SUMMARY_HASH_MISMATCH")
  const runSummary = await readOfflineSummary(runSummaryFile)
  await verifyRunSummary(layout, runSummaryFile, runSummary)
  const model = decodeReportModel(await readJson(path.join(resultRoot, "report-model.json")))
  const root = path.join(layout.reports, "offline", pointer.campaignSha256)
  const summaryFile = path.join(root, "summary.json")
  await fs.mkdir(path.join(layout.reports, "offline"), { recursive: true })
  const releaseReportLock = await acquireCampaignLock(path.join(layout.reports, "offline"))
  try {
    if (await Bun.file(summaryFile).exists()) {
      const summary = await readReportSummary(summaryFile)
      await verifyReportSummary(layout, summaryFile, summary)
      await writePointer(path.join(layout.reports, "offline", offlinePointerName()), {
        schemaVersion: 1,
        campaignSha256: summary.campaignSha256,
        summarySha256: await sha256File(summaryFile),
      })
      return summary
    }
    if (fsSyncExists(root)) await removeOwnedTree(path.join(layout.reports, "offline"), root)
    await fs.mkdir(root, { recursive: true })
    const bodies = { json: reportJson(model), csv: reportCsv(model), html: reportHtml(model) }
    if (bodies.json !== reportJson(model) || bodies.csv !== reportCsv(model) || bodies.html !== reportHtml(model)) {
      throw new TypeError("TASK24_OFFLINE_REPORT_NOT_REPRODUCIBLE")
    }
    const json = path.join(root, "report.json")
    const csv = path.join(root, "report.csv")
    const html = path.join(root, "report.html")
    await Promise.all([
      publishImmutable(json, bodies.json),
      publishImmutable(csv, bodies.csv),
      publishImmutable(html, bodies.html),
    ])
    let pdf: string
    let reproductionSha256: string
    const captures = runSummary.browserCaptures
    const browserRoot = await singleBrowserRelease(layout)
    const release = loadBrowserRelease(browserRoot)
    const reportID = `offline-${pointer.campaignSha256.slice(0, 24)}`
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname
        if (pathname === `/${reportID}/`) return new Response(bodies.html, { headers: { "content-type": "text/html" } })
        return new Response("not found", { status: 404 })
      },
    })
    const render = async (outputName: string) => {
      const browserOutput = path.join(root, outputName)
      const browserTemp = path.join(layout.tmp, `offline-browser-${crypto.randomUUID()}`)
      await Promise.all([fs.mkdir(browserOutput), fs.mkdir(browserTemp)])
      const runtime = makeBrowserRuntime({ release, outputRoot: browserOutput, tempRoot: browserTemp })
      try {
        return await runtime.renderPdf({
          reportID,
          reportURL: `http://127.0.0.1:${server.port}/${reportID}/`,
          evidenceHashes: model.evidenceHashes,
          timeoutMs: 60_000,
          signal: new AbortController().signal,
        })
      } finally {
        await removeOwnedTree(layout.tmp, browserTemp)
      }
    }
    const reproductionRoot = path.join(root, "browser-reproduction")
    try {
      const first = await render("browser")
      const second = await render("browser-reproduction")
      if (first.sha256 !== second.sha256 || first.bytes !== second.bytes) {
        throw new TypeError("TASK24_OFFLINE_PDF_NOT_REPRODUCIBLE")
      }
      pdf = first.pdf
      reproductionSha256 = second.sha256
    } finally {
      await server.stop(true)
      if (fsSyncExists(reproductionRoot)) await removeOwnedTree(root, reproductionRoot)
    }
    const hashes = {
      json: await sha256File(json),
      csv: await sha256File(csv),
      html: await sha256File(html),
      pdf: await sha256File(pdf),
    }
    const summary: OfflineReportSummary = Object.freeze({
      schemaVersion: 1,
      command: "report",
      stage: "offline",
      campaignID: model.campaignID,
      campaignSha256: pointer.campaignSha256,
      root,
      json,
      csv,
      html,
      pdf,
      reportModelSha256: await sha256File(path.join(resultRoot, "report-model.json")),
      hashes: Object.freeze(hashes),
      captures,
      renderer: "chromium-double-render",
      reproductionSha256,
    })
    await publishImmutable(summaryFile, canonicalJson(summary) + "\n")
    await writePointer(path.join(layout.reports, "offline", offlinePointerName()), {
      schemaVersion: 1,
      campaignSha256: pointer.campaignSha256,
      summarySha256: await sha256File(summaryFile),
    })
    const sealed = await candidate(layout)
    await scanDurableText(
      [root],
      ["TASK24_OFFLINE_FAKE_INPUT", "TASK24_BROKER_GRANT_", ...(await campaignPrompts(layout, sealed))],
    )
    return summary
  } finally {
    await releaseReportLock()
  }
}

async function reconcileOfflineRuns(input: {
  readonly layout: Task24Layout
  readonly campaign: SealedCampaign
  readonly runs: ReturnType<typeof planCampaignRuns>
  readonly store: ReturnType<typeof RunStore.open>
  readonly ledgerRoot: string
  readonly evidenceRoot: string
  readonly evaluationRoot: string
  readonly checkpointRoot: string
  readonly browserReleaseRoot: string
  readonly prices: ReturnType<typeof compilePriceBook>
}): Promise<void> {
  const planned = new Map(input.runs.map((run) => [run.runID, run]))
  for (const current of input.store.listRuns(input.campaign.id)) {
    const run = planned.get(current.runID)
    if (!run) throw new TypeError("TASK24_OFFLINE_RECOVERY_PLAN_MISMATCH")
    const evidenceFile = path.join(input.evidenceRoot, `${run.runID}.json`)
    await recoverMissingRunEvidence(input, run, current.state, evidenceFile)
    if (!(await Bun.file(evidenceFile).exists())) {
      if (["failed", "canceled", "rejected_budget"].includes(current.state)) {
        await removeRunWorkspaceIfPresent(input.layout, input.campaign, run.runID)
      }
      continue
    }
    const evaluationRoot = path.join(input.layout.runs, "offline", input.campaign.sha256, "evaluations", run.runID)
    const checkpoint = await readRunCheckpoint(
      evidenceFile,
      evaluationRoot,
      path.join(input.ledgerRoot, `${run.runID}.sqlite`),
      input.prices,
      run,
      input.campaign,
    )
    if (checkpoint.reportRun.runID !== run.runID) throw new TypeError("TASK24_OFFLINE_CHECKPOINT_IDENTITY_MISMATCH")
    let state = input.store.getRun(run.runID)?.state
    if (state === "running") {
      input.store.interruptActiveAttempt(run.runID, Date.now())
      input.store.transition(run.runID, "evaluating", new Date().toISOString())
      state = "evaluating"
    }
    if (state === "evaluating") {
      if (!input.store.hasEvaluation(run.runID)) {
        input.store.recordEvaluation(
          run.runID,
          input.campaign.evaluator.sha256,
          await sha256File(evidenceFile),
          Date.now(),
        )
      }
      input.store.transition(run.runID, "completed", new Date().toISOString())
      state = "completed"
    }
    if (state !== "completed" || !input.store.hasEvaluation(run.runID)) {
      throw new TypeError(`TASK24_OFFLINE_CHECKPOINT_STATE_INVALID:${run.runID}:${state ?? "missing"}`)
    }
    const lease = input.store.lease(run.runID)
    if (lease) input.store.releaseLease(run.runID, lease.ownerID)
    await removeRunWorkspaceIfPresent(input.layout, input.campaign, run.runID)
  }

  const recoverable = input.store
    .listRuns(input.campaign.id)
    .filter(
      (run) => !["planned", "resumable", "completed", "failed", "canceled", "rejected_budget"].includes(run.state),
    )
  if (recoverable.length === 0) return
  let recoveryNow = Date.now()
  for (const run of recoverable) {
    let lease = input.store.lease(run.runID)
    if (!lease) {
      const acquiredAt = Math.max(1, Date.now() - 2)
      if (!input.store.acquireLease(run.runID, `task24-recovery-${process.pid}`, acquiredAt, 1)) {
        throw new TypeError("TASK24_OFFLINE_RECOVERY_LEASE_UNAVAILABLE")
      }
      lease = input.store.lease(run.runID)
    }
    if (!lease) throw new TypeError("TASK24_OFFLINE_RECOVERY_LEASE_MISSING")
    recoveryNow = Math.max(recoveryNow, lease.expiresAt + 1)
  }
  const inspections = new Map<string, Awaited<ReturnType<typeof inspectOfflineRun>>>()
  for (const run of recoverable) inspections.set(run.runID, await inspectOfflineRun(input, run.runID, run.armID))
  await recoverExpiredRuns({
    store: input.store,
    now: recoveryNow,
    inspect: async (runID) => {
      const inspection = inspections.get(runID)
      if (!inspection) throw new TypeError("TASK24_OFFLINE_RECOVERY_INSPECTION_MISSING")
      return inspection
    },
  })
  for (const run of recoverable) {
    const state = input.store.getRun(run.runID)?.state
    if (state === "resumable" || state === "failed" || state === "canceled" || state === "completed") {
      await removeRunWorkspaceIfPresent(input.layout, input.campaign, run.runID)
    }
  }
}

async function recoverMissingRunEvidence(
  input: Parameters<typeof reconcileOfflineRuns>[0],
  run: ReturnType<typeof planCampaignRuns>[number],
  state: string,
  evidenceFile: string,
): Promise<void> {
  if (await Bun.file(evidenceFile).exists()) return
  const processCheckpointFile = path.join(input.checkpointRoot, `${run.runID}.process.json`)
  if (!(await Bun.file(processCheckpointFile).exists())) return
  const processCheckpoint = await readJson(processCheckpointFile)
  if (
    !record(processCheckpoint) ||
    processCheckpoint.schemaVersion !== 1 ||
    processCheckpoint.runID !== run.runID ||
    processCheckpoint.taskID !== run.taskID ||
    processCheckpoint.armID !== run.armID ||
    processCheckpoint.repetition !== run.repetition ||
    typeof processCheckpoint.preRunTreeSha256 !== "string" ||
    typeof processCheckpoint.postRunTreeSha256 !== "string" ||
    !record(processCheckpoint.binaryProcess) ||
    !Array.isArray(processCheckpoint.protocolCalls) ||
    !Array.isArray(processCheckpoint.ledger)
  ) {
    throw new TypeError("TASK24_OFFLINE_PROCESS_CHECKPOINT_INVALID")
  }
  const runRoot = path.join(input.layout.workspaces, offlineWorkspaceCampaign(input.campaign), run.runID)
  const roots = Object.freeze({
    repo: path.join(runRoot, "repo"),
    data: path.join(runRoot, "data"),
    config: path.join(runRoot, "config"),
    cache: path.join(runRoot, "cache"),
    temp: path.join(runRoot, "temp"),
    output: path.join(runRoot, "output"),
  })
  const evaluationRoot = path.join(input.evaluationRoot, run.runID)
  const evaluationFile = path.join(evaluationRoot, "evaluation.json")
  if (!(await Bun.file(evaluationFile).exists())) {
    if ((state !== "running" && state !== "evaluating") || !(await workspaceDirectoryExists(roots.repo))) return
    if ((await treeHash(roots.repo)) !== processCheckpoint.postRunTreeSha256) {
      throw new TypeError("TASK24_OFFLINE_RECOVERY_WORKSPACE_MISMATCH")
    }
    if (fsSyncExists(evaluationRoot)) await removeOwnedTree(input.evaluationRoot, evaluationRoot)
    const bundle = await validateTaskBundle(path.join(input.layout.assets, "tasks", run.taskID))
    await evaluateOfflineWorkspace({
      layout: input.layout,
      campaign: input.campaign,
      bundle,
      runID: run.runID,
      armID: run.armID,
      binary: binaryFor(input.campaign, input.layout, run.armID),
      roots,
      preRunTreeSha256: processCheckpoint.preRunTreeSha256,
      postRunTreeSha256: processCheckpoint.postRunTreeSha256,
      evaluationRoot,
      browserReleaseRoot: input.browserReleaseRoot,
    })
  }
  const evaluation = await readJson(evaluationFile)
  if (
    !record(evaluation) ||
    evaluation.schemaVersion !== 1 ||
    !record(evaluation.score) ||
    !integer(evaluation.changedFiles) ||
    !integer(evaluation.captures) ||
    evaluation.postRunTreeSha256 !== processCheckpoint.postRunTreeSha256 ||
    typeof evaluation.score.qualifiedSuccess !== "boolean" ||
    typeof evaluation.score.functional !== "number" ||
    typeof evaluation.score.diagnosticTotal !== "number" ||
    typeof evaluation.score.visualComposite !== "number"
  ) {
    throw new TypeError("TASK24_OFFLINE_RECOVERY_EVALUATION_INVALID")
  }
  const ledgerService = BrokerLedger.open({
    database: path.join(input.ledgerRoot, `${run.runID}.sqlite`),
    prices: input.prices,
    ceilings: { CNY: 10_000_000_000n, USD: 10_000_000_000n },
  })
  let ledger: ReturnType<typeof ledgerService.records>
  try {
    ledger = ledgerService.records()
  } finally {
    ledgerService.close()
  }
  if (canonicalJson(ledger) !== canonicalJson(processCheckpoint.ledger)) {
    throw new TypeError("TASK24_OFFLINE_RECOVERY_LEDGER_MISMATCH")
  }
  const binaryProcess = processCheckpoint.binaryProcess
  if (!integer(binaryProcess.durationMs) || !integer(binaryProcess.toolCalls)) {
    throw new TypeError("TASK24_OFFLINE_PROCESS_CHECKPOINT_INVALID")
  }
  const family = input.campaign.tasks.find((task) => task.id === run.taskID)?.family
  if (!family || processCheckpoint.family !== family) throw new TypeError("TASK24_OFFLINE_TASK_FAMILY_MISSING")
  const capabilityFailure =
    run.armID === "A" && input.campaign.tasks.find((task) => task.id === run.taskID)?.kind === "guardrail"
  if (capabilityFailure)
    classifyOfflineRejection({
      armID: run.armID,
      kind: "guardrail",
      classification: String(binaryProcess.classification),
      exitCode: binaryProcess.exitCode === 1 ? 1 : null,
      stdout: await fs.readFile(path.join(input.evidenceRoot, `${run.runID}.stdout`), "utf8"),
      calls: processCheckpoint.protocolCalls,
      unchanged: processCheckpoint.preRunTreeSha256 === processCheckpoint.postRunTreeSha256,
    })
  const usage = totalUsage(
    ledger.map((item) => {
      if (!item.usage) throw new TypeError("TASK24_OFFLINE_RECOVERY_LEDGER_INCOMPLETE")
      return item.usage
    }),
  )
  const observation: RunObservation = Object.freeze({
    taskID: run.taskID,
    family,
    armID: run.armID,
    repeat: run.repetition,
    qualifiedSuccess: evaluation.score.qualifiedSuccess,
    functionalSuccess: evaluation.score.functional === 45,
    diagnosticScore: evaluation.score.diagnosticTotal,
  })
  const reportRun: RunReport = Object.freeze({
    runID: run.runID,
    taskID: run.taskID,
    family,
    armID: run.armID,
    qualifiedSuccess: evaluation.score.qualifiedSuccess,
    functionalSuccess: evaluation.score.functional === 45,
    firstPassFunctionalSuccess: evaluation.score.functional === 45,
    firstPassVisualSuccess: evaluation.score.visualComposite >= input.campaign.preregistration.visualQualifiedThreshold,
    diagnosticScore: evaluation.score.diagnosticTotal,
    visualComposite: evaluation.score.visualComposite,
    durationMs: binaryProcess.durationMs,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    toolCalls: binaryProcess.toolCalls,
    retries: 0,
    revisionLoops: capabilityFailure ? 0 : run.armID === "A" ? 1 : 0,
    changedFiles: evaluation.changedFiles,
    recoveryCount: 1,
    costCnyMicros: runCostCny(ledger, input.campaign.exchangeRate.decimalRate).toString(),
    failureCategory: capabilityFailure ? "preview_configuration_required" : null,
  })
  const protocols = processCheckpoint.protocolCalls.map((item) => {
    if (!record(item) || (item.protocol !== "chat_completions" && item.protocol !== "responses")) {
      throw new TypeError("TASK24_OFFLINE_PROCESS_CHECKPOINT_INVALID")
    }
    return item.protocol
  })
  const checkpoint: OfflineRunCheckpoint = Object.freeze({
    providerCalls: ledger.length,
    protocolCalls: Object.freeze({
      chat_completions: protocols.filter((item) => item === "chat_completions").length,
      responses: protocols.filter((item) => item === "responses").length,
    }),
    providerTotals: Object.freeze({
      CNY: ledger
        .filter((item) => item.currency === "CNY")
        .reduce((sum, item) => sum + BigInt(item.chargedMicros), 0n)
        .toString(),
      USD: ledger
        .filter((item) => item.currency === "USD")
        .reduce((sum, item) => sum + BigInt(item.chargedMicros), 0n)
        .toString(),
    }),
    browserCaptures: evaluation.captures,
    observation,
    reportRun,
  })
  const evidence = {
    ...processCheckpoint,
    processCheckpointSha256: await sha256File(processCheckpointFile),
    evaluation: {
      evidenceSha256: await sha256File(evaluationFile),
      score: evaluation.score,
      changedFiles: evaluation.changedFiles,
      captures: evaluation.captures,
    },
    checkpoint,
  }
  await publishImmutable(evidenceFile, canonicalJson(evidence) + "\n")
}

async function inspectOfflineRun(
  input: {
    readonly ledgerRoot: string
    readonly prices: ReturnType<typeof compilePriceBook>
  },
  runID: string,
  armID: "A" | "B" | "C" | "D" | "E",
) {
  const database = path.join(input.ledgerRoot, `${runID}.sqlite`)
  let providerDisposition: "none" | "settled" | "unknown" = "none"
  if (await Bun.file(database).exists()) {
    const ledger = BrokerLedger.open({
      database,
      prices: input.prices,
      ceilings: { CNY: 10_000_000_000n, USD: 10_000_000_000n },
    })
    try {
      providerDisposition = ledger.disposition()
    } finally {
      ledger.close()
    }
  }
  return Object.freeze({
    processAlive: false,
    providerDisposition,
    workflowDisposition:
      armID === "A" && providerDisposition !== "none" ? ("unknown" as const) : ("not_applicable" as const),
    workspaceIntact: true,
    evaluationComplete: false,
  })
}

async function readRunCheckpoint(
  evidenceFile: string,
  evaluationRoot: string,
  ledgerDatabase: string,
  prices: ReturnType<typeof compilePriceBook>,
  run: ReturnType<typeof planCampaignRuns>[number],
  campaign: SealedCampaign,
): Promise<OfflineRunCheckpoint> {
  const value = await readJson(evidenceFile)
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.runID !== run.runID ||
    value.taskID !== run.taskID ||
    value.armID !== run.armID ||
    value.repetition !== run.repetition ||
    !record(value.binaryProcess) ||
    !record(value.evaluation) ||
    !Array.isArray(value.protocolCalls) ||
    !Array.isArray(value.ledger) ||
    !record(value.checkpoint)
  ) {
    throw new TypeError("TASK24_OFFLINE_CHECKPOINT_INVALID")
  }
  const expectedBinary =
    run.armID === "D" || run.armID === "E" ? campaign.binaries.upstream.sha256 : campaign.binaries.modified.sha256
  const expectedRejection =
    run.armID === "A" && campaign.tasks.find((task) => task.id === run.taskID)?.kind === "guardrail"
  if (
    value.binaryProcess.executableSha256 !== expectedBinary ||
    value.binaryProcess.classification !== "exited" ||
    value.binaryProcess.exitCode !== (expectedRejection ? 1 : 0) ||
    typeof value.binaryProcess.stdoutSha256 !== "string" ||
    typeof value.binaryProcess.stderrSha256 !== "string"
  ) {
    throw new TypeError("TASK24_OFFLINE_CHECKPOINT_BINARY_INVALID")
  }
  const evidenceRoot = path.dirname(evidenceFile)
  if (
    (await sha256File(path.join(evidenceRoot, `${run.runID}.stdout`))) !== value.binaryProcess.stdoutSha256 ||
    (await sha256File(path.join(evidenceRoot, `${run.runID}.stderr`))) !== value.binaryProcess.stderrSha256
  ) {
    throw new TypeError("TASK24_OFFLINE_CHECKPOINT_STREAM_HASH_MISMATCH")
  }
  if (expectedRejection)
    classifyOfflineRejection({
      armID: run.armID,
      kind: "guardrail",
      classification: value.binaryProcess.classification,
      exitCode: 1,
      stdout: await fs.readFile(path.join(evidenceRoot, `${run.runID}.stdout`), "utf8"),
      calls: value.protocolCalls,
      unchanged: value.preRunTreeSha256 === value.postRunTreeSha256,
    })
  const processCheckpointFile = path.join(path.dirname(evidenceRoot), "checkpoints", `${run.runID}.process.json`)
  if (
    typeof value.processCheckpointSha256 !== "string" ||
    (await sha256File(processCheckpointFile)) !== value.processCheckpointSha256
  ) {
    throw new TypeError("TASK24_OFFLINE_PROCESS_CHECKPOINT_HASH_MISMATCH")
  }
  const processCheckpoint = await readJson(processCheckpointFile)
  const {
    evaluation: _evaluation,
    checkpoint: _checkpoint,
    processCheckpointSha256: _processCheckpointSha256,
    ...evidenceBase
  } = value
  if (canonicalJson(processCheckpoint) !== canonicalJson(evidenceBase)) {
    throw new TypeError("TASK24_OFFLINE_PROCESS_CHECKPOINT_CONTENT_MISMATCH")
  }
  const evaluationFile = path.join(evaluationRoot, "evaluation.json")
  if (
    typeof value.evaluation.evidenceSha256 !== "string" ||
    (await sha256File(evaluationFile)) !== value.evaluation.evidenceSha256
  ) {
    throw new TypeError("TASK24_OFFLINE_CHECKPOINT_EVALUATION_HASH_MISMATCH")
  }
  const evaluationValue = await readJson(evaluationFile)
  verifyEvaluationEvidence(evaluationRoot, evaluationValue)
  if (
    !record(evaluationValue) ||
    evaluationValue.schemaVersion !== 1 ||
    !record(evaluationValue.score) ||
    canonicalJson(value.evaluation.score) !== canonicalJson(evaluationValue.score) ||
    value.evaluation.changedFiles !== evaluationValue.changedFiles ||
    value.evaluation.captures !== evaluationValue.captures ||
    value.postRunTreeSha256 !== evaluationValue.postRunTreeSha256
  ) {
    throw new TypeError("TASK24_OFFLINE_CHECKPOINT_EVALUATION_CONTENT_MISMATCH")
  }
  const scoreIdentity =
    record(evaluationValue.score) && record(evaluationValue.score.identity) ? evaluationValue.score.identity : undefined
  const taskAuthority = campaign.tasks.find((candidate) => candidate.id === run.taskID)
  if (
    !scoreIdentity ||
    !taskAuthority ||
    scoreIdentity.runID !== run.runID ||
    scoreIdentity.armID !== run.armID ||
    scoreIdentity.binarySha256 !== expectedBinary ||
    scoreIdentity.evaluatorSha256 !== campaign.evaluator.sha256 ||
    scoreIdentity.taskSha256 !== taskAuthority.bundleSha256 ||
    scoreIdentity.goldSha256 !== taskAuthority.goldSha256
  ) {
    throw new TypeError("TASK24_OFFLINE_CHECKPOINT_SCORE_IDENTITY_MISMATCH")
  }
  const authority = BrokerLedger.open({
    database: ledgerDatabase,
    prices,
    ceilings: { CNY: 10_000_000_000n, USD: 10_000_000_000n },
  })
  let authoritativeLedger: ReturnType<typeof authority.records>
  try {
    authoritativeLedger = authority.records()
  } finally {
    authority.close()
  }
  if (canonicalJson(value.ledger) !== canonicalJson(authoritativeLedger)) {
    throw new TypeError("TASK24_OFFLINE_CHECKPOINT_LEDGER_MISMATCH")
  }
  const checkpoint = decodeRunCheckpoint(value.checkpoint)
  const task = campaign.tasks.find((candidate) => candidate.id === run.taskID)
  if (!task || !record(value.evaluation.score)) throw new TypeError("TASK24_OFFLINE_CHECKPOINT_CONTENT_MISMATCH")
  const protocols = value.protocolCalls.map((call) => {
    if (!record(call) || (call.protocol !== "chat_completions" && call.protocol !== "responses")) {
      throw new TypeError("TASK24_OFFLINE_CHECKPOINT_PROTOCOL_INVALID")
    }
    return call.protocol
  })
  const costs = { CNY: 0n, USD: 0n }
  const ledgerUsage: ProviderUsage[] = []
  for (const item of value.ledger) {
    if (
      !record(item) ||
      item.resultClass !== "completed" ||
      !record(item.usage) ||
      (item.currency !== "CNY" && item.currency !== "USD") ||
      typeof item.chargedMicros !== "string" ||
      !/^\d+$/.test(item.chargedMicros)
    ) {
      throw new TypeError("TASK24_OFFLINE_CHECKPOINT_LEDGER_INVALID")
    }
    if (item.campaignID !== campaign.id || item.runID !== run.runID || typeof item.recordSha256 !== "string") {
      throw new TypeError("TASK24_OFFLINE_CHECKPOINT_LEDGER_IDENTITY_INVALID")
    }
    const usage = item.usage
    if (
      !integer(usage.inputTokens) ||
      !integer(usage.cachedInputTokens) ||
      !integer(usage.outputTokens) ||
      !integer(usage.reasoningTokens) ||
      usage.cachedInputTokens > usage.inputTokens
    ) {
      throw new TypeError("TASK24_OFFLINE_CHECKPOINT_LEDGER_INVALID")
    }
    ledgerUsage.push({
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
    })
    costs[item.currency] += BigInt(item.chargedMicros)
  }
  const usage = totalUsage(ledgerUsage)
  const expectedCalls = expectedOfflineCalls(run.armID, task.kind)
  const expectedChatCalls = expectedRejection
    ? 0
    : run.armID === "A"
      ? 3
      : run.armID === "C" || run.armID === "E"
        ? 2
        : 0
  const expectedResponseCalls = expectedCalls - expectedChatCalls
  if (
    checkpoint.providerCalls !== expectedCalls ||
    checkpoint.protocolCalls.chat_completions !== expectedChatCalls ||
    checkpoint.protocolCalls.responses !== expectedResponseCalls ||
    protocols.length !== checkpoint.providerCalls ||
    checkpoint.protocolCalls.chat_completions !== protocols.filter((item) => item === "chat_completions").length ||
    checkpoint.protocolCalls.responses !== protocols.filter((item) => item === "responses").length ||
    checkpoint.providerTotals.CNY !== costs.CNY.toString() ||
    checkpoint.providerTotals.USD !== costs.USD.toString() ||
    checkpoint.observation.taskID !== run.taskID ||
    checkpoint.observation.family !== task.family ||
    checkpoint.observation.armID !== run.armID ||
    checkpoint.observation.repeat !== run.repetition ||
    checkpoint.reportRun.runID !== run.runID ||
    checkpoint.reportRun.taskID !== run.taskID ||
    checkpoint.reportRun.family !== task.family ||
    checkpoint.reportRun.armID !== run.armID ||
    checkpoint.reportRun.qualifiedSuccess !== checkpoint.observation.qualifiedSuccess ||
    checkpoint.reportRun.functionalSuccess !== checkpoint.observation.functionalSuccess ||
    checkpoint.reportRun.diagnosticScore !== checkpoint.observation.diagnosticScore ||
    checkpoint.reportRun.durationMs !== value.binaryProcess.durationMs ||
    checkpoint.reportRun.inputTokens !== usage.inputTokens ||
    checkpoint.reportRun.cachedInputTokens !== usage.cachedInputTokens ||
    checkpoint.reportRun.outputTokens !== usage.outputTokens ||
    checkpoint.reportRun.qualifiedSuccess !== evaluationValue.score.qualifiedSuccess ||
    checkpoint.reportRun.functionalSuccess !== (evaluationValue.score.functional === 45) ||
    checkpoint.reportRun.diagnosticScore !== evaluationValue.score.diagnosticTotal ||
    checkpoint.reportRun.visualComposite !== evaluationValue.score.visualComposite ||
    checkpoint.reportRun.changedFiles !== evaluationValue.changedFiles ||
    checkpoint.browserCaptures !== evaluationValue.captures
  ) {
    throw new TypeError("TASK24_OFFLINE_CHECKPOINT_CONTENT_MISMATCH")
  }
  if (
    expectedRejection &&
    (checkpoint.reportRun.qualifiedSuccess ||
      checkpoint.reportRun.functionalSuccess ||
      checkpoint.reportRun.changedFiles !== 0 ||
      checkpoint.reportRun.revisionLoops !== 0 ||
      checkpoint.reportRun.failureCategory !== "preview_configuration_required")
  )
    throw new TypeError("TASK24_OFFLINE_CAPABILITY_FAILURE_INVALID")
  return checkpoint
}

function decodeRunCheckpoint(value: Record<string, unknown>): OfflineRunCheckpoint {
  if (
    !exactKeys(value, [
      "providerCalls",
      "protocolCalls",
      "providerTotals",
      "browserCaptures",
      "observation",
      "reportRun",
    ]) ||
    !integer(value.providerCalls) ||
    !record(value.protocolCalls) ||
    !integer(value.protocolCalls.chat_completions) ||
    !integer(value.protocolCalls.responses) ||
    !record(value.providerTotals) ||
    typeof value.providerTotals.CNY !== "string" ||
    typeof value.providerTotals.USD !== "string" ||
    !/^\d+$/.test(value.providerTotals.CNY) ||
    !/^\d+$/.test(value.providerTotals.USD) ||
    !integer(value.browserCaptures) ||
    !record(value.observation) ||
    !record(value.reportRun)
  ) {
    throw new TypeError("TASK24_OFFLINE_CHECKPOINT_INVALID")
  }
  const observation = value.observation
  const reportRun = value.reportRun
  const observationArmID = checkpointArmID(observation.armID)
  const reportArmID = checkpointArmID(reportRun.armID)
  if (
    !exactKeys(observation, [
      "taskID",
      "family",
      "armID",
      "repeat",
      "qualifiedSuccess",
      "functionalSuccess",
      "diagnosticScore",
    ]) ||
    !exactKeys(reportRun, [
      "runID",
      "taskID",
      "family",
      "armID",
      "qualifiedSuccess",
      "functionalSuccess",
      "firstPassFunctionalSuccess",
      "firstPassVisualSuccess",
      "diagnosticScore",
      "visualComposite",
      "durationMs",
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "toolCalls",
      "retries",
      "revisionLoops",
      "changedFiles",
      "recoveryCount",
      "costCnyMicros",
      "failureCategory",
    ]) ||
    typeof observation.taskID !== "string" ||
    typeof observation.family !== "string" ||
    !integer(observation.repeat) ||
    typeof observation.qualifiedSuccess !== "boolean" ||
    typeof observation.functionalSuccess !== "boolean" ||
    !scoreNumber(observation.diagnosticScore) ||
    typeof reportRun.runID !== "string" ||
    typeof reportRun.taskID !== "string" ||
    typeof reportRun.family !== "string" ||
    typeof reportRun.qualifiedSuccess !== "boolean" ||
    typeof reportRun.functionalSuccess !== "boolean" ||
    typeof reportRun.firstPassFunctionalSuccess !== "boolean" ||
    typeof reportRun.firstPassVisualSuccess !== "boolean" ||
    !scoreNumber(reportRun.diagnosticScore) ||
    !scoreNumber(reportRun.visualComposite) ||
    ![
      "durationMs",
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "toolCalls",
      "retries",
      "revisionLoops",
      "changedFiles",
      "recoveryCount",
    ].every((key) => integer(reportRun[key])) ||
    typeof reportRun.costCnyMicros !== "string" ||
    !/^\d+$/.test(reportRun.costCnyMicros) ||
    (reportRun.failureCategory !== null && typeof reportRun.failureCategory !== "string")
  ) {
    throw new TypeError("TASK24_OFFLINE_CHECKPOINT_INVALID")
  }
  return Object.freeze({
    providerCalls: value.providerCalls,
    protocolCalls: Object.freeze({
      chat_completions: value.protocolCalls.chat_completions,
      responses: value.protocolCalls.responses,
    }),
    providerTotals: Object.freeze({ CNY: value.providerTotals.CNY, USD: value.providerTotals.USD }),
    browserCaptures: value.browserCaptures,
    observation: Object.freeze({
      taskID: observation.taskID,
      family: observation.family,
      armID: observationArmID,
      repeat: observation.repeat,
      qualifiedSuccess: observation.qualifiedSuccess,
      functionalSuccess: observation.functionalSuccess,
      diagnosticScore: observation.diagnosticScore,
    }),
    reportRun: Object.freeze({
      runID: reportRun.runID,
      taskID: reportRun.taskID,
      family: reportRun.family,
      armID: reportArmID,
      qualifiedSuccess: reportRun.qualifiedSuccess,
      functionalSuccess: reportRun.functionalSuccess,
      firstPassFunctionalSuccess: reportRun.firstPassFunctionalSuccess,
      firstPassVisualSuccess: reportRun.firstPassVisualSuccess,
      diagnosticScore: reportRun.diagnosticScore,
      visualComposite: reportRun.visualComposite,
      durationMs: checkpointInteger(reportRun.durationMs),
      inputTokens: checkpointInteger(reportRun.inputTokens),
      cachedInputTokens: checkpointInteger(reportRun.cachedInputTokens),
      outputTokens: checkpointInteger(reportRun.outputTokens),
      toolCalls: checkpointInteger(reportRun.toolCalls),
      retries: checkpointInteger(reportRun.retries),
      revisionLoops: checkpointInteger(reportRun.revisionLoops),
      changedFiles: checkpointInteger(reportRun.changedFiles),
      recoveryCount: checkpointInteger(reportRun.recoveryCount),
      costCnyMicros: reportRun.costCnyMicros,
      failureCategory: reportRun.failureCategory,
    }),
  })
}

function checkpointArmID(value: unknown): (typeof benchmarkArmIDs)[number] {
  if (value === "A" || value === "B" || value === "C" || value === "D" || value === "E") return value
  throw new TypeError("TASK24_OFFLINE_CHECKPOINT_INVALID")
}

function checkpointInteger(value: unknown): number {
  if (!integer(value)) throw new TypeError("TASK24_OFFLINE_CHECKPOINT_INVALID")
  return value
}

function applyCheckpoint(
  checkpoint: OfflineRunCheckpoint,
  accumulators: {
    readonly armRuns: Record<"A" | "B" | "C" | "D" | "E", number>
    readonly observations: RunObservation[]
    readonly reportRuns: RunReport[]
    readonly evidenceHashes: string[]
    readonly providerTotals: { CNY: bigint; USD: bigint }
    readonly protocolCalls: { chat_completions: number; responses: number }
    readonly addProviderCalls: (count: number) => void
    readonly addBinaryProcesses: (count: number) => void
    readonly addBrowserCaptures: (count: number) => void
  },
  evidenceSha256: string,
): void {
  if (accumulators.reportRuns.some((run) => run.runID === checkpoint.reportRun.runID)) {
    throw new TypeError("TASK24_OFFLINE_CHECKPOINT_DUPLICATE")
  }
  accumulators.armRuns[checkpoint.reportRun.armID]++
  accumulators.observations.push(checkpoint.observation)
  accumulators.reportRuns.push(checkpoint.reportRun)
  accumulators.evidenceHashes.push(evidenceSha256)
  accumulators.providerTotals.CNY += BigInt(checkpoint.providerTotals.CNY)
  accumulators.providerTotals.USD += BigInt(checkpoint.providerTotals.USD)
  accumulators.protocolCalls.chat_completions += checkpoint.protocolCalls.chat_completions
  accumulators.protocolCalls.responses += checkpoint.protocolCalls.responses
  accumulators.addProviderCalls(checkpoint.providerCalls)
  accumulators.addBinaryProcesses(1)
  accumulators.addBrowserCaptures(checkpoint.browserCaptures)
}

async function acquireCampaignLock(resultRoot: string): Promise<() => Promise<void>> {
  const file = path.join(resultRoot, "campaign.lock")
  if (await Bun.file(file).exists()) {
    const stale = await readJson(file).catch(() => undefined)
    if (!record(stale) || !integer(stale.pid) || typeof stale.token !== "string") {
      throw new TypeError("TASK24_OFFLINE_LOCK_INVALID")
    }
    if (processAlive(stale.pid)) throw new TypeError("TASK24_OFFLINE_ALREADY_RUNNING")
    await fs.rm(file, { force: false })
  }
  const token = crypto.randomUUID()
  await fs.writeFile(file, canonicalJson({ schemaVersion: 1, pid: process.pid, token }) + "\n", { flag: "wx" })
  return async () => {
    if (!(await Bun.file(file).exists())) return
    const current = await readJson(file)
    if (!record(current) || current.pid !== process.pid || current.token !== token) {
      throw new TypeError("TASK24_OFFLINE_LOCK_OWNERSHIP_LOST")
    }
    await fs.rm(file, { force: false })
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code !== "ESRCH"
  }
}

async function removeRunWorkspaceIfPresent(
  layout: Task24Layout,
  campaign: SealedCampaign,
  runID: string,
): Promise<void> {
  const runRoot = path.join(layout.workspaces, offlineWorkspaceCampaign(campaign), runID)
  if (fsSyncExists(runRoot)) await removeRunWorkspace(layout, runRoot)
}

function scoreNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted()
  const orderedExpected = [...expected].toSorted()
  return actual.length === orderedExpected.length && actual.every((key, index) => key === orderedExpected[index])
}

async function candidate(layout: Task24Layout): Promise<SealedCampaign> {
  return scopeRecoveryCampaign(sealCampaign(await readJson(path.join(layout.runs, "preregistration.candidate.json"))))
}

function validateWorkflowBinary(stdout: string, calls: readonly FakeProviderCall[]) {
  let output: unknown
  try {
    output = JSON.parse(stdout.trim())
  } catch {
    throw new TypeError("TASK24_OFFLINE_WORKFLOW_OUTPUT_INVALID")
  }
  if (
    !record(output) ||
    !record(output.workflow) ||
    output.workflow.status !== "succeeded" ||
    !record(output.response) ||
    output.response.status !== "completed" ||
    !Array.isArray(output.artifacts) ||
    !output.artifacts.some((artifact) => record(artifact) && artifact.kind === "workflow.delivery")
  ) {
    throw new TypeError("TASK24_OFFLINE_WORKFLOW_NOT_TERMINAL")
  }
  const expected = [
    ["design", 0],
    ["decompose", 0],
    ["implement", 0],
    ["test", 0],
    ["repair", 1],
    ["test", 1],
    ["visual_review", 1],
    ["deliver", 1],
  ] as const
  if (calls.length !== expected.length) throw new TypeError("TASK24_OFFLINE_WORKFLOW_ROUTE_COUNT_MISMATCH")
  const sealed = new Map(workflowRoutes().map((route) => [route.role, route]))
  for (let index = 0; index < expected.length; index++) {
    const call = calls[index]!
    const [role, revision] = expected[index]!
    const route = sealed.get(role)
    if (
      !route ||
      call.workflowRole !== role ||
      call.workflowRevision !== revision ||
      call.provider !== route.provider ||
      call.model !== route.model ||
      call.protocol !== route.protocol
    ) {
      throw new TypeError(`TASK24_OFFLINE_WORKFLOW_ROUTE_MISMATCH:${role}:${revision}`)
    }
  }
  return Object.freeze({ toolCalls: 0, workflowCalls: calls.length, workflowRoles: expected.map(([role]) => role) })
}

async function validateDirectBinary(stdout: string, repo: string, calls: readonly FakeProviderCall[]) {
  const collected = collectDirectOutput(stdout)
  if (calls.length !== 2 || calls.some((call) => call.workflowRole !== undefined)) {
    throw new TypeError("TASK24_OFFLINE_DIRECT_ROUTE_COUNT_MISMATCH")
  }
  const [first, second] = calls
  if (
    first === undefined ||
    second === undefined ||
    first.provider !== second.provider ||
    first.model !== second.model ||
    first.protocol !== second.protocol ||
    collected.toolCalls !== 1
  ) {
    throw new TypeError("TASK24_OFFLINE_DIRECT_ROUTE_MISMATCH")
  }
  const edit = path.join(repo, "task24-offline-provider-edit.txt")
  if ((await fs.readFile(edit, "utf8")) !== "TASK24_OFFLINE_BINARY_EDIT\n") {
    throw new TypeError("TASK24_OFFLINE_DIRECT_EDIT_MISSING")
  }
  return Object.freeze({ toolCalls: collected.toolCalls, workflowCalls: 0, workflowRoles: [] as string[] })
}

function binaryFor(
  campaign: SealedCampaign,
  layout: Task24Layout,
  armID: "A" | "B" | "C" | "D" | "E",
): BinaryAuthority {
  if (armID === "D" || armID === "E") {
    return { runtime: "upstream", executable: upstreamExecutable(layout), ...campaign.binaries.upstream }
  }
  return { runtime: "modified", executable: modifiedExecutable, ...campaign.binaries.modified }
}

function upstreamExecutable(layout: Task24Layout): string {
  return path.join(layout.toolchain, "upstream", "opencode.exe")
}

function expectedProviderCalls(campaign: SealedCampaign, runs: ReturnType<typeof planCampaignRuns>): number {
  const armIDs = new Set(campaign.arms.map((arm) => arm.id))
  if (benchmarkArmIDs.some((arm) => !armIDs.has(arm))) {
    throw new TypeError("TASK24_OFFLINE_ARM_MATRIX_INCOMPLETE")
  }
  return runs.reduce(
    (sum, run) =>
      sum + expectedOfflineCalls(run.armID, campaign.tasks.find((task) => task.id === run.taskID)?.kind ?? "primary"),
    0,
  )
}

function totalUsage(values: readonly ProviderUsage[]): ProviderUsage {
  return values.reduce(
    (sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + usage.cachedInputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      reasoningTokens: sum.reasoningTokens + usage.reasoningTokens,
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  )
}

function runCostCny(
  records: readonly { readonly currency: "CNY" | "USD"; readonly chargedMicros: string }[],
  usdPerCny: string,
): bigint {
  let cny = 0n
  for (const record of records) {
    const amount = BigInt(record.chargedMicros)
    cny += record.currency === "CNY" ? amount : divideDecimal(amount, usdPerCny)
  }
  return cny
}

function divideDecimal(value: bigint, decimal: string): bigint {
  const [, integer = "0", fraction = ""] = /^(\d+)(?:\.(\d+))?$/.exec(decimal) ?? []
  const denominator = BigInt(integer + fraction)
  const scale = 10n ** BigInt(fraction.length)
  return (value * scale + denominator - 1n) / denominator
}

function makeReportModel(
  campaign: SealedCampaign,
  observations: readonly RunObservation[],
  runs: readonly RunReport[],
  evidenceHashes: readonly string[],
  costs: Readonly<{ CNY: bigint; USD: bigint }>,
): ReportModel {
  const arms = aggregateArms(observations)
  const bootstrap = clusteredBootstrap(observations, { seed: campaign.preregistration.seed, iterations: 10_000 })
  const primaryFamilies = [
    ...new Set(campaign.tasks.filter((task) => task.kind === "primary").map((task) => task.family)),
  ].toSorted()
  const totalCny = costs.CNY + divideDecimal(costs.USD, campaign.exchangeRate.decimalRate)
  const qualified = runs.filter((run) => run.qualifiedSuccess).length
  return decodeReportModel({
    schemaVersion: 1,
    campaignID: campaign.id,
    generatedAt: campaign.createdAt,
    decision: "incomplete",
    decisionReasons: ["OFFLINE_FAKE_PROVIDER_ONLY", "LIVE_PROVIDER_EFFECT_NOT_MEASURED"],
    armSummaries: arms,
    contrasts: bootstrap.contrasts,
    familyChecks: primaryFamilies.map((family) => ({ family, effect: 0 })),
    guardrails: { functionalRegression: 0, securityIncidents: 0, equalBudgets: true },
    cost: {
      kimiCnyMicros: costs.CNY.toString(),
      deepseekUsdMicros: costs.USD.toString(),
      totalCnyMicros: totalCny.toString(),
      costPerQualifiedSuccessCnyMicros:
        qualified === 0 ? null : ((totalCny + BigInt(qualified) - 1n) / BigInt(qualified)).toString(),
      costRatio: null,
    },
    runs: [...runs].toSorted((left, right) => left.runID.localeCompare(right.runID)),
    metadata: {
      campaignSha256: campaign.sha256,
      sourceSha256: sha256Text(canonicalJson(campaign.sources)),
      modifiedBinarySha256: campaign.binaries.modified.sha256,
      upstreamBinarySha256: campaign.binaries.upstream.sha256,
      evaluatorSha256: campaign.evaluator.sha256,
      modelRevisionSha256: sha256Text(canonicalJson(campaign.arms.map((arm) => arm.routes))),
      protocolRevisionSha256: sha256Text(
        canonicalJson(campaign.arms.map((arm) => arm.routes.map((route) => route.protocol))),
      ),
      priceRevisionSha256: sha256Text(canonicalJson(campaign.pricing)),
      exchangeRateSha256: sha256Text(canonicalJson(campaign.exchangeRate)),
    },
    limitations: [
      "This report validates the harness with deterministic fake providers; it does not estimate live model quality.",
      "The visual-build host cannot admit nonvisual guardrail projects; those arm A capability failures are retained, not excluded or repaired with dummy HTML.",
    ],
    exclusions: [],
    harnessFailures: [],
    evidenceHashes: [...evidenceHashes].toSorted(),
  })
}

async function binaryStatus(executable: string, expectedSha256: string) {
  const exists = await Bun.file(executable).exists()
  const actualSha256 = exists ? await sha256File(executable) : null
  return Object.freeze({ executable, expectedSha256, actualSha256, exists, matches: actualSha256 === expectedSha256 })
}

function isProvisional(campaign: SealedCampaign): boolean {
  return (
    campaign.binaries.modified.version.includes("candidate") || campaign.binaries.upstream.version.includes("candidate")
  )
}

async function assertExactBinaries(campaign: SealedCampaign, layout: Task24Layout): Promise<void> {
  if (isProvisional(campaign)) throw new TypeError("TASK24_OFFLINE_BINARY_LOCK_PROVISIONAL")
  const [modified, upstream] = await Promise.all([
    binaryStatus(modifiedExecutable, campaign.binaries.modified.sha256),
    binaryStatus(upstreamExecutable(layout), campaign.binaries.upstream.sha256),
  ])
  if (!modified.matches || !upstream.matches) throw new TypeError("TASK24_OFFLINE_BINARY_LOCK_MISMATCH")
}

function runPointer(summary: OfflineCampaignSummary, summarySha256: string) {
  return {
    schemaVersion: 1,
    campaignID: summary.campaignID,
    campaignSha256: summary.campaignSha256,
    summarySha256,
  }
}

async function verifyRunSummary(
  layout: Task24Layout,
  summaryFile: string,
  summary: OfflineCampaignSummary,
): Promise<void> {
  const campaign = await candidate(layout)
  await assertEvaluatorLock(campaign)
  await assertExactBinaries(campaign, layout)
  const runs = offlineRuns(campaign)
  const expectedArms = runs.reduce(
    (counts, run) => {
      counts[run.armID]++
      return counts
    },
    { A: 0, B: 0, C: 0, D: 0, E: 0 },
  )
  const expectedRoot = path.join(layout.runs, "offline", summary.campaignSha256)
  if (
    summary.campaignID !== campaign.id ||
    summary.campaignSha256 !== campaign.sha256 ||
    path.resolve(summary.resultRoot) !== path.resolve(expectedRoot) ||
    path.resolve(summary.reportModel) !== path.join(path.resolve(expectedRoot), "report-model.json") ||
    !(await Bun.file(summary.reportModel).exists()) ||
    (await sha256File(summary.reportModel)) !== summary.reportModelSha256 ||
    summary.runCount !== runs.length ||
    summary.completedRuns !== summary.runCount ||
    summary.providerCalls !== expectedProviderCalls(campaign, runs) ||
    summary.protocolCalls.chat_completions + summary.protocolCalls.responses !== summary.providerCalls ||
    benchmarkArmIDs.some((armID) => summary.armRuns[armID] !== expectedArms[armID]) ||
    summary.binaryProcesses !== summary.runCount ||
    summary.binaryExecution !== "exact" ||
    path.resolve(summary.security.evidenceFile) !==
      path.resolve(expectedRoot, "security", "security-acceptance.json") ||
    (await sha256File(summary.security.evidenceFile)) !== summary.security.evidenceSha256
  ) {
    throw new TypeError("TASK24_OFFLINE_SUMMARY_INCOMPLETE")
  }
  await verifySecurityEvidence(layout, campaign, summary.security.evidenceFile)
  if (!recoveryProbeID()) await verifyRecoveryMatrix(summary.recovery, campaign, path.join(expectedRoot, "recovery"))
  const model = decodeReportModel(await readJson(summary.reportModel))
  if (model.campaignID !== summary.campaignID || model.runs.length !== summary.runCount) {
    throw new TypeError("TASK24_OFFLINE_SUMMARY_MODEL_MISMATCH")
  }
  const evidenceRoot = path.join(expectedRoot, "evidence")
  const evidenceJSON = (await fs.readdir(evidenceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(evidenceRoot, entry.name))
  const evidenceHashes = (await Promise.all(evidenceJSON.map(sha256File))).toSorted()
  if (
    evidenceJSON.length !== summary.runCount ||
    canonicalJson(evidenceHashes) !== canonicalJson([...model.evidenceHashes].toSorted())
  ) {
    throw new TypeError("TASK24_OFFLINE_EVIDENCE_HASH_MISMATCH")
  }
  const observations: RunObservation[] = []
  const reportRuns: RunReport[] = []
  const costs = { CNY: 0n, USD: 0n }
  const protocols = { chat_completions: 0, responses: 0 }
  const arms = { A: 0, B: 0, C: 0, D: 0, E: 0 }
  let providerCalls = 0
  let browserCaptures = 0
  for (const run of runs) {
    const evidenceFile = path.join(evidenceRoot, `${run.runID}.json`)
    const checkpoint = await readRunCheckpoint(
      evidenceFile,
      path.join(expectedRoot, "evaluations", run.runID),
      path.join(expectedRoot, "ledgers", `${run.runID}.sqlite`),
      compilePriceBook(campaign.pricing),
      run,
      campaign,
    )
    observations.push(checkpoint.observation)
    reportRuns.push(checkpoint.reportRun)
    costs.CNY += BigInt(checkpoint.providerTotals.CNY)
    costs.USD += BigInt(checkpoint.providerTotals.USD)
    protocols.chat_completions += checkpoint.protocolCalls.chat_completions
    protocols.responses += checkpoint.protocolCalls.responses
    arms[run.armID]++
    providerCalls += checkpoint.providerCalls
    browserCaptures += checkpoint.browserCaptures
  }
  const regeneratedModel = makeReportModel(campaign, observations, reportRuns, evidenceHashes, costs)
  if (
    reportJson(regeneratedModel) !== reportJson(model) ||
    providerCalls !== summary.providerCalls ||
    protocols.chat_completions !== summary.protocolCalls.chat_completions ||
    protocols.responses !== summary.protocolCalls.responses ||
    browserCaptures !== summary.browserCaptures ||
    benchmarkArmIDs.some((armID) => arms[armID] !== summary.armRuns[armID])
  ) {
    throw new TypeError("TASK24_OFFLINE_SUMMARY_CONTENT_MISMATCH")
  }
  const pointerFile = path.join(layout.runs, "offline", offlinePointerName())
  if (await Bun.file(pointerFile).exists()) {
    const pointer = await readJson(pointerFile)
    if (
      record(pointer) &&
      pointer.campaignSha256 === summary.campaignSha256 &&
      pointer.summarySha256 !== (await sha256File(summaryFile))
    ) {
      throw new TypeError("TASK24_OFFLINE_SUMMARY_HASH_MISMATCH")
    }
  }
  await scanDurableText(
    [expectedRoot],
    ["sk-TASK24_FAKE_", "TASK24_OFFLINE_FAKE_INPUT", ...(await campaignPrompts(layout, campaign))],
  )
}

async function assertEvaluatorLock(campaign: SealedCampaign): Promise<void> {
  if ((await offlineEvaluatorSha256()) !== campaign.evaluator.sha256) {
    throw new TypeError("TASK24_OFFLINE_EVALUATOR_SOURCE_MISMATCH")
  }
}

async function verifySecurityEvidence(
  layout: Task24Layout,
  campaign: SealedCampaign,
  evidenceFile: string,
): Promise<void> {
  const value = await readJson(evidenceFile)
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.checks) ||
    !Array.isArray(value.exactBinaryChecks)
  ) {
    throw new TypeError("TASK24_OFFLINE_SECURITY_EVIDENCE_INVALID")
  }
  const checks = new Set(value.checks.filter((item): item is string => typeof item === "string"))
  for (const required of [
    "exact_binary_incomplete",
    "exact_binary_failed",
    "exact_binary_external_network",
    "evaluator_sandbox_boundary",
    "log_injection",
  ]) {
    if (!checks.has(required)) throw new TypeError("TASK24_OFFLINE_SECURITY_EVIDENCE_INCOMPLETE")
  }
  const byCheck = new Map<string, Record<string, unknown>>()
  if (!Array.isArray(value.retainedEvidence) || value.retainedEvidence.length < 8)
    throw new TypeError("TASK24_OFFLINE_SECURITY_RETAINED_EVIDENCE_MISSING")
  for (const reference of decodeRetainedEvidence(value.retainedEvidence))
    verifyEvidenceFile(path.dirname(evidenceFile), reference)
  for (const item of value.exactBinaryChecks) {
    if (!record(item) || typeof item.check !== "string" || byCheck.has(item.check)) {
      throw new TypeError("TASK24_OFFLINE_SECURITY_EVIDENCE_INVALID")
    }
    byCheck.set(item.check, item)
  }
  const incomplete = byCheck.get("exact_binary_incomplete")
  const failed = byCheck.get("exact_binary_failed")
  const network = byCheck.get("exact_binary_external_network")
  const sandbox = byCheck.get("evaluator_sandbox_boundary")
  const manifestFile = "D:\\OpenCode-Local\\runtime\\sandbox\\workflow-sandbox.manifest.json"
  const manifest = await readJson(manifestFile)
  if (!record(manifest)) throw new TypeError("TASK24_OFFLINE_SECURITY_SANDBOX_MANIFEST_INVALID")
  const upstream = binaryFor(campaign, layout, "E")
  const modified = binaryFor(campaign, layout, "C")
  if (
    !incomplete ||
    incomplete.binarySha256 !== modified.sha256 ||
    incomplete.resultClass !== "incomplete" ||
    incomplete.rejected !== true ||
    incomplete.logInjectionRedacted !== true ||
    !failed ||
    failed.binarySha256 !== upstream.sha256 ||
    failed.resultClass !== "failed" ||
    failed.rejected !== true ||
    !network ||
    network.binarySha256 !== modified.sha256 ||
    network.exitCode !== 0 ||
    network.networkHits !== 0 ||
    network.explicitlyDenied !== true ||
    network.toolCatalogDenied !== true ||
    !sandbox ||
    sandbox.networkDenied !== true ||
    sandbox.writeDenied !== true ||
    sandbox.dockerSocketAbsent !== true ||
    sandbox.hiddenGoldAbsent !== true ||
    sandbox.vectorAbsent !== true ||
    sandbox.image !== manifest.image ||
    sandbox.engineSha256 !== manifest.engineSha256 ||
    sandbox.manifestSha256 !== (await sha256File(manifestFile))
  ) {
    throw new TypeError("TASK24_OFFLINE_SECURITY_EVIDENCE_CONTENT_MISMATCH")
  }
}

async function campaignPrompts(layout: Task24Layout, campaign: SealedCampaign): Promise<readonly string[]> {
  return Promise.all(
    campaign.tasks.map(async (task) => {
      const bundle = await validateTaskBundle(path.join(layout.assets, "tasks", task.id))
      return bundle.manifest.prompt
    }),
  )
}

async function verifyReportSummary(
  layout: Task24Layout,
  summaryFile: string,
  summary: OfflineReportSummary,
): Promise<void> {
  const expectedRoot = path.join(layout.reports, "offline", summary.campaignSha256)
  const modelFile = path.join(layout.runs, "offline", summary.campaignSha256, "report-model.json")
  if (
    path.resolve(summary.root) !== path.resolve(expectedRoot) ||
    path.resolve(summaryFile) !== path.join(path.resolve(expectedRoot), "summary.json") ||
    path.resolve(summary.json) !== path.join(path.resolve(expectedRoot), "report.json") ||
    path.resolve(summary.csv) !== path.join(path.resolve(expectedRoot), "report.csv") ||
    path.resolve(summary.html) !== path.join(path.resolve(expectedRoot), "report.html") ||
    !strictlyContains(expectedRoot, summary.pdf) ||
    path.basename(summary.pdf) !== "report.pdf" ||
    !(await Bun.file(modelFile).exists()) ||
    (await sha256File(modelFile)) !== summary.reportModelSha256 ||
    summary.renderer !== "chromium-double-render" ||
    summary.reproductionSha256 !== summary.hashes.pdf
  ) {
    throw new TypeError("TASK24_OFFLINE_REPORT_IDENTITY_MISMATCH")
  }
  const model = decodeReportModel(await readJson(modelFile))
  if (model.campaignID !== summary.campaignID) throw new TypeError("TASK24_OFFLINE_REPORT_IDENTITY_MISMATCH")
  const runSummary = await readOfflineSummary(path.join(layout.runs, "offline", summary.campaignSha256, "summary.json"))
  if (summary.captures !== runSummary.browserCaptures) {
    throw new TypeError("TASK24_OFFLINE_REPORT_CAPTURE_MISMATCH")
  }
  for (const [kind, file] of [
    ["json", summary.json],
    ["csv", summary.csv],
    ["html", summary.html],
    ["pdf", summary.pdf],
  ] as const) {
    if (!(await Bun.file(file).exists()) || (await sha256File(file)) !== summary.hashes[kind]) {
      throw new TypeError(`TASK24_OFFLINE_REPORT_HASH_MISMATCH:${kind}`)
    }
  }
  const pdfEvidence = await readJson(path.join(path.dirname(summary.pdf), "evidence.json"))
  if (
    !record(pdfEvidence) ||
    pdfEvidence.schemaVersion !== 1 ||
    pdfEvidence.reportID !== path.basename(path.dirname(summary.pdf)) ||
    pdfEvidence.pdfSha256 !== summary.hashes.pdf ||
    !Array.isArray(pdfEvidence.evidenceHashes) ||
    canonicalJson(pdfEvidence.evidenceHashes) !== canonicalJson([...model.evidenceHashes].toSorted())
  ) {
    throw new TypeError("TASK24_OFFLINE_REPORT_PDF_EVIDENCE_MISMATCH")
  }
  const regenerated = { json: reportJson(model), csv: reportCsv(model), html: reportHtml(model) }
  for (const [kind, file] of [
    ["json", summary.json],
    ["csv", summary.csv],
    ["html", summary.html],
  ] as const) {
    if ((await fs.readFile(file, "utf8")) !== regenerated[kind]) {
      throw new TypeError(`TASK24_OFFLINE_REPORT_REGEN_MISMATCH:${kind}`)
    }
  }
  await scanDurableText([summary.root], ["sk-TASK24_FAKE_", "TASK24_OFFLINE_FAKE_INPUT"])
}

function offlineWorkspaceCampaign(campaign: SealedCampaign): string {
  return `offline-${campaign.sha256.slice(0, 24)}`
}

async function removeRunWorkspace(layout: Task24Layout, runRoot: string): Promise<void> {
  const parent = path.resolve(layout.workspaces, path.dirname(path.relative(layout.workspaces, runRoot)))
  const resolved = path.resolve(runRoot)
  if (!resolved.startsWith(path.resolve(layout.workspaces) + path.sep) || path.dirname(resolved) !== parent) {
    throw new TypeError("TASK24_OFFLINE_WORKSPACE_CLEANUP_UNSAFE")
  }
  await fs.rm(resolved, { recursive: true, force: true })
}

async function singleBrowserRelease(layout: Task24Layout): Promise<string> {
  const verified = verifyFairnessFingerprint(await readJson(path.join(layout.runs, "fairness-fingerprint.json")))
  if (!verified.ok) throw new TypeError(verified.reason)
  const selected = verified.fingerprint.roots.browserRuntime
  if (
    path.dirname(selected) !== path.join(layout.toolchain, "browser") ||
    !/^[a-f0-9]{64}$/.test(path.basename(selected))
  ) {
    throw new TypeError("TASK24_BROWSER_RELEASE_IDENTITY_INVALID")
  }
  loadBrowserRelease(selected)
  return selected
}

async function writePointer(file: string, value: unknown): Promise<void> {
  const staging = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  const handle = await fs.open(staging, "wx")
  try {
    await handle.writeFile(canonicalJson(value) + "\n")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(staging, file)
  } catch (cause) {
    await fs.rm(staging, { force: true }).catch(() => undefined)
    throw cause
  }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"))
}

async function readOfflineSummary(file: string): Promise<OfflineCampaignSummary> {
  const value = await readJson(file)
  if (!isOfflineCampaignSummary(value)) throw new TypeError("TASK24_OFFLINE_SUMMARY_INVALID")
  return value
}

async function readReportSummary(file: string): Promise<OfflineReportSummary> {
  const value = await readJson(file)
  if (!isOfflineReportSummary(value)) throw new TypeError("TASK24_OFFLINE_REPORT_SUMMARY_INVALID")
  return value
}

async function removeOwnedTree(parent: string, target: string): Promise<void> {
  const resolvedParent = path.resolve(parent) + path.sep
  const resolvedTarget = path.resolve(target)
  if (!resolvedTarget.startsWith(resolvedParent)) throw new TypeError("TASK24_OFFLINE_CLEANUP_UNSAFE")
  await fs.rm(resolvedTarget, { recursive: true, force: true })
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isOfflineCampaignSummary(value: unknown): value is OfflineCampaignSummary {
  if (!record(value) || !record(value.protocolCalls) || !record(value.armRuns) || !record(value.security)) return false
  const armRuns = value.armRuns
  return (
    value.schemaVersion === 1 &&
    value.command === "run" &&
    value.stage === "offline" &&
    typeof value.campaignID === "string" &&
    typeof value.campaignSha256 === "string" &&
    integer(value.runCount) &&
    integer(value.completedRuns) &&
    integer(value.providerCalls) &&
    integer(value.protocolCalls.chat_completions) &&
    integer(value.protocolCalls.responses) &&
    ["A", "B", "C", "D", "E"].every((arm) => integer(armRuns[arm])) &&
    integer(value.uniqueWorkspaces) &&
    integer(value.binaryProcesses) &&
    value.binaryExecution === "exact" &&
    integer(value.browserCaptures) &&
    Array.isArray(value.recovery) &&
    Array.isArray(value.security.checks) &&
    value.security.checks.every((check) => typeof check === "string") &&
    Array.isArray(value.security.exactBinaryChecks) &&
    value.security.exactBinaryChecks.every((check) => typeof check === "string") &&
    typeof value.security.evidenceFile === "string" &&
    typeof value.security.evidenceSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.security.evidenceSha256) &&
    value.security.leaks === 0 &&
    integer(value.security.rejected) &&
    typeof value.resultRoot === "string" &&
    typeof value.reportModel === "string" &&
    typeof value.reportModelSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.reportModelSha256) &&
    value.paidProviderCalls === 0
  )
}

function isOfflineReportSummary(value: unknown): value is OfflineReportSummary {
  if (!record(value) || !record(value.hashes)) return false
  return (
    value.schemaVersion === 1 &&
    value.command === "report" &&
    value.stage === "offline" &&
    typeof value.campaignID === "string" &&
    typeof value.campaignSha256 === "string" &&
    [value.root, value.json, value.csv, value.html, value.pdf].every((item) => typeof item === "string") &&
    typeof value.reportModelSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.reportModelSha256) &&
    [value.hashes.json, value.hashes.csv, value.hashes.html, value.hashes.pdf].every(
      (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
    ) &&
    integer(value.captures) &&
    value.renderer === "chromium-double-render" &&
    typeof value.reproductionSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.reproductionSha256)
  )
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function strictlyContains(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function fsSyncExists(value: string): boolean {
  return existsSync(value)
}
