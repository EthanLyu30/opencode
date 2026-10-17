import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { canonicalJson } from "../campaign/canonical"
import { freeze } from "../corpus/evaluation-profile"
import { sha256Text } from "../hash"
import { publishImmutable } from "../offline/atomic"
import { bindEvidenceFile, verifyEvidenceFile, type EvidenceReference } from "../evaluator/evidence"
import type { ArmID, ArmInput, ArmLaunch, DirectArmLaunch } from "../arms/types"
import { prepareWorkflowArm } from "../arms/workflow"
import { prepareDirectArm } from "../arms/direct"
import { fileIdentity } from "./storage"
import { sessionState, revalidateSession } from "./preflight"
import type { FileIdentity, EngineSession, Gate } from "./contracts"
import { requireRealDockerRunner } from "./docker"
import { Schema } from "effect"
import { startFixtureCapabilityProvider, type FixtureReply } from "./fixture-provider"
export type PublicMcpConnection = Readonly<{ pipe: string; capability: string; bun: FileIdentity; entry: FileIdentity }>
export async function configurePublicMcp(
  launch: DirectArmLaunch,
  connection: PublicMcpConnection,
  session: EngineSession,
) {
  const state = sessionState(session)
  for (const [id, file] of [
    ["controller-bun", connection.bun],
    ["public-mcp", connection.entry],
  ] as const) {
    const artifact = state.manifest.artifacts.find((a) => a.id === id && a.kind !== "pending")
    if (
      !artifact ||
      !("sha256" in artifact) ||
      artifact.sha256 !== file.sha256 ||
      artifact.path !== file.path ||
      canonicalJson(await fileIdentity(file.path)) !== canonicalJson(file)
    )
      throw new TypeError("TASK24_PUBLIC_MCP_ARTIFACT")
  }
  if (
    !/^\\\\\.\\pipe\\opencode-task24-[a-f0-9]{64}$/.test(connection.pipe) ||
    !/^[a-f0-9]{64}$/.test(connection.capability) ||
    launch.configFile !== path.join(launch.snapshot.roots.config, "opencode.json")
  )
    throw new TypeError("TASK24_PUBLIC_MCP_CONFIG")
  const config = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    JSON.parse(await fs.readFile(launch.configFile, "utf8")),
  )
  const permission = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(config.permission ?? {})
  await fs.writeFile(
    launch.configFile,
    canonicalJson({
      ...config,
      permission: { ...permission, "task24_*": "allow" },
      mcp: {
        task24: {
          type: "local",
          command: [connection.bun.path, "--no-env-file", "run", connection.entry.path, "--pipe", connection.pipe],
          environment: { TASK24_PUBLIC_TOOL_CAPABILITY: connection.capability },
          enabled: true,
        },
      },
    }),
  )
}
export type HostIsolationAdapter = Readonly<{
  verify(): Promise<Gate<{ evidence: readonly EvidenceReference[] }>>
  launch(input: { launch: ArmLaunch; kind: "visual" | "coding"; readonly: boolean; signal: AbortSignal }): Promise<{
    ended: boolean
    deniedCanaryReads: number
    canaryReads: number
    externalNetworkHits: number
    changed: boolean
    checkExit: number
    preview: boolean
    capture: boolean
    readonlyDenied: boolean
    evidence: readonly EvidenceReference[]
  }>
}>
const adapters = new WeakSet<object>(),
  issued = new WeakSet<object>()
