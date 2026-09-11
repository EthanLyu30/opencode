import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Database as BunDatabase } from "bun:sqlite"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"
import { WorkflowVisualEvidence } from "@opencode-ai/core/workflow/visual-evidence"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import {
  assertProductionAcceptanceDatabaseSafeSurface,
  assertProductionAcceptanceSafeSurface,
  type RuntimeObservation,
} from "./lib/workflow-production-runtime"

const bun = "D:\\OpenCode-Toolchain\\bun-1.3.14\\bun-windows-x64\\bun.exe"
const acceptanceRoot = "D:\\OpenCode-Local\\tmp\\workflow-host\\acceptance"
const finalSource = '<!doctype html><main id="app">implementation-r2</main>\n'
const workerOutputLimitBytes = 32 * 1024
const outputTruncationMarker = "\n...[output truncated]"
const outputCancellationMarker = "\n...[output capture cancelled]"
const workerKillGraceMs = 500
const workerHardKillDeadlineMs = 1_000
const workerOutputCloseDeadlineMs = 500
const workerTerminationBudgetMs = workerKillGraceMs + workerHardKillDeadlineMs + workerOutputCloseDeadlineMs
const acceptanceCases = new Map<string, { readonly outerDeadlineAt: number; readonly workerDeadlineAt: number }>()
const unsafeAcceptanceCases = new Map<string, Error>()

afterEach(cleanupAcceptanceCases)

async function cleanupAcceptanceCases(): Promise<void> {
  const failures: unknown[] = []
  for (const caseRoot of acceptanceCases.keys()) {
    try {
      const leak = unsafeAcceptanceCases.get(caseRoot)
      if (leak !== undefined) {
        throw new Error(`Refusing to clean a case whose worker may still be live: ${caseRoot}`, { cause: leak })
      }
      await removeAcceptanceCaseRoot(caseRoot)
    } catch (error) {
      failures.push(error)
    } finally {
      acceptanceCases.delete(caseRoot)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Failed to clean production acceptance case roots")
}

test("removes an acceptance case leaf by leaf without traversing a junction", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-cleanup")
  const targetRoot = makeAcceptanceCaseRoot("production-cleanup-target")
  const nested = path.join(caseRoot, "nested")
  const junction = path.join(caseRoot, "outside")
  const sentinel = path.join(targetRoot, "sentinel.txt")
  await fs.mkdir(targetRoot, { recursive: true })
  try {
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(path.join(nested, "artifact.txt"), "artifact")
    await fs.writeFile(sentinel, "preserve")
    await fs.symlink(targetRoot, junction, "junction")
    await removeAcceptanceCaseRoot(caseRoot)
    expect(
      await fs.stat(caseRoot).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect(await fs.readFile(sentinel, "utf8")).toBe("preserve")
  } finally {
    await fs.unlink(junction).catch(async () => fs.rmdir(junction).catch(() => undefined))
    await fs.unlink(path.join(nested, "artifact.txt")).catch(() => undefined)
    await fs.rmdir(nested).catch(() => undefined)
    await fs.rmdir(caseRoot).catch(() => undefined)
    await fs.unlink(sentinel).catch(() => undefined)
    await fs.rmdir(targetRoot).catch(() => undefined)
  }
})

test("kills an overdue worker, awaits its exit, and bounds both output streams", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-worker-deadline", 3_000)
  const resultPath = path.join(caseRoot, "completed.txt")
  const worker = path.join(import.meta.dir, "fixtures", "workflow-production-hanging-worker.ts")
  await fs.mkdir(caseRoot, { recursive: true })
  const startedAt = Date.now()
  let failure: unknown
  try {
    await runWorker(worker, caseRoot, resultPath, [], 75)
  } catch (error) {
    failure = error
  }
  const elapsed = Date.now() - startedAt

  try {
    expect(failure).toBeInstanceOf(WorkerDeadlineError)
    if (!(failure instanceof WorkerDeadlineError)) throw failure ?? new Error("Worker did not reach its deadline")
    const output = failure
    expect(output.name).toBe("WorkerDeadlineError")
    expect(output.deadlineMs).toBe(75)
    expect(typeof output.stdout).toBe("string")
    expect(typeof output.stderr).toBe("string")
    expect(output.stdout.length).toBeLessThanOrEqual(32 * 1024 + 32)
    expect(output.stderr.length).toBeLessThanOrEqual(32 * 1024 + 32)
    expect(output.stdout.endsWith("\n...[output truncated]")).toBe(true)
    expect(output.stderr.endsWith("\n...[output truncated]")).toBe(true)
    expect(elapsed).toBeLessThan(700)
    await cleanupAcceptanceCases()
    expect(
      await fs.stat(caseRoot).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    await Bun.sleep(800)
    expect(
      await fs.stat(resultPath).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  } finally {
    await fs.unlink(resultPath).catch(() => undefined)
    await fs.rmdir(caseRoot).catch(() => undefined)
  }
}, 3_000)

test("shares one absolute worker budget across every phase in an acceptance case", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-worker-budget", 3_000)
  const first = remainingWorkerDeadline(caseRoot)
  await Bun.sleep(50)
  const second = remainingWorkerDeadline(caseRoot)
  expect(first).toBeLessThan(3_000)
  expect(second).toBeLessThan(first)
})

test("applies the worker deadline to pipes held open after the parent exits", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-descendant-pipe", 3_000)
  const resultPath = path.join(caseRoot, "unused.txt")
  const worker = path.join(import.meta.dir, "fixtures", "workflow-production-hanging-worker.ts")
  await fs.mkdir(caseRoot, { recursive: true })
  const startedAt = Date.now()
  let failure: unknown
  try {
    await runWorker(worker, caseRoot, resultPath, ["spawn-pipe-descendant"], 75)
  } catch (error) {
    failure = error
  }
  const elapsed = Date.now() - startedAt
  let assertionFailure: unknown
  try {
    expect(failure).toBeInstanceOf(WorkerDeadlineSettlementError)
    expect(unsafeAcceptanceCases.has(caseRoot)).toBe(true)
    expect(elapsed).toBeLessThan(700)
    let cleanupFailure: unknown
    try {
      await cleanupAcceptanceCases()
    } catch (error) {
      cleanupFailure = error
    }
    expect(cleanupFailure).toBeInstanceOf(AggregateError)
    expect(
      await fs.stat(caseRoot).then(
        () => true,
        () => false,
      ),
    ).toBe(true)
  } catch (error) {
    assertionFailure = error
  }

  let settlementFailure: Error | undefined
  try {
    await waitForExactFile(resultPath, "descendant exited", 1_250)
    unsafeAcceptanceCases.delete(caseRoot)
    await removeAcceptanceCaseRoot(caseRoot)
  } catch (error) {
    const leak = new Error(`Detached descendant exit was not confirmed; cleanup remains prohibited for ${caseRoot}`, {
      cause: error,
    })
    unsafeAcceptanceCases.set(caseRoot, leak)
    settlementFailure = leak
  }
  if (settlementFailure !== undefined) {
    if (assertionFailure !== undefined)
      throw new AggregateError(
        [assertionFailure, settlementFailure],
        "Descendant-pipe regression and its safety gate both failed",
      )
    throw settlementFailure
  }
  if (assertionFailure !== undefined) throw assertionFailure
}, 3_000)

test("never changes a hard-linked sentinel while cleaning an acceptance case", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-hardlink-cleanup")
  const sentinelRoot = makeAcceptanceCaseRoot("production-hardlink-sentinel")
  const caseFile = path.join(caseRoot, "shared.txt")
  const sentinel = path.join(sentinelRoot, "shared.txt")
  await Promise.all([fs.mkdir(caseRoot, { recursive: true }), fs.mkdir(sentinelRoot, { recursive: true })])
  await fs.writeFile(caseFile, "preserve hard-linked content")
  await fs.link(caseFile, sentinel)
  await fs.chmod(caseFile, 0o444)
  const beforeMode = (await fs.lstat(sentinel)).mode & 0o777
  let cleanupFailure: unknown
  try {
    await removeAcceptanceCaseRoot(caseRoot)
  } catch (error) {
    cleanupFailure = error
  }

  try {
    const caseExists = await fs.stat(caseRoot).then(
      () => true,
      () => false,
    )
    expect(cleanupFailure === undefined ? caseExists : !caseExists).toBe(false)
    expect((await fs.lstat(sentinel)).mode & 0o777).toBe(beforeMode)
    expect(await fs.readFile(sentinel, "utf8")).toBe("preserve hard-linked content")
  } finally {
    await fs.chmod(sentinel, 0o600).catch(() => undefined)
    await fs.unlink(caseFile).catch(() => undefined)
    await fs.rmdir(caseRoot).catch(() => undefined)
    await fs.unlink(sentinel).catch(() => undefined)
    await fs.rmdir(sentinelRoot).catch(() => undefined)
  }
})

