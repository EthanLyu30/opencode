import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { sha256Text } from "../../hash"
import { FileIdentity, decodeHostRequest, type StorageProof, type HostRequest, type DockerRunner } from "../contracts"
import { bindEffectiveSwap, type StorageSource } from "../storage-source"
import { isReadonlyDockerInvocation } from "../docker"
import { type DesktopLaunchSession, type DesktopLaunchInventory } from "./contracts"
import type { DesktopLaunchSpecV2, DesktopPreparedProfileV2 } from "./v2-contracts"
import { requireDesktopSettingsSession, observeDesktopLaunchSessionV2 } from "./launch-v2"
import { requireDesktopSettingsSeal, withDesktopRuntimeSettings, type DesktopSettingsSeal } from "./settings-runtime"
import { desktopIdentityV2, readDesktopDirectoryV2 } from "./identity-v2"

const Disk = Schema.Struct({ path: Schema.String, fileID: Schema.String, volumeID: Schema.String })
const Binding = Schema.Struct({
  version: Schema.String,
  distributionName: Schema.Literal("docker-desktop"),
  basePath: Schema.String,
  windowsProfile: Schema.String,
  settingsPath: Schema.String,
  settings: Schema.Unknown,
  settingsModifiedAt: Schema.Number,
  backendStartedAt: Schema.Number,
  imagePath: Schema.String,
  attached: Schema.Boolean,
  windowsFilesystemUUID: Schema.String,
  guestFilesystemUUID: Schema.String,
  guestEngineID: Schema.String,
  daemonServerID: Schema.String,
})
const Snapshot = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  manifestSha256: Schema.String,
  intentSha256: Schema.String,
  policySha256: Schema.String,
  runtimeSealSha256: Schema.String,
  sequence: Schema.Number,
  registration: Schema.Struct({ distributionName: Schema.String, basePath: Schema.String, fileID: Schema.String }),
  runtimeDisk: Disk,
  dataDisk: Disk,
  wslConfig: Schema.Struct({ ...FileIdentity.fields, modifiedAt: Schema.Number }),
  swapsText: Schema.String,
  active: Schema.Boolean,
  binding: Binding,
})
export function decodeDesktopStorageObservationV2(
  raw: unknown,
  context: {
    spec: DesktopLaunchSpecV2
    profile: DesktopPreparedProfileV2
    session: DesktopLaunchSession
    seal: DesktopSettingsSeal
  },
): StorageProof {
  const seal = requireDesktopSettingsSeal(context.session, context.seal),
    live = requireDesktopSettingsSession(context.session)
  if (live.spec !== context.spec || live.profile !== context.profile || live.phase !== "observed")
    throw new TypeError("TASK24_DESKTOP_STORAGE_SESSION")
  const value = Schema.decodeUnknownSync(Snapshot)(raw, { onExcessProperty: "error" }),
    spec = context.spec,
    plan = context.profile.plan,
    b = value.binding,
    wsl = value.wslConfig
  const settings = seal.semantics.files.find((f) => f.target === "settings-store")!
  if (
    value.intentSha256 !== seal.intentSha256 ||
    value.policySha256 !== seal.policySha256 ||
    value.runtimeSealSha256 !== seal.sha256 ||
    value.sequence !== seal.sequence ||
    value.manifestSha256 !== context.profile.manifestSha256 ||
    canonicalJson(value.registration) !== canonicalJson(spec.registration) ||
    canonicalJson(value.runtimeDisk) !== canonicalJson(spec.disks.runtime) ||
    canonicalJson(value.dataDisk) !== canonicalJson(spec.disks.data) ||
    canonicalJson({ path: wsl.path, fileID: wsl.fileID, sha256: wsl.sha256 }) !== canonicalJson(spec.wslConfig) ||
    b.version !== spec.version ||
    b.distributionName !== spec.registration.distributionName ||
    b.basePath !== spec.registration.basePath ||
    b.windowsProfile !== spec.windowsProfile ||
    b.settingsPath !== plan.runtimeTargets["settings-store"] ||
    sha256Text(canonicalJson(b.settings)) !== settings.semanticSha256 ||
    b.backendStartedAt !== live.process.createdAt ||
    !Number.isFinite(b.settingsModifiedAt) ||
    b.settingsModifiedAt < 0 ||
    b.settingsModifiedAt > Date.now() ||
    !Number.isFinite(wsl.modifiedAt) ||
    wsl.modifiedAt < 0 ||
    wsl.modifiedAt > b.backendStartedAt ||
    b.backendStartedAt <= 0 ||
    b.imagePath !== spec.disks.data.path ||
    !b.attached ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(b.windowsFilesystemUUID) ||
    b.windowsFilesystemUUID.toLowerCase() !== b.guestFilesystemUUID.toLowerCase() ||
    !b.guestEngineID ||
    b.guestEngineID !== b.daemonServerID
  )
    throw new TypeError("TASK24_DESKTOP_V2_STORAGE_OBSERVATION")
  bindEffectiveSwap({
    sourcePath: wsl.path,
    windowsProfile: spec.windowsProfile,
    swap: { kind: "disabled" },
    active: value.active,
    swapsText: value.swapsText,
  })
  return freeze({
    backend: "wsl2" as const,
    disk: value.dataDisk,
    dataRoot: path.join(spec.dataRoot, "disk"),
    swap: { kind: "disabled" as const },
    settingsSha256: sha256Text(
      canonicalJson({
        schemaVersion: 2,
        intentSha256: value.intentSha256,
        policySha256: value.policySha256,
        runtimeSealSha256: value.runtimeSealSha256,
        observation: value,
        planSha256: plan.planSha256,
      }),
    ),
    observedAt: Date.now(),
  })
}
async function physical(context: ReturnType<typeof requireDesktopSettingsSession>, raw: typeof Snapshot.Type) {
  const base = await readDesktopDirectoryV2(context.spec.dataRoot)
  for (const disk of Object.values(context.spec.disks)) {
    await readDesktopDirectoryV2(path.dirname(disk.path))
    const stat = await fs.lstat(disk.path, { bigint: true })
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      desktopIdentityV2(stat) !== disk.fileID ||
      String(stat.dev) !== disk.volumeID ||
      String(stat.dev) !== base.volumeID
    )
      throw new TypeError("TASK24_DESKTOP_STORAGE_IDENTITY")
  }
  if (
    (await fs.stat(context.spec.wslConfig.path)).mtimeMs !== raw.wslConfig.modifiedAt ||
    (await fs.stat(context.profile.plan.runtimeTargets["settings-store"])).mtimeMs !== raw.binding.settingsModifiedAt
  )
    throw new TypeError("TASK24_DESKTOP_STORAGE_TIME")
}
export async function inspectDesktopLaunchV2(session: DesktopLaunchSession): Promise<DesktopLaunchInventory> {
  return withDesktopRuntimeSettings(session, async (seal) => {
    const context = requireDesktopSettingsSession(session),
      raw = await observeDesktopLaunchSessionV2(session, seal),
      missing: string[] = []
    let storage: StorageProof | null = null
    try {
      storage = decodeDesktopStorageObservationV2(raw.storage, { ...context, session, seal })
      await physical(context, Schema.decodeUnknownSync(Snapshot)(raw.storage, { onExcessProperty: "error" }))
    } catch {
      storage = null
      missing.push("desktop_storage_not_verified")
    }
    const same =
      raw.profileEndpoint && raw.productionDefaultEndpoint
        ? raw.profileEndpoint === raw.productionDefaultEndpoint
        : null
    if (same === false) missing.push("production_default_endpoint_mismatch")
    if (same === null) missing.push("production_default_endpoint_unobserved")
    if (raw.profileEndpoint !== context.profile.plan.endpoint) missing.push("desktop_profile_endpoint_mismatch")
    await observeDesktopLaunchSessionV2(session, seal)
    return freeze({
      launchID: session.launchID,
      assurance: "fixture" as const,
      status: missing.length ? ("blocked" as const) : ("inventory_observed_not_accepted" as const),
      missing,
      observationSha256: sha256Text(canonicalJson(raw)),
      storage,
      profileEndpoint: raw.profileEndpoint ?? null,
      productionDefaultEndpoint: raw.productionDefaultEndpoint ?? null,
      production_default_compatible: same,
      engine_verified: false as const,
      tool_capability_verified: false as const,
      corpus_engine_ready: false as const,
    })
  })
}
export function makeDesktopProfileRunnerV2(input: {
  request: HostRequest
  session: DesktopLaunchSession
}): DockerRunner {
  const request = decodeHostRequest(input.request)
  return {
    async execute(invocation) {
      return withDesktopRuntimeSettings(
        input.session,
        async (seal) => {
          const context = requireDesktopSettingsSession(input.session),
            plan = context.profile.plan
          if (
            request.endpoint !== plan.endpoint ||
            request.roots.config !== plan.paths.cli ||
            request.roots.temp !== plan.paths.temp ||
            canonicalJson(request.cli) !== canonicalJson(context.spec.install.cli)
          )
            throw new TypeError("TASK24_DESKTOP_RUNNER_BINDING")
          const args = invocation.argv[0] === "--context" ? invocation.argv.slice(2) : invocation.argv
          const selected = invocation.argv[0] === "--context" ? invocation.argv[1] : request.context
          if (
            ![request.context, "default"].includes(selected ?? "") ||
            !isReadonlyDockerInvocation(args, false) ||
            invocation.stdin ||
            invocation.stdinFile ||
            (args[0] === "context" && ![request.context, "default"].includes(args[2] ?? ""))
          )
            throw new TypeError("TASK24_DESKTOP_READONLY_REQUIRED")
          await observeDesktopLaunchSessionV2(input.session, seal, invocation.signal)
          // No native v2 catalog/session exists. Never execute a synthetic installation as a CLI.
          throw new TypeError("TASK24_DESKTOP_NATIVE_SESSION_REQUIRED")
        },
        invocation.signal,
      )
    },
  }
}
export async function readDesktopLaunchStorageV2(input: {
  request: HostRequest
  source: StorageSource
  session: DesktopLaunchSession
}): Promise<StorageProof> {
  requireDesktopSettingsSession(input.session)
  // Fixture success cannot supply the native storage-probe capability.
  throw new TypeError("TASK24_DESKTOP_NATIVE_SESSION_REQUIRED")
}
