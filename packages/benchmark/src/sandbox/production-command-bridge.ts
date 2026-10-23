import path from "node:path"
import fs from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { freeze, safePath } from "../corpus/evaluation-profile"
import { sha256Bytes } from "../hash"
import type { AuthorityGuard, DockerRunner, EngineSession } from "./contracts"
import {
  requireOperation,
  requireDockerExecution,
  isRealDockerRunner,
  requireRealDockerRunner,
  makeProductionCommandDockerRunner,
} from "./docker"
import { sessionState, revalidateSession } from "./preflight"
import { directoryIdentity, fileIdentity } from "./storage"
import { mapWsl2Workspace } from "./wsl2-independent"
import { ordinaryFiles } from "../corpus/evaluation-bundle"
import type { ProductionCapture } from "./production-command-http"

/** Controller-frozen public commands, never a request supplied by the agent. */
export type ProductionCommand = Readonly<{
  image: string
  /** Logical same-digest name accepted by the unchanged production config. */
  publicImage?: string
  argv: readonly string[]
  workdir: string
  workspace?: Readonly<{ source: string; readonly: boolean }>
  interactive?: true
  stdin?: Uint8Array
  archiveSha256?: string
  /** Exact production Archive; controller-only, never sent as model tool arguments. */
  sealedArchive?: unknown
}>
export type ProductionInvocation = Readonly<{
  argv: readonly string[]
  stdin?: string | Uint8Array
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
}>
type Result = Readonly<{ exit: number; stdout: string; stderr: string; truncated: boolean }>
type FrozenCommand = Omit<ProductionCommand, "stdin"> & {
  readonly stdin?: string
  readonly sealedWorkspace?: Readonly<{ source: string; readonly: true }>
}
type Owned = {
  id: string
  name: string
  labels: Readonly<Record<string, string>>
  commands: readonly FrozenCommand[]
  imported: boolean
  started: boolean
}
type OwnershipEvent = Readonly<{
  kind: "intent" | "created" | "removed" | "uncertain"
  name: string
  labels: Readonly<Record<string, string>>
  id?: string
}>
const labelNames = ["workflow", "stage", "call", "role", "policy", "session", "agent", "lease"].map(
  (key) => "io.opencode.workflow." + key,
)

/**
 * A finite Docker.Engine-compatible adapter for the ORIGINAL production command
 * launcher. It is not a generic Docker proxy and cannot mint engine receipts.
 * Its HTTP/CLI admission layer additionally requires a real runner.
 */