test("runs the frozen production visual workflow offline through the generated SDK and embedded Server", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-e2e")
  const worker = path.join(import.meta.dir, "workflow-production-crash-worker.ts")
  const resultPath = path.join(caseRoot, "result.json")
  const workspace = path.join(caseRoot, "workspace")
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(workspace, "index.html"), '<!doctype html><main id="app">initial</main>\n')
  await initializeRepository(workspace, caseRoot)

  const { exit, stdout, stderr } = await runWorker(worker, caseRoot, resultPath)
  expect(exit, `${stdout}\n${stderr}`).toBe(0)
  const result = JSON.parse(await fs.readFile(resultPath, "utf8")) as RuntimeObservation

  expect(result.workflowStatus).toBe("succeeded")
  expect(result.responseStatus).toBe("completed")
  expect(result.stages).toHaveLength(12)
  expect(result.stages.map(({ role, revision, status }) => ({ role, revision, status }))).toEqual([
    { role: "design", revision: 0, status: "succeeded" },
    { role: "decompose", revision: 0, status: "succeeded" },
    { role: "implement", revision: 0, status: "succeeded" },
    { role: "test", revision: 0, status: "succeeded" },
    { role: "visual_review", revision: 0, status: "skipped" },
    { role: "repair", revision: 1, status: "succeeded" },
    { role: "test", revision: 1, status: "succeeded" },
    { role: "visual_review", revision: 1, status: "succeeded" },
    { role: "repair", revision: 2, status: "succeeded" },
    { role: "test", revision: 2, status: "succeeded" },
    { role: "visual_review", revision: 2, status: "succeeded" },
    { role: "deliver", revision: 2, status: "succeeded" },
  ])
  expect(result.stages.every((stage) => stage.attempt === (stage.status === "skipped" ? 0 : 1))).toBe(true)
  expect(result.counters).toEqual({
    providerCalls: 14,
    credentialReads: 15,
    outboundCalls: 0,
    browserCaptures: 3,
    browserCloses: 1,
    functionalTests: 3,
    processStarts: 0,
    processStops: 0,
    processRecovers: 0,
  })
  expect(result.frozenTests.map(({ revision, exit }) => ({ revision, exit }))).toEqual([
    { revision: 0, exit: 1 },
    { revision: 1, exit: 0 },
    { revision: 2, exit: 0 },
  ])
  expect(result.browserBodies).toEqual([
    {
      kind: "reference",
      revision: 0,
      sha256: "8b7b843950d61b38b8c4f0ff28b55733917b0bbb3734fbb0d51739e538d789a5",
      size: 55,
    },
    {
      kind: "implementation",
      revision: 1,
      sha256: "2d1bf2b76681437c844ae823a6a0430498e89a69fbb28d17d030417936cff9da",
      size: 55,
    },
    {
      kind: "implementation",
      revision: 2,
      sha256: "8b7b843950d61b38b8c4f0ff28b55733917b0bbb3734fbb0d51739e538d789a5",
      size: 55,
    },
  ])
  expect(result.evidence).toHaveLength(3)
  expect(result.evidence.map(({ kind, revision, state }) => ({ kind, revision, state }))).toEqual([
    { kind: "reference", revision: 0, state: "released" },
    { kind: "implementation", revision: 1, state: "released" },
    { kind: "implementation", revision: 2, state: "released" },
  ])
  expect(result.evidenceBytes).toBeGreaterThan(0)
  expect(result.workflowSessionVisibility).toBe("workflow")
  expect(result.conversationCount).toBe(0)
  expect(result.responseItems).toEqual(["message"])
  expect(result.responseItemKinds).toEqual(["context", "input", "output"])
  expect(result.responseUsage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
  const workflowUsage = readOnlyDatabase(path.join(caseRoot, "data", "workflow.sqlite"), (database) =>
    JSON.parse(database.query<{ usage: string }, []>("SELECT usage FROM workflow_run").get()?.usage ?? "null"),
  )
  expect(workflowUsage).toEqual({ tokens: 55, turns: 14, toolCalls: 3, attempts: 11 })
  expect(result.toolContinuations).toEqual([
    { role: "implement", revision: 0, callID: "call-implement-r0", name: "apply_patch" },
    { role: "repair", revision: 1, callID: "call-repair-r1", name: "apply_patch" },
    { role: "repair", revision: 2, callID: "call-repair-r2", name: "apply_patch" },
  ])
  expect(result.providerRequests.map(({ role, revision, phase }) => ({ role, revision, phase }))).toEqual([
    { role: "design", revision: 0, phase: "initial" },
    { role: "decompose", revision: 0, phase: "initial" },
    { role: "implement", revision: 0, phase: "initial" },
    { role: "implement", revision: 0, phase: "after-tool" },
    { role: "test", revision: 0, phase: "initial" },
    { role: "repair", revision: 1, phase: "initial" },
    { role: "repair", revision: 1, phase: "after-tool" },
    { role: "test", revision: 1, phase: "initial" },
    { role: "visual_review", revision: 1, phase: "initial" },
    { role: "repair", revision: 2, phase: "initial" },
    { role: "repair", revision: 2, phase: "after-tool" },
    { role: "test", revision: 2, phase: "initial" },
    { role: "visual_review", revision: 2, phase: "initial" },
    { role: "deliver", revision: 2, phase: "initial" },
  ])
  expect(result.secretScanPassed).toBe(true)
  expect(result.replay).toEqual({
    eventCount: 120,
    batchCount: 71,
    incompleteCases: 25,
    secondReplayIdempotent: true,
  })
  expect(result.finalWorkspaceSha256).toBe(new Bun.CryptoHasher("sha256").update(finalSource).digest("hex"))
  expect(await fs.readFile(path.join(workspace, "index.html"), "utf8")).toBe(finalSource)
}, 120_000)

