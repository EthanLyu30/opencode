import { canonicalJson } from "../campaign/canonical"
import type { HostManifest } from "./contracts"
import type { OperationReceipt } from "./receipt"
import { sha256Text } from "../hash"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import {
  decodeEngineApproval,
  decodeHostManifest,
  type EngineSession,
  type EngineApproval,
  type DockerRunner,
  type AuthorityGuard,
} from "./contracts"
import { revalidateSession, sessionState } from "./preflight"
import { isRealDockerRunner, requireOperation, makeDockerRunner } from "./docker"
import { requestOf } from "./contracts"
import { createOwnedContainer, inspectOwnedContainer, cleanupOwnedContainer, type Owner } from "./ownership"
import { recordOperationReceipt, verifyOperationReceipt, requireOperationReceipt } from "./receipt"
import { publishImmutable } from "../offline/atomic"
import { bindEvidenceFile, verifyEvidenceFile, type EvidenceReference } from "../evaluator/evidence"
import { freeze } from "../corpus/evaluation-profile"
import { fileIdentity } from "./storage"
import { linuxSafetyWorkerSource } from "./acceptance-worker"
import { requireCapabilityReceipt, type CapabilityReceipt } from "./capability"
import { requireBrowserTrace } from "./browser"
import type { PublishedEvidence } from "../evaluator/capture"
import type { EvaluationIdentityV2 } from "../corpus/evaluation-profile"
import type { RawBuild, RawProbe } from "./linux-backend"
import type { ProbeResponse } from "../evaluator/independent/probe"
import { requireDependencyAudit } from "./dependency-auditors"
export const engineCheckIDs = [
  "engine-storage-image",
  "privilege-root",
  "network-canary",
  "mounts-archive",
  "build-noexec-dotenv",
  "bounded-resources",
  "preview-browser-pdf",
  "exact-production-tools",
  "cancellation-recovery",
  "foreign-isolation",
] as const
export type EngineCheckID = (typeof engineCheckIDs)[number]
export type EngineReceipt = Readonly<{
  schemaVersion: 2
  acceptanceID: string
  manifestSha256: string
  checks: readonly { id: EngineCheckID; receipt: OperationReceipt; evidence: readonly EvidenceReference[] }[]
  receiptSha256: string
}>
export type CheckResult = Readonly<{
  id: EngineCheckID
  status: "passed" | "failed" | "blocked" | "not_run"
  evidence: readonly EvidenceReference[]
  code: string | null
}>
export type EngineAcceptance =
  | { status: "passed"; receipt: EngineReceipt }
  | { status: "blocked" | "failed"; checks: readonly CheckResult[] }
export type ProjectAcceptanceEvidence = Readonly<{
  kind: "chart" | "http" | "pdf"
  identity: EvaluationIdentityV2
  build: RawBuild
  probe: RawProbe | { payload: { kind: "ok"; response: ProbeResponse }; browser: true }
  captures: readonly PublishedEvidence[]
  operations: readonly OperationReceipt[]
  admission: {
    result: {
      networkBlocked: boolean
      websocketBlocked: boolean
      fileBlocked: boolean
      dataBlocked: boolean
      crossCapabilityBlocked: boolean
      blockedRequests: number
    }
    canaryHealthy: boolean
    canaryHits: number
  }
}>
export type EngineAcceptanceInput = Readonly<{
  session: EngineSession
  manifest: HostManifest
  approval: EngineApproval
  runner: DockerRunner
  guard: AuthorityGuard
  signal?: AbortSignal
  projectVerifier?: () => Promise<readonly ProjectAcceptanceEvidence[]>
  capabilityVerifier?: () => Promise<readonly CapabilityReceipt[]>
  dependencyVerifier?: () => Promise<readonly EvidenceReference[]>
}>
export function summarizeEngineChecks(checks: readonly CheckResult[]): "passed" | "blocked" | "failed" {
  if (
    checks.length !== engineCheckIDs.length ||
    new Set(checks.map((c) => c.id)).size !== engineCheckIDs.length ||
    engineCheckIDs.some((id) => !checks.some((c) => c.id === id))
  )
    return "blocked"
  if (checks.some((c) => c.status === "failed")) return "failed"
  return checks.every((c) => c.status === "passed" && c.evidence.length) ? "passed" : "blocked"
}
// The acceptance implementation is the sole issuer. Until its matrix executes there is no authority.
const issued = new WeakSet<object>()
const sessions = new WeakMap<EngineReceipt, EngineSession>()
export function requireEngineReceipt(receipt: EngineReceipt, manifest: HostManifest) {
  if (
    !issued.has(receipt) ||
    receipt.manifestSha256 !== sha256Text(canonicalJson(manifest)) ||
    receipt.acceptanceID !== manifest.acceptanceID
  )
    throw new TypeError("TASK24_ENGINE_RECEIPT_AUTHORITY")
  const session = sessions.get(receipt)
  if (!session) throw new TypeError("TASK24_ENGINE_RECEIPT_AUTHORITY")
  sessionState(session)
}

