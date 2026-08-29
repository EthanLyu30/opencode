export * as DockerProcessOwnership from "./docker-process-ownership"

import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Docker } from "./docker"
import { DockerConfig } from "./docker-config"
import { ProcessOwnership } from "./process-ownership"

const labelDomain = "io.opencode.workflow.preview"
const opaquePattern = /^[a-f0-9]{64}$/
const relayPort = 18_080
const supervisor = "/usr/local/bin/opencode-preview-supervisor"

interface IdentitySnapshot {
  readonly canonical: string
  readonly device: number
  readonly inode: number
  readonly links?: number
}

interface TreeSnapshot {
  readonly workspace: readonly IdentitySnapshot[]
  readonly capabilityTemp: readonly IdentitySnapshot[]
  readonly hostRoot: IdentitySnapshot
}

interface Ownership {
  readonly containerName: string
  readonly networkName: string
  readonly labels: Readonly<Record<string, string>>
}

interface OwnedState {
  readonly ownership: Ownership
  readonly containerID: string
  readonly networkID: string
  readonly completion: Promise<{ readonly exit: number; readonly stdout: Uint8Array; readonly stderr: Uint8Array }>
  stopped: boolean
}

export interface Options {
  readonly engine: Docker.Engine
  readonly config: DockerConfig.Config
  readonly hostRoot: string
  readonly now?: () => number
  readonly beforePreflight?: (signal: AbortSignal) => Promise<void>
}