test("rechecks a shared screenshot payload when it also reaches an ordinary surface", () => {
  const cycle: Record<string, unknown> = { value: "safe" }
  cycle.self = cycle
  expect(() => assertProductionAcceptanceSafeSurface(cycle)).not.toThrow()
  const workflowID = `wfl_scanner_${randomUUID()}` as never
  const stageID = `wfs_scanner_${randomUUID()}` as never
  const viewport = { name: "desktop", width: 1280, height: 720 }
  const bytes = WorkflowVisualHost.deterministicPng(viewport)
  const coordinates = {
    schemaVersion: 1 as const,
    workflowID,
    stageID,
    kind: "implementation" as const,
    revision: 2,
    viewport,
    configSha256: "b".repeat(64),
    sourceSha256: "c".repeat(64),
    readySelectorSha256: "d".repeat(64),
  }
  const receipt = {
    evidenceID: WorkflowVisualEvidence.evidenceID(coordinates),
    coordinates,
    pngSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    width: viewport.width,
    height: viewport.height,
    evidenceBytes: bytes.byteLength,
  }
  const screenshot = WorkflowVisualReviewArtifact.commitScreenshot(
    WorkflowVisualReviewArtifact.capturedImage({
      workflowID,
      kind: "implementation",
      viewport: viewport.name,
      revision: 2,
      bytes,
      evidenceReceipt: receipt,
    }),
  )
  const metadata = screenshot.metadata
  if (metadata === null || typeof metadata !== "object") throw new Error("Screenshot metadata is absent")
  const payload = Reflect.get(metadata, "payload")
  expect(() =>
    assertProductionAcceptanceSafeSurface([screenshot, { kind: "ordinary-artifact", metadata: { payload } }]),
  ).toThrow("dataBase64")
})

test("rejects credential material hidden in binary and whitespace-prefixed JSON surfaces", async () => {
  const credential = `sk-${randomUUID().replaceAll("-", "")}`
  const bytes = Buffer.from(credential)
  expect(() => assertProductionAcceptanceSafeSurface(bytes)).toThrow("Credential value")
  expect(() =>
    assertProductionAcceptanceSafeSurface(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  ).toThrow("Credential value")

  const caseRoot = makeAcceptanceCaseRoot("production-scanner")
  const databasePath = path.join(caseRoot, "surface.sqlite")
  await fs.mkdir(caseRoot, { recursive: true })
  const database = new BunDatabase(databasePath)
  try {
    database.exec("CREATE TABLE surface (payload TEXT NOT NULL)")
    database.query("INSERT INTO surface (payload) VALUES (?)").run('  {"authorization":"opaque"}')
  } finally {
    database.close()
  }
  try {
    expect(() => assertProductionAcceptanceDatabaseSafeSurface(databasePath)).toThrow("Credential-like key")
  } finally {
    await fs.unlink(databasePath)
    await fs.rmdir(caseRoot)
  }
})

test("rejects a screenshot receipt whose coordinate owner differs from the image owner", () => {
  const workflowID = `wfl_scanner_${randomUUID()}` as never
  const stageID = `wfs_scanner_${randomUUID()}` as never
  const viewport = { name: "desktop", width: 1280, height: 720 }
  const bytes = WorkflowVisualHost.deterministicPng(viewport)
  const forgedCoordinates = {
    schemaVersion: 1 as const,
    workflowID: `wfl_scanner_${randomUUID()}` as never,
    stageID,
    kind: "implementation" as const,
    revision: 2,
    viewport,
    configSha256: "b".repeat(64),
    sourceSha256: "c".repeat(64),
    readySelectorSha256: "d".repeat(64),
  }
  const receipt = {
    evidenceID: WorkflowVisualEvidence.evidenceID(forgedCoordinates),
    coordinates: forgedCoordinates,
    pngSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    width: viewport.width,
    height: viewport.height,
    evidenceBytes: bytes.byteLength,
  }
  expect(() =>
    WorkflowVisualReviewArtifact.commitScreenshot(
      WorkflowVisualReviewArtifact.capturedImage({
        workflowID,
        kind: "implementation",
        viewport: viewport.name,
        revision: 2,
        bytes,
        evidenceReceipt: receipt,
      }),
    ),
  ).toThrow("receipt")
})

test("recovers a process crash after atomic admission and before wake", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-admission-crash")
  const worker = path.join(import.meta.dir, "workflow-production-crash-worker.ts")
  const resultPath = path.join(caseRoot, "result.json")
  const markerPath = path.join(caseRoot, "admission.marker.json")
  const workspace = path.join(caseRoot, "workspace")
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(workspace, "index.html"), '<!doctype html><main id="app">initial</main>\n')
  await initializeRepository(workspace, caseRoot)

  const crashed = await runWorker(worker, caseRoot, resultPath, ["admission-postcommit-prewake", markerPath])
  expect(crashed.exit, crashed.stderr).toBe(17)
  expect(JSON.parse(await fs.readFile(markerPath, "utf8"))).toEqual({ boundary: "admission-postcommit-prewake" })
  const persistedCounts = readOnlyDatabase(path.join(caseRoot, "data", "workflow.sqlite"), (database) => [
    database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM workflow_run").get()?.count,
    database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM workflow_stage").get()?.count,
    database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM response").get()?.count,
    database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session").get()?.count,
  ])
  expect(persistedCounts).toEqual([1, 12, 1, 1])

  const recovered = await runWorker(worker, caseRoot, resultPath)
  expect(recovered.exit, recovered.stderr).toBe(0)
  const result = JSON.parse(await fs.readFile(resultPath, "utf8")) as RuntimeObservation
  expect(result.workflowStatus).toBe("succeeded")
  expect(result.counters.providerCalls).toBe(14)
}, 120_000)

test("recovers a durable provider result without requesting it again", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-provider-crash")
  const worker = path.join(import.meta.dir, "workflow-production-crash-worker.ts")
  const resultPath = path.join(caseRoot, "result.json")
  const markerPath = path.join(caseRoot, "provider.marker.json")
  const workspace = path.join(caseRoot, "workspace")
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(workspace, "index.html"), '<!doctype html><main id="app">initial</main>\n')
  await initializeRepository(workspace, caseRoot)

  const crashed = await runWorker(worker, caseRoot, resultPath, ["provider-result-checkpoint", markerPath])
  expect(crashed.exit, crashed.stderr).toBe(17)
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"))
  expect(marker.boundary).toBe("provider-result-checkpoint")
  expect(marker.counters.providerCalls).toBe(1)
  const databasePath = path.join(caseRoot, "data", "workflow.sqlite")
  await waitForRunningLeaseExpiry(databasePath)

  const recovered = await runWorker(worker, caseRoot, resultPath)
  expect(recovered.exit, recovered.stderr).toBe(0)
  const result = JSON.parse(await fs.readFile(resultPath, "utf8")) as RuntimeObservation
  expect(result.workflowStatus).toBe("succeeded")
  expect(result.counters.providerCalls).toBe(13)
  expect(result.providerRequests[0]).toMatchObject({ role: "decompose", revision: 0, phase: "initial" })
}, 120_000)