export async function verifyFrozenArtifacts(manifest: HostManifest, runner?: DockerRunner) {
  if (manifest.phase !== "accept") throw new TypeError("TASK24_LINUX_ACCEPT_PHASE")
  for (const artifact of manifest.artifacts)
    if (artifact.path) {
      const file = await fileIdentity(artifact.path)
      if (file.sha256 !== artifact.sha256) throw new TypeError("TASK24_LINUX_ARTIFACT_STALE")
    }
  if (runner)
    for (const artifact of manifest.artifacts.filter((a) => a.kind === "image")) {
      const result = await runner.execute({
        argv: ["image", "inspect", "--format", "{{json .}}", artifact.image!],
        timeoutMs: 15000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal: new AbortController().signal,
      })
      if (!result.started || result.exitCode !== 0 || result.truncated)
        throw new TypeError("TASK24_LINUX_IMAGE_UNAVAILABLE")
      const image = Schema.decodeUnknownSync(
        Schema.Struct({
          Os: Schema.String,
          Architecture: Schema.String,
          RepoDigests: Schema.Array(Schema.String),
          Id: Schema.String,
        }),
      )(JSON.parse(Buffer.from(result.stdout).toString("utf8")))
      if (
        image.Os !== "linux" ||
        image.Architecture !== manifest.architecture ||
        !image.RepoDigests.includes(artifact.image!) ||
        !/^sha256:[a-f0-9]{64}$/.test(image.Id)
      )
        throw new TypeError("TASK24_LINUX_IMAGE_STALE")
    }
}
export async function restoreEngineReceipt(input: {
  session: EngineSession
  receipt: EngineReceipt
  expectedSha256: string
}): Promise<EngineReceipt> {
  const state = await revalidateSession(input.session)
  const { openLinuxRuntime } = await import("./runtime")
  await (await openLinuxRuntime(input.session)).guard()
  await verifyFrozenArtifacts(
    state.manifest,
    makeDockerRunner({
      request: requestOf(state.manifest),
      session: input.session,
      guard: async () => {
        await revalidateSession(input.session)
      },
    }),
  )
  const { receiptSha256, ...body } = input.receipt
  if (
    receiptSha256 !== input.expectedSha256 ||
    sha256Text(canonicalJson(body)) !== receiptSha256 ||
    input.receipt.manifestSha256 !== input.session.manifestSha256 ||
    input.receipt.acceptanceID !== input.session.acceptanceID ||
    canonicalJson(input.receipt.checks.map((c) => c.id)) !== canonicalJson(engineCheckIDs)
  )
    throw new TypeError("TASK24_ENGINE_RECEIPT_STALE")
  const file = path.join(state.manifest.roots.evidence, `engine-${receiptSha256}.json`)
  if (canonicalJson(JSON.parse(await fs.readFile(file, "utf8"))) !== canonicalJson(input.receipt))
    throw new TypeError("TASK24_ENGINE_RECEIPT_DRIFT")
  for (const check of input.receipt.checks) {
    if (check.receipt.assurance !== "linux-attested" || !check.evidence.length)
      throw new TypeError("TASK24_ENGINE_RECEIPT_FIXTURE")
    verifyOperationReceipt({
      receipt: check.receipt,
      manifest: state.manifest,
      evidenceRoot: state.manifest.roots.evidence,
    })
    for (const ref of check.evidence) verifyEvidenceFile(state.manifest.roots.evidence, ref)
  }
  if (!isRealDockerRunner(state.inspection.runner)) throw new TypeError("TASK24_ENGINE_RECEIPT_FIXTURE")
  const receipt = freeze(input.receipt)
  issued.add(receipt)
  sessions.set(receipt, input.session)
  return receipt
}

