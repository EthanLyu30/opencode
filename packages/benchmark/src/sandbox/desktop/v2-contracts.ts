import path from "node:path"
import { Schema } from "effect"
import { Sha256 } from "../../schema"
import { freeze } from "../../corpus/evaluation-profile"
import { FileIdentity } from "../contracts"
import { canonicalDesktopPath } from "./compatibility"
import { parseDesktopSettingsJson } from "./settings-json"
import {
  DesktopSpec,
  type DesktopLaunchSpec,
  type DesktopLaunchPlan,
  type DesktopPreparedProfile,
  type DesktopLaunchApproval,
  type DesktopPaths,
} from "./contracts"

export const DesktopSpecV2 = Schema.Struct({ ...DesktopSpec.fields, schemaVersion: Schema.Literal(2) })
export type DesktopLaunchSpecV2 = typeof DesktopSpecV2.Type
export type DesktopSpecVersioned = DesktopLaunchSpec | DesktopLaunchSpecV2
export type DesktopPlanVersioned = DesktopLaunchPlan | DesktopLaunchPlanV2
export type DesktopProfileVersioned = DesktopPreparedProfile | DesktopPreparedProfileV2
export type DesktopApprovalVersioned = DesktopLaunchApproval | DesktopLaunchApprovalV2

export const desktopSettingsLimitsV2 = Object.freeze({
  intentBytes: 16384,
  fileBytes: 1048576,
  filesBytes: 3145728,
  jsonDepth: 32,
  temporaryFiles: 3,
  temporaryFileBytes: 1048576,
  totalBytes: 6291456,
})
export const DesktopIntent = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  policyID: Schema.NonEmptyString,
  policySha256: Sha256,
  expected: Schema.Struct({
    SettingsVersion: Schema.Literal(44),
    CustomWslDistroDir: Schema.NonEmptyString,
    WslEngineEnabled: Schema.Literal(true),
    UseWindowsContainers: Schema.Literal(false),
    AutoStart: Schema.Literal(false),
  }),
})
export type DesktopIntentV2 = typeof DesktopIntent.Type
export type DesktopSettingsTarget = "settings-store" | "daemon" | "windows-daemon"
export type DesktopSettingsPhase = "starting" | "observed" | "stopping" | "stopped" | "stale"
export type DesktopLaunchPlanV2 = Readonly<{
  schemaVersion: 2
  assurance: "fixture" | "native-static"
  spec: DesktopLaunchSpecV2
  specSha256: string
  compatibilitySha256: string
  paths: DesktopPaths
  env: Readonly<Record<string, string>>
  endpoint: string
  planSha256: string
  intent: DesktopIntentV2
  intentSha256: string
  policyID: string
  policySha256: string
  seedSha256: string
  runtimeTargets: Readonly<Record<DesktopSettingsTarget, string>>
  phases: readonly ["starting", "observed", "stopping"]
  limits: typeof desktopSettingsLimitsV2
}>
export type DesktopPreparedProfileV2 = Readonly<{
  assurance: "fixture" | "native-static"
  plan: DesktopLaunchPlanV2
  manifestSha256: string
  ownerNonce: string
  rootIdentity: string
  immutableFiles: readonly FileIdentity[]
  seed: FileIdentity
  runtimeTargets: DesktopLaunchPlanV2["runtimeTargets"]
  directories: Readonly<Record<string, string>>
}>
const approvalFields = {
  schemaVersion: Schema.Literal(2),
  launchID: Schema.NonEmptyString,
  nonce: Sha256,
  sid: Schema.NonEmptyString,
  planSha256: Sha256,
  compatibilitySha256: Sha256,
  registration: DesktopSpec.fields.registration,
  disks: DesktopSpec.fields.disks,
  issuedAt: Schema.Number,
  expiresAt: Schema.Number,
}
export const DesktopApprovalV2 = Schema.Union([
  Schema.Struct({
    ...approvalFields,
    phase: Schema.Literal("prepare-profile"),
    operations: Schema.Tuple([Schema.Literal("prepare-profile")]),
    expectedProfileRoot: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...approvalFields,
    phase: Schema.Literal("start-readonly"),
    operations: Schema.Tuple([Schema.Literal("start-readonly"), Schema.Literal("stop-owned")]),
    manifestSha256: Sha256,
  }),
])
export type DesktopLaunchApprovalV2 = typeof DesktopApprovalV2.Type
export const DesktopManifestV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  planSha256: Sha256,
  compatibilitySha256: Sha256,
  intentSha256: Sha256,
  policySha256: Sha256,
  rootIdentity: Schema.NonEmptyString,
  ownerNonce: Sha256,
  immutableFiles: Schema.Array(FileIdentity),
  seed: FileIdentity,
  runtimeTargets: Schema.Record(Schema.String, Schema.String),
  directories: Schema.Record(Schema.String, Schema.String),
})

