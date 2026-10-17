import { canonicalJson } from "../campaign/canonical"
import { freeze } from "../corpus/evaluation-profile"
import { sha256Text } from "../hash"
import {
  decodeHostRequest,
  decodeHostManifest,
  decodeEngineApproval,
  requestOf,
  type HostRequest,
  type HostManifest,
  type HostInventory,
  type DockerRunner,
  type EngineSession,
  type EngineApproval,
  type Gate,
} from "./contracts"
import { directoryIdentity, fileIdentity, inspectStorage, storageIdentity } from "./storage"

type Inspection = { request: HostRequest; runner: DockerRunner; storageProbe: () => Promise<unknown> }
const inventories = new WeakMap<object, Inspection>()
const sessions = new WeakMap<
  object,
  Readonly<{ manifest: HostManifest; approval: EngineApproval; inventory: HostInventory; inspection: Inspection }>
>()

export async function inspectLinuxHost(input: Inspection): Promise<HostInventory> {
  const request = decodeHostRequest(input.request),
    missing: string[] = []
  const cli = await fileIdentity(request.cli.path).catch(() => null)
  if (!cli || canonicalJson(cli) !== canonicalJson(request.cli)) missing.push("engine_cli_changed")
  const roots: Record<string, string> = {}
  for (const [key, root] of Object.entries(request.roots)) {
    const id = await directoryIdentity(root).catch(() => null)
    if (id) roots[key] = id
    else missing.push("engine_root_changed")
  }
  const storage = await inspectStorage(await input.storageProbe().catch(() => null))
  if (storage.kind !== "ready") missing.push(storage.code)
  async function read(context: string, args: readonly string[]) {
    const r = await input.runner.execute({
      argv: ["--context", context, ...args],
      timeoutMs: 15000,
      maxStdoutBytes: 1048576,
      maxStderrBytes: 65536,
      signal: new AbortController().signal,
    })
    if (!r.started || r.exitCode !== 0 || r.truncated || r.stdout.length > 1048576)
      throw new TypeError("TASK24_LINUX_ENGINE_UNAVAILABLE")
    return JSON.parse(Buffer.from(r.stdout).toString("utf8"))
  }
  let engine: HostInventory["engine"] = null
  if (!missing.includes("engine_cli_changed"))
    try {
      const context = await read(request.context, ["context", "inspect", request.context, "--format", "{{json .}}"])
      const defaultContext = await read("default", ["context", "inspect", "default", "--format", "{{json .}}"])
      const version = await read(request.context, ["version", "--format", "{{json .Server}}"])
      const info = await read(request.context, ["info", "--format", "{{json .}}"])
      const defaultInfo = await read("default", ["info", "--format", "{{json .}}"])
      const endpoint = context?.Endpoints?.docker?.Host,
        defaultEndpoint = defaultContext?.Endpoints?.docker?.Host
      if (
        endpoint !== request.endpoint ||
        defaultEndpoint !== endpoint ||
        info.ID !== defaultInfo.ID ||
        typeof info.ID !== "string" ||
        !info.ID ||
        version.Os !== "linux" ||
        info.OSType !== "linux" ||
        version.Arch !== request.architecture ||
        typeof version.Version !== "string"
      )
        missing.push("engine_identity_not_verified")
      else
        engine = {
          serverID: info.ID,
          version: version.Version,
          os: "linux",
          architecture: request.architecture,
          endpoint,
          defaultEndpoint,
        }
    } catch {
      missing.push("engine_unavailable")
    }
  const finalCli = await fileIdentity(request.cli.path).catch(() => null)
  if (canonicalJson(cli) !== canonicalJson(finalCli) && !missing.includes("engine_cli_changed"))
    missing.push("engine_cli_changed")
  const body = {
    requestSha256: sha256Text(canonicalJson(request)),
    cli,
    engine,
    storage: storage.kind === "ready" ? storage.value : null,
    rootIdentities: roots,
    missing: [...new Set(missing)],
  }
  const result = freeze({
    ...body,
    contextFingerprint: sha256Text(
      canonicalJson({ request, engine, storage: storageIdentity(body.storage), rootIdentities: roots }),
    ),
  })
  inventories.set(result, { ...input, request })
  return result
}
export function openLinuxSession(input: {
  manifest: unknown
  approval: unknown
  inventory: HostInventory
}): Gate<EngineSession> {
  try {
    const manifest = decodeHostManifest(input.manifest),
      approval = decodeEngineApproval(input.approval),
      inventory = input.inventory,
      inspection = inventories.get(inventory)
    if (
      !inspection ||
      inventory.missing.length ||
      inventory.requestSha256 !== sha256Text(canonicalJson(requestOf(manifest))) ||
      canonicalJson(inventory.engine) !== canonicalJson(manifest.engine) ||
      canonicalJson(storageIdentity(inventory.storage)) !== canonicalJson(storageIdentity(manifest.storage))
    )
      throw new TypeError("TASK24_LINUX_SESSION_IDENTITY")
    const manifestSha256 = sha256Text(canonicalJson(manifest))
    if (
      approval.manifestSha256 !== manifestSha256 ||
      approval.planSha256 !== manifest.planSha256 ||
      approval.acceptanceID !== manifest.acceptanceID ||
      approval.scope !== manifest.phase ||
      approval.contextFingerprint !== inventory.contextFingerprint ||
      approval.artifactManifestSha256 !== manifest.artifactManifestSha256 ||
      approval.expiresAt <= Date.now() ||
      Object.values(manifest.roots).some((root) => !approval.storageRoots.includes(root))
    )
      throw new TypeError("TASK24_LINUX_APPROVAL")
    const session = freeze({ acceptanceID: manifest.acceptanceID, manifestSha256 })
    sessions.set(session, freeze({ manifest, approval, inventory, inspection }))
    return { kind: "ready", value: session }
  } catch {
    return { kind: "blocked", code: "engine_authority_not_verified", missing: ["engine_authority_not_verified"] }
  }
}
export function sessionState(session: EngineSession) {
  const state = sessions.get(session)
  if (!state || state.approval.expiresAt <= Date.now()) throw new TypeError("TASK24_LINUX_SESSION_AUTHORITY")
  return state
}
export async function revalidateSession(session: EngineSession) {
  const state = sessionState(session),
    current = await inspectLinuxHost(state.inspection)
  if (current.missing.length || current.contextFingerprint !== state.inventory.contextFingerprint)
    throw new TypeError("TASK24_LINUX_SESSION_STALE")
  return state
}