test("recovers a pending tool intent as ambiguous without executing it", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-pending-tool-crash")
  const worker = path.join(import.meta.dir, "workflow-production-crash-worker.ts")
  const resultPath = path.join(caseRoot, "result.json")
  const markerPath = path.join(caseRoot, "pending-tool.marker.json")
  const workspace = path.join(caseRoot, "workspace")
  const initial = '<!doctype html><main id="app">initial</main>\n'
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(workspace, "index.html"), initial)
  await initializeRepository(workspace, caseRoot)

  const crashed = await runWorker(worker, caseRoot, resultPath, ["pending-tool-intent", markerPath])
  expect(crashed.exit, crashed.stderr).toBe(17)
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"))
  expect(marker.boundary).toBe("pending-tool-intent")
  expect(marker.counters.providerCalls).toBe(3)
  expect(await fs.readFile(path.join(workspace, "index.html"), "utf8")).toBe(initial)
  const databasePath = path.join(caseRoot, "data", "workflow.sqlite")
  const { active, continuationCount } = readOnlyDatabase(databasePath, (database) => ({
    active: database
      .query<
        { status: string; checkpoint: string | null },
        []
      >("SELECT status, checkpoint FROM workflow_stage WHERE stage_type = 'implement' AND status = 'running'")
      .get(),
    continuationCount:
      database
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM workflow_artifact WHERE kind = 'tool-continuation'")
        .get()?.count ?? -1,
  }))
  expect(active?.status).toBe("running")
  expect(Reflect.get(JSON.parse(active?.checkpoint ?? "null")?.activeTurn ?? {}, "pendingCallID")).toBe(
    "call-implement-r0",
  )
  expect(continuationCount).toBe(0)
  await waitForRunningLeaseExpiry(databasePath)

  const recovered = await runWorker(worker, caseRoot, resultPath, ["observe-tool-ambiguity"])
  expect(recovered.exit, recovered.stderr).toBe(0)
  const result = JSON.parse(await fs.readFile(resultPath, "utf8")) as {
    readonly workflowStatus: string
    readonly responseStatus: string
    readonly stage: {
      readonly role: string
      readonly revision: number
      readonly status: string
      readonly error?: { readonly code: string }
    }
    readonly providerCalls: number
    readonly toolContinuations: number
    readonly workspaceSha256: string
  }
  expect(result).toEqual({
    workflowStatus: "waiting_approval",
    responseStatus: "queued",
    stage: {
      role: "implement",
      revision: 0,
      status: "waiting_approval",
      error: { code: "tool_execution_ambiguous" },
    },
    providerCalls: 0,
    toolContinuations: 0,
    workspaceSha256: new Bun.CryptoHasher("sha256").update(initial).digest("hex"),
  })
}, 120_000)

test("resumes a settled tool result without executing the tool again", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-settled-tool-crash")
  const worker = path.join(import.meta.dir, "workflow-production-crash-worker.ts")
  const resultPath = path.join(caseRoot, "result.json")
  const markerPath = path.join(caseRoot, "settled-tool.marker.json")
  const workspace = path.join(caseRoot, "workspace")
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(workspace, "index.html"), '<!doctype html><main id="app">initial</main>\n')
  await initializeRepository(workspace, caseRoot)

  const crashed = await runWorker(worker, caseRoot, resultPath, ["settled-tool-result", markerPath])
  expect(crashed.exit, crashed.stderr).toBe(17)
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"))
  expect(marker.boundary).toBe("settled-tool-result")
  expect(marker.counters.providerCalls).toBe(3)
  expect(await fs.readFile(path.join(workspace, "index.html"), "utf8")).toBe(
    '<!doctype html><main id="app">implementation-r0</main>\n',
  )
  const databasePath = path.join(caseRoot, "data", "workflow.sqlite")
  const { checkpoint, continuationCount } = readOnlyDatabase(databasePath, (database) => {
    const active = database
      .query<
        { checkpoint: string | null },
        []
      >("SELECT checkpoint FROM workflow_stage WHERE stage_type = 'implement' AND status = 'running'")
      .get()
    return {
      checkpoint: JSON.parse(active?.checkpoint ?? "null"),
      continuationCount: database
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM workflow_artifact WHERE kind = 'tool-continuation'")
        .get()?.count,
    }
  })
  expect(checkpoint?.activeTurn?.pendingCallID).toBeUndefined()
  expect(checkpoint?.activeTurn?.results).toHaveLength(1)
  expect(checkpoint?.activeTurn?.results?.[0]).toMatchObject({ id: "call-implement-r0", name: "apply_patch" })
  expect(checkpoint?.artifacts).toHaveLength(1)
  expect(checkpoint?.artifacts?.[0]?.kind).toBe("tool-continuation")
  expect(continuationCount).toBe(0)
  await waitForRunningLeaseExpiry(databasePath)

  const recovered = await runWorker(worker, caseRoot, resultPath)
  expect(recovered.exit, recovered.stderr).toBe(0)
  const result = JSON.parse(await fs.readFile(resultPath, "utf8")) as RuntimeObservation
  expect(result.workflowStatus).toBe("succeeded")
  expect(result.counters.providerCalls).toBe(11)
  expect(result.providerRequests[0]).toMatchObject({ role: "implement", revision: 0, phase: "after-tool" })
  expect(
    result.providerRequests.filter((request) => request.role === "implement" && request.revision === 0),
  ).toHaveLength(1)
  expect(await fs.readFile(path.join(workspace, "index.html"), "utf8")).toBe(finalSource)
}, 120_000)

