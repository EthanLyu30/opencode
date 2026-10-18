import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { fileIdentity, directoryIdentity } from "../storage"
import { FileIdentity } from "../contracts"
import { sha256Text } from "../../hash"
import {
  DesktopApproval,
  DesktopObservation,
  desktopBlocked,
  type DesktopLaunchApproval,
  type DesktopLaunchPlan,
  type DesktopLaunchSpec,
  type DesktopCompatibilityReport,
  type DesktopPlatform,
  type DesktopPreparedProfile,
} from "./contracts"
import {
  canonicalDesktopPath,
  decodeDesktopLaunchSpec,
  readDesktopText,
  requireDesktopReport,
  revalidateDesktopSpec,
} from "./compatibility"

const plans = new WeakMap<object, DesktopPlatform>()
const approvals = new WeakMap<object, string>()
const prepared = new WeakSet<object>()
const preparedByRoot = new Map<string, DesktopPreparedProfile>()

/** Called by a trusted embedding controller; JSON input or flags never count as human confirmation. */
export async function confirmDesktopApproval(
  raw: unknown,
  verifyHumanConfirmation: (approval: DesktopLaunchApproval) => Promise<boolean>,
) {
  const approval = freeze(Schema.decodeUnknownSync(DesktopApproval)(raw, { onExcessProperty: "error" }))
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(approval.launchID) ||
    !Number.isFinite(approval.issuedAt) ||
    !Number.isFinite(approval.expiresAt) ||
    approval.issuedAt > Date.now() ||
    approval.expiresAt <= Date.now() ||
    approval.expiresAt - approval.issuedAt > 900000 ||
    !(await verifyHumanConfirmation(approval))
  )
    throw new TypeError("TASK24_DESKTOP_CONFIRMATION_REQUIRED")
  approvals.set(approval, sha256Text(canonicalJson(approval)))
  return approval
}
export function requireDesktopPlan(plan: DesktopLaunchPlan, platform?: DesktopPlatform) {
  const authority = plans.get(plan)
  if (!authority || (platform && authority !== platform)) throw new TypeError("TASK24_DESKTOP_PLAN_AUTHORITY")
  return authority
}
export function requireDesktopApproval(
  approval: DesktopLaunchApproval,
  plan: DesktopLaunchPlan,
  phase: DesktopLaunchApproval["phase"],
  sid: string,
) {
  if (
    approvals.get(approval) !== sha256Text(canonicalJson(approval)) ||
    approval.phase !== phase ||
    approval.sid !== sid ||
    approval.issuedAt > Date.now() ||
    approval.expiresAt <= Date.now() ||
    approval.expiresAt - approval.issuedAt > 900000 ||
    approval.planSha256 !== plan.planSha256 ||
    approval.compatibilitySha256 !== plan.compatibilitySha256 ||
    canonicalJson(approval.registration) !== canonicalJson(plan.spec.registration) ||
    canonicalJson(approval.disks) !== canonicalJson(plan.spec.disks)
  )
    throw new TypeError("TASK24_DESKTOP_APPROVAL_AUTHORITY")
}
export function planDesktopProfile(raw: DesktopLaunchSpec, report: DesktopCompatibilityReport) {
  try {
    const spec = decodeDesktopLaunchSpec(raw),
      platform = requireDesktopReport(spec, report)
    const paths = {
      root: spec.profileRoot,
      home: path.join(spec.profileRoot, "home-oc-task24-dd479"),
      frontend: path.join(spec.profileRoot, "frontend"),
      cli: path.join(spec.profileRoot, "cli"),
      temp: path.join(spec.profileRoot, "temp"),
    }
    const settings = {
      SettingsVersion: 44,
      CustomWslDistroDir: spec.dataRoot,
      WslEngineEnabled: true,
      UseWindowsContainers: false,
      AutoStart: false,
    }
    const env = {
      PINATA_HOME_DIRECTORY_OVERRIDE: paths.home,
      PINATA_USER_DATA_DIR_OVERRIDE: paths.frontend,
      HOME: paths.home,
      USERPROFILE: paths.home,
      APPDATA: path.join(paths.home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(paths.home, "AppData", "Local"),
      TEMP: paths.temp,
      TMP: paths.temp,
      DOCKER_CONFIG: paths.cli,
      DOCKER_HOST: "",
      DOCKER_CONTEXT: "default",
      DOCKER_TLS_VERIFY: "",
      DOCKER_CERT_PATH: "",
      BUILDX_BUILDER: "",
      BUILDKIT_HOST: "",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      PATH: path.dirname(spec.install.cli.path) + ";C:\\Windows\\System32",
      PSModuleAnalysisCachePath: path.join(paths.temp, "ModuleAnalysisCache"),
    }
    const body = {
      schemaVersion: 1 as const,
      assurance: report.assurance,
      spec,
      specSha256: sha256Text(canonicalJson(spec)),
      compatibilitySha256: sha256Text(canonicalJson(report)),
      paths,
      env,
      settings,
      settingsSha256: sha256Text(canonicalJson(settings)),
      endpoint: "npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine",
    }
    const plan = freeze({ ...body, planSha256: sha256Text(canonicalJson(body)) })
    plans.set(plan, platform)
    return { kind: "ready" as const, value: plan }
  } catch (error) {
    return desktopBlocked(error instanceof Error ? error.message : "desktop_plan_failed")
  }
}
async function writeExclusive(file: string, text: string) {
  await directoryIdentity(path.dirname(file))
  const handle = await fs.open(file, "wx")
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return fileIdentity(file)
}
async function ownDirectory(root: string, target: string) {
  canonicalDesktopPath(target)
  if (target !== root && !target.startsWith(root + path.sep)) throw new TypeError("TASK24_DESKTOP_DIRECTORY_SCOPE")
  await directoryIdentity(root)
  let current = root
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (!(await fs.exists(current))) await fs.mkdir(current)
    await directoryIdentity(current)
  }
}
export async function consumeDesktopGrant(profileRoot: string, approval: DesktopLaunchApproval) {
  if (approvals.get(approval) !== sha256Text(canonicalJson(approval)) || !/^[a-f0-9]{64}$/.test(approval.nonce))
    throw new TypeError("TASK24_DESKTOP_APPROVAL_AUTHORITY")
  const ledger = path.join(profileRoot, "state", "grants")
  await ownDirectory(profileRoot, ledger)
  await writeExclusive(
    path.join(ledger, approval.nonce + ".json"),
    canonicalJson({
      phase: approval.phase,
      launchID: approval.launchID,
      approvalSha256: sha256Text(canonicalJson(approval)),
    }),
  )
}
export async function prepareDesktopProfile(input: {
  spec: DesktopLaunchSpec
  plan: DesktopLaunchPlan
  approval: DesktopLaunchApproval
  platform: DesktopPlatform
}) {
  try {
    const plan = input.plan,
      approval = input.approval
    requireDesktopPlan(plan, input.platform)
    if (canonicalJson(input.spec) !== canonicalJson(plan.spec)) throw new TypeError("TASK24_DESKTOP_SPEC_DRIFT")
    const state = Schema.decodeUnknownSync(DesktopObservation)(await input.platform.observe(plan.spec), {
      onExcessProperty: "error",
    })
    requireDesktopApproval(approval, plan, "prepare-profile", state.sid)
    if (approval.phase !== "prepare-profile" || approval.expectedProfileRoot !== plan.paths.root)
      throw new TypeError("TASK24_DESKTOP_PROFILE_BINDING")
    await revalidateDesktopSpec(plan.spec)
    const parentIdentity = await directoryIdentity(path.dirname(plan.paths.root))
    if (await fs.exists(plan.paths.root)) {
      const existing = preparedByRoot.get(plan.paths.root)
      if (!existing || existing.ownerNonce !== approval.nonce || existing.plan.planSha256 !== plan.planSha256)
        throw new TypeError("TASK24_DESKTOP_PROFILE_EXISTS")
      await revalidateDesktopProfile(existing)
      return { kind: "ready" as const, value: existing }
    }
    await fs.mkdir(plan.paths.root)
    const rootIdentity = await directoryIdentity(plan.paths.root)
    const owner = await writeExclusive(
      path.join(plan.paths.root, "owner.json"),
      canonicalJson({ schemaVersion: 1, nonce: approval.nonce, planSha256: plan.planSha256 }),
    )
    await consumeDesktopGrant(plan.paths.root, approval)
    if ((await directoryIdentity(path.dirname(plan.paths.root))) !== parentIdentity)
      throw new TypeError("TASK24_DESKTOP_PARENT_DRIFT")
    for (const target of [
      ...Object.values(plan.paths),
      path.join(plan.paths.home, "AppData", "Local", "Docker"),
      path.join(plan.paths.home, "AppData", "Roaming", "Docker"),
    ])
      await ownDirectory(plan.paths.root, target)
    const settingsFile = path.join(plan.paths.home, "AppData", "Roaming", "Docker", "settings-store.json")
    const settings = await writeExclusive(settingsFile, canonicalJson(plan.settings))
    const directories: Record<string, string> = {}
    for (const target of [
      path.dirname(plan.paths.root),
      ...Object.values(plan.paths),
      path.dirname(settingsFile),
      path.join(plan.paths.root, "state"),
      path.join(plan.paths.root, "state", "grants"),
    ])
      directories[target] = await directoryIdentity(target)
    const body = {
      schemaVersion: 1,
      planSha256: plan.planSha256,
      compatibilitySha256: plan.compatibilitySha256,
      rootIdentity,
      ownerNonce: approval.nonce,
      files: [owner, settings],
      directories,
    }
    const text = canonicalJson(body)
    const manifest = await writeExclusive(path.join(plan.paths.root, "manifest.json"), text)
    const result: DesktopPreparedProfile = freeze({
      assurance: plan.assurance,
      plan,
      manifestSha256: sha256Text(text),
      ownerNonce: approval.nonce,
      rootIdentity,
      files: [owner, settings, manifest],
      directories,
    })
    prepared.add(result)
    await revalidateDesktopProfile(result)
    preparedByRoot.set(plan.paths.root, result)
    return { kind: "ready" as const, value: result }
  } catch (error) {
    return desktopBlocked(error instanceof Error ? error.message : "desktop_prepare_failed")
  }
}
export async function revalidateDesktopProfile(profile: DesktopPreparedProfile) {
  if (!prepared.has(profile)) throw new TypeError("TASK24_DESKTOP_PROFILE_AUTHORITY")
  requireDesktopPlan(profile.plan)
  await revalidateDesktopSpec(profile.plan.spec)
  if ((await directoryIdentity(profile.plan.paths.root)) !== profile.rootIdentity)
    throw new TypeError("TASK24_DESKTOP_PROFILE_DRIFT")
  for (const [target, id] of Object.entries(profile.directories)) {
    if ((await directoryIdentity(target)) !== id) throw new TypeError("TASK24_DESKTOP_DIRECTORY_DRIFT")
  }
  for (const file of profile.files)
    if (canonicalJson(await fileIdentity(file.path)) !== canonicalJson(file))
      throw new TypeError("TASK24_DESKTOP_FILE_DRIFT")
  const manifest = await readDesktopText(path.join(profile.plan.paths.root, "manifest.json"))
  if (manifest.sha256 !== profile.manifestSha256) throw new TypeError("TASK24_DESKTOP_MANIFEST_DRIFT")
}

