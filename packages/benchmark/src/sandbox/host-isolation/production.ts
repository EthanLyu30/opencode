import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Bytes, sha256Text } from "../../hash"
import { assertRunRoots } from "../../arms/environment"
import type { ArmLaunch } from "../../arms/types"
import { directRoot } from "../../corpus/direct-root"
import { bindEvidenceFile, verifyEvidenceFile, type EvidenceReference } from "../../evaluator/evidence"
import { publishImmutable } from "../../offline/atomic"
import type { FileIdentity } from "../contracts"
import type { HostIsolationAdapter, HostIsolationContext, PublicMcpConnection } from "../capability"
import { requirePublicToolObservation, type PublicToolObservation } from "../public-tools"
import { fileIdentity } from "../storage"
import { runWindowsSandbox, type WindowsSandboxResult } from "./windows"
import { WindowsWorkflowEnvironment } from "./windows-workflow-environment"
import type { WorkflowBenchmarkModels } from "../../../../schema/src/workflow-benchmark-models"
import { ordinaryFiles } from "../../corpus/evaluation-bundle"

type WorkflowAuthority = Readonly<{ campaignID: string; runID: string; bindingSha256: string; expiresAt: number }>

export type ProductionWorkflowHost = Readonly<{
  environment: Readonly<Record<string, string>>
  authority: WorkflowAuthority
  host: typeof WindowsWorkflowEnvironment.Host.Type
  port: number
  models: WorkflowBenchmarkModels.Packet
  /** External command/browser observations, not agent stdout or writable database rows. */
  observe(
    execution: Readonly<
      Pick<WindowsSandboxResult["execution"], "started" | "exitCode" | "stdout" | "stderr" | "truncated">
    >,
  ): Promise<
    Readonly<{
      workflowSucceeded: boolean
      checkExit: number
      preview: boolean
      capture: boolean
      readonlyDenied: boolean
      evidence: readonly EvidenceReference[]
    }>
  >
  close(): Promise<void>
}>

