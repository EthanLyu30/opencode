import { Schema } from "effect"
import { FileIdentity, type Gate, type StorageProof } from "../contracts"
import { Sha256 } from "../../schema"

const Text = Schema.NonEmptyString
const Disk = Schema.Struct({ path: Text, fileID: Text, volumeID: Text })
const Registration = Schema.Struct({ distributionName: Text, basePath: Text, fileID: Text })
export const DesktopSpec = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  profileID: Schema.Literal("oc-task24-dd479"),
  sourceSha256: Sha256,
  specSha256: Sha256,
  planSha256: Sha256,
  version: Text,
  cliVersion: Text,
  settingsVersion: Schema.Int,
  windowsProfile: Text,
  profileRoot: Text,
  dataRoot: Text,
  install: Schema.Struct({
    desktop: FileIdentity,
    frontend: FileIdentity,
    backend: FileIdentity,
    asar: FileIdentity,
    cli: FileIdentity,
  }),
  wslConfig: FileIdentity,
  registration: Registration,
  disks: Schema.Struct({ runtime: Disk, data: Disk }),
})
export type DesktopLaunchSpec = typeof DesktopSpec.Type
export const Evidence = Schema.Struct({
  id: Schema.Literals(["path_routing", "backend_environment", "registration_reuse", "stop_owned", "cli_default"]),
  source: Text,
  sourceSha256: Sha256,
  location: Text,
  conclusion: Schema.Literals(["proved", "unproved"]),
})
export const Compatibility = Schema.Struct({
  assurance: Schema.Literals(["fixture", "native-static"]),
  specSha256: Sha256,
  checks: Schema.Array(Evidence),
  missing: Schema.Array(Text),
})
export type DesktopCompatibilityReport = typeof Compatibility.Type
export type DesktopPaths = Readonly<{ root: string; home: string; frontend: string; cli: string; temp: string }>
export type DesktopLaunchPlan = Readonly<{
  schemaVersion: 1
  assurance: "fixture" | "native-static"
  spec: DesktopLaunchSpec
  specSha256: string
  compatibilitySha256: string
  paths: DesktopPaths
  env: Readonly<Record<string, string>>
  settings: Readonly<Record<string, string | boolean | number>>
  settingsSha256: string
  endpoint: string
  planSha256: string
}>
export type DesktopPreparedProfile = Readonly<{
  assurance: "fixture" | "native-static"
  plan: DesktopLaunchPlan
  manifestSha256: string
  ownerNonce: string
  rootIdentity: string
  files: readonly FileIdentity[]
  directories: Readonly<Record<string, string>>
}>
const ApprovalFields = {
  schemaVersion: Schema.Literal(1),
  launchID: Text,
  nonce: Sha256,
  sid: Text,
  planSha256: Sha256,
  compatibilitySha256: Sha256,
  registration: Registration,
  disks: Schema.Struct({ runtime: Disk, data: Disk }),
  issuedAt: Schema.Number,
  expiresAt: Schema.Number,
}
export const DesktopApproval = Schema.Union([
  Schema.Struct({
    ...ApprovalFields,
    phase: Schema.Literal("prepare-profile"),
    operations: Schema.Tuple([Schema.Literal("prepare-profile")]),
    expectedProfileRoot: Text,
  }),
  Schema.Struct({
    ...ApprovalFields,
    phase: Schema.Literal("start-readonly"),
    operations: Schema.Tuple([Schema.Literal("start-readonly"), Schema.Literal("stop-owned")]),
    manifestSha256: Sha256,
  }),
])
export type DesktopLaunchApproval = typeof DesktopApproval.Type
export const ProcessIdentity = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  createdAt: Schema.Number.check(Schema.isGreaterThan(0)),
  ownerSID: Text,
  image: FileIdentity,
  parentPID: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type DesktopProcessIdentity = typeof ProcessIdentity.Type
export type DesktopLaunchSession = Readonly<{ launchID: string }>
export const DesktopObservation = Schema.Struct({
  phase: Schema.Literals(["idle", "starting", "running", "stopped"]),
  sid: Text,
  runningDocker: Schema.Boolean,
  runningWsl: Schema.Boolean,
  process: Schema.optionalKey(ProcessIdentity),
  pipe: Schema.optionalKey(Schema.Struct({ endpoint: Text, owner: ProcessIdentity })),
  related: Schema.optionalKey(Schema.Array(ProcessIdentity)),
  storage: Schema.optionalKey(Schema.Unknown),
  profileEndpoint: Schema.optionalKey(Text),
  productionDefaultEndpoint: Schema.optionalKey(Text),
})
export type DesktopLaunchInventory = Readonly<{
  launchID: string
  assurance: "fixture" | "native"
  status: "inventory_observed_not_accepted" | "blocked" | "cleanup_uncertain"
  missing: readonly string[]
  observationSha256: string
  storage: StorageProof | null
  profileEndpoint: string | null
  productionDefaultEndpoint: string | null
  production_default_compatible: boolean | null
  engine_verified: false
  tool_capability_verified: false
  corpus_engine_ready: false
}>
export interface DesktopPlatform {
  audit(spec: DesktopLaunchSpec): Promise<DesktopCompatibilityReport>
  observe(spec: DesktopLaunchSpec): Promise<unknown>
  start(plan: DesktopLaunchPlan): Promise<DesktopProcessIdentity>
  stop(process: DesktopProcessIdentity): Promise<"stopped" | "uncertain">
}
export function desktopBlocked(code: string, missing: readonly string[] = [code]): Gate<never> {
  return { kind: "blocked", code, missing }
}