test("recovers a durable preview start intent through its authenticated owner before starting a replacement", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-preview-owner-crash")
  const worker = path.join(import.meta.dir, "workflow-production-crash-worker.ts")
  const resultPath = path.join(caseRoot, "result.json")
  const markerPath = path.join(caseRoot, "preview-owner.marker.json")
  const workspace = path.join(caseRoot, "workspace")
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(workspace, "index.html"), '<!doctype html><main id="app">initial</main>\n')
  await fs.writeFile(path.join(workspace, "server.mjs"), "setInterval(() => undefined, 60_000)\n")
  await initializeRepository(workspace, caseRoot, ["index.html", "server.mjs"])

  const crashed = await runWorker(worker, caseRoot, resultPath, ["preview-start-intent", markerPath])
  expect(crashed.exit, crashed.stderr).toBe(17)
  const stored = readOnlyDatabase(path.join(caseRoot, "data", "workflow.sqlite"), (database) =>
    database.query<{ input: string }, []>("SELECT input FROM workflow_run").get(),
  )
  const input = JSON.parse(stored?.input ?? "null")
  expect(input?.["workflow.production-host-plan.v1"]?.preview?.allowedOrigins).toEqual([])
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"))
  expect(marker).toMatchObject({
    boundary: "preview-start-intent",
    counters: { processStarts: 1, processRecovers: 0 },
    identity: {
      workflowID: expect.stringMatching(/^wfl_/),
      stageID: expect.stringMatching(/^wfs_/),
      attempt: 1,
      leaseOwner: "task-23-11-production-owner",
      leaseExpiresAt: expect.any(Number),
      hostID: expect.stringMatching(/^[a-f0-9]{64}$/),
      nonce: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  })
  expect(marker.manifest).toEqual({
    hostID: marker.identity.hostID,
    createdAt: expect.any(Number),
    kind: "script",
    workflowID: marker.identity.workflowID,
    stageID: marker.identity.stageID,
    attempt: marker.identity.attempt,
    leaseOwner: marker.identity.leaseOwner,
    leaseExpiresAt: marker.identity.leaseExpiresAt,
    nonce: marker.identity.nonce,
    revision: 1,
    purpose: "implementation",
    sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    configurationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    claimKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    claimGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
    claimSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  const databasePath = path.join(caseRoot, "data", "workflow.sqlite")
  await waitForRunningLeaseExpiry(databasePath)

  const recovered = await runWorker(worker, caseRoot, resultPath)
  expect(recovered.exit, recovered.stderr).toBe(0)
  const result = JSON.parse(await fs.readFile(resultPath, "utf8")) as RuntimeObservation
  expect(result.workflowStatus).toBe("succeeded")
  expect(result.responseStatus).toBe("completed")
  expect(result.counters).toEqual({
    providerCalls: 6,
    credentialReads: 9,
    outboundCalls: 0,
    browserCaptures: 3,
    browserCloses: 1,
    functionalTests: 1,
    processStarts: 2,
    processStops: 2,
    processRecovers: 1,
  })
  expect(marker.counters.providerCalls + result.counters.providerCalls).toBe(14)
  expect(marker.counters.browserCaptures + result.counters.browserCaptures).toBe(3)
  expect(result.artifacts).toHaveLength(32)
  expect(result.toolContinuations).toHaveLength(3)
  expect(result.evidence).toEqual([
    { kind: "reference", revision: 0, state: "released", bytes: 3653 },
    { kind: "implementation", revision: 1, state: "released", bytes: 3653 },
    { kind: "implementation", revision: 2, state: "released", bytes: 3653 },
  ])
  expect(result.responseItems).toEqual(["message"])
  expect(result.responseItemKinds).toEqual(["context", "input", "output"])
  expect(result.responseUsage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
  const usage = readOnlyDatabase(databasePath, (database) =>
    JSON.parse(database.query<{ usage: string }, []>("SELECT usage FROM workflow_run").get()?.usage ?? "null"),
  )
  expect(usage).toEqual({ tokens: 55, turns: 14, toolCalls: 3, attempts: 12 })

  const ownership = JSON.parse(await fs.readFile(path.join(caseRoot, "ownership.json"), "utf8"))
  expect(ownership).toHaveLength(6)
  expect(ownership[0]).toEqual({
    operation: "start",
    identity: marker.identity,
    origin: marker.origin,
    finalGateResults: [],
  })
  expect(ownership[1]).toEqual({
    operation: "recover",
    identity: marker.identity,
    origin: marker.origin,
    finalGateResults: [true],
  })
  expect(ownership[2]).toMatchObject({
    operation: "start",
    identity: {
      workflowID: marker.identity.workflowID,
      stageID: marker.identity.stageID,
      attempt: 2,
      leaseOwner: marker.identity.leaseOwner,
    },
    finalGateResults: [],
  })
  expect(ownership[3]).toEqual({ ...ownership[2], operation: "stop" })
  expect(ownership[4]).toMatchObject({
    operation: "start",
    identity: { workflowID: marker.identity.workflowID, attempt: 1, leaseOwner: marker.identity.leaseOwner },
    finalGateResults: [],
  })
  expect(ownership[4].identity.stageID).not.toBe(marker.identity.stageID)
  expect(ownership[5]).toEqual({ ...ownership[4], operation: "stop" })
}, 120_000)

test("reuses exact staged PNG evidence after a crash before its EventV2 artifact publish", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-png-staged-crash", 180_000)
  const worker = path.join(import.meta.dir, "workflow-production-crash-worker.ts")
  const resultPath = path.join(caseRoot, "result.json")
  const markerPath = path.join(caseRoot, "png-staged.marker.json")
  const workspace = path.join(caseRoot, "workspace")
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(workspace, "index.html"), '<!doctype html><main id="app">initial</main>\n')
  await initializeRepository(workspace, caseRoot)

  const crashed = await runWorker(worker, caseRoot, resultPath, ["png-staged-before-event", markerPath])
  expect(crashed.exit, crashed.stderr).toBe(17)
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"))
  expect(marker).toMatchObject({
    boundary: "png-staged-before-event",
    counters: { browserCaptures: 2, processStarts: 0, outboundCalls: 0 },
  })
  const databasePath = path.join(caseRoot, "data", "workflow.sqlite")
  const artifactCount = readOnlyDatabase(
    databasePath,
    (database) =>
      database
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM workflow_artifact WHERE kind IN ('workflow.visual.reference-screenshot', 'workflow.visual.implementation-screenshot')")
        .get()?.count,
  )
  expect(artifactCount).toBe(0)
  const evidencePath = path.join(caseRoot, "evidence", "evidence.sqlite")
  const { staged, stagedQuota } = readOnlyDatabase(evidencePath, (database) => ({
    staged: database
      .query<
        {
          evidence_id: string
          preview_kind: string
          revision: number
          state: string
          png_sha256: string
          evidence_bytes: number
          receipt_json: string
          png_length: number
        },
        []
      >(
        "SELECT evidence_id, preview_kind, revision, state, png_sha256, evidence_bytes, receipt_json, length(png_blob) AS png_length FROM workflow_evidence_item ORDER BY preview_kind DESC, revision",
      )
      .all(),
    stagedQuota: database.query<{ evidence_bytes: number }, []>("SELECT evidence_bytes FROM workflow_evidence").get(),
  }))
  expect(staged.map(({ preview_kind, revision, state }) => ({ preview_kind, revision, state }))).toEqual([
    { preview_kind: "reference", revision: 0, state: "staged" },
    { preview_kind: "implementation", revision: 1, state: "staged" },
  ])
  expect(staged.every((item) => item.png_length === item.evidence_bytes && item.receipt_json.length > 0)).toBe(true)
  expect(stagedQuota?.evidence_bytes).toBe(staged.reduce((total, item) => total + item.evidence_bytes, 0))
  await waitForRunningLeaseExpiry(databasePath)

  const recovered = await runWorker(worker, caseRoot, resultPath)
  expect(recovered.exit, recovered.stderr).toBe(0)
  const result = JSON.parse(await fs.readFile(resultPath, "utf8")) as RuntimeObservation
  expect(result.workflowStatus).toBe("succeeded")
  expect(result.counters.browserCaptures).toBe(1)
  expect(result.counters.outboundCalls).toBe(0)
  expect(result.browserBodies).toEqual([
    {
      kind: "implementation",
      revision: 2,
      sha256: "8b7b843950d61b38b8c4f0ff28b55733917b0bbb3734fbb0d51739e538d789a5",
      size: 55,
    },
  ])
  const { settled, settledQuota } = readOnlyDatabase(evidencePath, (database) => ({
    settled: database
      .query<
        {
          evidence_id: string
          preview_kind: string
          revision: number
          state: string
          png_sha256: string
          evidence_bytes: number
          receipt_json: string
          png_length: number | null
        },
        []
      >(
        "SELECT evidence_id, preview_kind, revision, state, png_sha256, evidence_bytes, receipt_json, length(png_blob) AS png_length FROM workflow_evidence_item ORDER BY preview_kind DESC, revision",
      )
      .all(),
    settledQuota: database.query<{ evidence_bytes: number }, []>("SELECT evidence_bytes FROM workflow_evidence").get(),
  }))
  expect(settled).toHaveLength(3)
  expect(settled.every((item) => item.state === "released" && item.png_length === null)).toBe(true)
  for (const before of staged) {
    const after = settled.find((item) => item.evidence_id === before.evidence_id)
    expect(after).toMatchObject({
      evidence_id: before.evidence_id,
      preview_kind: before.preview_kind,
      revision: before.revision,
      png_sha256: before.png_sha256,
      evidence_bytes: before.evidence_bytes,
      receipt_json: before.receipt_json,
    })
  }
  expect(settledQuota?.evidence_bytes).toBe(settled.reduce((total, item) => total + item.evidence_bytes, 0))
}, 180_000)