export function make(options: Options): ProcessOwnership.Service {
  const owned = new WeakMap<ProcessOwnership.OwnedProcess, OwnedState>()
  const now = options.now ?? Date.now

  const internal = Object.freeze({
    available: true,
    start: async (input: Parameters<ProcessOwnership.Service["start"]>[0]) => {
      rejectCancelledOrExpired(input.signal, input.deadline, now)
      await options.beforePreflight?.(input.signal)
      const config = await DockerConfig.validate(options.config)
      const admitted = await validateStart(options.hostRoot, config, input)
      const ownership = ownershipFor(input.identity, config)
      let networkID: string | undefined
      let containerID: string | undefined
      let networkVerified = false
      let containerVerified = false
      let containerRunning = false
      let detachedResourceCleanup = false
      try {
        const network = await beforeDeadline(
          options.engine,
          config,
          input,
          now,
          [
            "network",
            "create",
            "--driver",
            "bridge",
            "--internal",
            ...labelsArgv(ownership.labels),
            ownership.networkName,
          ],
          config.limits.maxOutputBytes,
          {
            timeoutMs: detachedCleanupTimeout(config),
            detached: () => {
              detachedResourceCleanup = true
            },
            settle: (late, deadline) => cleanupLateNetwork(options.engine, config, ownership, late, deadline),
          },
        )
        if (network.exit !== 0 || network.truncated || !opaquePattern.test(network.stdout.trim())) {
          throw new Docker.Unavailable("Preview Docker network could not be created")
        }
        networkID = network.stdout.trim()
        networkVerified = await inspectNetwork(
          options.engine,
          config,
          networkID,
          ownership,
          false,
          startBoundary(input, now),
        )
        if (!networkVerified) throw new Docker.Unavailable("Preview Docker network ownership verification failed")

        rejectCancelledOrExpired(input.signal, input.deadline, now)
        await revalidate(options.hostRoot, config, input, admitted)
        const runtime = normalizeRuntime(input.plan.argv ?? [])
        const authenticatedNetworkID = networkID
        const create = await beforeDeadline(
          options.engine,
          config,
          input,
          now,
          [
            "container",
            "create",
            "--name",
            ownership.containerName,
            ...labelsArgv(ownership.labels),
            "--pull",
            "never",
            "--network",
            ownership.networkName,
            "--publish",
            `127.0.0.1:${admitted.port}:${relayPort}/tcp`,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges=true",
            "--user",
            "65532:65532",
            "--pids-limit",
            String(config.limits.pids),
            "--memory",
            String(config.limits.memoryBytes),
            "--cpus",
            String(config.limits.cpus),
            "--stop-timeout",
            "3",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777",
            "--tmpfs",
            "/home/sandbox:rw,nosuid,nodev,noexec,size=16777216,mode=700,uid=65532,gid=65532",
            ...environmentArgv(input.plan.env, admitted.port),
            ...(input.archive === undefined
              ? ["--mount", `type=bind,src=${admitted.workspace},dst=/workspace,readonly`]
              : []),
            "--mount",
            `type=bind,src=${admitted.capabilityTemp},dst=/opencode/tmp`,
            "--workdir",
            admitted.relativeCwd === "." ? "/workspace" : `/workspace/${admitted.relativeCwd}`,
            config.image,
            supervisor,
            "--listen",
            `0.0.0.0:${relayPort}`,
            "--target",
            `127.0.0.1:${admitted.port}`,
            "--",
            ...runtime,
          ],
          config.limits.maxOutputBytes,
          {
            timeoutMs: detachedCleanupTimeout(config),
            detached: () => {
              detachedResourceCleanup = true
            },
            settle: (late, deadline) =>
              cleanupLateContainer(options.engine, config, ownership, authenticatedNetworkID, late, deadline),
          },
        )
        if (create.exit !== 0 || create.truncated || !opaquePattern.test(create.stdout.trim())) {
          throw new Docker.Unavailable("Preview Docker container or pinned image is unavailable")
        }
        containerID = create.stdout.trim()
        const createdState = await inspectContainerState(
          options.engine,
          config,
          containerID,
          ownership,
          false,
          startBoundary(input, now),
        )
        containerVerified = createdState !== undefined
        containerRunning = createdState ?? false
        if (!containerVerified) throw new Docker.Unavailable("Preview Docker container ownership verification failed")

        if (input.archive !== undefined) {
          const imported = await execute(options.engine, config, {
            argv: ["container", "cp", "-", `${containerID}:/`],
            stdin: WorkflowWorkspaceMaterialization.tarBytes(input.archive),
            timeoutMs: Math.min(config.limits.engineTimeoutMs, input.deadline - now()),
            maxOutputBytes: config.limits.maxOutputBytes,
            signal: input.signal,
          })
          if (imported.exit !== 0 || imported.truncated)
            throw new Docker.Unavailable("Host-sealed Snapshot import into preview container failed")
        }

        rejectCancelledOrExpired(input.signal, input.deadline, now)
        await revalidate(options.hostRoot, config, input, admitted)
        const started = await beforeDeadline(
          options.engine,
          config,
          input,
          now,
          ["container", "start", containerID],
          config.limits.maxOutputBytes,
        )
        if (started.exit !== 0 || started.truncated)
          throw new Docker.Unavailable("Preview Docker container did not start")
        const startedState = await inspectContainerState(
          options.engine,
          config,
          containerID,
          ownership,
          true,
          startBoundary(input, now),
        )
        if (startedState !== true) {
          throw new Docker.Unavailable("Preview Docker container identity changed after start")
        }
        containerRunning = true
        rejectCancelledOrExpired(input.signal, input.deadline, now)

        const completion = settle(options.engine, config, containerID, ownership, input.signal)
        const exited = completion.then((value) => value.exit)
        // Consumers may attach after start() returns; mark the rejection observed
        // immediately while preserving the original promise's rejection semantics.
        void exited.catch(() => undefined)
        const process: ProcessOwnership.OwnedProcess = Object.freeze({
          exited,
          stdout: promisedStream(completion.then((value) => value.stdout)),
          stderr: promisedStream(completion.then((value) => value.stderr)),
        })
        owned.set(process, {
          ownership,
          containerID,
          networkID,
          completion,
          stopped: false,
        })
        return process
      } catch (cause) {
        const cleanup = detachedResourceCleanup
          ? Promise.resolve(undefined)
          : cleanupAfterStartFailure(options.engine, config, ownership, {
              networkID,
              networkVerified,
              containerID,
              containerVerified,
              containerRunning,
            })
        const cleanupResult = await observeCleanupBeforeDeadline(cleanup, input, now)
        if (cleanupResult !== detachedCleanup && cleanupResult !== undefined) {
          throw new Error(`Preview start cleanup failed: ${cleanupResult.message}`, { cause })
        }
        throw cause
      }
    },
    stop: async (input: Parameters<ProcessOwnership.Service["stop"]>[0]) => {
      const state = owned.get(input.process)
      if (state === undefined || state.stopped) return
      const config = await DockerConfig.validate(options.config)
      const running = await inspectContainerState(options.engine, config, state.containerID, state.ownership, true)
      if (
        running === undefined ||
        !(await inspectNetwork(options.engine, config, state.networkID, state.ownership, true))
      ) {
        throw new Docker.Unavailable("Preview Docker ownership changed before stop")
      }
      state.stopped = true
      const failure = await cleanupOwned(
        options.engine,
        config,
        state.ownership,
        state.containerID,
        state.networkID,
        running,
      )
      if (failure !== undefined) throw failure
    },
    recover: async (identity: ProcessOwnership.Identity) => {
      const config = await DockerConfig.validate(options.config)
      const ownership = ownershipFor(identity, config)
      const containerIDs = await listExact(options.engine, config, "container", ownership.labels)
      const networkIDs = await listExact(options.engine, config, "network", ownership.labels)
      if (containerIDs.length === 0 && networkIDs.length === 0) return
      if (containerIDs.length !== 1 || networkIDs.length !== 1) {
        throw new Docker.Unavailable("Preview Docker recovery identity was ambiguous")
      }
      const containerID = containerIDs[0]
      const networkID = networkIDs[0]
      const running = await inspectContainerState(options.engine, config, containerID, ownership, true)
      if (running === undefined || !(await inspectNetwork(options.engine, config, networkID, ownership, true))) {
        throw new Docker.Unavailable("Preview Docker recovery ownership did not match")
      }
      const failure = await cleanupOwned(options.engine, config, ownership, containerID, networkID, running)
      if (failure !== undefined) throw failure
    },
  })
  return Object.freeze({
    ...internal,
    start: (input: Parameters<ProcessOwnership.Service["start"]>[0]) =>
      startAtCallerBoundary({
        input,
        now,
        run: (signal) => internal.start({ ...input, signal }),
        cleanup: (process) => internal.stop({ identity: input.identity, process }),
        detachedTimeoutMs: detachedCleanupTimeout(options.config),
      }),
  })
}