export async function acceptLinuxEngine(input: EngineAcceptanceInput): Promise<EngineAcceptance> {
  const checks: CheckResult[] = engineCheckIDs.map((id) => ({
    id,
    status: "not_run",
    evidence: [],
    code: "acceptance_not_run",
  }))
  const blocked = (code: string): EngineAcceptance => ({
    status: "blocked",
    checks: checks.map((c) => (c.status === "not_run" ? { ...c, code } : c)),
  })
  if (!input?.session || !input.manifest || !input.approval || !input.runner) return blocked("accept_approval_required")
  try {
    const approval = decodeEngineApproval(input.approval),
      manifest = decodeHostManifest(input.manifest),
      state = await revalidateSession(input.session)
    if (
      approval.scope !== "accept" ||
      manifest.phase !== "accept" ||
      canonicalJson(approval) !== canonicalJson(state.approval) ||
      canonicalJson(manifest) !== canonicalJson(state.manifest)
    )
      return blocked("accept_approval_mismatch")
    if (!isRealDockerRunner(input.runner) || !isRealDockerRunner(state.inspection.runner))
      return blocked("real_docker_transport_required")
    if (!input.projectVerifier || !input.capabilityVerifier || !input.dependencyVerifier)
      return blocked("project_and_exact_binary_matrix_inputs_required")
    await verifyFrozenArtifacts(manifest, input.runner)
    const dependencyEvidence = await input.dependencyVerifier()
    requireDependencyAudit(dependencyEvidence, input.session)
    const signal = input.signal ?? new AbortController().signal,
      nonce = randomBytes(16).toString("hex"),
      root = await fs.mkdtemp(path.join(manifest.roots.work, "acceptance-"))
    await fs.writeFile(path.join(root, "sentinel"), "own acceptance sentinel", { flag: "wx" })
    const before = await fileIdentity(path.join(root, "sentinel")),
      owners: Owner[] = [],
      operations: OperationReceipt[] = []
    const owner = (operationID: string) => ({
      acceptanceID: input.session.acceptanceID,
      runID: "engine-acceptance",
      attemptID: "engine-" + nonce,
      leaseGeneration: 1,
      operationID,
      nonce: randomBytes(16).toString("hex"),
      daemonFingerprint: state.inventory.contextFingerprint,
    })
    const image = manifest.artifacts.find((a) => a.id === "linux-runtime" && a.kind === "image")
    if (!image || !("image" in image) || !image.image) return blocked("linux_runtime_missing")
    let canaryHits = 0
    const canaryNonce = randomBytes(16).toString("hex"),
      canary = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch(r) {
          if (new URL(r.url).pathname === "/" + canaryNonce) {
            canaryHits++
            return new Response("own healthy canary")
          }
          return new Response(null, { status: 404 })
        },
      })
    const healthy = await fetch(`http://127.0.0.1:${canary.port}/${canaryNonce}`)
    if ((await healthy.text()) !== "own healthy canary") {
      canary.stop(true)
      return blocked("canary_not_healthy")
    }
    canaryHits = 0
    async function execute(o: Owner, source: string, stdin: unknown, timeoutMs = 15000, maxStdoutBytes = 1048576) {
      await requireOperation(input.session, "container-exec", input.guard)
      const argv = ["container", "exec", "--interactive", o.containerID, "/usr/local/bin/node", "-e", source],
        execution = await input.runner.execute({
          argv,
          stdin: Buffer.from(canonicalJson(stdin)),
          timeoutMs,
          maxStdoutBytes,
          maxStderrBytes: 65536,
          signal,
        })
      const inspect = await inspectOwnedContainer({ ...input, owner: o, signal })
      const receipt = await recordOperationReceipt({
        ...input,
        owner: o,
        operation: "engine-probe",
        binding: {
          candidateSha256: before.sha256,
          configSha256: manifest.policySha256,
          profileSha256: manifest.testSha256,
          dependencySha256: image!.sha256,
          workerSha256: sha256Text(source),
        },
        argv,
        inspect,
        execution,
        evidenceRoot: manifest.roots.evidence,
      })
      operations.push(receipt)
      return { execution, receipt }
    }
    const evidence: EvidenceReference[] = []
    async function row(id: EngineCheckID, passed: boolean, refs: readonly EvidenceReference[], code: string) {
      const index = checks.findIndex((c) => c.id === id)
      checks[index] = { id, status: passed ? "passed" : "failed", evidence: refs, code: passed ? null : code }
    }
    try {
      const list = await input.runner.execute({
        argv: ["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"],
        timeoutMs: 15000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal,
      })
      if (!list.started || list.exitCode || list.truncated) throw new TypeError("TASK24_ACCEPT_FOREIGN_SNAPSHOT")
      const foreign = Buffer.from(list.stdout).toString("utf8").trim().split(/\s+/).filter(Boolean)
      const info = await input.runner.execute({
          argv: ["info", "--format", "{{json .}}"],
          timeoutMs: 15000,
          maxStdoutBytes: 1048576,
          maxStderrBytes: 65536,
          signal,
        }),
        engineInfo = Schema.decodeUnknownSync(Schema.Struct({ MemTotal: Schema.Int }))(
          JSON.parse(Buffer.from(info.stdout).toString("utf8")),
        )
      if (engineInfo.MemTotal < 2147483648) return blocked("daemon_resource_headroom_not_verified")
      const ro = await createOwnedContainer({
        ...input,
        owner: owner("readonly"),
        spec: {
          image: image.image,
          argv: ["/usr/local/bin/node", "-e", "setInterval(()=>{},1000)"],
          workspace: { source: root, readonly: true },
        },
        signal,
      })
      owners.push(ro)
      const audit = await execute(
        ro,
        linuxSafetyWorkerSource(),
        { nonce, canary: `http://host.docker.internal:${canary.port}/${canaryNonce}`, pressure: true },
        30000,
      )
      if (!audit.execution.started || audit.execution.exitCode || audit.execution.truncated)
        throw new TypeError("TASK24_ACCEPT_AUDIT_FAILED")
      const facts = Schema.decodeUnknownSync(
        Schema.Struct({
          uid: Schema.Int,
          gid: Schema.Int,
          capEff: Schema.String,
          noNewPrivs: Schema.Int,
          rootWriteDenied: Schema.Boolean,
          forbiddenAbsent: Schema.Boolean,
          interfaces: Schema.Array(Schema.String),
          routes: Schema.String,
          canaryBlocked: Schema.Boolean,
          readonlyDenied: Schema.Boolean,
          nodeWorks: Schema.Boolean,
          noexecDenied: Schema.Boolean,
          dotenvAbsent: Schema.Boolean,
          wrongExit: Schema.Int,
          correctExit: Schema.Int,
          memoryMax: Schema.String,
          pidsMax: Schema.String,
          cpuMax: Schema.String,
          pidRejected: Schema.Boolean,
          memoryRejected: Schema.Boolean,
        }),
      )(JSON.parse(Buffer.from(audit.execution.stdout).toString("utf8")), { onExcessProperty: "error" })
      const observedFile = path.join(manifest.roots.evidence, `engine-observed-${nonce}.json`)
      await publishImmutable(
        observedFile,
        canonicalJson({ manifestSha256: input.session.manifestSha256, facts, receipt: audit.receipt.receiptSha256 }),
      )
      evidence.push(
        audit.receipt.evidence,
        bindEvidenceFile(manifest.roots.evidence, observedFile, "engine-observation"),
      )
      await row(
        "privilege-root",
        facts.uid === 65532 &&
          facts.gid === 65532 &&
          /^0+$/.test(facts.capEff) &&
          facts.noNewPrivs === 1 &&
          facts.rootWriteDenied &&
          facts.forbiddenAbsent,
        evidence,
        "privilege_probe_failed",
      )
      await row(
        "network-canary",
        facts.interfaces.every((i) => i === "lo") &&
          facts.routes
            .trim()
            .split("\n")
            .slice(1)
            .every((l) => !l.trim() || l.trim().startsWith("lo")) &&
          facts.canaryBlocked &&
          canaryHits === 0,
        evidence,
        "network_probe_failed",
      )
      await row(
        "build-noexec-dotenv",
        facts.nodeWorks && facts.noexecDenied && facts.dotenvAbsent && facts.wrongExit === 1 && facts.correctExit === 0,
        evidence,
        "build_noexec_dotenv_failed",
      )
      const rw = await createOwnedContainer({
        ...input,
        owner: owner("mutable"),
        spec: {
          image: image.image,
          argv: ["/usr/local/bin/node", "-e", "setInterval(()=>{},1000)"],
          workspace: { source: root, readonly: false },
        },
        signal,
      })
      owners.push(rw)
      const write = await execute(
        rw,
        `import fs from 'node:fs/promises';await fs.writeFile('/workspace/own-write','mutable');process.stdout.write('ok')`,
        {},
      )
      await row(
        "mounts-archive",
        facts.readonlyDenied &&
          write.execution.exitCode === 0 &&
          (await fs.readFile(path.join(root, "own-write"), "utf8")) === "mutable",
        [...evidence, write.receipt.evidence],
        "mount_write_probe_failed",
      )
      const limited = await execute(ro, `process.stdout.write('x'.repeat(1048577))`, {}, 5000),
        timed = await execute(ro, `setInterval(()=>{},1000)`, {}, 100)
      await row(
        "bounded-resources",
        facts.memoryMax === "1073741824" &&
          facts.pidsMax === "64" &&
          facts.cpuMax === "150000 100000" &&
          facts.pidRejected &&
          facts.memoryRejected &&
          limited.execution.truncated &&
          timed.execution.exitCode === 124,
        [...evidence, limited.receipt.evidence, timed.receipt.evidence],
        "resource_probe_failed",
      )
      const projects = await input.projectVerifier!()
      const projectRefs: EvidenceReference[] = []
      if (projects.length !== 3 || new Set(projects.map((p) => p.kind)).size !== 3)
        throw new TypeError("TASK24_ACCEPT_PROJECT_COVERAGE")
      for (const project of projects) {
        if (project.build.payload.kind !== "ok" || project.probe.payload.kind !== "ok" || project.captures.length !== 3)
          throw new TypeError("TASK24_ACCEPT_PROJECT_FAILED")
        for (const operation of [
          project.build.receipt,
          ...("receipt" in project.probe ? [project.probe.receipt] : []),
          ...project.operations,
        ]) {
          requireOperationReceipt(operation)
          if (operation.assurance !== "linux-attested" || operation.manifestSha256 !== input.session.manifestSha256)
            throw new TypeError("TASK24_ACCEPT_PROJECT_FIXTURE")
          projectRefs.push(operation.evidence)
        }
        if ("browser" in project.probe) {
          const trace = requireBrowserTrace(project.probe.payload.response, project.identity)
          verifyEvidenceFile(manifest.roots.evidence, trace.evidence)
          projectRefs.push(trace.evidence)
        }
        const expected = manifest.artifacts.find((a) => a.id === "acceptance-" + project.kind + "-expected")
        if (!expected || sha256Text(canonicalJson(project.probe.payload.response)) !== expected.sha256)
          throw new TypeError("TASK24_ACCEPT_PROJECT_EXPECTATION")
        for (const capture of project.captures) {
          const trace = requireBrowserTrace(capture, project.identity)
          if (
            trace.browserSha256 !== manifest.artifacts.find((a) => a.id === "browser")?.sha256 ||
            trace.fontSha256 !== manifest.artifacts.find((a) => a.id === "fonts")?.sha256 ||
            trace.helperSha256 !== manifest.artifacts.find((a) => a.id === "browser-helper")?.sha256
          )
            throw new TypeError("TASK24_ACCEPT_BROWSER_RUNTIME")
          projectRefs.push(trace.evidence)
          verifyEvidenceFile(manifest.roots.evidence, trace.evidence)
        }
        const admission = project.admission,
          trace = requireBrowserTrace(admission.result, project.identity)
        if (
          !admission.canaryHealthy ||
          admission.canaryHits !== 0 ||
          !admission.result.networkBlocked ||
          !admission.result.websocketBlocked ||
          !admission.result.fileBlocked ||
          !admission.result.dataBlocked ||
          !admission.result.crossCapabilityBlocked ||
          admission.result.blockedRequests < 1
        )
          throw new TypeError("TASK24_ACCEPT_BROWSER_ADMISSION")
        verifyEvidenceFile(manifest.roots.evidence, trace.evidence)
        projectRefs.push(trace.evidence)
        if (project.kind === "http" && !project.operations.some((o) => o.operation === "preview"))
          throw new TypeError("TASK24_ACCEPT_HTTP_RELAY")
      }
      await row("preview-browser-pdf", true, projectRefs, "project_probe_failed")
      const capabilities = await input.capabilityVerifier!()
      if (capabilities.length !== 5 || new Set(capabilities.map((c) => c.armID)).size !== 5)
        throw new TypeError("TASK24_ACCEPT_CAPABILITY_COVERAGE")
      for (const capability of capabilities) requireCapabilityReceipt(capability, input.session)
      await row(
        "exact-production-tools",
        true,
        capabilities.flatMap((c) => c.cases.flatMap((t) => t.evidence)),
        "capability_probe_failed",
      )
      const dormant = await createOwnedContainer({
        ...input,
        owner: owner("created-not-started"),
        spec: { image: image.image, argv: ["/usr/local/bin/node", "-e", "setInterval(()=>{},1000)"] },
        signal,
        start: false,
      })
      owners.push(dormant)
      const dormantInspection = await inspectOwnedContainer({ ...input, owner: dormant, signal })
      const stale = await cleanupOwnedContainer({
        ...input,
        owner: { ...ro, leaseGeneration: ro.leaseGeneration + 1 },
        signal,
      })
      const orphanRefs: EvidenceReference[] = []
      for (const kind of ["build", "probe", "preview"]) {
        const orphan = await createOwnedContainer({
          ...input,
          owner: owner("orphan-" + kind),
          spec: {
            image: image.image,
            argv: ["/usr/local/bin/node", "-e", "setInterval(()=>{},1000)"],
            workspace: { source: root, readonly: false },
          },
          signal,
        })
        owners.push(orphan)
        const marker = path.join(root, kind + ".started"),
          pending = execute(
            orphan,
            `import fs from 'node:fs/promises';await fs.writeFile('/workspace/${kind}.started',${JSON.stringify(nonce)});setInterval(()=>{},1000)`,
            {},
            10000,
          )
        const deadline = Date.now() + 5000
        while (Date.now() < deadline && (await fs.readFile(marker, "utf8").catch(() => "")) !== nonce)
          await new Promise((resolve) => setTimeout(resolve, 20))
        if ((await fs.readFile(marker, "utf8").catch(() => "")) !== nonce)
          throw new TypeError("TASK24_ACCEPT_ORPHAN_NOT_STARTED")
        await requireOperation(input.session, "container-stop", input.guard)
        const stopped = await input.runner.execute({
          argv: ["container", "stop", "--time", "3", orphan.containerID],
          timeoutMs: 5000,
          maxStdoutBytes: 1048576,
          maxStderrBytes: 65536,
          signal,
        })
        const ended = await pending,
          inspection = await inspectOwnedContainer({ ...input, owner: orphan, signal })
        if (stopped.exitCode !== 0 || inspection.State.Running || ended.execution.exitCode === 0)
          throw new TypeError("TASK24_ACCEPT_ORPHAN_NOT_ENDED")
        orphanRefs.push(ended.receipt.evidence)
      }
      await row(
        "cancellation-recovery",
        !dormantInspection.State.Running && !stale.ended && !stale.removed,
        [...evidence, ...orphanRefs],
        "owner_fencing_failed",
      )
      for (const o of owners) {
        const cleanup = await cleanupOwnedContainer({ ...input, owner: o, signal })
        if (!cleanup.ended || !cleanup.removed) throw new TypeError("TASK24_ACCEPT_CLEANUP_UNCERTAIN")
      }
      owners.length = 0
      const afterList = await input.runner.execute({
        argv: ["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"],
        timeoutMs: 15000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal,
      })
      const remaining = Buffer.from(afterList.stdout).toString("utf8").trim().split(/\s+/).filter(Boolean)
      await row(
        "foreign-isolation",
        afterList.started &&
          afterList.exitCode === 0 &&
          !afterList.truncated &&
          foreign.every((id) => remaining.includes(id)),
        evidence,
        "foreign_resources_changed",
      )
      await revalidateSession(input.session)
      await verifyFrozenArtifacts(manifest, input.runner)
      await row(
        "engine-storage-image",
        (await fileIdentity(path.join(root, "sentinel"))).sha256 === before.sha256,
        [...evidence, ...dependencyEvidence],
        "host_sentinel_changed",
      )
      const status = summarizeEngineChecks(checks)
      if (status !== "passed") return { status, checks }
      const body = {
          schemaVersion: 2 as const,
          acceptanceID: manifest.acceptanceID,
          manifestSha256: input.session.manifestSha256,
          checks: checks.map((c) => ({ id: c.id, receipt: audit.receipt, evidence: c.evidence })),
        },
        receipt = freeze({ ...body, receiptSha256: sha256Text(canonicalJson(body)) })
      await publishImmutable(
        path.join(manifest.roots.evidence, `engine-${receipt.receiptSha256}.json`),
        canonicalJson(receipt),
      )
      issued.add(receipt)
      sessions.set(receipt, input.session)
      return { status: "passed", receipt }
    } finally {
      canary.stop(true)
      let uncertain = false
      for (const o of owners) {
        const cleanup = await cleanupOwnedContainer({ ...input, owner: o, signal: new AbortController().signal })
        if (!cleanup.ended || !cleanup.removed) uncertain = true
      }
      if (uncertain) throw new TypeError("TASK24_ACCEPT_CLEANUP_UNCERTAIN")
      if (path.dirname(root) !== manifest.roots.work || !path.basename(root).startsWith("acceptance-"))
        throw new TypeError("TASK24_ACCEPT_CLEANUP_ROOT")
      await fs.rm(root, { recursive: true })
    }
  } catch (error) {
    return {
      status: "failed",
      checks: checks.map((c) =>
        c.status === "not_run"
          ? {
              ...c,
              status: "blocked",
              code:
                error instanceof TypeError && /^TASK24_[A-Z0-9_]+$/.test(error.message)
                  ? error.message
                  : "acceptance_driver_failed",
            }
          : c,
      ),
    }
  }
}