export async function makeProductionCommandEngine(input: {
  session: EngineSession
  runner: DockerRunner
  guard: AuthorityGuard
  commands: readonly ProductionCommand[]
  record?: (event: OwnershipEvent) => Promise<void>
}) {
  const state = sessionState(input.session)
  if (!state.manifest.wsl2 || state.manifest.phase !== "accept" || !input.commands.length || input.commands.length > 32)
    throw new TypeError("TASK24_PRODUCTION_COMMAND_PLAN")
  // Copy binary input too: Object.freeze cannot make typed-array elements immutable.
  const staged = new Map<
    string,
    { identity: string; files: readonly { path: string; sha256: string; size: number }[] }
  >()
  const requested = input.commands.map((value) => ({
    ...value,
    argv: [...value.argv],
    ...(value.stdin ? { stdin: Buffer.from(value.stdin) } : {}),
    ...(value.workspace ? { workspace: { ...value.workspace } } : {}),
    ...(value.sealedArchive === undefined ? {} : { sealedArchive: structuredClone(value.sealedArchive) }),
  }))
  const commands: FrozenCommand[] = []
  const workspaces = new Map<string, string>()
  try {
    // Validate every sibling before creating any stage. Staging is deliberately
    // sequential, so a rejected initialization cannot leave late writers behind.
    for (const value of requested) {
      if (
        value.publicImage &&
        (!/^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(value.publicImage) ||
          value.publicImage.slice(value.publicImage.indexOf("@")) !== value.image.slice(value.image.indexOf("@")))
      )
        throw new TypeError("TASK24_PRODUCTION_COMMAND_IMAGE")
      if (
        !state.manifest.artifacts.some((a) => a.kind === "image" && a.image === value.image) ||
        !value.argv.length ||
        value.argv.some((arg) => !arg || arg.includes("\0")) ||
        !/^\/(?:workspace(?:\/[a-zA-Z0-9._-]+)*|)$/.test(value.workdir) ||
        value.workdir.split("/").some((part) => part === "." || part === "..") ||
        (value.stdin?.byteLength ?? 0) > 8388608 ||
        (value.archiveSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(value.archiveSha256) || value.workspace)) ||
        (value.sealedArchive !== undefined && !value.archiveSha256)
      )
        throw new TypeError("TASK24_PRODUCTION_COMMAND_PLAN")
    }
    for (const value of requested) {
      const sealedWorkspace = value.archiveSha256 ? await stageArchive(value) : undefined
      commands.push(
        freeze({
          ...value,
          argv: [...value.argv],
          ...(value.workspace ? { workspace: { ...value.workspace } } : {}),
          stdin: value.stdin ? Buffer.from(value.stdin).toString("base64") : undefined,
          sealedArchive: undefined,
          ...(sealedWorkspace ? { sealedWorkspace } : {}),
        }),
      )
    }
    for (const command of commands)
      if (command.workspace ?? command.sealedWorkspace) {
        const source = (command.workspace ?? command.sealedWorkspace)!.source
        await workspaceGuard(source)
        workspaces.set(source, await directoryIdentity(source))
      }
  } catch (cause) {
    const residualArtifacts: { path: string; identity: string }[] = []
    for (const [source, snapshot] of staged) {
      try {
        await removeStage(source, snapshot)
      } catch {
        residualArtifacts.push({ path: source, identity: snapshot.identity })
      }
    }
    if (residualArtifacts.length)
      throw Object.assign(new Error("TASK24_PRODUCTION_INITIALIZATION_RESIDUAL", { cause }), { residualArtifacts })
    throw cause
  }
  const owned = new Map<string, Owned>()
  const names = new Map<string, string>()
  const uncertain = new Set<string>()
  let total = 0
  let queued = 0
  let tail = Promise.resolve()

  async function stageArchive(command: ProductionCommand) {
    // Reuse the producer's exact validator and deterministic ustar serializer;
    // never interpret untrusted tar paths with another extraction algorithm.
    // This fixed lazy URL keeps Core checked under its OWN package tsconfig;
    // benchmark's stricter indexed-access setting must not silently recheck all
    // of Core/SQL/LLM under different flags. No caller-controlled module path.
    const url = new URL("../../../core/src/workflow/workspace-materialization.ts", import.meta.url)
    const moduleIdentity = await fileIdentity(fileURLToPath(url))
    const loaded: unknown = await import(url.href)
    if (!loaded || typeof loaded !== "object") throw new TypeError("TASK24_PRODUCTION_ARCHIVE_MODULE")
    const api = Reflect.get(loaded, "WorkflowWorkspaceMaterialization") as unknown
    if (
      !api ||
      typeof api !== "object" ||
      typeof Reflect.get(api, "validateArchive") !== "function" ||
      typeof Reflect.get(api, "tarBytes") !== "function"
    )
      throw new TypeError("TASK24_PRODUCTION_ARCHIVE_MODULE")
    const materialization = api as { validateArchive(value: unknown): unknown; tarBytes(value: unknown): unknown }
    const archive = Schema.decodeUnknownSync(
      Schema.Struct({
        entries: Schema.Array(
          Schema.Struct({
            path: Schema.String,
            type: Schema.Literals(["file", "executable"]),
            contentBase64: Schema.String,
            size: Schema.Int,
            sha256: Schema.String,
          }),
        ),
        schemaVersion: Schema.Literal(1),
        archiveSha256: Schema.String,
        workspaceSha256: Schema.String,
      }),
    )(materialization.validateArchive(command.sealedArchive), { onExcessProperty: "error" })
    const tar = materialization.tarBytes(archive)
    if (
      !(tar instanceof Uint8Array) ||
      canonicalJson(await fileIdentity(moduleIdentity.path)) !== canonicalJson(moduleIdentity)
    )
      throw new TypeError("TASK24_PRODUCTION_ARCHIVE_MODULE")
    if (tar.length > 8388608 || sha256Bytes(tar) !== command.archiveSha256)
      throw new TypeError("TASK24_PRODUCTION_COMMAND_ARCHIVE")
    for (const entry of archive.entries) safePath(entry.path)
    const source = await fs.mkdtemp(path.join(state.manifest.roots.work, "production-sealed-"))
    const snapshot = {
      identity: "unverified",
      files: [] as { path: string; size: number; sha256: string }[],
    }
    staged.set(source, snapshot)
    snapshot.identity = await directoryIdentity(source)
    for (const entry of archive.entries) {
      const file = path.join(source, entry.path)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, Buffer.from(entry.contentBase64, "base64"), {
        flag: "wx",
        mode: entry.type === "executable" ? 0o755 : 0o644,
      })
      snapshot.files.push({ path: entry.path, size: entry.size, sha256: entry.sha256 })
    }
    return { source, readonly: true as const }
  }

  async function workspaceGuard(source: string) {
    if (!source.startsWith(state.manifest.roots.work + path.sep) || source.includes(","))
      throw new TypeError("TASK24_PRODUCTION_COMMAND_WORKSPACE")
    const identity = await directoryIdentity(source)
    if (workspaces.has(source) && workspaces.get(source) !== identity)
      throw new TypeError("TASK24_PRODUCTION_COMMAND_WORKSPACE_CHANGED")
    const snapshot = staged.get(source)
    const ordered = (files: readonly { path: string; size: number; sha256: string }[]) =>
      [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    if (
      snapshot &&
      (snapshot.identity !== identity ||
        canonicalJson(ordered(await ordinaryFiles(source))) !== canonicalJson(ordered(snapshot.files)))
    )
      throw new TypeError("TASK24_PRODUCTION_COMMAND_ARCHIVE_CHANGED")
  }
  async function removeStage(source: string, snapshot: { identity: string }) {
    if (
      !source.startsWith(state.manifest.roots.work + path.sep) ||
      (await directoryIdentity(source)) !== snapshot.identity
    )
      throw new TypeError("TASK24_PRODUCTION_COMMAND_WORKSPACE_CHANGED")
    await workspaceGuard(source)
    await fs.rm(source, { recursive: true })
    staged.delete(source)
  }
  async function call(argv: readonly string[], invocation: ProductionInvocation) {
    await input.guard()
    // A real runner revalidates its exact host on every call. Fixture transport
    // has no such authority and must use the original full session check.
    if (!isRealDockerRunner(input.runner)) await revalidateSession(input.session)
    const result = await input.runner.execute({
      argv: ["--context", "default", ...argv],
      ...(invocation.stdin === undefined
        ? {}
        : { stdin: typeof invocation.stdin === "string" ? Buffer.from(invocation.stdin) : invocation.stdin }),
      timeoutMs: invocation.timeoutMs,
      maxStdoutBytes: invocation.maxOutputBytes,
      maxStderrBytes: invocation.maxOutputBytes,
      signal: invocation.signal ?? new AbortController().signal,
    })
    if (isRealDockerRunner(input.runner))
      requireDockerExecution(input.runner, result, ["--context", "default", ...argv])
    await input.guard()
    if (!result.started || result.cleanupUncertain) throw new TypeError("TASK24_PRODUCTION_COMMAND_UNSETTLED")
    const stdout = result.stdout.subarray(0, invocation.maxOutputBytes)
    const stderr = result.stderr.subarray(0, Math.max(0, invocation.maxOutputBytes - stdout.length))
    return {
      exit: result.exitCode,
      stdout: Buffer.from(stdout).toString("utf8"),
      stderr: Buffer.from(stderr).toString("utf8"),
      truncated: result.truncated || stdout.length + stderr.length !== result.stdout.length + result.stderr.length,
    }
  }
  async function admit(operation: Parameters<typeof requireOperation>[1]) {
    if (!isRealDockerRunner(input.runner)) return requireOperation(input.session, operation, input.guard)
    await input.guard()
    if (!sessionState(input.session).approval.allowedOperations.includes(operation))
      throw new TypeError("TASK24_LINUX_OPERATION_DENIED")
  }
  async function inspect(record: Owned, invocation: ProductionInvocation) {
    const result = await call(["container", "inspect", record.id], {
      ...invocation,
      stdin: undefined,
      timeoutMs: Math.min(invocation.timeoutMs, 15000),
    })
    if (result.exit !== 0 || result.truncated) throw new TypeError("TASK24_PRODUCTION_COMMAND_INSPECTION")
    const all = JSON.parse(result.stdout)
    if (!Array.isArray(all) || all.length !== 1) throw new TypeError("TASK24_PRODUCTION_COMMAND_INSPECTION")
    const item = all[0]
    const policy = item?.HostConfig
    const command = record.commands[0]!
    const mount = command.workspace ?? command.sealedWorkspace
    if (mount) await workspaceGuard(mount.source)
    if (
      item.Id !== record.id ||
      item.Name !== "/" + record.name ||
      canonicalJson(item.Config?.Labels) !== canonicalJson(record.labels) ||
      item.Config?.Image !== command.image ||
      item.Config?.User !== "65532:65532" ||
      policy?.NetworkMode !== "none" ||
      policy.ReadonlyRootfs !== true ||
      policy.Privileged !== false ||
      canonicalJson(policy.CapDrop) !== canonicalJson(["ALL"]) ||
      (policy.CapAdd?.length ?? 0) !== 0 ||
      canonicalJson(policy.SecurityOpt) !== canonicalJson(["no-new-privileges=true"]) ||
      policy.PidsLimit !== 64 ||
      policy.Memory !== 1073741824 ||
      policy.NanoCpus !== 1500000000 ||
      (policy.Devices?.length ?? 0) !== 0 ||
      Object.keys(policy.PortBindings ?? {}).length !== 0 ||
      canonicalJson(policy.Tmpfs) !==
        canonicalJson({
          "/tmp": "rw,nosuid,nodev,noexec,size=67108864,mode=1777",
          "/home/sandbox": "rw,nosuid,nodev,noexec,size=16777216,mode=700,uid=65532,gid=65532",
        }) ||
      !Array.isArray(item.Mounts) ||
      item.Mounts.length !== (mount ? 1 : 0) ||
      (mount &&
        !item.Mounts.some(
          (m: { Type: string; Source: string; Destination: string; RW: boolean }) =>
            m.Type === "bind" &&
            m.Source === mapWsl2Workspace(state.manifest, mount.source) &&
            m.Destination === "/workspace" &&
            m.RW === !mount.readonly,
        )) ||
      typeof item.State?.Running !== "boolean"
    )
      throw new TypeError("TASK24_PRODUCTION_COMMAND_OWNERSHIP_OR_POLICY")
    return result
  }
  async function execute(invocation: ProductionInvocation): Promise<Result> {
    const args = invocation.argv
    const limit = args[1] === "start" ? 600000 : args[1] === "rm" || args[1] === "kill" ? 5000 : 15000
    if (
      invocation.signal?.aborted ||
      !Number.isSafeInteger(invocation.timeoutMs) ||
      invocation.timeoutMs < 1 ||
      invocation.timeoutMs > limit ||
      !Number.isSafeInteger(invocation.maxOutputBytes) ||
      invocation.maxOutputBytes < 1 ||
      invocation.maxOutputBytes > 1048576 ||
      args.some((arg) => arg.includes("\0"))
    )
      throw new TypeError("TASK24_PRODUCTION_COMMAND_LIMIT")
    if (args[0] !== "container") throw new TypeError("TASK24_PRODUCTION_COMMAND_DENIED")
    if (args[1] === "create") {
      if (invocation.stdin !== undefined || total >= 64) throw new TypeError("TASK24_PRODUCTION_COMMAND_DENIED")
      const offset = args[2] === "--interactive" ? 3 : 2
      const name = args[offset + 1]!
      if (args[offset] !== "--name" || !/^ocw-[a-f0-9]{48}$/.test(name) || names.has(name) || uncertain.has(name))
        throw new TypeError("TASK24_PRODUCTION_COMMAND_NAME")
      const labels: Record<string, string> = {}
      for (let i = 0; i < labelNames.length; i++) {
        const index = offset + 2 + i * 2
        const [key, value, extra] = (args[index + 1] ?? "").split("=")
        if (
          args[index] !== "--label" ||
          key !== labelNames[i] ||
          !/^[a-f0-9]{64}$/.test(value ?? "") ||
          extra !== undefined
        )
          throw new TypeError("TASK24_PRODUCTION_COMMAND_LABELS")
        labels[key!] = value!
      }
      const matches = commands.filter(
        (command) =>
          canonicalJson(args) ===
          canonicalJson([
            "container",
            "create",
            ...(command.interactive ? ["--interactive"] : []),
            "--name",
            name,
            ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
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
            "64",
            "--memory",
            "1073741824",
            "--cpus",
            "1.5",
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
            ...(command.workspace
              ? [
                  "--mount",
                  `type=bind,src=${command.workspace.source},dst=/workspace${command.workspace.readonly ? ",readonly" : ""}`,
                ]
              : []),
            "--workdir",
            command.workdir,
            command.publicImage ?? command.image,
            ...command.argv,
          ]),
      )
      if (!matches.length) throw new TypeError("TASK24_PRODUCTION_COMMAND_NOT_FROZEN")
      if (new Set(matches.map((command) => command.archiveSha256 ?? "")).size !== 1)
        throw new TypeError("TASK24_PRODUCTION_COMMAND_AMBIGUOUS")
      for (const match of matches)
        if (match.workspace ?? match.sealedWorkspace)
          await workspaceGuard((match.workspace ?? match.sealedWorkspace)!.source)
      await admit("container-create")
      const mapped = args.map((arg, index) =>
        index === args.length - matches[0]!.argv.length - 1
          ? matches[0]!.image
          : arg.startsWith("type=bind,src=")
            ? arg.replace(
                matches[0]!.workspace!.source,
                mapWsl2Workspace(state.manifest, matches[0]!.workspace!.source),
              )
            : arg,
      )
      if (matches[0]!.sealedWorkspace)
        mapped.splice(
          mapped.indexOf("--workdir"),
          0,
          "--mount",
          `type=bind,src=${mapWsl2Workspace(state.manifest, matches[0]!.sealedWorkspace.source)},dst=/workspace,readonly`,
        )
      total++
      await input.record?.({ kind: "intent", name, labels })
      const result = await call(mapped, invocation).catch(async (cause) => {
        uncertain.add(name)
        await input.record?.({ kind: "uncertain", name, labels })
        throw cause
      })
      if (result.exit !== 0) {
        uncertain.add(name)
        await input.record?.({ kind: "uncertain", name, labels })
        return result // Never adopt/discover/delete an existing same-name container.
      }
      const id = result.stdout.trim()
      if (result.truncated || !/^[a-f0-9]{64}$/.test(id) || owned.has(id)) {
        uncertain.add(name)
        await input.record?.({ kind: "uncertain", name, labels })
        throw new TypeError("TASK24_PRODUCTION_COMMAND_CREATE_UNCERTAIN")
      }
      const record = {
        id,
        name,
        labels: freeze(labels),
        commands: matches,
        imported: !matches.some((m) => m.archiveSha256),
        started: false,
      }
      owned.set(id, record)
      names.set(name, id)
      await input.record?.({ kind: "created", id, name, labels })
      await inspect(record, invocation)
      return result
    }
    const id =
      args[1] === "start"
        ? args[4]
        : args[1] === "rm"
          ? args[3]
          : args[1] === "cp"
            ? args[3]?.replace(/:\/$/, "")
            : args[2]
    const record = owned.get(names.get(id ?? "") ?? id ?? "")
    if (!record) throw new TypeError("TASK24_PRODUCTION_COMMAND_UNOWNED")
    const operation = args[1]
    const stdin = invocation.stdin === undefined ? undefined : Buffer.from(invocation.stdin).toString("base64")
    if (operation === "start") {
      if (
        canonicalJson(args) !== canonicalJson(["container", "start", "--attach", "--interactive", record.id]) ||
        record.started ||
        !record.imported ||
        !record.commands.some((m) => m.stdin === stdin)
      )
        throw new TypeError("TASK24_PRODUCTION_COMMAND_START")
      await admit("container-start")
    } else if (operation === "cp") {
      if (
        canonicalJson(args) !== canonicalJson(["container", "cp", "-", `${record.id}:/`]) ||
        record.started ||
        record.imported ||
        invocation.stdin === undefined ||
        Buffer.byteLength(invocation.stdin) > 8388608 ||
        !record.commands.some((m) => m.archiveSha256 === sha256Bytes(Buffer.from(invocation.stdin!)))
      )
        throw new TypeError("TASK24_PRODUCTION_COMMAND_ARCHIVE")
      await admit("container-exec")
    } else {
      if (
        invocation.stdin !== undefined ||
        !["inspect", "kill", "rm"].includes(operation ?? "") ||
        canonicalJson(args) !==
          canonicalJson(
            operation === "rm"
              ? ["container", "rm", "--force", record.id]
              : ["container", operation, operation === "inspect" ? id : record.id],
          )
      )
        throw new TypeError("TASK24_PRODUCTION_COMMAND_DENIED")
      await admit(operation === "rm" ? "container-remove" : operation === "kill" ? "container-stop" : "container-exec")
    }
    const verified = await inspect(record, invocation)
    if (operation === "inspect") return verified
    // Once dispatched, a start can have executed even when its response is
    // lost. Consume the attempt before dispatch; never replay unknown effects.
    if (operation === "start") record.started = true
    // Docker29 refuses cp into readonly rootfs. Bytes were independently validated
    // and staged BEFORE create, then mounted readonly; this is a byte-bound
    // acknowledgement, NOT a fabricated Docker execution or container identity.
    const result =
      operation === "cp" ? { exit: 0, stdout: "", stderr: "", truncated: false } : await call(args, invocation)
    if (operation === "cp" && result.exit === 0) record.imported = true
    if (operation === "rm" && result.exit === 0) {
      await input.record?.({ kind: "removed", id: record.id, name: record.name, labels: record.labels })
      owned.delete(record.id)
      names.delete(record.name)
    }
    return result
  }
  return Object.freeze({
    async execute(invocation: ProductionInvocation) {
      if (queued >= 16) throw new TypeError("TASK24_PRODUCTION_COMMAND_BUSY")
      // Snapshot caller-owned buffers/arrays before yielding to the serialized queue.
      const snapshot = {
        ...invocation,
        argv: [...invocation.argv],
        ...(invocation.stdin === undefined
          ? {}
          : { stdin: typeof invocation.stdin === "string" ? invocation.stdin : Buffer.from(invocation.stdin) }),
      }
      queued++
      const result = tail.then(() => execute(snapshot))
      tail = result.then(
        () => {},
        () => {},
      )
      try {
        return await result
      } finally {
        queued--
      }
    },
    outstanding() {
      return { containers: [...owned.keys()], uncertainNames: [...uncertain] }
    },
    async retire() {
      if (owned.size || uncertain.size) throw new TypeError("TASK24_PRODUCTION_COMMAND_CLEANUP_UNCERTAIN")
      try {
        for (const [source, snapshot] of staged) await removeStage(source, snapshot)
      } catch (cause) {
        throw Object.assign(new Error("TASK24_PRODUCTION_COMMAND_RETIRE_RESIDUAL", { cause }), {
          residualArtifacts: [...staged].map(([path, snapshot]) => ({ path, identity: snapshot.identity })),
        })
      }
    },
  })
}