async function startAtCallerBoundary(input: {
  readonly input: Parameters<ProcessOwnership.Service["start"]>[0]
  readonly now: () => number
  readonly run: (signal: AbortSignal) => Promise<ProcessOwnership.OwnedProcess>
  readonly cleanup: (process: ProcessOwnership.OwnedProcess) => Promise<void>
  readonly detachedTimeoutMs: number
}): Promise<ProcessOwnership.OwnedProcess> {
  rejectCancelledOrExpired(input.input.signal, input.input.deadline, input.now)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let detached = false
  let removeAbort: () => void = () => {}
  const boundary = new Promise<never>((_resolve, reject) => {
    const detach = (cause: Docker.Cancelled | Docker.Timeout) => {
      if (detached) return
      detached = true
      controller.abort(cause)
      reject(cause)
    }
    const onAbort = () => detach(new Docker.Cancelled("Preview Docker start was cancelled"))
    input.input.signal.addEventListener("abort", onAbort, { once: true })
    removeAbort = () => input.input.signal.removeEventListener("abort", onAbort)
    if (input.input.signal.aborted) {
      onAbort()
      return
    }
    timer = setTimeout(
      () => detach(new Docker.Timeout("Preview Docker start deadline elapsed")),
      input.input.deadline - input.now(),
    )
  })
  const operation = input.run(controller.signal)
  try {
    return await Promise.race([operation, boundary])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeAbort()
    if (detached) {
      void cleanupDetachedStartedProcess(operation, input.cleanup, input.detachedTimeoutMs).catch(() => undefined)
    }
  }
}

async function cleanupDetachedStartedProcess(
  operation: Promise<ProcessOwnership.OwnedProcess>,
  cleanup: (process: ProcessOwnership.OwnedProcess) => Promise<void>,
  timeoutMs: number,
) {
  const observed = await boundedOutcome(operation, timeoutMs)
  if (observed === boundedTimeout || !observed.ok) return
  await boundedOutcome(cleanup(observed.value), timeoutMs)
}

const boundedTimeout = Symbol("bounded-timeout")

async function boundedOutcome<A>(
  operation: Promise<A>,
  timeoutMs: number,
): Promise<{ readonly ok: true; readonly value: A } | { readonly ok: false } | typeof boundedTimeout> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof boundedTimeout>((resolve) => {
    timer = setTimeout(() => resolve(boundedTimeout), timeoutMs)
  })
  const result = await Promise.race([
    operation.then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    ),
    timeout,
  ])
  if (timer !== undefined) clearTimeout(timer)
  return result
}

function detachedCleanupTimeout(config: DockerConfig.Config) {
  const total = config.limits.engineTimeoutMs + config.limits.cleanupTimeoutMs * 4
  return Number.isSafeInteger(total) && total > 0 ? Math.min(total, 60_000) : 60_000
}

async function validateStart(
  configuredHostRoot: string,
  config: DockerConfig.ValidatedConfig,
  input: Parameters<ProcessOwnership.Service["start"]>[0],
) {
  if (!opaquePattern.test(input.identity.hostID) || !opaquePattern.test(input.identity.nonce)) {
    throw new TypeError("Preview process identity is not opaque")
  }
  if (input.plan.kind !== "script" || !PreviewPlan.isFrozen(input.plan) || input.plan.argv === undefined) {
    throw new TypeError("Preview Docker ownership requires a frozen script plan")
  }
  PreviewPlan.verifyConfiguration(input.plan)
  if (
    input.plan.allowedOrigins.length !== 1 ||
    PreviewPlan.normalizeLocalOrigin(input.plan.allowedOrigins[0]) !== input.plan.allowedOrigins[0]
  ) {
    throw new TypeError("Preview Docker ownership requires one canonical origin")
  }
  const port = Number(new URL(input.plan.allowedOrigins[0]).port)
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535 || port === relayPort) {
    throw new TypeError("Preview port conflicts with the fixed relay")
  }
  const hostRoot = await canonicalDDirectory(configuredHostRoot)
  const archive =
    input.archive === undefined ? undefined : WorkflowWorkspaceMaterialization.validateArchive(input.archive)
  const archivedRelativeCwd = archive === undefined ? undefined : sealedRelativeWorkdir(input.plan, archive)
  const workspace =
    archive === undefined
      ? await DockerConfig.admitWorkspace(config, input.workspaceRoot ?? input.plan.locationRoot)
      : ""
  const cwd = archive === undefined ? await canonicalDDirectory(input.plan.cwd) : ""
  const capabilityTemp = await canonicalDDirectory(input.tempRoot)
  const expectedTemp = path.join(hostRoot, input.identity.hostID, ".tmp")
  if (
    path.resolve(expectedTemp) !== capabilityTemp ||
    (archive === undefined && !contains(workspace, cwd)) ||
    (archive === undefined && overlap(hostRoot, workspace)) ||
    (archive === undefined && overlap(config.dockerConfig, workspace)) ||
    (archive === undefined && overlap(config.temp, workspace)) ||
    overlap(config.dockerConfig, hostRoot) ||
    overlap(config.temp, hostRoot)
  ) {
    throw new TypeError("Preview Docker roots are not isolated")
  }
  const snapshot = await snapshotTree(hostRoot, workspace, capabilityTemp)
  return {
    port,
    workspace,
    capabilityTemp,
    relativeCwd:
      archive === undefined
        ? cwd === workspace
          ? "."
          : path.relative(workspace, cwd).replaceAll("\\", "/")
        : archivedRelativeCwd!,
    snapshot,
  }
}

function sealedRelativeWorkdir(
  plan: PreviewPlan.PreviewPlan,
  archive: WorkflowWorkspaceMaterialization.Archive,
): string {
  if (!path.isAbsolute(plan.locationRoot) || !path.isAbsolute(plan.cwd))
    throw new TypeError("Sealed preview roots must be absolute")
  if (path.parse(plan.locationRoot).root.toLowerCase() !== path.parse(plan.cwd).root.toLowerCase())
    throw new TypeError("Sealed preview workdir must share the Location volume")
  const relative = path.relative(plan.locationRoot, plan.cwd)
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new TypeError("Sealed preview workdir escapes the Location")
  const canonical = relative === "" ? "." : relative.replaceAll("\\", "/")
  if (canonical !== "." && !archive.entries.some((entry) => entry.path.startsWith(`${canonical}/`)))
    throw new TypeError("Sealed preview workdir is absent from the exact Snapshot")
  return canonical
}

