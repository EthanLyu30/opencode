import path from "node:path"
import fs from "node:fs/promises"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { sha256Bytes, sha256Text } from "../../hash"
import type { FileIdentity, Gate } from "../contracts"
import { desktopBlocked, type DesktopPlatform } from "./contracts"
import { isNativeDesktopPlatform } from "./platform"
import { canonicalDesktopPath } from "./compatibility"
import { desktopIdentityV2, readDesktopFileV2, readDesktopDirectoryV2 } from "./identity-v2"
import { parseDesktopSettingsJson } from "./settings-json"
import {
  DesktopIntent,
  desktopRuntimeTargetsV2,
  desktopSettingsLimitsV2,
  type DesktopLaunchSpecV2,
  type DesktopSpecVersioned,
  type DesktopIntentV2,
  type DesktopSettingsTarget,
} from "./v2-contracts"

export type DesktopSettingsPolicy = Readonly<{ id: string; sha256: string; assurance: "fixture" }>
export type DesktopSettingsBytes = Readonly<{
  target: DesktopSettingsTarget
  relative: string
  bytes: Uint8Array
  identity: FileIdentity
}>
export type DesktopSettingsSemantics = Readonly<{
  files: readonly { target: DesktopSettingsTarget; identity: FileIdentity; rawSha256: string; semanticSha256: string }[]
  crossFileSha256: string
}>
const policies = new WeakMap<
  DesktopSettingsPolicy,
  { spec: DesktopLaunchSpecV2; platform: DesktopPlatform; scope: string }
>()
const Epoch = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9 }))
const Daemon = Schema.Struct({ FixtureEpoch: Epoch, features: Schema.Struct({ fixture: Schema.Literal(false) }) })

export async function requireDesktopFixtureScopeV2(spec: DesktopLaunchSpecV2, platform: DesktopPlatform) {
  if (isNativeDesktopPlatform(platform)) throw new TypeError("TASK24_DESKTOP_FIXTURE_SCOPE")
  const root = canonicalDesktopPath(process.env.TMPDIR ?? "")
  if (!/^D:\\OpenCode-Benchmark\\Task24\\tmp\\bprep1-[^\\]+$/i.test(root))
    throw new TypeError("TASK24_DESKTOP_FIXTURE_SCOPE")
  for (const file of [
    spec.profileRoot,
    spec.dataRoot,
    spec.windowsProfile,
    ...Object.values(spec.install).map((f) => f.path),
    spec.wslConfig.path,
    ...Object.values(spec.disks).map((d) => d.path),
  ]) {
    canonicalDesktopPath(file)
    if (!file.startsWith(root + path.sep)) throw new TypeError("TASK24_DESKTOP_FIXTURE_SCOPE")
  }
  const owner = await readDesktopFileV2(path.join(root, "owner.json"), 4096)
  Schema.decodeUnknownSync(
    Schema.Struct({
      nonce: Schema.Literal("bprep2-0786b1f11abc"),
      runOwner: Schema.String.check(Schema.isPattern(/^[a-z0-9-]{8,128}$/)),
    }),
  )(parseDesktopSettingsJson(owner.bytes, 4096), { onExcessProperty: "error" })
  for (const [key, expected] of Object.entries(spec.install)) {
    const actual = await readDesktopFileV2(expected.path)
    if (
      canonicalJson(actual.identity) !== canonicalJson(expected) ||
      new TextDecoder().decode(actual.bytes) !== `non-executable fixture ${key}`
    )
      throw new TypeError("TASK24_DESKTOP_FIXTURE_INSTALL")
  }
  const wsl = await readDesktopFileV2(spec.wslConfig.path)
  if (canonicalJson(wsl.identity) !== canonicalJson(spec.wslConfig)) throw new TypeError("TASK24_DESKTOP_V2_WSL_DRIFT")
  const data = await readDesktopDirectoryV2(spec.dataRoot)
  for (const disk of Object.values(spec.disks)) {
    await readDesktopDirectoryV2(path.dirname(disk.path))
    const stat = await fs.lstat(disk.path, { bigint: true })
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      desktopIdentityV2(stat) !== disk.fileID ||
      String(stat.dev) !== disk.volumeID ||
      String(stat.dev) !== data.volumeID ||
      (await fs.realpath(disk.path)).toLowerCase() !== disk.path.toLowerCase()
    )
      throw new TypeError("TASK24_DESKTOP_V2_DISK_DRIFT")
  }
  return canonicalJson({
    root: await readDesktopDirectoryV2(root),
    owner: owner.identity,
    data: await readDesktopDirectoryV2(spec.dataRoot),
    registration: spec.registration,
    disks: spec.disks,
  })
}

export async function selectDesktopSettingsPolicy(
  spec: DesktopSpecVersioned,
  platform: DesktopPlatform,
): Promise<Gate<DesktopSettingsPolicy>> {
  if (isNativeDesktopPlatform(platform)) return desktopBlocked("settings_mutation_unproved")
  try {
    if (spec.schemaVersion !== 2) throw new TypeError("TASK24_DESKTOP_V2_REQUIRED")
    const scope = await requireDesktopFixtureScopeV2(spec, platform)
    const fields = [
      ["SettingsVersion", "literal:44", "immutable", "settings"],
      ["CustomWslDistroDir", spec.dataRoot, "immutable", "path"],
      ["WslEngineEnabled", "literal:true", "immutable", "engine"],
      ["UseWindowsContainers", "literal:false", "immutable", "engine"],
      ["AutoStart", "literal:false", "immutable", "startup"],
      ["FixtureEpoch", "integer:1..9", "window-only;equal-across-three", "synthetic-revision"],
      ["features.fixture", "literal:false", "immutable", "synthetic-daemon"],
    ].map(([name, value, change, safety]) => ({
      name,
      value,
      change,
      safety,
      source: "compiled-fixture-catalog-v2",
      phases: ["starting", "observed", "stopping"],
    }))
    const body = {
      id: "fixture-settings-v2",
      version: spec.version,
      settingsVersion: 44,
      install: spec.install,
      scope,
      fields,
      targets: desktopRuntimeTargetsV2(spec.profileRoot),
      temporarySuffixes: [".fixture-01.tmp", ".fixture-02.tmp", ".fixture-03.tmp"],
      limits: desktopSettingsLimitsV2,
    }
    const policy = Object.freeze({
      id: body.id,
      sha256: sha256Text(canonicalJson(body)),
      assurance: "fixture" as const,
    })
    policies.set(policy, { spec, platform, scope })
    return { kind: "ready", value: policy }
  } catch (error) {
    return desktopBlocked(error instanceof Error ? error.message : "settings_mutation_unproved")
  }
}

