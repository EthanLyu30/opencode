export * as WorkflowCommandSandboxServer from "./command-sandbox"

import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Location } from "@opencode-ai/core/location"
import { SessionStore } from "@opencode-ai/core/session/store"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowRoleAgents } from "@opencode-ai/core/workflow/role-agents"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowToolLineage } from "@opencode-ai/core/workflow/tool-lineage"
import { DateTime, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Docker } from "./docker"
import { DockerConfig } from "./docker-config"
import { WorkflowRuntimeRecovery } from "./runtime-recovery"

const labelDomain = "io.opencode.workflow"
const containerIDPattern = /^[a-f0-9]{64}$/
const executableRoles = new Set<WorkflowCommandSandbox.Request["role"]>(["implement", "repair", "test", "deliver"])

export type Config = DockerConfig.Config

export interface Options {
  readonly engine: Docker.Engine
  readonly config: Config
  readonly now?: () => number
  readonly recoveryReady?: () => boolean
}

export interface RecoveryAuthority {
  readonly workflowID: WorkflowCommandSandbox.Request["workflowID"]
  readonly stageID: WorkflowCommandSandbox.Request["stageID"]
  readonly toolCallID: WorkflowCommandSandbox.Request["toolCallID"]
  readonly role: WorkflowCommandSandbox.Request["role"]
  readonly policyDigest: string
  readonly sessionID: WorkflowCommandSandbox.Request["sessionID"]
  readonly agent: WorkflowCommandSandbox.Request["agent"]
  readonly leaseOwner: string
  readonly attempt: number
  /** Durable recovery-only lineage; deliberately not added to the reviewed B1 Docker label set. */
  readonly assistantMessageID?: WorkflowCommandSandbox.Request["assistantMessageID"]
  readonly callDigest?: string
}

interface OwnedContainer {
  readonly id: string
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly running?: boolean
  readonly exitCode?: number
}

interface PathIdentity {
  readonly canonical: string
  readonly device: number
  readonly inode: number
}

export function makeLayer(
  options: Options,
): Layer.Layer<WorkflowCommandSandbox.Service, never, WorkflowStore.Service | SessionStore.Service | Location.Service> {
  return Layer.effect(
    WorkflowCommandSandbox.Service,
    Effect.gen(function* () {
      const workflows = yield* WorkflowStore.Service
      const sessions = yield* SessionStore.Service
      const location = yield* Location.Service
      return WorkflowCommandSandbox.Service.of({
        run: Effect.fn("WorkflowCommandSandboxServer.run")(function* (request) {
          if (!executableRoles.has(request.role))
            return yield* rejected(`Workflow role ${request.role} cannot use Bash`)
          if (options.recoveryReady?.() === false)
            return yield* unavailable("Workflow Docker recovery or configuration is unavailable")
          const authority = yield* reloadAuthority({
            request,
            workflows,
            sessions,
            location,
            now: options.now ?? Date.now,
          })
          const config = yield* Effect.tryPromise({
            try: () => validatedConfig(options.config),
            catch: () => unavailable("Workflow Docker sandbox configuration is unavailable"),
          })
          const paths = yield* Effect.tryPromise({
            try: () => validatePaths(location.directory, request.workdir ?? "."),
            catch: () => rejected("Workflow sandbox path is not canonical and contained by the persisted Location"),
          })
          const ownership = ownershipFor({
            workflowID: request.workflowID,
            stageID: request.stageID,
            toolCallID: request.toolCallID,
            role: request.role,
            policyDigest: request.policyDigest,
            sessionID: request.sessionID,
            agent: request.agent,
            leaseOwner: authority.leaseOwner,
            attempt: authority.attempt,
          })
          return yield* Effect.tryPromise({
            try: (signal) =>
              runOwned(options.engine, config, request, paths, ownership, signal, async () => {
                const current = await Effect.runPromise(
                  reloadAuthority({
                    request,
                    workflows,
                    sessions,
                    location,
                    now: options.now ?? Date.now,
                  }),
                )
                if (current.leaseOwner !== authority.leaseOwner || current.attempt !== authority.attempt)
                  throw rejected("Persisted Workflow Stage lease changed before launch")
                const currentPaths = await validatePaths(location.directory, request.workdir ?? ".")
                if (
                  !sameIdentity(paths.workspace, currentPaths.workspace) ||
                  !sameIdentity(paths.workdir, currentPaths.workdir)
                )
                  throw rejected("Workflow sandbox path identity changed before launch")
                if (current.leaseExpiresAt < (options.now?.() ?? Date.now()))
                  throw rejected("Persisted Workflow Stage lease expired before launch")
              }),
            catch: (cause) =>
              cause instanceof WorkflowCommandSandbox.Rejected
                ? cause
                : unavailable("Workflow Docker sandbox failed before command settlement"),
          })
        }),
      })
    }),
  )
}

