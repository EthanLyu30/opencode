import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Text } from "../../hash"
import { freeze } from "../../corpus/evaluation-profile"
import { FileIdentity, decodeHostRequest, type HostRequest, type DockerRunner, type StorageProof } from "../contracts"
import { isReadonlyDockerInvocation, makeProcessRunner } from "../docker"
import { inspectStorage } from "../storage"
import { bindEffectiveSwap, decodeManagedLaunchRegistration, type StorageSource } from "../storage-source"
import {
  DesktopObservation,
  type DesktopLaunchSession,
  type DesktopLaunchSpec,
  type DesktopPreparedProfile,
  type DesktopLaunchInventory,
} from "./contracts"
import { revalidateDesktopLaunchSession } from "./launch"
import { readDesktopText } from "./compatibility"

const Disk = Schema.Struct({ path: Schema.String, fileID: Schema.String, volumeID: Schema.String })
const Snapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  manifestSha256: Schema.String,
  registration: Schema.Struct({ distributionName: Schema.String, basePath: Schema.String, fileID: Schema.String }),
  runtimeDisk: Disk,
  dataDisk: Disk,
  settingsSha256: Schema.String,
  wslConfig: Schema.Struct({ ...FileIdentity.fields, modifiedAt: Schema.Number }),
  swapsText: Schema.String,
  active: Schema.Boolean,
  binding: Schema.Unknown,
})
export function decodeDesktopStorageObservation(
  raw: unknown,
  context: { spec: DesktopLaunchSpec; profile: DesktopPreparedProfile },
): StorageProof {
  const value = Schema.decodeUnknownSync(Snapshot)(raw, { onExcessProperty: "error" })
  const spec = context.spec,
    plan = context.profile.plan
  const registration = decodeManagedLaunchRegistration(value.binding, {
    windowsProfile: spec.windowsProfile,
    dockerProfile: plan.paths.home,
  })
  const timing = Schema.decodeUnknownSync(Schema.Struct({ backendStartedAt: Schema.Number }))(value.binding)
  const wsl = value.wslConfig
  if (
    value.manifestSha256 !== context.profile.manifestSha256 ||
    value.settingsSha256 !== plan.settingsSha256 ||
    canonicalJson(value.registration) !== canonicalJson(spec.registration) ||
    canonicalJson(value.runtimeDisk) !== canonicalJson(spec.disks.runtime) ||
    canonicalJson(value.dataDisk) !== canonicalJson(spec.disks.data) ||
    canonicalJson({ path: wsl.path, fileID: wsl.fileID, sha256: wsl.sha256 }) !== canonicalJson(spec.wslConfig) ||
    !Number.isFinite(wsl.modifiedAt) ||
    wsl.modifiedAt < 0 ||
    wsl.modifiedAt > timing.backendStartedAt ||
    registration.version !== spec.version ||
    registration.diskPath !== spec.disks.data.path ||
    registration.runtimeDiskPath !== spec.disks.runtime.path
  )
    throw new TypeError("TASK24_DESKTOP_STORAGE_OBSERVATION")
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
    dataRoot: registration.dataRoot,
    swap: { kind: "disabled" as const },
    settingsSha256: sha256Text(canonicalJson({ value, plan: plan.planSha256 })),
    observedAt: Date.now(),
  })
}
export function makeDesktopProfileRunner(input: { request: HostRequest; session: DesktopLaunchSession }): DockerRunner {
  const request = decodeHostRequest(input.request)
  return {
    async execute(invocation) {
      const context = await revalidateDesktopLaunchSession(input.session),
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
      const runner = makeProcessRunner({
        executable: request.cli.path,
        argvPrefix: [],
        cwd: plan.paths.temp,
        env: { ...plan.env, DOCKER_HOST: plan.endpoint, DOCKER_CONTEXT: selected! },
      })
      const result = await runner.execute({ ...invocation, argv: ["--context", selected!, ...args] })
      await revalidateDesktopLaunchSession(input.session)
      return result
    },
  }
}
export async function inspectDesktopLaunch(session: DesktopLaunchSession): Promise<DesktopLaunchInventory> {
  const missing: string[] = []
  const context = await revalidateDesktopLaunchSession(session)
  const raw = Schema.decodeUnknownSync(DesktopObservation)(await context.platform.observe(context.spec), {
    onExcessProperty: "error",
  })
  const storage = (() => {
    try {
      return decodeDesktopStorageObservation(raw.storage, context)
    } catch {
      missing.push("desktop_storage_not_verified")
      return null
    }
  })()
  if (storage && (await inspectStorage(storage)).kind !== "ready") missing.push("desktop_storage_identity_changed")
  const same =
    raw.profileEndpoint && raw.productionDefaultEndpoint ? raw.profileEndpoint === raw.productionDefaultEndpoint : null
  if (same === false) missing.push("production_default_endpoint_mismatch")
  if (same === null) missing.push("production_default_endpoint_unobserved")
  if (raw.profileEndpoint !== context.profile.plan.endpoint) missing.push("desktop_profile_endpoint_mismatch")
  await revalidateDesktopLaunchSession(session)
  return freeze({
    launchID: session.launchID,
    assurance: context.assurance,
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
}
export async function readDesktopLaunchStorage(input: {
  request: HostRequest
  source: StorageSource
  session: DesktopLaunchSession
}): Promise<StorageProof> {
  const context = await revalidateDesktopLaunchSession(input.session)
  if (
    context.assurance !== "native" ||
    input.source.kind !== "desktop-wsl-managed-launch" ||
    input.source.profileManifest !== path.join(context.spec.profileRoot, "manifest.json") ||
    input.source.settingsFile !==
      path.join(context.profile.plan.paths.home, "AppData", "Roaming", "Docker", "settings-store.json") ||
    input.source.wslConfig !== context.spec.wslConfig.path ||
    input.request.endpoint !== context.profile.plan.endpoint ||
    canonicalJson(input.source.desktop) !== canonicalJson(context.spec.install.desktop) ||
    canonicalJson(input.source.backend) !== canonicalJson(context.spec.install.backend)
  )
    throw new TypeError("TASK24_DESKTOP_NATIVE_SESSION_REQUIRED")
  const settings = await readDesktopText(input.source.settingsFile)
  if (settings.sha256 !== context.profile.plan.settingsSha256) throw new TypeError("TASK24_DESKTOP_SETTINGS_DRIFT")
  const inventory = await inspectDesktopLaunch(input.session)
  if (!inventory.storage || inventory.missing.some((v) => v !== "production_default_endpoint_mismatch"))
    throw new TypeError("TASK24_DESKTOP_STORAGE_UNOBSERVED")
  return inventory.storage
}