export type CapabilityReceipt = Readonly<{
  schemaVersion: 2
  status: "passed"
  armID: ArmID
  manifestSha256: string
  binary: FileIdentity
  cases: readonly { kind: "visual" | "coding"; launchSha256: string; evidence: readonly EvidenceReference[] }[]
  receiptSha256: string
}>
export async function loadHostIsolationAdapter(input: {
  session: EngineSession
  file: FileIdentity
}): Promise<HostIsolationAdapter> {
  const state = await revalidateSession(input.session),
    artifact = state.manifest.artifacts.find((a) => a.id === "host-isolation" && a.kind === "worker")
  requireRealDockerRunner(state.inspection.runner)
  if (
    !artifact ||
    !("sha256" in artifact) ||
    artifact.sha256 !== input.file.sha256 ||
    artifact.path !== input.file.path ||
    canonicalJson(await fileIdentity(input.file.path)) !== canonicalJson(input.file)
  )
    throw new TypeError("TASK24_ISOLATION_ARTIFACT")
  const module: unknown = await import(pathToFileURL(input.file.path).href)
  if (
    !module ||
    typeof module !== "object" ||
    !("createIsolationAdapter" in module) ||
    typeof module.createIsolationAdapter !== "function"
  )
    throw new TypeError("TASK24_ISOLATION_ADAPTER")
  const adapter: HostIsolationAdapter = await module.createIsolationAdapter()
  if (typeof adapter.verify !== "function" || typeof adapter.launch !== "function")
    throw new TypeError("TASK24_ISOLATION_ADAPTER")
  adapters.add(adapter)
  return adapter
}
export async function verifyBinaryCapabilities(input: {
  binary: FileIdentity
  armID: ArmID
  session: EngineSession
  isolation?: HostIsolationAdapter
  cases?: readonly {
    kind: "visual" | "coding"
    input: ArmInput
    checks?: unknown
    scripts: { main: readonly FixtureReply[]; readonly: readonly FixtureReply[] }
  }[]
  signal?: AbortSignal
  tools?: PublicMcpConnection
  publicTools?: {
    open(
      c: NonNullable<Parameters<typeof verifyBinaryCapabilities>[0]["cases"]>[number],
    ): Promise<{ connection: PublicMcpConnection; setReadonly(): void; dispose(): Promise<void> }>
  }
}): Promise<CapabilityReceipt | { status: "blocked"; code: "tool_capability_blocked"; missing: readonly string[] }> {
  const blocked = (reason: string) => ({
    status: "blocked" as const,
    code: "tool_capability_blocked" as const,
    missing: [reason],
  })
  if (!input.isolation || !adapters.has(input.isolation)) return blocked("verified_os_isolation_adapter")
  const state = await revalidateSession(input.session),
    proof = await input.isolation.verify()
  if (proof.kind !== "ready" || !proof.value.evidence.length) return blocked("os_isolation_evidence")
  if (
    !input.cases ||
    input.cases.length !== 2 ||
    !["visual", "coding"].every((k) => input.cases?.some((c) => c.kind === k))
  )
    return blocked("visual_and_coding_cases")
  if (canonicalJson(await fileIdentity(input.binary.path)) !== canonicalJson(input.binary))
    return blocked("binary_changed")
  const cases = []
  for (const c of input.cases) {
    if (
      c.input.armID !== input.armID ||
      c.input.deterministicOfflineEvidence ||
      c.input.binary.sha256 !== input.binary.sha256 ||
      c.input.binary.executable !== input.binary.path
    )
      return blocked("exact_production_binary")
    const provider = startFixtureCapabilityProvider([...c.scripts.main, ...c.scripts.readonly])
    const publicTools = input.publicTools ? await input.publicTools.open(c) : undefined
    try {
      const armInput = {
        ...c.input,
        brokerOrigin: provider.origin,
        brokerGrant: provider.grant,
        grantExpiresAt: Date.now() + 300000,
      }
      const launch = input.armID === "A" ? await prepareWorkflowArm(armInput) : await prepareDirectArm(armInput)
      if (input.armID !== "A") {
        const connection = publicTools?.connection ?? input.tools
        if (!connection || !("configFile" in launch)) return blocked("public_mcp_connection")
        await configurePublicMcp(launch, connection, input.session)
      }
      const actual =
        c.kind === "coding" && input.armID === "A"
          ? {
              ...launch,
              args: [
                ...launch.args.slice(0, 3),
                "--kind",
                "coding",
                "--checks",
                canonicalJson(c.checks),
                ...launch.args
                  .slice(3)
                  .filter((_, i, a) => a[i - 1] !== "--visual-budget" && a[i] !== "--visual-budget"),
              ],
            }
          : launch
      const result = await input.isolation.launch({
        launch: actual,
        kind: c.kind,
        readonly: false,
        signal: input.signal ?? new AbortController().signal,
      })
      publicTools?.setReadonly()
      const readonly = await input.isolation.launch({
        launch: actual,
        kind: c.kind,
        readonly: true,
        signal: input.signal ?? new AbortController().signal,
      })
      if (
        !provider.observation().complete ||
        !result.ended ||
        !readonly.ended ||
        !result.changed ||
        result.checkExit !== 0 ||
        (c.kind === "visual" && (!result.preview || !result.capture)) ||
        result.canaryReads !== 0 ||
        result.externalNetworkHits !== 0 ||
        result.deniedCanaryReads < 1 ||
        readonly.deniedCanaryReads < 1 ||
        readonly.canaryReads !== 0 ||
        readonly.externalNetworkHits !== 0 ||
        provider.observation().rejected !== 0 ||
        !readonly.readonlyDenied ||
        readonly.changed ||
        !result.evidence.length ||
        !readonly.evidence.length
      )
        return blocked("production_tool_microcheck_failed")
      for (const ref of [...result.evidence, ...readonly.evidence, ...proof.value.evidence])
        verifyEvidenceFile(state.manifest.roots.evidence, ref)
      cases.push({
        kind: c.kind,
        launchSha256: sha256Text(canonicalJson(actual.snapshot)),
        evidence: [...result.evidence, ...readonly.evidence, ...proof.value.evidence],
      })
    } finally {
      await publicTools?.dispose()
      await provider.stop()
    }
  }
  const body = {
      schemaVersion: 2 as const,
      status: "passed" as const,
      armID: input.armID,
      manifestSha256: input.session.manifestSha256,
      binary: input.binary,
      cases,
    },
    receiptSha256 = sha256Text(canonicalJson(body))
  await publishImmutable(
    path.join(state.manifest.roots.evidence, `capability-${receiptSha256}.json`),
    canonicalJson(body),
  )
  const receipt = freeze({ ...body, receiptSha256 })
  issued.add(receipt)
  return receipt
}
export function requireCapabilityReceipt(receipt: CapabilityReceipt, session: EngineSession) {
  if (!issued.has(receipt) || receipt.manifestSha256 !== session.manifestSha256)
    throw new TypeError("TASK24_CAPABILITY_AUTHORITY")
}
export async function restoreCapabilityReceipt(input: {
  session: EngineSession
  receipt: CapabilityReceipt
  expectedSha256: string
}) {
  const state = await revalidateSession(input.session),
    r = input.receipt
  const { receiptSha256, ...body } = r
  if (
    receiptSha256 !== input.expectedSha256 ||
    sha256Text(canonicalJson(body)) !== receiptSha256 ||
    r.schemaVersion !== 2 ||
    r.status !== "passed" ||
    !["A", "B", "C", "D", "E"].includes(r.armID) ||
    r.manifestSha256 !== input.session.manifestSha256 ||
    r.cases.length !== 2 ||
    r.cases
      .map((c) => c.kind)
      .sort()
      .join(",") !== "coding,visual"
  )
    throw new TypeError("TASK24_CAPABILITY_STALE")
  const artifact = state.manifest.artifacts.find(
    (a) => a.id === (["D", "E"].includes(r.armID) ? "upstream" : "modified"),
  )
  if (
    !artifact ||
    !("sha256" in artifact) ||
    artifact.sha256 !== r.binary.sha256 ||
    artifact.path !== r.binary.path ||
    canonicalJson(await fileIdentity(r.binary.path)) !== canonicalJson(r.binary)
  )
    throw new TypeError("TASK24_CAPABILITY_BINARY_STALE")
  if (
    canonicalJson(
      JSON.parse(
        await fs.readFile(path.join(state.manifest.roots.evidence, `capability-${receiptSha256}.json`), "utf8"),
      ),
    ) !== canonicalJson(body)
  )
    throw new TypeError("TASK24_CAPABILITY_FILE_STALE")
  for (const c of r.cases) {
    if (!c.evidence.length || !/^[a-f0-9]{64}$/.test(c.launchSha256)) throw new TypeError("TASK24_CAPABILITY_EVIDENCE")
    for (const e of c.evidence) verifyEvidenceFile(state.manifest.roots.evidence, e)
  }
  const receipt = freeze(r)
  issued.add(receipt)
  return receipt
}