export const layer = Layer.unwrap(
  Effect.map(WorkflowRuntimeRecovery.Service, (recovery) =>
    makeLayer({
      engine: Docker.production,
      config: DockerConfig.fromEnvironment(process.env),
      recoveryReady: () => recovery.ready,
    }),
  ),
)

export const node = makeLocationNode({
  service: WorkflowCommandSandbox.Service,
  layer,
  deps: [WorkflowStore.node, SessionStore.node, Location.node, WorkflowRuntimeRecovery.node],
})

export async function recover(input: {
  readonly engine: Docker.Engine
  readonly config: Config
  readonly authority: RecoveryAuthority
  readonly finalGate?: () => Promise<boolean>
}): Promise<number> {
  try {
    return await recoverOwned(input)
  } catch (cause) {
    if (cause instanceof WorkflowCommandSandbox.Unavailable) throw cause
    throw unavailable("Workflow Docker recovery is unavailable")
  }
}

async function recoverOwned(input: {
  readonly engine: Docker.Engine
  readonly config: Config
  readonly authority: RecoveryAuthority
  readonly finalGate?: () => Promise<boolean>
}): Promise<number> {
  const config = await validatedConfig(input.config)
  const ownership = ownershipFor(input.authority)
  const listed = await execute(input.engine, config, {
    argv: [
      "container",
      "ls",
      "--all",
      "--quiet",
      ...Object.entries(ownership.labels).flatMap(([key, value]) => ["--filter", `label=${key}=${value}`]),
    ],
    timeoutMs: config.limits.engineTimeoutMs,
  })
  if (listed.exit !== 0) throw unavailable("Workflow Docker recovery is unavailable")
  if (listed.truncated) throw unavailable("Workflow Docker recovery listing exceeded its bound")
  const lines = listed.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
  if (lines.some((value) => !containerIDPattern.test(value)))
    throw unavailable("Workflow Docker recovery listing was malformed")
  const ids = [...new Set(lines)]
  const exact = (
    await Promise.all(
      ids.map(async (id) => ((await inspect(input.engine, config, id, ownership, true)) ? id : undefined)),
    )
  ).filter((id): id is string => id !== undefined)
  if (input.finalGate !== undefined && !(await input.finalGate())) return 0
  let cleanupFailed = false
  for (const id of exact) {
    try {
      const killed = await execute(input.engine, config, {
        argv: ["container", "kill", id],
        timeoutMs: config.limits.cleanupTimeoutMs,
      })
      if (killed.exit !== 0) cleanupFailed = true
    } catch {
      cleanupFailed = true
    } finally {
      try {
        const removed = await execute(input.engine, config, {
          argv: ["container", "rm", "--force", id],
          timeoutMs: config.limits.cleanupTimeoutMs,
        })
        if (removed.exit !== 0) cleanupFailed = true
      } catch {
        cleanupFailed = true
      }
    }
  }
  if (cleanupFailed) throw unavailable("Workflow Docker recovery cleanup failed")
  return exact.length
}