/** Same production CLI and host contract; no MCP replacement for arm A. */
export async function planWindowsWorkflowLaunch(input: {
  launch: ArmLaunch
  binary: FileIdentity
  root: string
  readonly: boolean
  authority: WorkflowAuthority
  host: typeof WindowsWorkflowEnvironment.Host.Type
  port: number
}) {
  const { launch, binary, host, authority } = input
  if (launch.snapshot.armID !== "A" || launch.snapshot.mode !== "workflow")
    throw new TypeError("TASK24_PRODUCTION_WORKFLOW_BRIDGE_REQUIRED")
  if (
    launch.executable !== binary.path ||
    launch.snapshot.executable !== binary.path ||
    launch.snapshot.executableSha256 !== binary.sha256 ||
    canonicalJson(await fileIdentity(binary.path)) !== canonicalJson(binary)
  )
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_BINARY")
  const roots = assertRunRoots(launch.snapshot.roots)
  if (launch.cwd !== roots.repo || overlap(input.root, roots.runRoot))
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_ROOTS")
  await directRoot(input.root)
  for (const directory of Object.values(roots)) await directRoot(directory)
  const state = [roots.data, roots.config, roots.cache, roots.temp, roots.output]
  const env = launch.environment
  const deployment = env.OPENCODE_WORKFLOW_HOST_ROOT
  if (!deployment || deployment === roots.data || !contains(roots.data, deployment))
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_ROOTS")
  const hostRoots = [
    ...new Set(
      WindowsWorkflowEnvironment.pathNames
        .filter((name) => name !== "OPENCODE_WORKFLOW_SANDBOX_ENGINE" && name !== "OPENCODE_BENCHMARK_HOST_FILE")
        .map((name) => env[name]!),
    ),
  ]
  if (hostRoots.some((directory) => !directory || !contains(deployment, directory)))
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_ROOTS")
  const writable = [...(input.readonly ? [] : [roots.repo]), ...state, ...hostRoots]
  const readonly = [path.dirname(host.engine.path), ...(input.readonly ? [roots.repo] : [])]
  if (readonly.some((directory) => state.some((root) => overlap(root, directory)) || overlap(input.root, directory)))
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_ROOTS")
  const environment: Record<string, string> = {}
  const hostKeys = new Set<string>([...WindowsWorkflowEnvironment.pathNames, "OPENCODE_WORKFLOW_SANDBOX_IMAGE"])
  const workflowPaths = new Set(["OPENCODE_BENCHMARK_TRANSPORT_FILE", "OPENCODE_BENCHMARK_RUN_DATA_ROOT"])
  const workflowValues = new Set([
    "OPENCODE_BENCHMARK_CAMPAIGN_ID",
    "OPENCODE_BENCHMARK_RUN_ID",
    "MOONSHOT_API_KEY",
    "DEEPSEEK_API_KEY",
  ])
  for (const [key, value] of Object.entries(env)) {
    if (ignoredKeys.has(key)) continue
    if (key === "OPENCODE_DISABLE_PROJECT_CONFIG" || key === "OPENCODE_DISABLE_DEFAULT_PLUGINS") {
      if (value !== "1") throw new TypeError("TASK24_PRODUCTION_ADAPTER_ENVIRONMENT")
      environment[key] = value
      continue
    }
    if (
      !pathKeys.has(key) &&
      !valueKeys.has(key) &&
      !workflowPaths.has(key) &&
      !workflowValues.has(key) &&
      !hostKeys.has(key)
    )
      throw new TypeError("TASK24_PRODUCTION_ADAPTER_ENVIRONMENT")
    if ((pathKeys.has(key) || workflowPaths.has(key)) && !state.some((root) => contains(root, value)))
      throw new TypeError("TASK24_PRODUCTION_ADAPTER_ENVIRONMENT")
    environment[key] = value
  }
  if (
    !environment.MOONSHOT_API_KEY ||
    environment.MOONSHOT_API_KEY !== environment.DEEPSEEK_API_KEY ||
    sha256Text(environment.MOONSHOT_API_KEY) !== launch.snapshot.brokerGrantSha256 ||
    environment.OPENCODE_BENCHMARK_RUN_DATA_ROOT !== roots.data ||
    Object.hasOwn(environment, "TASK24_BROKER_GRANT")
  )
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_ENVIRONMENT")
  const origin = new URL(launch.snapshot.brokerOrigin)
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.origin !== launch.snapshot.brokerOrigin ||
    Number(origin.port) < 1024
  )
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_BROKER")
  const ports = [...new Set([Number(origin.port), input.port])]
  await WindowsWorkflowEnvironment.verify({ environment, readonly, writable, ports, authority, host })
  environment.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  environment.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"
  return {
    executable: binary,
    argv: [...launch.args],
    cwd: roots.repo,
    root: input.root,
    readonly,
    writable,
    ports,
    environment,
    ancestorMetadata: true as const,
    benchmarkAcl: authority,
    benchmarkHost: host,
    timeoutMs: Math.min(600000, launch.snapshot.budget.maxDurationMs),
    maxStdoutBytes: 2097152,
    maxStderrBytes: 65536,
  }
}

const contains = (root: string, value: string) =>
  value.toLowerCase() === root.toLowerCase() || value.toLowerCase().startsWith(root.toLowerCase() + path.sep)
const overlap = (a: string, b: string) => contains(a, b) || contains(b, a)
const pathKeys = new Set([
  "OPENCODE_TEST_HOME",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
])
const valueKeys = new Set([
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_PRUNE",
  "OPENCODE_PERMISSION",
  "TASK24_BROKER_GRANT",
])
const ignoredKeys = new Set([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "TMP",
  "TEMP",
  "BUN_INSTALL_CACHE_DIR",
  "npm_config_cache",
])
type Tools = { connection: PublicMcpConnection; observation(): PublicToolObservation }