/** Reloads only prepared files after a fresh audit; never reconstructs live process/session authority. */
export async function loadDesktopPreparedProfile(plan: DesktopLaunchPlan): Promise<DesktopPreparedProfile> {
  requireDesktopPlan(plan)
  const file = path.join(plan.paths.root, "manifest.json")
  const snapshot = await readDesktopText(file)
  const body = Schema.decodeUnknownSync(
    Schema.Struct({
      schemaVersion: Schema.Literal(1),
      planSha256: Schema.String,
      compatibilitySha256: Schema.String,
      rootIdentity: Schema.String,
      ownerNonce: Schema.String,
      files: Schema.Array(FileIdentity),
      directories: Schema.Record(Schema.String, Schema.String),
    }),
  )(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(snapshot.text), { onExcessProperty: "error" })
  const settingsFile = path.join(plan.paths.home, "AppData", "Roaming", "Docker", "settings-store.json")
  const expectedFiles = [path.join(plan.paths.root, "owner.json"), settingsFile].sort()
  const expectedDirectories = [
    ...new Set([
      path.dirname(plan.paths.root),
      ...Object.values(plan.paths),
      path.dirname(settingsFile),
      path.join(plan.paths.root, "state"),
      path.join(plan.paths.root, "state", "grants"),
    ]),
  ].sort()
  if (
    body.planSha256 !== plan.planSha256 ||
    body.compatibilitySha256 !== plan.compatibilitySha256 ||
    !/^[a-f0-9]{64}$/.test(body.ownerNonce) ||
    canonicalJson(body.files.map((f) => f.path).sort()) !== canonicalJson(expectedFiles) ||
    canonicalJson(Object.keys(body.directories).sort()) !== canonicalJson(expectedDirectories)
  )
    throw new TypeError("TASK24_DESKTOP_MANIFEST_BINDING")
  const owner = await readDesktopText(expectedFiles.find((f) => path.basename(f) === "owner.json")!)
  if (owner.text !== canonicalJson({ schemaVersion: 1, nonce: body.ownerNonce, planSha256: plan.planSha256 }))
    throw new TypeError("TASK24_DESKTOP_OWNER_BINDING")
  const profile: DesktopPreparedProfile = freeze({
    assurance: plan.assurance,
    plan,
    manifestSha256: snapshot.sha256,
    ownerNonce: body.ownerNonce,
    rootIdentity: body.rootIdentity,
    files: [...body.files, await fileIdentity(file)],
    directories: body.directories,
  })
  prepared.add(profile)
  await revalidateDesktopProfile(profile)
  return profile
}