const reloadAuthority = Effect.fn("WorkflowCommandSandboxServer.reloadAuthority")(function* (input: {
  readonly request: WorkflowCommandSandbox.Request
  readonly workflows: WorkflowStore.Interface
  readonly sessions: SessionStore.Interface
  readonly location: Location.Interface
  readonly now: () => number
}) {
  const detail = yield* input.workflows.get(input.request.workflowID)
  if (detail === undefined || detail.run.id !== input.request.workflowID)
    return yield* rejected("Persisted Workflow is required")
  const stage = yield* input.workflows.stage(input.request.stageID)
  if (stage === undefined || stage.id !== input.request.stageID || stage.workflowID !== detail.run.id)
    return yield* rejected("Persisted Stage is required")
  const session = yield* input.sessions.get(input.request.sessionID)
  if (session === undefined || session.id !== input.request.sessionID)
    return yield* rejected("Persisted Session is required")
  if (
    input.request.assistantMessageID !== workflowMessageID(input.request.stageID, input.request.toolCallID) ||
    !pendingCheckpointCall(stage.checkpoint, input.request)
  ) {
    return yield* rejected("Workflow Bash call is not the current unsettled persisted call")
  }
  if (
    detail.run.location === undefined ||
    !sameLocation(detail.run.location, input.location) ||
    !sameLocation(session.location, input.location)
  ) {
    return yield* rejected("Persisted Workflow, Session, and active Location do not match")
  }
  if (
    detail.run.sessionID !== input.request.sessionID ||
    (stage.sessionID !== undefined && stage.sessionID !== input.request.sessionID) ||
    stage.type !== input.request.role
  ) {
    return yield* rejected("Persisted Workflow Stage authority does not match the command request")
  }
  if (input.request.agent !== WorkflowRoleAgents.agentForRole(input.request.role)) {
    return yield* rejected("Persisted workflow role agent does not match the command request")
  }
  if (
    detail.run.status !== "running" ||
    detail.run.currentStageID !== stage.id ||
    (stage.status !== "leased" && stage.status !== "running") ||
    !stage.leaseOwner ||
    stage.attempt < 1 ||
    stage.leaseExpiresAt === undefined ||
    DateTime.toEpochMillis(stage.leaseExpiresAt) < input.now()
  ) {
    return yield* rejected("Persisted Workflow Stage lease is not current")
  }
  const route = yield* Effect.try({
    try: () =>
      WorkflowRouting.resolve({
        role: input.request.role,
        budget: detail.run.budget,
        requested: WorkflowRouting.requestedFromStage(input.request.role, stage.input),
      }),
    catch: () => rejected("Persisted Workflow route policy is invalid"),
  })
  const policyDigest = yield* WorkflowToolLineage.policyDigest({
    workflow: detail.run,
    stage,
    route,
    agent: input.request.agent,
  }).pipe(Effect.mapError(() => rejected("Persisted Workflow policy is invalid")))
  if (policyDigest !== input.request.policyDigest) {
    return yield* rejected("Persisted Workflow policy digest does not match the command request")
  }
  return {
    leaseOwner: stage.leaseOwner,
    attempt: stage.attempt,
    leaseExpiresAt: DateTime.toEpochMillis(stage.leaseExpiresAt),
  }
})