/** A plan is not an OS proof. Native launch re-pins every admitted file and directory. */
export async function planWindowsAgentLaunch(input: {
  launch: ArmLaunch
  binary: FileIdentity
  tools: Tools
  readonly: boolean
  root: string
}) {
  const { launch, binary, tools } = input
  if (launch.snapshot.mode !== "direct" || launch.snapshot.armID === "A")
    throw new TypeError("TASK24_PRODUCTION_WORKFLOW_BRIDGE_REQUIRED")
  if (
    launch.executable !== binary.path ||
    launch.snapshot.executable !== binary.path ||
    launch.snapshot.executableSha256 !== binary.sha256 ||
    canonicalJson(await fileIdentity(binary.path)) !== canonicalJson(binary)
  )
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_BINARY")
  const roots = assertRunRoots(launch.snapshot.roots)
  if (launch.cwd !== roots.repo || overlap(input.root, roots.runRoot))
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_ROOTS")
  await directRoot(input.root)
  for (const root of Object.values(roots)) await directRoot(root)
  const observation = tools.observation()
  requirePublicToolObservation(observation, roots.repo)
  if (observation.readonly !== input.readonly) throw new TypeError("TASK24_PRODUCTION_ADAPTER_READONLY")
  const connection = tools.connection
  if (
    connection.host !== "127.0.0.1" ||
    !Number.isSafeInteger(connection.port) ||
    connection.port < 1024 ||
    !/^[a-f0-9]{64}$/.test(connection.capability) ||
    !connection.entry.path.endsWith(".exe") ||
    canonicalJson(await fileIdentity(connection.entry.path)) !== canonicalJson(connection.entry)
  )
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_MCP")
  const runtime = path.dirname(connection.entry.path)
  if (overlap(runtime, roots.runRoot) || overlap(runtime, input.root))
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_ROOTS")
  const origin = new URL(launch.snapshot.brokerOrigin)
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.origin !== launch.snapshot.brokerOrigin ||
    Number(origin.port) < 1024
  )
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_BROKER")
  const writable = [roots.data, roots.config, roots.cache, roots.temp, roots.output]
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(launch.environment)) {
    if (ignoredKeys.has(key)) continue
    if (!pathKeys.has(key) && !valueKeys.has(key)) throw new TypeError("TASK24_PRODUCTION_ADAPTER_ENVIRONMENT")
    if (pathKeys.has(key) && !writable.some((root) => contains(root, value)))
      throw new TypeError("TASK24_PRODUCTION_ADAPTER_ENVIRONMENT")
    if (key === "TASK24_BROKER_GRANT" && sha256Text(value) !== launch.snapshot.brokerGrantSha256)
      throw new TypeError("TASK24_PRODUCTION_ADAPTER_ENVIRONMENT")
    environment[key] = value
  }
  if (!environment.TASK24_BROKER_GRANT) throw new TypeError("TASK24_PRODUCTION_ADAPTER_ENVIRONMENT")
  environment.TASK24_PUBLIC_TOOL_CAPABILITY = connection.capability
  environment.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  environment.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"
  return {
    executable: binary,
    argv: [...launch.args],
    cwd: roots.repo,
    root: input.root,
    readonly: [runtime],
    mediated: [roots.repo],
    writable,
    ports: [...new Set([Number(origin.port), connection.port])],
    environment,
    ancestorMetadata: true as const,
    timeoutMs: Math.min(600000, launch.snapshot.budget.maxDurationMs),
    maxStdoutBytes: 2097152,
    maxStderrBytes: 65536,
  }
}

function requireEnded(result: WindowsSandboxResult) {
  const c = result.containment
  if (
    !result.execution.started ||
    result.execution.truncated ||
    !c.appContainer ||
    !c.dynamicNetworkPolicy ||
    !c.processTreeEnded ||
    !c.cleanupCompleted ||
    !c.persistentNetworkPolicy ||
    !c.persistentPolicyRetired
  )
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_CONTAINMENT")
}

async function ownedScope(parent: string, manifestSha256: string) {
  await directRoot(parent)
  const root = await fs.mkdtemp(path.join(parent, "production-agent-"))
  try {
    const stat = await fs.lstat(root, { bigint: true })
    const id = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
    const owner = canonicalJson({
      purpose: "task24-production-agent",
      nonce: randomBytes(16).toString("hex"),
      manifestSha256,
    })
    await fs.writeFile(path.join(root, "owner.json"), owner, { flag: "wx" })
    for (const dir of ["control", "files", "work"]) await fs.mkdir(path.join(root, dir))
    await fs.writeFile(path.join(root, "work", "bunfig.toml"), "# Frozen empty admission configuration\n", {
      flag: "wx",
    })
    await fs.writeFile(
      path.join(root, "private-canary.txt"),
      "OWN_CONTROLLER_CANARY_" + randomBytes(16).toString("hex"),
      { flag: "wx" },
    )
    return {
      root,
      async dispose() {
        await directRoot(root)
        const now = await fs.lstat(root, { bigint: true })
        if (
          `${now.dev}:${now.ino}:${now.birthtimeNs}` !== id ||
          path.dirname(root) !== parent ||
          (await fs.readFile(path.join(root, "owner.json"), "utf8")) !== owner
        )
          throw new TypeError("TASK24_PRODUCTION_ADAPTER_CLEANUP")
        let entries = 0
        async function inspect(directory: string): Promise<void> {
          for await (const entry of await fs.opendir(directory)) {
            if (++entries > 25000) throw new TypeError("TASK24_PRODUCTION_ADAPTER_CLEANUP")
            const file = path.join(directory, entry.name),
              s = await fs.lstat(file)
            if (
              s.isSymbolicLink() ||
              (!s.isDirectory() && (!s.isFile() || s.nlink !== 1)) ||
              entry.name === "network-policy.intent.json"
            )
              throw new TypeError("TASK24_PRODUCTION_ADAPTER_CLEANUP")
            if (s.isDirectory()) await inspect(file)
          }
        }
        await inspect(root)
        await fs.rm(root, { recursive: true })
      },
    }
  } catch (cause) {
    // Initialization may fail before an ownership marker can be persisted.
    // Retain the exact allocation and block, never guess that it is disposable.
    throw Object.assign(new Error("TASK24_PRODUCTION_ADAPTER_INITIALIZATION_UNCERTAIN", { cause }), {
      cleanupUncertain: true,
      root,
    })
  }
}

