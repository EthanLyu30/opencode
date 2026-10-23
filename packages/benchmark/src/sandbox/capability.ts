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
import type {
  FileIdentity,
  EngineSession,
  HostManifest,
  Gate,
  DockerRunner,
  DockerInvocation,
  DockerExecution,
} from "./contracts"
import { requireRealDockerRunner } from "./docker"
import { Schema } from "effect"
import { startFixtureCapabilityProvider, type FixtureReply } from "./fixture-provider"
import { verifyBinaryBuildRecords } from "./binary-build"
import { requirePublicToolObservation, type PublicToolObservation } from "./public-tools"
export type PublicMcpConnection = Readonly<
  {
    capability: string
    bun: FileIdentity
    entry: FileIdentity
  } & (
    | { pipe: string; host?: never; port?: never; transport?: "stdio" }
    | { host: "127.0.0.1"; port: number; pipe?: never; transport?: "stdio" | "http" }
  )
>

export function publicMcpArguments(connection: PublicMcpConnection): readonly string[] {
  if (!/^[a-f0-9]{64}$/.test(connection.capability)) throw new TypeError("TASK24_PUBLIC_MCP_CONFIG")
  if (connection.transport !== undefined && connection.transport !== "stdio" && connection.transport !== "http")
    throw new TypeError("TASK24_PUBLIC_MCP_CONFIG")
  if (typeof connection.pipe === "string") {
    if (
      !/^\\\\\.\\pipe\\opencode-task24-[a-f0-9]{64}$/.test(connection.pipe) ||
      connection.host !== undefined ||
      connection.port !== undefined ||
      (connection as PublicMcpConnection).transport === "http"
    )
      throw new TypeError("TASK24_PUBLIC_MCP_CONFIG")
    return ["--pipe", connection.pipe]
  }
  if (
    connection.host !== "127.0.0.1" ||
    !Number.isInteger(connection.port) ||
    connection.port < 1 ||
    connection.port > 65535
  )
    throw new TypeError("TASK24_PUBLIC_MCP_CONFIG")
  return ["--loopback", String(connection.port)]
}
export function publicMcpCommand(connection: PublicMcpConnection): readonly string[] {
  const endpoint = publicMcpArguments(connection)
  return connection.entry.path.endsWith(".exe")
    ? [connection.entry.path, ...endpoint]
    : [connection.bun.path, "--no-env-file", "run", connection.entry.path, ...endpoint]
}
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
  const command = publicMcpCommand(connection)
  if (launch.configFile !== path.join(launch.snapshot.roots.config, "opencode.json"))
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
        task24:
          connection.transport === "http"
            ? {
                type: "remote",
                url: `http://127.0.0.1:${connection.port}/task24/mcp`,
                headers: { Authorization: `Bearer ${connection.capability}` },
                oauth: false,
                enabled: true,
              }
            : {
                type: "local",
                command,
                environment: { TASK24_PUBLIC_TOOL_CAPABILITY: connection.capability },
                enabled: true,
              },
      },
    }),
  )
}
export type HostIsolationAdapter = Readonly<{
  browser?(input: {
    invocation: DockerInvocation
    executable: string
    helper: FileIdentity
    browser: FileIdentity
    node: FileIdentity
    cwd: string
    env: Readonly<Record<string, string>>
    manifestSha256: string
    previewID: string
    previewURL: string
    chromiumSandboxRequired: true
    denyNonPreviewNetwork: true
  }): Promise<{ execution: DockerExecution; observation: unknown }>
  verify(): Promise<Gate<{ evidence: readonly EvidenceReference[] }>>
  launch(input: {
    launch: ArmLaunch
    kind: "visual" | "coding"
    readonly: boolean
    signal: AbortSignal
    tools?: { connection: PublicMcpConnection; observation(): PublicToolObservation }
  }): Promise<{
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

export function verifyPublicToolTransition(input: {
  before: PublicToolObservation
  after: PublicToolObservation
  workspace: string
  kind: "visual" | "coding"
  readonly: boolean
}) {
  requirePublicToolObservation(input.before, input.workspace)
  requirePublicToolObservation(input.after, input.workspace)
  const { before, after } = input
  if (
    before.hostID !== after.hostID ||
    before.readonly !== input.readonly ||
    after.readonly !== input.readonly ||
    after.toolCalls < before.toolCalls ||
    after.deniedReads < before.deniedReads ||
    after.deniedWrites < before.deniedWrites
  )
    return false
  for (const key of ["writes", "checks", "previews", "captures"] as const) {
    if (
      after[key].length < before[key].length ||
      canonicalJson(after[key].slice(0, before[key].length)) !== canonicalJson(before[key])
    )
      return false
  }
  if (input.readonly) return after.writes.length === before.writes.length && after.deniedWrites > before.deniedWrites
  const writes = after.writes.slice(before.writes.length),
    check = after.checks.slice(before.checks.length).at(-1)
  if (
    !writes.some((v) => v.beforeSha256 !== v.afterSha256) ||
    !check ||
    check.revision !== after.writes.length ||
    check.status !== "ok" ||
    !check.commands.length ||
    !check.commands.some((c) => c.id === check.commandID) ||
    check.commands.some((c) => c.exitCode !== 0)
  )
    return false
  if (input.kind === "coding") return true
  const previews = after.previews.slice(before.previews.length),
    captures = after.captures.slice(before.captures.length)
  return previews.some(
    (p) =>
      p.revision === check.revision &&
      p.candidateSha256 === check.candidateSha256 &&
      captures.some(
        (c) =>
          c.revision === check.revision && c.candidateSha256 === check.candidateSha256 && c.previewID === p.previewID,
      ),
  )
}
const browserRunners = new WeakSet<object>()
export function requireBrowserIsolationRunner(runner: DockerRunner) {
  if (!browserRunners.has(runner)) throw new TypeError("TASK24_BROWSER_OS_ISOLATION_REQUIRED")
}
export async function makeBrowserIsolationRunner(input: {
  session: EngineSession
  adapter: HostIsolationAdapter
  helper: FileIdentity
  browser: FileIdentity
  node: FileIdentity
  cwd: string
  env: Readonly<Record<string, string>>
  previewID: string
  previewURL: string
}): Promise<DockerRunner> {
  if (!adapters.has(input.adapter) || !input.adapter.browser)
    throw new TypeError("TASK24_BROWSER_OS_ISOLATION_REQUIRED")
  const state = await revalidateSession(input.session)
  const runner: DockerRunner = {
    async execute(invocation) {
      await revalidateSession(input.session)
      for (const file of [input.helper, input.browser, input.node])
        if (canonicalJson(await fileIdentity(file.path)) !== canonicalJson(file))
          throw new TypeError("TASK24_BROWSER_ISOLATION_ARTIFACT_STALE")
      if (canonicalJson(invocation.argv) !== canonicalJson([input.helper.path]))
        throw new TypeError("TASK24_BROWSER_ISOLATION_ARGUMENTS")
      const result = await input.adapter.browser!({
        ...input,
        invocation,
        executable: input.node.path,
        manifestSha256: input.session.manifestSha256,
        chromiumSandboxRequired: true,
        denyNonPreviewNetwork: true,
      })
      const value = Schema.decodeUnknownSync(
        Schema.Struct({
          manifestSha256: Schema.String,
          previewID: Schema.String,
          helperSha256: Schema.String,
          nodeSha256: Schema.String,
          browserSha256: Schema.String,
          ended: Schema.Literal(true),
          processTreeEnded: Schema.Literal(true),
          sandboxEnabled: Schema.Literal(true),
          nonPreviewNetworkBlocked: Schema.Literal(true),
          canaryHealthy: Schema.Literal(true),
          deniedCanaryAttempts: Schema.Int,
          canaryHits: Schema.Literal(0),
          evidence: Schema.Array(
            Schema.Struct({
              kind: Schema.String,
              relativePath: Schema.String,
              sha256: Schema.String,
              bytes: Schema.Int,
            }),
          ),
        }),
      )(result.observation, { onExcessProperty: "error" })
      if (
        value.manifestSha256 !== input.session.manifestSha256 ||
        value.previewID !== input.previewID ||
        value.helperSha256 !== input.helper.sha256 ||
        value.nodeSha256 !== input.node.sha256 ||
        value.browserSha256 !== input.browser.sha256 ||
        value.deniedCanaryAttempts < 1 ||
        !value.evidence.length ||
        result.execution.cleanupUncertain
      )
        throw new TypeError("TASK24_BROWSER_OS_ISOLATION_UNOBSERVED")
      const { evidence, ...body } = value
      for (const ref of evidence) {
        verifyEvidenceFile(state.manifest.roots.evidence, ref)
        if (
          canonicalJson(
            JSON.parse(await fs.readFile(path.join(state.manifest.roots.evidence, ref.relativePath), "utf8")),
          ) !==
          canonicalJson({
            ...body,
            stdoutSha256: sha256Text(Buffer.from(result.execution.stdout).toString("base64")),
            exitCode: result.execution.exitCode,
          })
        )
          throw new TypeError("TASK24_BROWSER_OS_ISOLATION_EVIDENCE")
      }
      return result.execution
    },
  }
  browserRunners.add(runner)
  return runner
}
const adapters = new WeakSet<object>(),
  issued = new WeakSet<object>()

/** Compose controller-owned browser transport without changing or widening launch authority. */
export function attachBrowserIsolationDispatch(input: {
  adapter: HostIsolationAdapter
  browser: NonNullable<HostIsolationAdapter["browser"]>
}): HostIsolationAdapter {
  if (!adapters.has(input.adapter) || typeof input.browser !== "function")
    throw new TypeError("TASK24_BROWSER_OS_ISOLATION_REQUIRED")
  const adapter = Object.freeze({
    verify: input.adapter.verify.bind(input.adapter),
    launch: input.adapter.launch.bind(input.adapter),
    browser: input.browser,
  })
  adapters.add(adapter)
  return adapter
}
export type CapabilityReceipt = Readonly<{
  schemaVersion: 2
  status: "passed"
  armID: ArmID
  manifestSha256: string
  binary: FileIdentity
  cases: readonly { kind: "visual" | "coding"; launchSha256: string; evidence: readonly EvidenceReference[] }[]
  receiptSha256: string
}>
export type HostIsolationContext = Readonly<{
  schemaVersion: 2
  session: EngineSession
  manifest: HostManifest
  artifact: FileIdentity
  guard(): Promise<void>
}>

/** Trusted-controller context only, never a capability/engine receipt or child environment. */
export async function createHostIsolationContext(input: {
  session: EngineSession
  file: FileIdentity
}): Promise<HostIsolationContext> {
  const file = freeze({ ...input.file })
  const session = input.session
  async function guard() {
    const state = await revalidateSession(session)
    const artifact = state.manifest.artifacts.find((a) => a.id === "host-isolation" && a.kind === "worker")
    if (
      !artifact ||
      !("sha256" in artifact) ||
      artifact.sha256 !== file.sha256 ||
      artifact.path !== file.path ||
      canonicalJson(await fileIdentity(file.path)) !== canonicalJson(file)
    )
      throw new TypeError("TASK24_ISOLATION_ARTIFACT")
  }
  await guard()
  return Object.freeze({ schemaVersion: 2, session, manifest: sessionState(session).manifest, artifact: file, guard })
}

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
  const context = await createHostIsolationContext(input)
  const moduleURL = pathToFileURL(context.artifact.path)
  moduleURL.searchParams.set("identity", sha256Text(canonicalJson(context.artifact)))
  const module: unknown = await import(moduleURL.href)
  if (
    !module ||
    typeof module !== "object" ||
    !("createIsolationAdapter" in module) ||
    typeof module.createIsolationAdapter !== "function"
  )
    throw new TypeError("TASK24_ISOLATION_ADAPTER")
  await context.guard()
  const adapter: HostIsolationAdapter = await module.createIsolationAdapter(context)
  await context.guard()
  if (
    !adapter ||
    typeof adapter !== "object" ||
    typeof adapter.verify !== "function" ||
    typeof adapter.launch !== "function"
  )
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
    open(c: NonNullable<Parameters<typeof verifyBinaryCapabilities>[0]["cases"]>[number]): Promise<{
      connection: PublicMcpConnection
      observation?(): PublicToolObservation
      setReadonly(): void | Promise<void>
      dispose(): Promise<void>
    }>
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
  await verifyBinaryBuildRecords({ manifest: state.manifest })
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
        if (!publicTools?.observation) return blocked("controller_tool_observations")
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
      const tools = publicTools?.observation
        ? { connection: publicTools.connection, observation: publicTools.observation.bind(publicTools) }
        : undefined
      const before = tools?.observation()
      const result = await input.isolation.launch({
        launch: actual,
        kind: c.kind,
        readonly: false,
        signal: input.signal ?? new AbortController().signal,
        ...(tools ? { tools } : {}),
      })
      const after = tools?.observation()
      await publicTools?.setReadonly()
      const readonlyBefore = tools?.observation()
      const readonly = await input.isolation.launch({
        launch: actual,
        kind: c.kind,
        readonly: true,
        signal: input.signal ?? new AbortController().signal,
        ...(tools ? { tools } : {}),
      })
      const readonlyAfter = tools?.observation()
      const toolEvidence = []
      if (input.armID !== "A") {
        if (!before || !after || !readonlyBefore || !readonlyAfter) return blocked("controller_tool_observations")
        if (
          !verifyPublicToolTransition({ before, after, workspace: actual.cwd, kind: c.kind, readonly: false }) ||
          !verifyPublicToolTransition({
            before: readonlyBefore,
            after: readonlyAfter,
            workspace: actual.cwd,
            kind: c.kind,
            readonly: true,
          })
        )
          return blocked("controller_tool_microcheck_failed")
        const body = {
          manifestSha256: input.session.manifestSha256,
          armID: input.armID,
          kind: c.kind,
          launchSha256: sha256Text(canonicalJson(actual.snapshot)),
          before,
          after,
          readonlyBefore,
          readonlyAfter,
        }
        const file = path.join(
          state.manifest.roots.evidence,
          "capability-tools-" + sha256Text(canonicalJson(body)) + ".json",
        )
        await publishImmutable(file, canonicalJson(body))
        toolEvidence.push(bindEvidenceFile(state.manifest.roots.evidence, file, "capability-tools"))
      }
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
        evidence: [...result.evidence, ...readonly.evidence, ...proof.value.evidence, ...toolEvidence],
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