async function runOwned(
  engine: Docker.Engine,
  config: Config,
  request: WorkflowCommandSandbox.Request,
  paths: { readonly workspace: PathIdentity; readonly workdir: PathIdentity; readonly relativeWorkdir: string },
  ownership: ReturnType<typeof ownershipFor>,
  signal: AbortSignal,
  finalGate: () => Promise<void>,
): Promise<WorkflowCommandSandbox.Result> {
  const workspaceAccess = request.role === "implement" || request.role === "repair" ? "readwrite" : "readonly"
  const mount = `type=bind,src=${paths.workspace.canonical},dst=/workspace${workspaceAccess === "readonly" ? ",readonly" : ""}`
  const created = await execute(engine, config, {
    argv: [
      "container",
      "create",
      "--name",
      ownership.name,
      ...Object.entries(ownership.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--pull",
      "never",
      "--network",
      "none",
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
      "--env",
      "HOME=/home/sandbox",
      "--env",
      "LANG=C.UTF-8",
      "--mount",
      mount,
      "--workdir",
      paths.relativeWorkdir === "." ? "/workspace" : `/workspace/${paths.relativeWorkdir}`,
      config.image,
      "/bin/bash",
      "-se",
    ],
    timeoutMs: config.limits.engineTimeoutMs,
  })
  if (created.exit !== 0) throw unavailable("Workflow Docker daemon or pinned image is unavailable")
  const id = created.stdout.trim()
  if (!containerIDPattern.test(id)) throw unavailable("Docker returned an invalid container identity")
  const owned = await inspect(engine, config, id, ownership)
  if (!owned) throw unavailable("Docker container ownership verification failed")

  let kill = false
  let settled: WorkflowCommandSandbox.Result | undefined
  let failure: unknown
  try {
    await finalGate()
    const timeoutMs = Math.min(request.timeout ?? config.limits.timeoutMs, config.limits.timeoutMs)
    const result = await execute(engine, config, {
      argv: ["container", "start", "--attach", "--interactive", owned.id],
      stdin: `${request.command}\n`,
      timeoutMs,
      maxOutputBytes: config.limits.maxOutputBytes,
      signal,
    })
    const final = await inspect(engine, config, owned.id, ownership, true)
    if (!final || final.running !== false || final.exitCode === undefined)
      throw new Docker.Unavailable("Docker container did not expose a settled command state")
    if (result.exit !== 0 && final.exitCode === 0)
      throw new Docker.Unavailable("Docker CLI failed while attaching to the sandbox command")
    const output = `${result.stdout}${result.stderr}` || "(no output)"
    settled = { exit: final.exitCode, output, truncated: result.truncated }
  } catch (cause) {
    kill = cause instanceof Docker.Cancelled || cause instanceof Docker.Timeout || cause instanceof Docker.Unavailable
    failure = cause
  }
  if (kill) {
    await execute(engine, config, {
      argv: ["container", "kill", owned.id],
      timeoutMs: config.limits.cleanupTimeoutMs,
    }).catch(() => undefined)
  }
  const removed = await execute(engine, config, {
    argv: ["container", "rm", "--force", owned.id],
    timeoutMs: config.limits.cleanupTimeoutMs,
  }).catch(() => undefined)
  if (removed?.exit !== 0) throw unavailable("Verified Docker container cleanup failed")
  if (failure !== undefined) throw failure
  if (settled === undefined) throw unavailable("Workflow Docker command did not settle")
  return settled
}

async function inspect(
  engine: Docker.Engine,
  config: Config,
  id: string,
  ownership: ReturnType<typeof ownershipFor>,
  strict = false,
): Promise<OwnedContainer | undefined> {
  const result = await execute(engine, config, {
    argv: ["container", "inspect", id],
    timeoutMs: config.limits.engineTimeoutMs,
  })
  if (result.exit !== 0 || result.truncated) {
    if (strict) throw new Docker.Unavailable("Docker inspection failed")
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch (cause) {
    if (strict) throw new Docker.Unavailable("Docker inspection was malformed", { cause })
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] === null || typeof parsed[0] !== "object")
    return undefined
  const candidate = parsed[0]
  const candidateID = Reflect.get(candidate, "Id")
  const name = Reflect.get(candidate, "Name")
  const dockerConfig = Reflect.get(candidate, "Config")
  if (typeof candidateID !== "string" || candidateID !== id || name !== `/${ownership.name}`) return undefined
  if (dockerConfig === null || typeof dockerConfig !== "object") return undefined
  const labels = Reflect.get(dockerConfig, "Labels")
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) return undefined
  if (
    Object.keys(ownership.labels).length !== Object.keys(labels).length ||
    Object.entries(ownership.labels).some(([key, value]) => Reflect.get(labels, key) !== value)
  ) {
    return undefined
  }
  const state = Reflect.get(candidate, "State")
  const running = state !== null && typeof state === "object" ? Reflect.get(state, "Running") : undefined
  const exitCode = state !== null && typeof state === "object" ? Reflect.get(state, "ExitCode") : undefined
  return {
    id,
    name: ownership.name,
    labels: ownership.labels,
    ...(typeof running === "boolean" ? { running } : {}),
    ...(Number.isSafeInteger(exitCode) && exitCode >= 0 ? { exitCode } : {}),
  }
}