async function revalidate(
  configuredHostRoot: string,
  config: DockerConfig.ValidatedConfig,
  input: Parameters<ProcessOwnership.Service["start"]>[0],
  admitted: Awaited<ReturnType<typeof validateStart>>,
) {
  const currentConfig = await DockerConfig.revalidate(config)
  if (currentConfig.dockerConfig !== config.dockerConfig || currentConfig.temp !== config.temp) {
    throw new TypeError("Preview Docker configuration identity changed")
  }
  PreviewPlan.verifyConfiguration(input.plan)
  const current = await validateStart(configuredHostRoot, currentConfig, input)
  if (
    current.port !== admitted.port ||
    current.workspace !== admitted.workspace ||
    current.capabilityTemp !== admitted.capabilityTemp ||
    current.relativeCwd !== admitted.relativeCwd ||
    !sameTree(current.snapshot, admitted.snapshot)
  ) {
    throw new TypeError("Preview Docker path identity changed before start")
  }
}

async function snapshotTree(hostRoot: string, workspace: string, capabilityTemp: string): Promise<TreeSnapshot> {
  return {
    hostRoot: await identity(hostRoot),
    workspace: workspace === "" ? [] : await walk(workspace),
    capabilityTemp: await walk(capabilityTemp),
  }
}

async function walk(root: string): Promise<readonly IdentitySnapshot[]> {
  const result: IdentitySnapshot[] = []
  const visit = async (target: string): Promise<void> => {
    const item = await identity(target)
    result.push(item)
    const stat = await fs.lstat(target)
    if (!stat.isDirectory()) return
    const entries = (await fs.readdir(target, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )
    for (const entry of entries) await visit(path.join(target, entry.name))
  }
  await visit(root)
  return result
}

async function identity(target: string): Promise<IdentitySnapshot> {
  const lexical = path.resolve(target)
  const canonical = await fs.realpath(lexical)
  const stat = await fs.lstat(lexical)
  if (canonical !== lexical || stat.isSymbolicLink()) throw new TypeError("Preview Docker path aliases are forbidden")
  if (stat.isFile()) {
    if (!Number.isSafeInteger(stat.nlink) || stat.nlink !== 1) {
      throw new TypeError("Preview Docker regular files must have one trusted owner")
    }
    return { canonical, device: stat.dev, inode: stat.ino, links: stat.nlink }
  }
  if (!stat.isDirectory()) throw new TypeError("Preview Docker path type is unsupported")
  return { canonical, device: stat.dev, inode: stat.ino }
}

function sameTree(left: TreeSnapshot, right: TreeSnapshot) {
  const same = (a: IdentitySnapshot, b: IdentitySnapshot) =>
    a.canonical === b.canonical && a.device === b.device && a.inode === b.inode && a.links === b.links
  return (
    same(left.hostRoot, right.hostRoot) &&
    left.workspace.length === right.workspace.length &&
    left.workspace.every((item, index) => same(item, right.workspace[index])) &&
    left.capabilityTemp.length === right.capabilityTemp.length &&
    left.capabilityTemp.every((item, index) => same(item, right.capabilityTemp[index]))
  )
}

function ownershipFor(identity: ProcessOwnership.Identity, config: DockerConfig.Config): Ownership {
  const digest = (scope: string, value: string) => createHash("sha256").update(`${scope}\0${value}`).digest("hex")
  const configIdentity = digest(
    "config",
    JSON.stringify({
      enginePath: config.enginePath,
      image: config.image,
      dockerConfig: config.dockerConfig,
      temp: config.temp,
      limits: config.limits,
    }),
  )
  const labels = Object.freeze({
    [`${labelDomain}.host`]: digest("host", identity.hostID),
    [`${labelDomain}.nonce`]: digest("nonce", identity.nonce),
    [`${labelDomain}.config`]: configIdentity,
    [`${labelDomain}.image`]: digest("image", config.image),
    [`${labelDomain}.kind`]: digest("kind", "script-preview"),
  })
  const aggregate = digest("owned", Object.values(labels).join("\0")).slice(0, 48)
  return { containerName: `ocp-${aggregate}`, networkName: `ocpn-${aggregate}`, labels }
}

function labelsArgv(labels: Readonly<Record<string, string>>) {
  return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`])
}

function environmentArgv(environment: Readonly<Record<string, string>>, port: number) {
  const values = [
    ...Object.entries(environment).map(([name, value]) => `${name}=${value}`),
    "CI=1",
    "HOME=/home/sandbox",
    "LANG=C.UTF-8",
    "NO_COLOR=1",
    `OPENCODE_PREVIEW_PORT=${port}`,
    "TEMP=/opencode/tmp",
    "TMP=/opencode/tmp",
  ]
  return values.flatMap((value) => ["--env", value])
}

function normalizeRuntime(argv: readonly string[]) {
  const executable = argv[0]?.toLowerCase().replace(/\.exe$/, "")
  if (executable !== "node" && executable !== "bun") throw new TypeError("Preview Docker runtime is not approved")
  return [executable, ...argv.slice(1)]
}

async function beforeDeadline(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  input: Pick<Parameters<ProcessOwnership.Service["start"]>[0], "signal" | "deadline">,
  now: () => number,
  argv: readonly string[],
  maxOutputBytes = config.limits.maxOutputBytes,
  late?: LateResultObserver,
) {
  rejectCancelledOrExpired(input.signal, input.deadline, now)
  return execute(engine, config, {
    argv,
    timeoutMs: Math.min(config.limits.engineTimeoutMs, input.deadline - now()),
    maxOutputBytes,
    signal: input.signal,
    late,
  })
}

function rejectCancelledOrExpired(signal: AbortSignal, deadline: number, now: () => number) {
  if (signal.aborted) throw new Docker.Cancelled("Preview Docker start was cancelled")
  if (!Number.isFinite(deadline) || deadline <= now()) throw new Docker.Timeout("Preview Docker start deadline elapsed")
}

function startBoundary(
  input: Pick<Parameters<ProcessOwnership.Service["start"]>[0], "signal" | "deadline">,
  now: () => number,
) {
  return { input, now }
}

async function inspectContainer(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  id: string,
  ownership: Ownership,
  strict = false,
  boundary?: {
    readonly input: Pick<Parameters<ProcessOwnership.Service["start"]>[0], "signal" | "deadline">
    readonly now: () => number
  },
) {
  return (await inspectContainerState(engine, config, id, ownership, strict, boundary)) !== undefined
}

async function inspectContainerState(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  id: string,
  ownership: Ownership,
  strict = false,
  boundary?: {
    readonly input: Pick<Parameters<ProcessOwnership.Service["start"]>[0], "signal" | "deadline">
    readonly now: () => number
  },
  timeoutMs = config.limits.engineTimeoutMs,
): Promise<boolean | undefined> {
  const argv = ["container", "inspect", id]
  const result =
    boundary === undefined
      ? await execute(engine, config, { argv, timeoutMs })
      : await beforeDeadline(engine, config, boundary.input, boundary.now, argv)
  const value = inspectObject(result, strict)
  if (
    value === undefined ||
    Reflect.get(value, "Id") !== id ||
    Reflect.get(value, "Name") !== `/${ownership.containerName}`
  )
    return undefined
  const dockerConfig = Reflect.get(value, "Config")
  const state = Reflect.get(value, "State")
  const running = state !== null && typeof state === "object" ? Reflect.get(state, "Running") : undefined
  if (
    dockerConfig === null ||
    typeof dockerConfig !== "object" ||
    !exactLabels(Reflect.get(dockerConfig, "Labels"), ownership.labels) ||
    typeof running !== "boolean"
  ) {
    return undefined
  }
  return running
}

async function inspectNetwork(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  id: string,
  ownership: Ownership,
  strict = false,
  boundary?: {
    readonly input: Pick<Parameters<ProcessOwnership.Service["start"]>[0], "signal" | "deadline">
    readonly now: () => number
  },
  timeoutMs = config.limits.engineTimeoutMs,
) {
  const argv = ["network", "inspect", id]
  const result =
    boundary === undefined
      ? await execute(engine, config, { argv, timeoutMs })
      : await beforeDeadline(engine, config, boundary.input, boundary.now, argv)
  const value = inspectObject(result, strict)
  return value !== undefined && exactNetwork(value, id, ownership)
}

function exactNetwork(value: object, id: string, ownership: Ownership) {
  return (
    Reflect.get(value, "Id") === id &&
    Reflect.get(value, "Name") === ownership.networkName &&
    Reflect.get(value, "Driver") === "bridge" &&
    Reflect.get(value, "Internal") === true &&
    exactLabels(Reflect.get(value, "Labels"), ownership.labels)
  )
}

function inspectObject(result: Docker.Result, strict: boolean): object | undefined {
  if (result.exit !== 0 || result.truncated) {
    if (strict) throw new Docker.Unavailable("Preview Docker inspection failed")
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout)
    return Array.isArray(parsed) && parsed.length === 1 && parsed[0] !== null && typeof parsed[0] === "object"
      ? parsed[0]
      : undefined
  } catch (cause) {
    if (strict) throw new Docker.Unavailable("Preview Docker inspection was malformed", { cause })
    return undefined
  }
}

function exactLabels(value: unknown, expected: Readonly<Record<string, string>>) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, item]) => Reflect.get(value, key) === item)
  )
}

async function settle(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  containerID: string,
  ownership: Ownership,
  signal: AbortSignal,
) {
  const waited = await execute(engine, config, {
    argv: ["container", "wait", containerID],
    timeoutMs: config.limits.timeoutMs,
    signal,
  })
  if (waited.exit !== 0 || waited.truncated || !/^(?:0|[1-9][0-9]{0,2})\r?\n?$/.test(waited.stdout)) {
    throw new Docker.Unavailable("Preview Docker wait did not return a bounded exit")
  }
  if (!(await inspectContainer(engine, config, containerID, ownership, true))) {
    throw new Docker.Unavailable("Preview Docker identity changed before logs")
  }
  const logs = await execute(engine, config, {
    argv: ["container", "logs", containerID],
    timeoutMs: config.limits.engineTimeoutMs,
    maxOutputBytes: config.limits.maxOutputBytes,
  })
  if (logs.exit !== 0) throw new Docker.Unavailable("Preview Docker logs were unavailable")
  return {
    exit: Number(waited.stdout.trim()),
    stdout: boundedBytes(logs.stdout, config.limits.maxOutputBytes),
    stderr: boundedBytes(logs.stderr, config.limits.maxOutputBytes),
  }
}

function promisedStream(value: Promise<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      void value.then(
        (bytes) => {
          if (bytes.byteLength > 0) controller.enqueue(bytes)
          controller.close()
        },
        (cause) => controller.error(cause),
      )
    },
  })
}

function boundedBytes(value: string, limit: number) {
  return new TextEncoder().encode(value).subarray(0, limit)
}

async function listExact(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  scope: "container" | "network",
  labels: Readonly<Record<string, string>>,
) {
  const result = await execute(engine, config, {
    argv: [
      scope,
      "ls",
      ...(scope === "container" ? ["--all"] : []),
      "--quiet",
      ...Object.entries(labels).flatMap(([key, value]) => ["--filter", `label=${key}=${value}`]),
    ],
    timeoutMs: config.limits.engineTimeoutMs,
  })
  if (result.exit !== 0 || result.truncated) throw new Docker.Unavailable("Preview Docker recovery listing failed")
  const ids = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
  if (ids.some((id) => !opaquePattern.test(id)))
    throw new Docker.Unavailable("Preview Docker recovery listing was malformed")
  return [...new Set(ids)]
}

async function cleanupOwned(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  ownership: Ownership,
  containerID: string,
  networkID: string,
  running: boolean,
  deadline?: number,
): Promise<Error | undefined> {
  const failures: unknown[] = []
  for (const argv of [
    ...(running ? [["container", "kill", containerID] as const] : []),
    ["container", "rm", "--force", containerID],
    ["network", "rm", networkID],
  ] as const) {
    try {
      const result = await execute(engine, config, { argv, timeoutMs: cleanupTimeoutBefore(config, deadline) })
      if (result.exit !== 0) {
        if (argv[0] === "container" && argv[1] === "kill") {
          const current = await inspectContainerState(
            engine,
            config,
            containerID,
            ownership,
            true,
            undefined,
            cleanupTimeoutBefore(config, deadline),
          ).catch(() => undefined)
          if (current === false) continue
        }
        failures.push(new Docker.Unavailable(`Preview Docker cleanup failed: ${argv[0]} ${argv[1]}`))
      }
    } catch (cause) {
      failures.push(cause)
    }
  }
  return failures.length === 0 ? undefined : new AggregateError(failures, "Preview Docker cleanup failed")
}

async function cleanupLateNetwork(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  ownership: Ownership,
  late: Readonly<LateResultState>,
  deadline: number,
) {
  const discoveryDeadline = lateDiscoveryDeadline(config, deadline, 1)
  const networkID = await discoverLateNetwork(engine, config, ownership, late, discoveryDeadline)
  if (networkID !== undefined) await removeNetwork(engine, config, networkID, deadline)
}

async function cleanupLateContainer(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  ownership: Ownership,
  networkID: string | undefined,
  late: Readonly<LateResultState>,
  deadline: number,
) {
  const discoveryDeadline = lateDiscoveryDeadline(config, deadline, 4)
  const [authenticatedNetworkID, authenticatedContainer] = await Promise.all([
    discoverLateNetwork(engine, config, ownership, undefined, discoveryDeadline, networkID),
    discoverLateContainer(engine, config, ownership, late, discoveryDeadline),
  ])

  if (authenticatedContainer === undefined) {
    if (authenticatedNetworkID !== undefined) await removeNetwork(engine, config, authenticatedNetworkID, deadline)
    return
  }
  if (authenticatedNetworkID !== undefined) {
    const failure = await cleanupOwned(
      engine,
      config,
      ownership,
      authenticatedContainer.id,
      authenticatedNetworkID,
      authenticatedContainer.running,
      deadline,
    )
    if (failure !== undefined) throw failure
    return
  }
  const failure = await cleanupContainer(
    engine,
    config,
    ownership,
    authenticatedContainer.id,
    authenticatedContainer.running,
    deadline,
  )
  if (failure !== undefined) throw failure
}

async function discoverLateNetwork(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  ownership: Ownership,
  late: Readonly<LateResultState> | undefined,
  deadline: number,
  knownID?: string,
): Promise<string | undefined> {
  let knownChecked = false
  let returnedChecked = false
  while (Date.now() < deadline) {
    if (!knownChecked && knownID !== undefined) {
      knownChecked = true
      const verified = await inspectNetwork(
        engine,
        config,
        knownID,
        ownership,
        false,
        undefined,
        cleanupTimeoutBefore(config, deadline),
      ).catch(() => false)
      if (verified) return knownID
    }
    if (!returnedChecked && late?.settled) {
      returnedChecked = true
      const returnedID = lateResourceID(late.result)
      if (returnedID !== undefined) {
        const verified = await inspectNetwork(
          engine,
          config,
          returnedID,
          ownership,
          false,
          undefined,
          cleanupTimeoutBefore(config, deadline),
        ).catch(() => false)
        if (verified) return returnedID
      }
    }
    const discovered = await inspectNetworkByName(engine, config, ownership, deadline).catch(() => undefined)
    if (discovered !== undefined) return discovered
    await pauseLateDiscovery(deadline)
  }
  return undefined
}

async function discoverLateContainer(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  ownership: Ownership,
  late: Readonly<LateResultState>,
  deadline: number,
): Promise<{ readonly id: string; readonly running: boolean } | undefined> {
  let returnedChecked = false
  while (Date.now() < deadline) {
    if (!returnedChecked && late.settled) {
      returnedChecked = true
      const returnedID = lateResourceID(late.result)
      if (returnedID !== undefined) {
        const running = await inspectContainerState(
          engine,
          config,
          returnedID,
          ownership,
          false,
          undefined,
          cleanupTimeoutBefore(config, deadline),
        ).catch(() => undefined)
        if (running !== undefined) return { id: returnedID, running }
      }
    }
    const discovered = await inspectContainerByName(engine, config, ownership, deadline).catch(() => undefined)
    if (discovered !== undefined) return discovered
    await pauseLateDiscovery(deadline)
  }
  return undefined
}

function lateDiscoveryDeadline(config: DockerConfig.Config, hardDeadline: number, reservedCleanupOperations: number) {
  const now = Date.now()
  const reserve = Math.min(Number.MAX_SAFE_INTEGER, config.limits.cleanupTimeoutMs * reservedCleanupOperations)
  const available = Math.max(0, hardDeadline - now - reserve)
  return now + available
}

async function pauseLateDiscovery(deadline: number) {
  const remaining = deadline - Date.now()
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)))
}

function cleanupTimeoutBefore(config: DockerConfig.Config, deadline?: number) {
  return deadline === undefined
    ? config.limits.cleanupTimeoutMs
    : Math.min(config.limits.cleanupTimeoutMs, deadline - Date.now())
}

function lateResourceID(result: Docker.Result | undefined) {
  if (result === undefined || result.exit !== 0 || result.truncated) return undefined
  const id = result.stdout.trim()
  return opaquePattern.test(id) ? id : undefined
}

async function cleanupContainer(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  ownership: Ownership,
  containerID: string,
  running: boolean,
  deadline?: number,
): Promise<Error | undefined> {
  const failures: unknown[] = []
  for (const argv of [
    ...(running ? [["container", "kill", containerID] as const] : []),
    ["container", "rm", "--force", containerID] as const,
  ]) {
    try {
      const result = await execute(engine, config, { argv, timeoutMs: cleanupTimeoutBefore(config, deadline) })
      if (result.exit === 0) continue
      if (argv[1] === "kill") {
        const current = await inspectContainerState(
          engine,
          config,
          containerID,
          ownership,
          true,
          undefined,
          cleanupTimeoutBefore(config, deadline),
        ).catch(() => undefined)
        if (current === false) continue
      }
      failures.push(new Docker.Unavailable(`Preview Docker cleanup failed: ${argv[0]} ${argv[1]}`))
    } catch (cause) {
      failures.push(cause)
    }
  }
  return failures.length === 0 ? undefined : new AggregateError(failures, "Preview Docker cleanup failed")
}

async function cleanupAfterStartFailure(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  ownership: Ownership,
  state: {
    readonly networkID?: string
    readonly networkVerified: boolean
    readonly containerID?: string
    readonly containerVerified: boolean
    readonly containerRunning: boolean
  },
): Promise<Error | undefined> {
  try {
    const discoveredNetwork =
      state.networkID === undefined
        ? await inspectNetworkByName(engine, config, ownership).catch(() => undefined)
        : undefined
    const networkID = state.networkID ?? discoveredNetwork
    let networkVerified = state.networkVerified || discoveredNetwork !== undefined
    if (!networkVerified && networkID !== undefined) {
      networkVerified = await inspectNetwork(engine, config, networkID, ownership, false).catch(() => false)
    }
    const discoveredContainer =
      state.containerID === undefined
        ? await inspectContainerByName(engine, config, ownership).catch(() => undefined)
        : undefined
    const containerID = state.containerID ?? discoveredContainer?.id
    let containerRunning = state.containerVerified ? state.containerRunning : discoveredContainer?.running
    if (containerRunning === undefined && containerID !== undefined) {
      containerRunning = await inspectContainerState(engine, config, containerID, ownership, false).catch(
        () => undefined,
      )
    }
    if (networkVerified && networkID !== undefined && containerID !== undefined && containerRunning !== undefined) {
      return cleanupOwned(engine, config, ownership, containerID, networkID, containerRunning)
    }
    if (containerID !== undefined && containerRunning !== undefined) {
      const failure = await cleanupContainer(engine, config, ownership, containerID, containerRunning)
      if (failure !== undefined) return failure
    }
    if (networkVerified && networkID !== undefined) {
      await removeNetwork(engine, config, networkID)
    }
    return undefined
  } catch (cause) {
    return cause instanceof Error ? cause : new Docker.Unavailable("Preview start cleanup failed", { cause })
  }
}

async function inspectNetworkByName(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  ownership: Ownership,
  deadline?: number,
): Promise<string | undefined> {
  const result = await execute(engine, config, {
    argv: ["network", "inspect", ownership.networkName],
    timeoutMs: cleanupTimeoutBefore(config, deadline),
  })
  const value = inspectObject(result, false)
  if (value === undefined) return undefined
  const id = Reflect.get(value, "Id")
  return typeof id === "string" && opaquePattern.test(id) && exactNetwork(value, id, ownership) ? id : undefined
}

async function inspectContainerByName(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  ownership: Ownership,
  deadline?: number,
): Promise<{ readonly id: string; readonly running: boolean } | undefined> {
  const result = await execute(engine, config, {
    argv: ["container", "inspect", ownership.containerName],
    timeoutMs: cleanupTimeoutBefore(config, deadline),
  })
  const value = inspectObject(result, false)
  if (value === undefined) return undefined
  const id = Reflect.get(value, "Id")
  if (typeof id !== "string" || !opaquePattern.test(id)) return undefined
  const state = Reflect.get(value, "State")
  const running = state !== null && typeof state === "object" ? Reflect.get(state, "Running") : undefined
  const dockerConfig = Reflect.get(value, "Config")
  return Reflect.get(value, "Name") === `/${ownership.containerName}` &&
    dockerConfig !== null &&
    typeof dockerConfig === "object" &&
    exactLabels(Reflect.get(dockerConfig, "Labels"), ownership.labels) &&
    typeof running === "boolean"
    ? { id, running }
    : undefined
}

const detachedCleanup = Symbol("detached-cleanup")

async function observeCleanupBeforeDeadline(
  cleanup: Promise<Error | undefined>,
  input: Pick<Parameters<ProcessOwnership.Service["start"]>[0], "signal" | "deadline">,
  now: () => number,
): Promise<Error | undefined | typeof detachedCleanup> {
  const remaining = input.deadline - now()
  if (input.signal.aborted || !Number.isFinite(remaining) || remaining <= 0) {
    void cleanup.catch(() => undefined)
    return detachedCleanup
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbort: () => void = () => {}
  const timeout = new Promise<typeof detachedCleanup>((resolve) => {
    timer = setTimeout(() => resolve(detachedCleanup), remaining)
  })
  const cancelled = new Promise<typeof detachedCleanup>((resolve) => {
    const onAbort = () => resolve(detachedCleanup)
    input.signal.addEventListener("abort", onAbort, { once: true })
    removeAbort = () => input.signal.removeEventListener("abort", onAbort)
    if (input.signal.aborted) onAbort()
  })
  const result = await Promise.race([cleanup, timeout, cancelled])
  if (timer !== undefined) clearTimeout(timer)
  removeAbort()
  if (result === detachedCleanup) void cleanup.catch(() => undefined)
  return result
}

async function removeNetwork(engine: Docker.Engine, config: DockerConfig.Config, networkID: string, deadline?: number) {
  const result = await execute(engine, config, {
    argv: ["network", "rm", networkID],
    timeoutMs: cleanupTimeoutBefore(config, deadline),
  })
  if (result.exit !== 0) throw new Docker.Unavailable("Preview Docker network cleanup failed")
}

interface LateResultObserver {
  readonly timeoutMs: number
  readonly detached: () => void
  readonly settle: (late: Readonly<LateResultState>, deadline: number) => Promise<void>
}

interface LateResultState {
  settled: boolean
  result?: Docker.Result
}

async function execute(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  input: {
    readonly argv: readonly string[]
    readonly timeoutMs: number
    readonly maxOutputBytes?: number
    readonly signal?: AbortSignal
    readonly late?: LateResultObserver
    readonly stdin?: string | Uint8Array
  },
) {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Docker.Timeout("Docker invocation deadline elapsed")
  }
  if (input.signal?.aborted) throw new Docker.Cancelled("Docker invocation was cancelled")
  const current = await DockerConfig.revalidate(config)
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let removeAbort: () => void = () => {}
  const invocation = engine.execute({
    executable: current.enginePath,
    argv: input.argv,
    env: DockerConfig.invocationEnvironment(current),
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes ?? config.limits.maxOutputBytes,
    ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
    signal: controller.signal,
  })
  const boundary = new Promise<{ readonly kind: "boundary"; readonly cause: Docker.Cancelled | Docker.Timeout }>(
    (resolve) => {
      const onAbort = () => {
        controller.abort(input.signal?.reason)
        // Give a resource-creating CLI that has already produced its opaque ID one
        // microtask to settle so the caller can authenticate and clean it up. The
        // absolute caller boundary is still wall-clock bounded.
        queueMicrotask(() =>
          resolve({ kind: "boundary", cause: new Docker.Cancelled("Docker invocation was cancelled") }),
        )
      }
      input.signal?.addEventListener("abort", onAbort, { once: true })
      removeAbort = () => {
        input.signal?.removeEventListener("abort", onAbort)
      }
      if (input.signal?.aborted) {
        onAbort()
        return
      }
      timeout = setTimeout(() => {
        const cause = new Docker.Timeout("Docker invocation timed out")
        controller.abort(cause)
        resolve({ kind: "boundary", cause })
      }, input.timeoutMs)
    },
  )
  try {
    const outcome = await Promise.race([
      invocation.then(
        (result) => ({ kind: "result" as const, result }),
        (cause) => ({ kind: "failure" as const, cause }),
      ),
      boundary,
    ])
    if (outcome.kind === "result") return outcome.result
    if (outcome.kind === "failure") {
      input.late?.detached()
      if (input.late !== undefined) void observeLateResult(invocation, input.late)
      throw outcome.cause
    }
    input.late?.detached()
    if (input.late !== undefined) void observeLateResult(invocation, input.late)
    throw outcome.cause
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    removeAbort()
  }
}

async function observeLateResult(invocation: Promise<Docker.Result>, observer: LateResultObserver) {
  const deadline = Date.now() + observer.timeoutMs
  const late: LateResultState = { settled: false }
  void invocation.then(
    (result) => {
      late.result = result
      late.settled = true
    },
    () => {
      late.settled = true
    },
  )
  const remaining = deadline - Date.now()
  if (remaining > 0) await boundedOutcome(observer.settle(late, deadline), remaining)
}

async function canonicalDDirectory(value: string): Promise<string> {
  if (!path.win32.isAbsolute(value) || !/^D:\\/i.test(value) || unsafeWindowsPath(value)) {
    throw new TypeError("Preview Docker roots must be canonical D-drive paths")
  }
  const canonical = await fs.realpath(value)
  const stat = await fs.lstat(value)
  if (path.resolve(value) !== canonical || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("Preview Docker root changed identity or spelling")
  }
  return canonical
}

function unsafeWindowsPath(value: string) {
  if (value.includes(",") || value.includes("=") || /[\u0000-\u001f\u007f]/.test(value)) return true
  return value
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function overlap(left: string, right: string) {
  return contains(left, right) || contains(right, left)
}