test("recovers a crash before the atomic terminal Workflow and Response publish exactly once", async () => {
  const caseRoot = makeAcceptanceCaseRoot("production-terminal-crash")
  const worker = path.join(import.meta.dir, "workflow-production-crash-worker.ts")
  const resultPath = path.join(caseRoot, "result.json")
  const markerPath = path.join(caseRoot, "terminal.marker.json")
  const workspace = path.join(caseRoot, "workspace")
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(workspace, "index.html"), '<!doctype html><main id="app">initial</main>\n')
  await initializeRepository(workspace, caseRoot)

  const crashed = await runWorker(worker, caseRoot, resultPath, ["terminal-before-publish", markerPath])
  expect(crashed.exit, crashed.stderr).toBe(17)
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"))
  expect(marker).toMatchObject({
    boundary: "terminal-before-publish",
    counters: { providerCalls: 14, browserCaptures: 3, functionalTests: 3, outboundCalls: 0 },
  })

  const databasePath = path.join(caseRoot, "data", "workflow.sqlite")
  const before = new BunDatabase(databasePath, { readonly: true })
  try {
    const run = before.query<{ status: string }, []>("SELECT status FROM workflow_run").get()
    const response = before.query<{ status: string }, []>("SELECT status FROM response").get()
    const terminalEvents =
      before
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM event WHERE type IN ('workflow.succeeded.1', 'response.completed.1')")
        .get()?.count ?? -1
    expect(run?.status).not.toBe("succeeded")
    expect(response?.status).not.toBe("completed")
    expect(terminalEvents).toBe(0)
  } finally {
    before.close()
  }
  await waitForRunningLeaseExpiry(databasePath)

  const recovered = await runWorker(worker, caseRoot, resultPath)
  expect(recovered.exit, recovered.stderr).toBe(0)
  const result = JSON.parse(await fs.readFile(resultPath, "utf8")) as RuntimeObservation
  expect(result.workflowStatus).toBe("succeeded")
  expect(result.responseStatus).toBe("completed")
  expect(result.artifacts).toHaveLength(32)
  expect(result.responseItems).toEqual(["message"])
  expect(result.responseUsage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
  expect(marker.counters.providerCalls + result.counters.providerCalls).toBe(14)
  expect(marker.counters.browserCaptures + result.counters.browserCaptures).toBe(3)
  expect(marker.counters.functionalTests + result.counters.functionalTests).toBe(3)
  expect(result.counters.outboundCalls).toBe(0)

  const after = new BunDatabase(databasePath, { readonly: true })
  try {
    const terminal = after
      .query<
        { type: string; count: number },
        []
      >("SELECT type, COUNT(*) AS count FROM event WHERE type IN ('workflow.succeeded.1', 'response.completed.1') GROUP BY type ORDER BY type")
      .all()
    expect(terminal).toEqual([
      { type: "response.completed.1", count: 1 },
      { type: "workflow.succeeded.1", count: 1 },
    ])
  } finally {
    after.close()
  }
}, 120_000)

