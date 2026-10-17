import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { freeze, safePath } from "../corpus/evaluation-profile"
import {
  requireDPath,
  productionLimits,
  type EngineSession,
  type DockerRunner,
  type AuthorityGuard,
  type DockerInvocation,
} from "./contracts"
import { requireOperation, isRealDockerRunner, requireDockerExecution } from "./docker"
import { sessionState, revalidateSession } from "./preflight"
import { directoryIdentity } from "./storage"

export type OwnerSeed = Readonly<{
  acceptanceID: string
  runID: string
  attemptID: string
  leaseGeneration: number
  operationID: string
  nonce: string
  daemonFingerprint: string
}>
export type Owner = OwnerSeed & Readonly<{ containerID: string }>
export type ContainerSpec = Readonly<{
  image: string
  argv: readonly string[]
  workspace?: Readonly<{ source: string; readonly: boolean }>
  dependencies?: readonly Readonly<{ name: string; target: string }>[]
  interactive?: boolean
  preparingDependencies?: true
}>
const Text = Schema.NonEmptyString
const Inspection = Schema.Struct({
  Id: Text,
  Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String), User: Text, Image: Text }),
  HostConfig: Schema.Struct({
    NetworkMode: Text,
    ReadonlyRootfs: Schema.Boolean,
    Privileged: Schema.Boolean,
    CapDrop: Schema.Array(Text),
    SecurityOpt: Schema.Array(Text),
    PidsLimit: Schema.Int,
    Memory: Schema.Int,
    NanoCpus: Schema.Int,
    Tmpfs: Schema.Record(Schema.String, Schema.String),
    CapAdd: Schema.optionalKey(Schema.NullOr(Schema.Array(Text))),
    Devices: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
    PortBindings: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  }),
  Mounts: Schema.Array(
    Schema.Struct({ Type: Text, Source: Text, Destination: Text, RW: Schema.Boolean, Name: Schema.optionalKey(Text) }),
  ),
  State: Schema.Struct({ Running: Schema.Boolean }),
})
export type ContainerInspection = typeof Inspection.Type
const inspections = new WeakMap<object, { session: EngineSession; runner: DockerRunner; owner: string }>()
export function requireOwnedInspection(value: object, session: EngineSession, runner: DockerRunner, owner: Owner) {
  const bound = inspections.get(value)
  if (!bound || bound.session !== session || bound.runner !== runner || bound.owner !== canonicalJson(owner))
    throw new TypeError("TASK24_LINUX_INSPECT_AUTHORITY")
}
export function ownerLabels(owner: OwnerSeed) {
  if (
    !Number.isSafeInteger(owner.leaseGeneration) ||
    owner.leaseGeneration <= 0 ||
    !/^[a-f0-9]{32}$/.test(owner.nonce) ||
    !/^[a-f0-9]{64}$/.test(owner.daemonFingerprint) ||
    [owner.acceptanceID, owner.runID, owner.attemptID, owner.operationID].some(
      (v) => !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(v),
    )
  )
    throw new TypeError("TASK24_LINUX_OWNER")
  return Object.fromEntries(
    Object.entries(owner)
      .filter(([k]) => k !== "containerID")
      .map(([k, v]) => [`opencode.task24.${k}`, String(v)]),
  )
}
export function decodeOwnedInspection(input: unknown, owner: Owner, session: EngineSession): ContainerInspection {
  const value = Schema.decodeUnknownSync(Inspection)(input)
  const state = sessionState(session)
  const labels = ownerLabels(owner)
  if (
    !/^[a-f0-9]{64}$/.test(owner.containerID) ||
    value.Id !== owner.containerID ||
    owner.acceptanceID !== session.acceptanceID ||
    owner.daemonFingerprint !== state.inventory.contextFingerprint ||
    Object.entries(labels).some(([k, v]) => value.Config.Labels[k] !== v)
  )
    throw new TypeError("TASK24_LINUX_OWNER_MISMATCH")
  const config = value.HostConfig
  if (
    value.Config.User !== "65532:65532" ||
    !state.manifest.artifacts.some((a) => a.kind === "image" && a.image === value.Config.Image) ||
    config.NetworkMode !== "none" ||
    !config.ReadonlyRootfs ||
    config.Privileged ||
    canonicalJson(config.CapDrop) !== canonicalJson(["ALL"]) ||
    !config.SecurityOpt.includes("no-new-privileges=true") ||
    config.PidsLimit !== 64 ||
    config.Memory !== 1073741824 ||
    config.NanoCpus !== 1500000000 ||
    (config.CapAdd?.length ?? 0) ||
    (config.Devices?.length ?? 0) ||
    Object.keys(config.PortBindings ?? {}).length
  )
    throw new TypeError("TASK24_LINUX_CONTAINER_POLICY")
  for (const [target, size] of [
    ["/tmp", "67108864"],
    ["/home/sandbox", "16777216"],
  ] as const) {
    const flags = (config.Tmpfs[target] ?? "").split(",")
    if (!["rw", "nosuid", "nodev", "noexec", `size=${size}`].every((f) => flags.includes(f)))
      throw new TypeError("TASK24_LINUX_TMPFS_POLICY")
  }
  if (Object.keys(config.Tmpfs).length !== 2) throw new TypeError("TASK24_LINUX_TMPFS_POLICY")
  for (const mount of value.Mounts) {
    if (mount.Type === "bind") {
      requireDPath(mount.Source)
      if (
        mount.Destination !== "/workspace" ||
        !mount.Source.toLowerCase().startsWith(state.manifest.roots.work.toLowerCase() + "\\")
      )
        throw new TypeError("TASK24_LINUX_MOUNT_POLICY")
    } else if (
      mount.Type !== "volume" ||
      mount.RW ||
      !/^task24-dep-[a-f0-9]{64}$/.test(mount.Name ?? "") ||
      !mount.Destination.startsWith("/workspace/")
    )
      throw new TypeError("TASK24_LINUX_MOUNT_POLICY")
  }
  return freeze(value)
}
function invocation(argv: readonly string[], signal: AbortSignal, timeoutMs = 15000): DockerInvocation {
  return { argv, timeoutMs, maxStdoutBytes: 1048576, maxStderrBytes: 65536, signal }
}
export async function inspectOwnedContainer(input: {
  session: EngineSession
  runner: DockerRunner
  owner: Owner
  signal: AbortSignal
}) {
  await revalidateSession(input.session)
  const argv = ["container", "inspect", input.owner.containerID]
  const result = await input.runner.execute(invocation(argv, input.signal))
  if (isRealDockerRunner(input.runner)) requireDockerExecution(input.runner, result, argv)
  if (!result.started || result.exitCode !== 0 || result.truncated)
    throw new TypeError("TASK24_LINUX_INSPECT_UNAVAILABLE")
  const parsed: unknown = JSON.parse(Buffer.from(result.stdout).toString("utf8"))
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new TypeError("TASK24_LINUX_INSPECT_INVALID")
  const inspection = decodeOwnedInspection(parsed[0], input.owner, input.session)
  inspections.set(inspection, { session: input.session, runner: input.runner, owner: canonicalJson(input.owner) })
  return inspection
}
export async function createOwnedContainer(input: {
  session: EngineSession
  runner: DockerRunner
  owner: OwnerSeed
  spec: ContainerSpec
  guard: AuthorityGuard
  signal: AbortSignal
  start?: false
}): Promise<Owner> {
  const state = await requireOperation(input.session, "container-create", input.guard),
    labels = ownerLabels(input.owner),
    spec = input.spec
  if (
    (spec.preparingDependencies
      ? !(
          state.manifest.phase === "prepare" &&
          state.approval.allowedOperations.includes("volume-prepare") &&
          !spec.workspace &&
          canonicalJson(spec.argv) === canonicalJson(["/usr/local/bin/node", "-e", "setInterval(()=>{},1000)"])
        )
      : state.manifest.phase !== "accept") ||
    !state.manifest.artifacts.some((a) => a.kind === "image" && a.image === spec.image) ||
    !spec.argv.length ||
    spec.argv.some((v) => v.includes("\0"))
  )
    throw new TypeError("TASK24_LINUX_CONTAINER_SPEC")
  const mounts: string[] = []
  if (spec.workspace) {
    const source = requireDPath(spec.workspace.source)
    await directoryIdentity(source)
    if (!source.toLowerCase().startsWith(state.manifest.roots.work.toLowerCase() + "\\") || source.includes(","))
      throw new TypeError("TASK24_LINUX_WORKSPACE")
    mounts.push("--mount", `type=bind,src=${source},dst=/workspace${spec.workspace.readonly ? ",readonly" : ""}`)
  }
  for (const mount of spec.dependencies ?? []) {
    if (
      !/^task24-dep-[a-f0-9]{64}$/.test(mount.name) ||
      !mount.target.startsWith("/workspace/") ||
      mount.target.includes(",")
    )
      throw new TypeError("TASK24_LINUX_DEPENDENCY_MOUNT")
    safePath(mount.target.slice(1))
    mounts.push(
      "--mount",
      `type=volume,src=${mount.name},dst=${mount.target},readonly${spec.preparingDependencies ? "" : ",volume-nocopy"}`,
    )
  }
  const argv = [
    "container",
    "create",
    ...(spec.interactive ? ["--interactive"] : []),
    "--name",
    `task24-${sha256Text(canonicalJson(input.owner)).slice(0, 32)}`,
    ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
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
    "--log-driver",
    "none",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777",
    "--tmpfs",
    "/home/sandbox:rw,nosuid,nodev,noexec,size=16777216,mode=700,uid=65532,gid=65532",
    "--env",
    "HOME=/home/sandbox",
    "--env",
    "LANG=C.UTF-8",
    "--entrypoint",
    spec.argv[0]!,
    ...mounts,
    spec.image,
    ...spec.argv.slice(1),
  ]
  const result = await input.runner.execute(invocation(argv, input.signal)).catch(() => null)
  const containerID = result ? Buffer.from(result.stdout).toString("utf8").trim() : ""
  if (!result || !result.started || result.exitCode !== 0 || result.truncated || !/^[a-f0-9]{64}$/.test(containerID)) {
    // A failed response is not evidence that create had no side effect. Never create twice.
    try {
      await input.guard()
      await revalidateSession(input.session)
      const discovered = await input.runner.execute(
        invocation(
          [
            "container",
            "ls",
            "--all",
            "--no-trunc",
            "--filter",
            `label=opencode.task24.nonce=${input.owner.nonce}`,
            "--filter",
            `label=opencode.task24.acceptanceID=${input.owner.acceptanceID}`,
            "--format",
            "{{.ID}}",
          ],
          new AbortController().signal,
        ),
      )
      const ids = Buffer.from(discovered.stdout).toString("utf8").trim().split(/\s+/).filter(Boolean)
      if (
        discovered.started &&
        discovered.exitCode === 0 &&
        !discovered.truncated &&
        ids.length === 1 &&
        /^[a-f0-9]{64}$/.test(ids[0]!)
      )
        await cleanupOwnedContainer({
          ...input,
          owner: freeze({ ...input.owner, containerID: ids[0]! }),
          signal: new AbortController().signal,
        })
    } catch {
      /* Preserve uncertain disposition; never broaden discovery or ownership. */
    }
    throw new TypeError("TASK24_LINUX_CREATE_UNCERTAIN")
  }
  const owner = freeze({ ...input.owner, containerID })
  try {
    await inspectOwnedContainer({ ...input, owner })
    if (input.start === false) return owner
    await requireOperation(input.session, "container-start", input.guard)
    const started = await input.runner.execute(invocation(["container", "start", containerID], input.signal))
    if (!started.started || started.exitCode !== 0 || started.truncated)
      throw new TypeError("TASK24_LINUX_START_FAILED")
    await inspectOwnedContainer({ ...input, owner })
    return owner
  } catch (error) {
    await cleanupOwnedContainer({ ...input, owner })
    throw error
  }
}
export async function cleanupOwnedContainer(input: {
  session: EngineSession
  runner: DockerRunner
  owner: Owner
  guard: AuthorityGuard
  signal?: AbortSignal
}): Promise<{ ended: boolean; removed: boolean }> {
  const signal = input.signal?.aborted ? new AbortController().signal : (input.signal ?? new AbortController().signal)
  try {
    await input.guard()
    const inspected = await inspectOwnedContainer({ ...input, signal })
    if (inspected.State.Running) {
      await requireOperation(input.session, "container-stop", input.guard)
      const stopped = await input.runner.execute(
        invocation(
          ["container", "stop", "--time", "3", input.owner.containerID],
          signal,
          productionLimits.cleanupTimeoutMs,
        ),
      )
      if (!stopped.started || stopped.exitCode !== 0 || stopped.truncated) return { ended: false, removed: false }
    }
    const after = await inspectOwnedContainer({ ...input, signal })
    if (after.State.Running) return { ended: false, removed: false }
    await requireOperation(input.session, "container-remove", input.guard)
    const removed = await input.runner.execute(
      invocation(["container", "rm", input.owner.containerID], signal, productionLimits.cleanupTimeoutMs),
    )
    return { ended: true, removed: removed.started && removed.exitCode === 0 && !removed.truncated }
  } catch {
    return { ended: false, removed: false }
  }
}