export async function startProductionCommandBridge(
  input: Parameters<typeof makeProductionCommandEngine>[0],
  options: { capture?: ProductionCapture } = {},
) {
  requireRealDockerRunner(input.runner)
  const runner = await makeProductionCommandDockerRunner(input)
  const state = sessionState(input.session)
  const root = await fs.mkdtemp(path.join(state.manifest.roots.evidence, "production-command-"))
  const rootIdentity = await directoryIdentity(root).catch((cause: unknown) => {
    throw Object.assign(new Error("TASK24_PRODUCTION_INITIALIZATION_RESIDUAL", { cause }), {
      residualArtifacts: [{ path: root, identity: "unverified" }],
    })
  })
  const nonce = randomBytes(32).toString("hex")
  let sequence = 0
  const record = async (event: OwnershipEvent) => {
    if ((await directoryIdentity(root)) !== rootIdentity) throw new TypeError("TASK24_PRODUCTION_JOURNAL_CHANGED")
    const file = await fs.open(path.join(root, String(sequence++).padStart(4, "0") + ".json"), "wx")
    try {
      await file.writeFile(
        canonicalJson({
          schemaVersion: 2,
          manifestSha256: input.session.manifestSha256,
          daemonFingerprint: state.inventory.contextFingerprint,
          nonce,
          ...event,
        }),
      )
      await file.sync()
    } finally {
      await file.close()
    }
    await input.record?.(event)
  }
  try {
    const engine = await makeProductionCommandEngine({ ...input, runner, record })
    const { startProductionCommandEndpoint } = await import("./production-command-http")
    const bridge = await startProductionCommandEndpoint(engine, options)
    return Object.freeze({ ...bridge, journalRoot: root })
  } catch (cause) {
    try {
      if ((await directoryIdentity(root)) !== rootIdentity || (await fs.readdir(root)).length)
        throw new TypeError("TASK24_PRODUCTION_JOURNAL_CHANGED")
      await fs.rmdir(root)
    } catch {
      const inherited =
        cause instanceof Error && "residualArtifacts" in cause && Array.isArray(cause.residualArtifacts)
          ? cause.residualArtifacts
          : []
      throw Object.assign(new Error("TASK24_PRODUCTION_INITIALIZATION_RESIDUAL", { cause }), {
        residualArtifacts: [...inherited, { path: root, identity: rootIdentity }],
      })
    }
    throw cause
  }
}