async function runWorker(
  worker: string,
  caseRoot: string,
  resultPath: string,
  extra: readonly string[] = [],
  deadlineOverrideMs?: number,
): Promise<{ readonly exit: number; readonly stdout: string; readonly stderr: string }> {
  const deadlineMs = remainingWorkerDeadline(caseRoot, deadlineOverrideMs)
  const child = Bun.spawn([bun, "run", worker, caseRoot, resultPath, ...extra], {
    cwd: import.meta.dir,
    env: childEnvironment(caseRoot),
    stdout: "pipe",
    stderr: "pipe",
  })
  let exited = false
  let exitStatus: number | undefined
  const exitPromise = child.exited.then(
    (exit) => {
      exited = true
      exitStatus = exit
      return exit
    },
    (error) => {
      exited = true
      throw error
    },
  )
  const stdout = captureBoundedWorkerOutput(child.stdout)
  const stderr = captureBoundedWorkerOutput(child.stderr)
  const completed = Promise.all([exitPromise, stdout.settled, stderr.settled]).then(([exit, stdout, stderr]) => ({
    exit,
    stdout,
    stderr,
  }))
  const deadlineToken = Symbol("worker-deadline")
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadlinePromise = new Promise<typeof deadlineToken>((resolve) => {
    deadlineTimer = setTimeout(() => resolve(deadlineToken), deadlineMs)
  })

  try {
    const outcome = await Promise.race([completed, deadlinePromise])
    if (outcome === deadlineToken) {
      const failures: unknown[] = []
      if (!exited) {
        try {
          exitStatus = await terminateWorker(child, exitPromise, () => exited, caseRoot)
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        await closeWorkerOutputCaptures(caseRoot, [stdout, stderr])
      } catch (error) {
        failures.push(error)
      }
      const deadline = new WorkerDeadlineError(deadlineMs, exitStatus ?? -1, stdout.snapshot(), stderr.snapshot())
      if (failures.length > 0) {
        throw new WorkerDeadlineSettlementError(deadline, failures)
      }
      throw deadline
    }
    return outcome
  } catch (error) {
    if (error instanceof WorkerDeadlineError || error instanceof WorkerDeadlineSettlementError) throw error
    const settlementFailures: unknown[] = []
    if (!exited && !unsafeAcceptanceCases.has(caseRoot)) {
      try {
        exitStatus = await terminateWorker(child, exitPromise, () => exited, caseRoot)
      } catch (failure) {
        settlementFailures.push(failure)
      }
    }
    try {
      await closeWorkerOutputCaptures(caseRoot, [stdout, stderr])
    } catch (failure) {
      settlementFailures.push(failure)
    }
    if (settlementFailures.length > 0) {
      const failure = new Error("Worker failed and could not be settled cleanly", { cause: error })
      Reflect.set(failure, "settlementFailures", settlementFailures)
      throw failure
    }
    throw error
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
  }
}

class WorkerDeadlineError extends Error {
  override readonly name = "WorkerDeadlineError"

  constructor(
    readonly deadlineMs: number,
    readonly exit: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`Worker exceeded its ${deadlineMs}ms deadline (exit ${exit})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
}

class WorkerDeadlineSettlementError extends Error {
  override readonly name = "WorkerDeadlineSettlementError"

  constructor(
    readonly deadline: WorkerDeadlineError,
    readonly settlementFailures: readonly unknown[],
  ) {
    super("Worker reached its deadline but did not settle cleanly", { cause: deadline })
  }
}

class WorkerLeakError extends Error {
  override readonly name = "WorkerLeakError"

  constructor(
    readonly caseRoot: string,
    readonly pid: number,
  ) {
    super(
      `Worker ${pid} did not exit within ${workerKillGraceMs}ms after termination or ${workerHardKillDeadlineMs}ms after forced termination; cleanup is prohibited for ${caseRoot}`,
    )
  }
}

class WorkerOutputLeakError extends Error {
  override readonly name = "WorkerOutputLeakError"

  constructor(readonly caseRoot: string) {
    super(
      `Worker output pipes did not close within ${workerOutputCloseDeadlineMs}ms after cancellation; cleanup is prohibited for ${caseRoot}`,
    )
  }
}

async function terminateWorker(
  child: ReturnType<typeof Bun.spawn>,
  exitPromise: Promise<number>,
  hasExited: () => boolean,
  caseRoot: string,
): Promise<number> {
  const failures: unknown[] = []
  if (!hasExited()) {
    try {
      child.kill()
    } catch (error) {
      failures.push(error)
    }
  }
  const gracefulExit = await settleWorkerExit(exitPromise, workerKillGraceMs)
  if (gracefulExit !== undefined) {
    if (failures.length > 0) {
      throw new AggregateError(failures, "Worker exited, but its initial termination signal failed")
    }
    return gracefulExit
  }

  try {
    child.kill(9)
  } catch (error) {
    failures.push(error)
  }
  const forcedExit = await settleWorkerExit(exitPromise, workerHardKillDeadlineMs)
  if (forcedExit !== undefined) return forcedExit

  const leak = new WorkerLeakError(caseRoot, child.pid)
  unsafeAcceptanceCases.set(caseRoot, leak)
  if (failures.length > 0) throw new AggregateError([leak, ...failures], "Production acceptance worker leaked")
  throw leak
}

async function settleWorkerExit(exitPromise: Promise<number>, timeoutMs: number): Promise<number | undefined> {
  const outcome = await Promise.race([
    exitPromise.then((exit) => ({ kind: "exit" as const, exit })),
    Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
  ])
  return outcome.kind === "timeout" ? undefined : outcome.exit
}

interface WorkerOutputCapture {
  readonly settled: Promise<string>
  readonly cancel: (reason: unknown) => Promise<void>
  readonly snapshot: () => string
}

function captureBoundedWorkerOutput(stream: ReadableStream<Uint8Array>): WorkerOutputCapture {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let kept = 0
  let truncated = false
  let cancelled = false
  let finished = false
  const snapshot = () =>
    `${Buffer.concat(chunks, kept).toString("utf8")}${
      truncated ? outputTruncationMarker : cancelled ? outputCancellationMarker : ""
    }`
  const settled = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (kept >= workerOutputLimitBytes) {
          truncated = true
          continue
        }
        const take = Math.min(value.byteLength, workerOutputLimitBytes - kept)
        chunks.push(Buffer.from(value.subarray(0, take)))
        kept += take
        if (take < value.byteLength) truncated = true
      }
      return snapshot()
    } finally {
      finished = true
      reader.releaseLock()
    }
  })()
  return {
    settled,
    snapshot,
    cancel: async (reason) => {
      if (finished) return
      cancelled = true
      await reader.cancel(reason)
    },
  }
}

async function closeWorkerOutputCaptures(caseRoot: string, captures: readonly WorkerOutputCapture[]): Promise<void> {
  const natural = await Promise.race([
    Promise.allSettled(captures.map((capture) => capture.settled)).then((results) => ({
      kind: "settled" as const,
      results,
    })),
    Bun.sleep(workerOutputCloseDeadlineMs / 2).then(() => ({ kind: "timeout" as const })),
  ])
  if (natural.kind === "settled") {
    const failures = natural.results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length > 0) throw new AggregateError(failures, "Worker output capture failed")
    return
  }

  const leak = new WorkerOutputLeakError(caseRoot)
  unsafeAcceptanceCases.set(caseRoot, leak)
  const cancelled = Promise.allSettled(captures.map((capture) => capture.cancel(new Error("Worker output closed"))))
  const settled = Promise.allSettled(captures.map((capture) => capture.settled))
  const outcome = await Promise.race([
    Promise.all([cancelled, settled]).then((results) => ({ kind: "settled" as const, results })),
    Bun.sleep(workerOutputCloseDeadlineMs / 2).then(() => ({ kind: "timeout" as const })),
  ])
  if (outcome.kind === "timeout") throw leak
  const failures = outcome.results.flat().flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (failures.length > 0) {
    throw new AggregateError([leak, ...failures], "Worker output capture cancellation failed after missing EOF")
  }
  throw leak
}

function makeAcceptanceCaseRoot(prefix: string, outerTimeoutMs = 120_000): string {
  if (!/^production-[a-z0-9-]+$/.test(prefix)) throw new Error(`Invalid production acceptance prefix: ${prefix}`)
  if (!Number.isSafeInteger(outerTimeoutMs) || outerTimeoutMs <= workerTerminationBudgetMs + 250) {
    throw new Error(`Acceptance outer timeout leaves no safe worker termination budget: ${outerTimeoutMs}`)
  }
  const caseRoot = path.resolve(acceptanceRoot, `${prefix}-${randomUUID()}`)
  assertAcceptanceCaseRoot(caseRoot)
  const now = Date.now()
  const reserve = Math.min(15_000, Math.max(workerTerminationBudgetMs + 500, Math.floor(outerTimeoutMs / 8)))
  acceptanceCases.set(caseRoot, {
    outerDeadlineAt: now + outerTimeoutMs,
    workerDeadlineAt: now + outerTimeoutMs - reserve,
  })
  return caseRoot
}

function remainingWorkerDeadline(caseRoot: string, overrideMs?: number): number {
  const resolved = assertAcceptanceCaseRoot(caseRoot)
  const budget = acceptanceCases.get(resolved)
  if (budget === undefined) throw new Error(`Worker case root is not registered for cleanup: ${resolved}`)
  const now = Date.now()
  const outerRemaining = Math.floor(budget.outerDeadlineAt - now)
  const deadlineMs = overrideMs ?? Math.floor(budget.workerDeadlineAt - now)
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`Production acceptance worker budget is exhausted before spawn: ${deadlineMs}`)
  }
  if (deadlineMs + workerTerminationBudgetMs >= outerRemaining) {
    throw new Error(
      `Worker deadline plus termination budget must finish before the outer test timeout: ${deadlineMs} + ${workerTerminationBudgetMs} >= ${outerRemaining}`,
    )
  }
  return deadlineMs
}

async function removeAcceptanceCaseRoot(caseRoot: string): Promise<void> {
  const resolved = assertAcceptanceCaseRoot(caseRoot)
  const leak = unsafeAcceptanceCases.get(resolved)
  if (leak !== undefined) {
    throw new Error(`Refusing to clean a case whose worker may still be live: ${resolved}`, { cause: leak })
  }
  if (!(await assertAcceptanceRootSafe())) return
  const stats = await fs.lstat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (stats === undefined) return
  if (stats.isSymbolicLink()) {
    await removeSymbolicLink(resolved)
    return
  }
  if (!stats.isDirectory()) {
    await removeOrdinaryEntry(resolved)
    return
  }
  await assertCanonicalOrdinaryDirectory(resolved, stats)
  await removeDirectoryChildren(resolved, resolved)
  await fs.chmod(resolved, 0o700).catch(() => undefined)
  await fs.rmdir(resolved)
}

async function waitForExactFile(target: string, expected: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const actual = await fs.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (actual === expected) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for exact descendant exit marker: ${target}`)
}

async function assertAcceptanceRootSafe(): Promise<boolean> {
  const resolved = path.resolve(acceptanceRoot)
  const stats = await fs.lstat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (stats === undefined) return false
  await assertCanonicalOrdinaryDirectory(resolved, stats)
  return true
}

async function assertCanonicalOrdinaryDirectory(directory: string, stats: Awaited<ReturnType<typeof fs.lstat>>) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Refusing cleanup through a non-ordinary directory: ${directory}`)
  }
  const canonical = path.resolve(await fs.realpath(directory))
  if (canonical.toLowerCase() !== path.resolve(directory).toLowerCase()) {
    throw new Error(`Refusing cleanup through an aliased or reparse directory: ${directory} -> ${canonical}`)
  }
}

function assertAcceptanceCaseRoot(caseRoot: string): string {
  const resolved = path.resolve(caseRoot)
  const parent = path.dirname(resolved)
  if (parent.toLowerCase() !== path.resolve(acceptanceRoot).toLowerCase()) {
    throw new Error(`Refusing to clean acceptance case outside the exact acceptance root: ${resolved}`)
  }
  if (
    !/^production-[a-z0-9-]+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path.basename(resolved),
    )
  ) {
    throw new Error(`Refusing to clean malformed acceptance case root: ${resolved}`)
  }
  return resolved
}

async function removeDirectoryChildren(caseRoot: string, directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const candidate = path.resolve(directory, entry.name)
    const relative = path.relative(caseRoot, candidate)
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to clean entry outside its acceptance case: ${candidate}`)
    }
    const stats = await fs.lstat(candidate)
    if (stats.isSymbolicLink()) {
      await removeSymbolicLink(candidate)
      continue
    }
    if (stats.isDirectory()) {
      await assertCanonicalOrdinaryDirectory(candidate, stats)
      await removeDirectoryChildren(caseRoot, candidate)
      await fs.chmod(candidate, 0o700).catch(() => undefined)
      await fs.rmdir(candidate)
      continue
    }
    await removeOrdinaryEntry(candidate)
  }
}