/** Frozen factory entry. No system installation, ambient spawn or real provider transport. */
export async function createIsolationAdapter(context: HostIsolationContext): Promise<HostIsolationAdapter> {
  await context.guard()
  if (
    context.schemaVersion !== 2 ||
    context.manifest.phase !== "accept" ||
    process.platform !== "win32" ||
    process.arch !== "x64"
  )
    throw new TypeError("TASK24_PRODUCTION_ADAPTER_PLATFORM")
  const manifestSha256 = context.session.manifestSha256
  const artifact = (id: string) => {
    const a = context.manifest.artifacts.find((a) => a.id === id && a.kind !== "pending")
    if (!a || !("path" in a) || !a.path || !("sha256" in a)) throw new TypeError("TASK24_PRODUCTION_ADAPTER_ARTIFACT")
    return a
  }
  let blocked = false
  async function guard() {
    if (blocked) throw new TypeError("TASK24_PRODUCTION_ADAPTER_CLEANUP_BLOCKED")
    await context.guard()
  }
  async function publish(kind: string, body: unknown) {
    await guard()
    const value = { schemaVersion: 2, manifestSha256, kind, body },
      file = path.join(context.manifest.roots.evidence, `production-agent-${sha256Text(canonicalJson(value))}.json`)
    await publishImmutable(file, canonicalJson(value))
    return bindEvidenceFile(context.manifest.roots.evidence, file, "production-agent-" + kind)
  }
  async function admission(
    scope: Awaited<ReturnType<typeof ownedScope>>,
    base: {
      cwd: string
      readonly: readonly string[]
      mediated?: readonly string[]
      writable: readonly string[]
      ports: readonly number[]
    },
    signal: AbortSignal,
  ) {
    const bun = artifact("controller-bun"),
      executable = await fileIdentity(bun.path!)
    if (executable.sha256 !== bun.sha256) throw new TypeError("TASK24_PRODUCTION_ADAPTER_ARTIFACT")
    let hits = 0
    const nonce = randomBytes(16).toString("hex")
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(r) {
        if (new URL(r.url).pathname !== "/" + nonce) return new Response(null, { status: 404 })
        hits++
        return new Response(nonce)
      },
    })
    try {
      const url = `http://127.0.0.1:${server.port}/${nonce}`
      if (
        (await (await fetch(url, { proxy: "", signal })).text()) !== nonce ||
        hits !== 1 ||
        base.ports.includes(server.port!)
      )
        throw new TypeError("TASK24_PRODUCTION_ADAPTER_CANARY")
      hits = 0
      const source = `const fs=require('node:fs');let denied=false;try{fs.readFileSync(${JSON.stringify(path.join(scope.root, "private-canary.txt"))})}catch(e){denied=e.code==='EACCES'||e.code==='EPERM'};let networkDenied=false;try{await fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(2000),proxy:''})}catch{networkDenied=true}console.log(JSON.stringify({denied,networkDenied}))`
      const result = await runWindowsSandbox({
        ...base,
        executable,
        argv: [
          "--no-env-file",
          "--no-install",
          "--config=" + path.join(scope.root, "work", "bunfig.toml"),
          "-e",
          source,
        ],
        cwd: path.join(scope.root, "work"),
        writable: [...new Set([...base.writable, path.join(scope.root, "work")])],
        root: path.join(scope.root, "control"),
        timeoutMs: 15000,
        maxStdoutBytes: 8192,
        maxStderrBytes: 65536,
        signal,
      })
      requireEnded(result)
      const observed = JSON.parse(Buffer.from(result.execution.stdout).toString("utf8") || "{}")
      if (
        result.execution.exitCode !== 0 ||
        hits !== 0 ||
        canonicalJson(observed) !== canonicalJson({ denied: true, networkDenied: true })
      )
        throw new TypeError(
          "TASK24_PRODUCTION_ADAPTER_CANARY:" +
            canonicalJson({
              exitCode: result.execution.exitCode,
              hits,
              denied: observed.denied === true,
              networkDenied: observed.networkDenied === true,
              stdoutSha256: sha256Bytes(result.execution.stdout),
              stderrSha256: sha256Bytes(result.execution.stderr),
            }),
        )
      return {
        deniedCanaryReads: 1,
        canaryReads: 0,
        externalNetworkHits: hits,
        evidence: await publish("admission", {
          containment: result.containment,
          executable,
          policy: {
            cwd: base.cwd,
            readonly: base.readonly,
            mediated: base.mediated ?? [],
            writable: base.writable,
            ports: base.ports,
          },
          stdoutSha256: sha256Bytes(result.execution.stdout),
          stderrSha256: sha256Bytes(result.execution.stderr),
          deniedCanaryReads: 1,
          canaryReads: 0,
          canaryHealthy: true,
          canaryHits: hits,
        }),
      }
    } finally {
      await server.stop(true)
    }
  }
  let queue = Promise.resolve()
  function scoped<T>(operation: (scope: Awaited<ReturnType<typeof ownedScope>>) => Promise<T>): Promise<T> {
    const work = queue.then(() => runScoped(operation))
    queue = work.then(
      () => {},
      () => {},
    )
    return work
  }
  async function runScoped<T>(operation: (scope: Awaited<ReturnType<typeof ownedScope>>) => Promise<T>) {
    await guard()
    let scope: Awaited<ReturnType<typeof ownedScope>> | undefined
    try {
      scope = await ownedScope(context.manifest.roots.temp, manifestSha256)
      return await operation(scope)
    } catch (cause) {
      if (cause && typeof cause === "object" && "cleanupUncertain" in cause && cause.cleanupUncertain === true)
        blocked = true
      throw cause
    } finally {
      if (scope && !blocked) {
        try {
          await scope.dispose()
        } catch (cause) {
          blocked = true
          throw Object.assign(new Error("TASK24_PRODUCTION_ADAPTER_CLEANUP_UNCERTAIN", { cause }), {
            cleanupUncertain: true,
            root: scope.root,
          })
        }
      }
    }
  }
  return Object.freeze({
    async verify() {
      const evidence = await scoped(async (scope) => {
        const proof = await admission(
          scope,
          { cwd: path.join(scope.root, "work"), readonly: [], writable: [path.join(scope.root, "work")], ports: [] },
          new AbortController().signal,
        )
        return proof.evidence
      })
      return { kind: "ready" as const, value: { evidence: [evidence] } }
    },
    async launch(input) {
      return scoped(async (scope) => {
        await guard()
        input.signal.throwIfAborted()
        if (input.launch.snapshot.armID === "A") {
          if (!context.workflow) throw new TypeError("TASK24_PRODUCTION_WORKFLOW_BRIDGE_REQUIRED")
          const entry = artifact("modified")
          const binary = await fileIdentity(entry.path!)
          if (
            binary.sha256 !== entry.sha256 ||
            input.launch.executable !== binary.path ||
            input.launch.snapshot.executableSha256 !== binary.sha256
          )
            throw new TypeError("TASK24_PRODUCTION_ADAPTER_BINARY")
          const host = await context.workflow(input)
          try {
            const modelArtifact = artifact("benchmark-models")
            if (
              (await fileIdentity(modelArtifact.path!)).sha256 !== modelArtifact.sha256 ||
              sha256Text(canonicalJson(host.models)) !== modelArtifact.sha256
            )
              throw new TypeError("TASK24_PRODUCTION_ADAPTER_MODELS")
            const engineArtifact = artifact("production-engine")
            if (
              engineArtifact.path !== host.host.engine.path ||
              engineArtifact.sha256 !== host.host.engine.sha256 ||
              canonicalJson(await fileIdentity(host.host.engine.path)) !== canonicalJson(host.host.engine)
            )
              throw new TypeError("TASK24_PRODUCTION_ADAPTER_ENGINE")
            const plan = await planWindowsWorkflowLaunch({
              launch: { ...input.launch, environment: host.environment },
              binary,
              root: path.join(scope.root, "control"),
              readonly: input.readonly,
              authority: host.authority,
              host: host.host,
              port: host.port,
            })
            const before = await ordinaryFiles(input.launch.cwd)
            const proof = await admission(scope, plan, input.signal)
            await guard()
            const result = await runWindowsSandbox({ ...plan, benchmarkModels: host.models, signal: input.signal })
            requireEnded(result)
            const after = await ordinaryFiles(input.launch.cwd)
            const observation = await host.observe(result.execution)
            if (!observation.evidence.length) throw new TypeError("TASK24_PRODUCTION_ADAPTER_OBSERVATIONS")
            for (const ref of observation.evidence) verifyEvidenceFile(context.manifest.roots.evidence, ref)
            const evidence = await publish("workflow-launch", {
              binary,
              launchSha256: sha256Text(canonicalJson(input.launch.snapshot)),
              readonly: input.readonly,
              exitCode: result.execution.exitCode,
              containment: result.containment,
              stdoutSha256: sha256Bytes(result.execution.stdout),
              stderrSha256: sha256Bytes(result.execution.stderr),
              before,
              after,
              observation,
            })
            return {
              ended: input.readonly
                ? observation.readonlyDenied
                : result.execution.exitCode === 0 && observation.workflowSucceeded,
              changed: canonicalJson(before) !== canonicalJson(after),
              checkExit: observation.checkExit,
              preview: observation.preview,
              capture: observation.capture,
              readonlyDenied: observation.readonlyDenied,
              deniedCanaryReads: proof.deniedCanaryReads,
              canaryReads: proof.canaryReads,
              externalNetworkHits: proof.externalNetworkHits,
              evidence: [proof.evidence, evidence, ...observation.evidence],
            }
          } finally {
            try {
              await host.close()
            } catch (cause) {
              throw Object.assign(new Error("TASK24_PRODUCTION_WORKFLOW_CLEANUP_UNCERTAIN", { cause }), {
                cleanupUncertain: true,
                root: scope.root,
              })
            }
          }
        }
        if (!input.tools) throw new TypeError("TASK24_PRODUCTION_ADAPTER_MCP")
        const entry = artifact(["D", "E"].includes(input.launch.snapshot.armID) ? "upstream" : "modified")
        const binary = await fileIdentity(entry.path!)
        if (binary.sha256 !== entry.sha256) throw new TypeError("TASK24_PRODUCTION_ADAPTER_BINARY")
        const mcp = artifact("public-mcp")
        if (input.tools.connection.entry.path !== mcp.path || input.tools.connection.entry.sha256 !== mcp.sha256)
          throw new TypeError("TASK24_PRODUCTION_ADAPTER_MCP")
        const plan = await planWindowsAgentLaunch({
          ...input,
          binary,
          tools: input.tools,
          root: path.join(scope.root, "control"),
        })
        const before = input.tools.observation()
        const proof = await admission(scope, plan, input.signal)
        await guard()
        const result = await runWindowsSandbox({ ...plan, signal: input.signal })
        requireEnded(result)
        const after = input.tools.observation()
        requirePublicToolObservation(after, input.launch.cwd)
        const checks = after.checks.slice(before.checks.length),
          check = checks.at(-1),
          previews = after.previews.slice(before.previews.length),
          captures = after.captures.slice(before.captures.length)
        const evidence = await publish("launch", {
          binary,
          launchSha256: sha256Text(canonicalJson(input.launch.snapshot)),
          readonly: input.readonly,
          exitCode: result.execution.exitCode,
          containment: result.containment,
          stdoutSha256: sha256Bytes(result.execution.stdout),
          stderrSha256: sha256Bytes(result.execution.stderr),
          before,
          after,
        })
        return {
          ended: result.execution.exitCode === 0,
          deniedCanaryReads: proof.deniedCanaryReads,
          canaryReads: proof.canaryReads,
          externalNetworkHits: proof.externalNetworkHits,
          changed: after.writes.length > before.writes.length,
          checkExit:
            check?.status === "ok" && check.commands.length > 0 && check.commands.every((c) => c.exitCode === 0)
              ? 0
              : 1,
          preview: previews.length > 0,
          capture: captures.length > 0,
          readonlyDenied: input.readonly && after.deniedWrites > before.deniedWrites,
          evidence: [proof.evidence, evidence],
        }
      })
    },
  })
}