async function execute(
  engine: Docker.Engine,
  config: Config,
  input: {
    readonly argv: readonly string[]
    readonly stdin?: string
    readonly timeoutMs: number
    readonly maxOutputBytes?: number
    readonly signal?: AbortSignal
  },
) {
  return engine.execute({
    executable: config.enginePath,
    argv: input.argv,
    env: DockerConfig.invocationEnvironment(config),
    ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes ?? config.limits.maxOutputBytes,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
}

async function validatedConfig(config: Config): Promise<Config> {
  return DockerConfig.validate(config)
}

async function validatePaths(workspace: string, workdir: string) {
  if (!relativePath(workdir)) throw new TypeError("Workflow workdir must be relative")
  const canonicalWorkspace = await canonicalDDirectory(workspace)
  await rejectLinks(canonicalWorkspace)
  const target = path.resolve(canonicalWorkspace, ...workdir.replaceAll("\\", "/").split("/"))
  const canonicalWorkdir = await identity(target)
  if (!contains(canonicalWorkspace, canonicalWorkdir.canonical) || !samePath(target, canonicalWorkdir.canonical)) {
    throw new TypeError("Workflow workdir escapes the workspace")
  }
  const workspaceIdentity = await identity(canonicalWorkspace)
  return {
    workspace: workspaceIdentity,
    workdir: canonicalWorkdir,
    relativeWorkdir:
      workdir === "." ? "." : path.relative(canonicalWorkspace, canonicalWorkdir.canonical).replaceAll("\\", "/"),
  }
}

async function canonicalDDirectory(value: string): Promise<string> {
  if (!path.win32.isAbsolute(value) || !/^D:\\/i.test(value) || unsafeWindowsPath(value)) {
    throw new TypeError("Sandbox host roots must be canonical D-drive paths")
  }
  const canonical = await fs.realpath(value)
  if (!samePath(path.resolve(value), canonical) || !/^D:\\/i.test(canonical)) {
    throw new TypeError("Sandbox host root changed identity or spelling")
  }
  if (!(await fs.stat(canonical)).isDirectory()) throw new TypeError("Sandbox host root must be a directory")
  return canonical
}

async function identity(value: string): Promise<PathIdentity> {
  const canonical = await fs.realpath(value)
  if (!samePath(path.resolve(value), canonical)) throw new TypeError("Sandbox path is a link or case alias")
  const stat = await fs.lstat(canonical)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("Sandbox path is not a real directory")
  return { canonical, device: stat.dev, inode: stat.ino }
}

async function rejectLinks(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name)
      const stat = await fs.lstat(target)
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new TypeError("Workspace links are forbidden")
      if (entry.isDirectory()) await rejectLinks(target)
    }),
  )
}

function sameIdentity(left: PathIdentity, right: PathIdentity) {
  return left.device === right.device && left.inode === right.inode && samePath(left.canonical, right.canonical)
}

