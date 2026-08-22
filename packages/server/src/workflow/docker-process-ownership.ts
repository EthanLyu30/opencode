export * as DockerProcessOwnership from "./docker-process-ownership"

import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
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
}

export function make(options: Options): ProcessOwnership.Service {
  const owned = new WeakMap<ProcessOwnership.OwnedProcess, OwnedState>()
  const now = options.now ?? Date.now

  return Object.freeze({
    available: true,
    start: async (input: Parameters<ProcessOwnership.Service["start"]>[0]) => {
      rejectCancelledOrExpired(input.signal, input.deadline, now)
      const config = await DockerConfig.validate(options.config)
      const admitted = await validateStart(options.hostRoot, config, input)
      const ownership = ownershipFor(input.identity, config)
      let networkID: string | undefined
      let containerID: string | undefined
      let networkVerified = false
      let containerVerified = false
      try {
        const network = await beforeDeadline(options.engine, config, input, now, [
          "network",
          "create",
          "--driver",
          "bridge",
          "--internal",
          ...labelsArgv(ownership.labels),
          ownership.networkName,
        ])
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
          activeStartBoundary(input, now),
        )
        if (!networkVerified) throw new Docker.Unavailable("Preview Docker network ownership verification failed")

        rejectCancelledOrExpired(input.signal, input.deadline, now)
        await revalidate(options.hostRoot, config, input, admitted)
        const runtime = normalizeRuntime(input.plan.argv ?? [])
        const create = await beforeDeadline(options.engine, config, input, now, [
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
          "--mount",
          `type=bind,src=${admitted.workspace},dst=/workspace,readonly`,
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
        ])
        if (create.exit !== 0 || create.truncated || !opaquePattern.test(create.stdout.trim())) {
          throw new Docker.Unavailable("Preview Docker container or pinned image is unavailable")
        }
        containerID = create.stdout.trim()
        containerVerified = await inspectContainer(
          options.engine,
          config,
          containerID,
          ownership,
          false,
          activeStartBoundary(input, now),
        )
        if (!containerVerified) throw new Docker.Unavailable("Preview Docker container ownership verification failed")

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
        if (
          !(await inspectContainer(
            options.engine,
            config,
            containerID,
            ownership,
            true,
            activeStartBoundary(input, now),
          ))
        ) {
          throw new Docker.Unavailable("Preview Docker container identity changed after start")
        }
        rejectCancelledOrExpired(input.signal, input.deadline, now)

        const completion = settle(options.engine, config, containerID, ownership, input.signal)
        const process: ProcessOwnership.OwnedProcess = Object.freeze({
          exited: completion.then((value) => value.exit),
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
        if (containerVerified && containerID !== undefined && networkVerified && networkID !== undefined) {
          const cleanup = await cleanupOwned(options.engine, config, containerID, networkID)
          if (cleanup !== undefined) {
            throw new Error(`Preview start cleanup failed: ${cleanup.message}`, { cause })
          }
        } else if (networkVerified && networkID !== undefined) {
          await removeNetwork(options.engine, config, networkID).catch(() => undefined)
        }
        throw cause
      }
    },
    stop: async (input: Parameters<ProcessOwnership.Service["stop"]>[0]) => {
      const state = owned.get(input.process)
      if (state === undefined || state.stopped) return
      if (
        !(await inspectContainer(
          options.engine,
          await DockerConfig.validate(options.config),
          state.containerID,
          state.ownership,
          true,
        )) ||
        !(await inspectNetwork(
          options.engine,
          await DockerConfig.validate(options.config),
          state.networkID,
          state.ownership,
          true,
        ))
      ) {
        throw new Docker.Unavailable("Preview Docker ownership changed before stop")
      }
      state.stopped = true
      const failure = await cleanupOwned(
        options.engine,
        await DockerConfig.validate(options.config),
        state.containerID,
        state.networkID,
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
      if (
        !(await inspectContainer(options.engine, config, containerID, ownership, true)) ||
        !(await inspectNetwork(options.engine, config, networkID, ownership, true))
      ) {
        throw new Docker.Unavailable("Preview Docker recovery ownership did not match")
      }
      const failure = await cleanupOwned(options.engine, config, containerID, networkID)
      if (failure !== undefined) throw failure
    },
  })
}

async function validateStart(
  configuredHostRoot: string,
  config: DockerConfig.Config,
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
  const workspace = await canonicalDDirectory(input.plan.locationRoot)
  const cwd = await canonicalDDirectory(input.plan.cwd)
  const capabilityTemp = await canonicalDDirectory(input.tempRoot)
  const expectedTemp = path.join(hostRoot, input.identity.hostID, ".tmp")
  if (
    path.resolve(expectedTemp) !== capabilityTemp ||
    !contains(workspace, cwd) ||
    overlap(hostRoot, workspace) ||
    overlap(config.dockerConfig, workspace) ||
    overlap(config.temp, workspace) ||
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
    relativeCwd: cwd === workspace ? "." : path.relative(workspace, cwd).replaceAll("\\", "/"),
    snapshot,
  }
}

async function revalidate(
  configuredHostRoot: string,
  config: DockerConfig.Config,
  input: Parameters<ProcessOwnership.Service["start"]>[0],
  admitted: Awaited<ReturnType<typeof validateStart>>,
) {
  const currentConfig = await DockerConfig.validate(config)
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
    workspace: await walk(workspace),
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
  return { canonical, device: stat.dev, inode: stat.ino }
}

function sameTree(left: TreeSnapshot, right: TreeSnapshot) {
  const same = (a: IdentitySnapshot, b: IdentitySnapshot) =>
    a.canonical === b.canonical && a.device === b.device && a.inode === b.inode
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
) {
  rejectCancelledOrExpired(input.signal, input.deadline, now)
  return execute(engine, config, {
    argv,
    timeoutMs: Math.min(config.limits.engineTimeoutMs, input.deadline - now()),
    maxOutputBytes,
    signal: input.signal,
  })
}

function rejectCancelledOrExpired(signal: AbortSignal, deadline: number, now: () => number) {
  if (signal.aborted) throw new Docker.Cancelled("Preview Docker start was cancelled")
  if (!Number.isFinite(deadline) || deadline <= now()) throw new Docker.Timeout("Preview Docker start deadline elapsed")
}

function activeStartBoundary(
  input: Pick<Parameters<ProcessOwnership.Service["start"]>[0], "signal" | "deadline">,
  now: () => number,
) {
  return !input.signal.aborted && Number.isFinite(input.deadline) && input.deadline > now() ? { input, now } : undefined
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
  const argv = ["container", "inspect", id]
  const result =
    boundary === undefined
      ? await execute(engine, config, { argv, timeoutMs: config.limits.engineTimeoutMs })
      : await beforeDeadline(engine, config, boundary.input, boundary.now, argv)
  const value = inspectObject(result, strict)
  if (
    value === undefined ||
    Reflect.get(value, "Id") !== id ||
    Reflect.get(value, "Name") !== `/${ownership.containerName}`
  )
    return false
  const dockerConfig = Reflect.get(value, "Config")
  return (
    dockerConfig !== null &&
    typeof dockerConfig === "object" &&
    exactLabels(Reflect.get(dockerConfig, "Labels"), ownership.labels)
  )
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
) {
  const argv = ["network", "inspect", id]
  const result =
    boundary === undefined
      ? await execute(engine, config, { argv, timeoutMs: config.limits.engineTimeoutMs })
      : await beforeDeadline(engine, config, boundary.input, boundary.now, argv)
  const value = inspectObject(result, strict)
  return (
    value !== undefined &&
    Reflect.get(value, "Id") === id &&
    Reflect.get(value, "Name") === ownership.networkName &&
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
  containerID: string,
  networkID: string,
): Promise<Error | undefined> {
  const failures: unknown[] = []
  for (const argv of [
    ["container", "kill", containerID],
    ["container", "rm", "--force", containerID],
    ["network", "rm", networkID],
  ] as const) {
    try {
      const result = await execute(engine, config, { argv, timeoutMs: config.limits.cleanupTimeoutMs })
      if (result.exit !== 0)
        failures.push(new Docker.Unavailable(`Preview Docker cleanup failed: ${argv[0]} ${argv[1]}`))
    } catch (cause) {
      failures.push(cause)
    }
  }
  return failures.length === 0 ? undefined : new AggregateError(failures, "Preview Docker cleanup failed")
}

async function removeNetwork(engine: Docker.Engine, config: DockerConfig.Config, networkID: string) {
  const result = await execute(engine, config, {
    argv: ["network", "rm", networkID],
    timeoutMs: config.limits.cleanupTimeoutMs,
  })
  if (result.exit !== 0) throw new Docker.Unavailable("Preview Docker network cleanup failed")
}

function execute(
  engine: Docker.Engine,
  config: DockerConfig.Config,
  input: {
    readonly argv: readonly string[]
    readonly timeoutMs: number
    readonly maxOutputBytes?: number
    readonly signal?: AbortSignal
  },
) {
  return engine.execute({
    executable: config.enginePath,
    argv: input.argv,
    env: DockerConfig.invocationEnvironment(config),
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes ?? config.limits.maxOutputBytes,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
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