export function decodeDesktopSpecV2(raw: unknown): DesktopLaunchSpecV2 {
  const spec = Schema.decodeUnknownSync(DesktopSpecV2)(raw, { onExcessProperty: "error" })
  for (const value of [
    spec.profileRoot,
    spec.dataRoot,
    ...Object.values(spec.install).map((f) => f.path),
    spec.registration.basePath,
    ...Object.values(spec.disks).map((d) => d.path),
  ])
    canonicalDesktopPath(value)
  canonicalDesktopPath(spec.windowsProfile, /^[cC]:/.test(spec.windowsProfile) ? "C" : "D")
  if (
    spec.version !== "4.79.0.230596" ||
    spec.cliVersion !== "29.5.3" ||
    spec.settingsVersion !== 44 ||
    spec.registration.distributionName !== "docker-desktop" ||
    spec.registration.basePath !== path.win32.join(spec.dataRoot, "main") ||
    spec.disks.runtime.path !== path.win32.join(spec.dataRoot, "main", "ext4.vhdx") ||
    spec.disks.data.path !== path.win32.join(spec.dataRoot, "disk", "docker_data.vhdx") ||
    spec.wslConfig.path !== path.win32.join(spec.windowsProfile, ".wslconfig") ||
    [spec.dataRoot, spec.windowsProfile, ...Object.values(spec.install).map((f) => f.path)].some((p) => {
      const a = p.toLowerCase(),
        b = spec.profileRoot.toLowerCase()
      return a === b || a.startsWith(b + "\\") || b.startsWith(a + "\\")
    })
  )
    throw new TypeError("TASK24_DESKTOP_V2_SPEC_BINDING")
  return freeze(spec)
}

export function decodeDesktopIntentV2(
  text: string,
  expected: { dataRoot: string; policyID: string; policySha256: string },
): DesktopIntentV2 {
  if (Buffer.byteLength(text) > 16384) throw new TypeError("TASK24_DESKTOP_V2_INTENT_LIMIT")
  const value = Schema.decodeUnknownSync(DesktopIntent)(
    parseDesktopSettingsJson(new TextEncoder().encode(text), 16384),
    {
      onExcessProperty: "error",
    },
  )
  canonicalDesktopPath(value.expected.CustomWslDistroDir)
  if (
    value.expected.CustomWslDistroDir !== expected.dataRoot ||
    value.policyID !== expected.policyID ||
    value.policySha256 !== expected.policySha256 ||
    /^0{64}$/.test(value.policySha256)
  )
    throw new TypeError("TASK24_DESKTOP_V2_INTENT_BINDING")
  return freeze(value)
}

export function desktopRuntimeTargetsV2(root: string): DesktopLaunchPlanV2["runtimeTargets"] {
  return Object.freeze({
    "settings-store": path.join(root, "home-oc-task24-dd479", "AppData", "Roaming", "Docker", "settings-store.json"),
    daemon: path.join(root, "home-oc-task24-dd479", ".docker", "daemon.json"),
    "windows-daemon": path.join(root, "home-oc-task24-dd479", ".docker", "windows-daemon.json"),
  })
}