async function removeOrdinaryEntry(target: string): Promise<void> {
  try {
    await fs.unlink(target)
    return
  } catch (error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined
    if (code === "ENOENT") return
    if (code !== "EPERM" && code !== "EACCES") throw error
  }

  const before = await fs.lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`Refusing to chmod a non-ordinary or multiply-linked cleanup entry: ${target}`)
  }
  await fs.chmod(target, 0o600)
  const after = await fs.lstat(target)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  ) {
    throw new Error(`Cleanup entry identity changed across its single-link chmod gate: ${target}`)
  }
  await fs.unlink(target)
}

async function removeSymbolicLink(target: string): Promise<void> {
  try {
    await fs.unlink(target)
  } catch (error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined
    if (code !== "EPERM" && code !== "EISDIR") throw error
    await fs.rmdir(target)
  }
}

async function waitForRunningLeaseExpiry(databasePath: string): Promise<void> {
  const productionLeaseDurationMs = 10_000
  const leaseClockToleranceMs = 250
  const { runningStages, leasedEvents } = readOnlyDatabase(databasePath, (database) => ({
    runningStages: database
      .query<
        {
          id: string
          status: string
          attempt: number
          lease_owner: string | null
          lease_expires_at: number | null
        },
        []
      >(
        "SELECT id, status, attempt, lease_owner, lease_expires_at FROM workflow_stage WHERE status = 'running' ORDER BY ordinal",
      )
      .all(),
    leasedEvents: database
      .query<{ data: string }, []>("SELECT data FROM event WHERE type = 'workflow.stage.leased.1' ORDER BY rowid")
      .all(),
  }))
  expect(runningStages).toHaveLength(1)
  const running = runningStages[0]
  if (running === undefined) throw new Error("Expected exactly one running stage with a durable lease")
  expect(running.status).toBe("running")
  expect(Number.isSafeInteger(running.attempt) && running.attempt > 0).toBe(true)
  expect(typeof running.lease_owner === "string" && running.lease_owner.trim().length > 0).toBe(true)
  if (running?.lease_expires_at === null || running?.lease_expires_at === undefined) {
    throw new Error("Expected one running stage with a durable lease")
  }
  expect(Number.isSafeInteger(running.lease_expires_at) && running.lease_expires_at >= 0).toBe(true)
  const parsedLeases = leasedEvents.map((row) => JSON.parse(row.data))
  const matchingLeases = parsedLeases.filter(
    (event) => event.stageID === running.id && event.attempt === running.attempt,
  )
  expect(matchingLeases.length).toBeGreaterThan(0)
  const leased = matchingLeases.at(-1)
  if (leased === undefined) throw new Error("Expected a leased event for the running stage attempt")
  expect(typeof leased.leaseOwner === "string" && leased.leaseOwner.trim().length > 0).toBe(true)
  expect(Number.isSafeInteger(leased.leaseExpiresAt) && leased.leaseExpiresAt >= 0).toBe(true)
  expect(leased?.leaseOwner).toBe(running.lease_owner)
  expect(running.lease_expires_at).toBeGreaterThanOrEqual(leased?.leaseExpiresAt)
  const remaining = running.lease_expires_at - Date.now()
  expect(remaining).toBeLessThanOrEqual(productionLeaseDurationMs + leaseClockToleranceMs)
  await Bun.sleep(Math.max(0, remaining + 25))
  const after = readOnlyDatabase(databasePath, (database) =>
    database
      .query<
        {
          id: string
          status: string
          attempt: number
          lease_owner: string | null
          lease_expires_at: number | null
        },
        []
      >(
        "SELECT id, status, attempt, lease_owner, lease_expires_at FROM workflow_stage WHERE status = 'running' ORDER BY ordinal",
      )
      .all(),
  )
  expect(after).toEqual([running])
  expect(Date.now()).toBeGreaterThan(running.lease_expires_at)
}

function readOnlyDatabase<T>(databasePath: string, read: (database: BunDatabase) => T): T {
  const database = new BunDatabase(databasePath, { readonly: true })
  try {
    return read(database)
  } finally {
    database.close()
  }
}

async function initializeRepository(
  workspace: string,
  caseRoot: string,
  files: readonly string[] = ["index.html"],
): Promise<void> {
  const git = Bun.spawnSync(["git", "init", "--quiet", workspace], {
    cwd: workspace,
    env: childEnvironment(caseRoot),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (git.exitCode !== 0) throw new Error(git.stderr.toString())
  const add = Bun.spawnSync(["git", "add", ...files], {
    cwd: workspace,
    env: childEnvironment(caseRoot),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (add.exitCode !== 0) throw new Error(add.stderr.toString())
}

function childEnvironment(caseRoot: string): Record<string, string> {
  const temp = path.join(caseRoot, "temp")
  const cache = path.join(caseRoot, "cache")
  const data = path.join(caseRoot, "data", "xdg")
  const config = path.join(caseRoot, "config")
  return {
    PATH: process.env.PATH ?? "",
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows",
    WINDIR: process.env.WINDIR ?? "C:\\Windows",
    COMSPEC: process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
    TEMP: temp,
    TMP: temp,
    BUN_INSTALL_CACHE_DIR: path.join(cache, "bun"),
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    OPENCODE_CACHE: path.join(cache, "product"),
    OPENCODE_DATA: path.join(data, "product"),
    OPENCODE_CONFIG: path.join(config, "product"),
    PLAYWRIGHT_BROWSERS_PATH: path.join(caseRoot, "browser"),
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(caseRoot, "git", "global.config"),
    GIT_OPTIONAL_LOCKS: "0",
    NO_COLOR: "1",
  }
}