function pendingCheckpointCall(
  checkpoint: Readonly<Record<string, unknown>> | undefined,
  request: WorkflowCommandSandbox.Request,
) {
  if (checkpoint?.kind !== "workflow.model.continuation" || checkpoint.version !== 1) return false
  const activeTurn = checkpoint.activeTurn
  if (activeTurn === null || typeof activeTurn !== "object" || Array.isArray(activeTurn)) return false
  const pendingCallID = Reflect.get(activeTurn, "pendingCallID")
  const calls = Reflect.get(activeTurn, "calls")
  const results = Reflect.get(activeTurn, "results")
  if (pendingCallID !== request.toolCallID || !Array.isArray(calls) || !Array.isArray(results)) return false
  if (
    calls.length === 0 ||
    results.length >= calls.length ||
    calls.filter((call) => call !== null && typeof call === "object" && Reflect.get(call, "id") === request.toolCallID)
      .length !== 1 ||
    results.some((result, index) => {
      const call = calls[index]
      return (
        result === null ||
        typeof result !== "object" ||
        call === null ||
        typeof call !== "object" ||
        Reflect.get(result, "id") !== Reflect.get(call, "id") ||
        Reflect.get(result, "name") !== Reflect.get(call, "name")
      )
    })
  )
    return false
  if (
    results.some(
      (result) => result !== null && typeof result === "object" && Reflect.get(result, "id") === request.toolCallID,
    )
  )
    return false
  const pending = calls[results.length]
  return (
    pending !== null &&
    typeof pending === "object" &&
    Reflect.get(pending, "id") === request.toolCallID &&
    Reflect.get(pending, "name") === "bash" &&
    sameCallInput(Reflect.get(pending, "input"), request)
  )
}

function workflowMessageID(stageID: string, toolCallID: string) {
  const digest = createHash("sha256").update(toolCallID).digest("hex").slice(0, 16)
  return `msg_workflow_${stageID.slice(4)}_${digest}`
}

function sameCallInput(input: unknown, request: WorkflowCommandSandbox.Request) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const expected = {
    command: request.command,
    ...(request.workdir === undefined ? {} : { workdir: request.workdir }),
    ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
  }
  const keys = Object.keys(input)
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => Object.hasOwn(expected, key) && Reflect.get(input, key) === Reflect.get(expected, key))
  )
}

function ownershipFor(input: RecoveryAuthority) {
  const label = (scope: string, value: string) => createHash("sha256").update(`${scope}\0${value}`).digest("hex")
  const labels = Object.freeze({
    [`${labelDomain}.workflow`]: label("workflow", input.workflowID),
    [`${labelDomain}.stage`]: label("stage", input.stageID),
    [`${labelDomain}.call`]: label("call", input.toolCallID),
    [`${labelDomain}.role`]: label("role", input.role),
    [`${labelDomain}.policy`]: label("policy", input.policyDigest),
    [`${labelDomain}.session`]: label("session", input.sessionID),
    [`${labelDomain}.agent`]: label("agent", input.agent),
    [`${labelDomain}.lease`]: label("lease", `${input.leaseOwner}\0${input.attempt}`),
  })
  return {
    name: `ocw-${label("container", Object.values(labels).join("\0")).slice(0, 48)}`,
    labels,
  }
}

function relativePath(value: string) {
  if (value === ".") return true
  if (value.length === 0 || value.includes("\0") || path.win32.isAbsolute(value) || unsafeWindowsPath(value))
    return false
  const parts = value.replaceAll("\\", "/").split("/")
  return !parts.some((part) => part === "" || part === ".." || (part === "." && parts.length > 1))
}

function unsafeWindowsPath(value: string) {
  if (value.includes(",") || value.includes("=") || /[\u0000-\u001f\u007f]/.test(value)) return true
  return value
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

function sameLocation(
  expected: { readonly directory: string; readonly workspaceID?: string },
  actual: { readonly directory: string; readonly workspaceID?: string },
) {
  return expected.directory === actual.directory && expected.workspaceID === actual.workspaceID
}

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right)
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function rejected(message: string) {
  return new WorkflowCommandSandbox.Rejected({ message })
}

function unavailable(message: string) {
  return new WorkflowCommandSandbox.Unavailable({ message })
}