export function requireDesktopSettingsPolicy(policy: DesktopSettingsPolicy) {
  const state = policies.get(policy)
  if (!state) throw new TypeError("TASK24_DESKTOP_SETTINGS_POLICY_AUTHORITY")
  return state
}
export async function revalidateDesktopSettingsPolicy(policy: DesktopSettingsPolicy) {
  const state = requireDesktopSettingsPolicy(policy)
  if (state.scope !== (await requireDesktopFixtureScopeV2(state.spec, state.platform)))
    throw new TypeError("TASK24_DESKTOP_SETTINGS_POLICY_DRIFT")
}
export function desktopTemporaryNames(policy: DesktopSettingsPolicy) {
  const state = requireDesktopSettingsPolicy(policy)
  return Object.entries(desktopRuntimeTargetsV2(state.spec.profileRoot)).flatMap(([target, file]) =>
    [".fixture-01.tmp", ".fixture-02.tmp", ".fixture-03.tmp"].map((suffix) => ({
      target: target as DesktopSettingsTarget,
      relative: path.relative(state.spec.profileRoot, file) + suffix,
    })),
  )
}

export function validateDesktopSettingsSet(input: {
  policy: DesktopSettingsPolicy
  intent: DesktopIntentV2
  files: readonly DesktopSettingsBytes[]
  temporary: readonly DesktopSettingsBytes[]
  phase: "starting" | "observed" | "stopping"
}): DesktopSettingsSemantics {
  Schema.decodeUnknownSync(DesktopIntent)(input.intent, { onExcessProperty: "error" })
  const state = requireDesktopSettingsPolicy(input.policy),
    spec = state.spec,
    limits = desktopSettingsLimitsV2
  if (
    !["starting", "observed", "stopping"].includes(input.phase) ||
    input.intent.policyID !== input.policy.id ||
    input.intent.policySha256 !== input.policy.sha256 ||
    input.intent.expected.CustomWslDistroDir !== spec.dataRoot
  )
    throw new TypeError("TASK24_DESKTOP_SETTINGS_POLICY_BINDING")
  if (
    input.files.length !== 3 ||
    new Set(input.files.map((f) => f.target)).size !== 3 ||
    input.temporary.length > 3 ||
    new Set(input.temporary.map((f) => f.relative)).size !== input.temporary.length ||
    input.files.reduce((n, f) => n + f.bytes.length, 0) > limits.filesBytes ||
    [...input.files, ...input.temporary].reduce((n, f) => n + f.bytes.length, 0) > limits.totalBytes
  )
    throw new TypeError("TASK24_DESKTOP_SETTINGS_SET_LIMIT")
  const targets = desktopRuntimeTargetsV2(spec.profileRoot),
    temporary = desktopTemporaryNames(input.policy)
  const Settings = Schema.Struct({
    SettingsVersion: Schema.Literal(44),
    CustomWslDistroDir: Schema.Literal(spec.dataRoot),
    WslEngineEnabled: Schema.Literal(true),
    UseWindowsContainers: Schema.Literal(false),
    AutoStart: Schema.Literal(false),
    FixtureEpoch: Epoch,
  })
  const check = (file: DesktopSettingsBytes, isTemporary: boolean) => {
    const expected = targets[file.target]
    if (
      !expected ||
      file.identity.path !== path.join(spec.profileRoot, file.relative) ||
      file.identity.sha256 !== sha256Bytes(file.bytes) ||
      (isTemporary
        ? !temporary.some((t) => t.target === file.target && t.relative === file.relative)
        : file.relative !== path.relative(spec.profileRoot, expected))
    )
      throw new TypeError("TASK24_DESKTOP_SETTINGS_TARGET")
    const raw = parseDesktopSettingsJson(file.bytes, limits.fileBytes)
    const value =
      file.target === "settings-store"
        ? Schema.decodeUnknownSync(Settings)(raw, { onExcessProperty: "error" })
        : Schema.decodeUnknownSync(Daemon)(raw, { onExcessProperty: "error" })
    return {
      value,
      target: file.target,
      identity: file.identity,
      rawSha256: sha256Bytes(file.bytes),
      semanticSha256: sha256Text(canonicalJson(value)),
    }
  }
  const checked = input.files.map((f) => check(f, false))
  input.temporary.forEach((f) => check(f, true))
  if (new Set(checked.map((f) => f.value.FixtureEpoch)).size !== 1)
    throw new TypeError("TASK24_DESKTOP_SETTINGS_CROSS_FILE")
  const files = checked.map(({ value, ...file }) => file).sort((a, b) => (a.target < b.target ? -1 : 1))
  return freeze({
    files,
    crossFileSha256: sha256Text(
      canonicalJson(files.map((f) => ({ target: f.target, semanticSha256: f.semanticSha256 }))),
    ),
  })
}
