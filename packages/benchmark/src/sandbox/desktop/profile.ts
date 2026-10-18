import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { fileIdentity, directoryIdentity } from "../storage"
import { FileIdentity } from "../contracts"
import { sha256Text } from "../../hash"
import {
  DesktopObservation,
  desktopBlocked,
  type DesktopLaunchApproval,
  type DesktopLaunchPlan,
  type DesktopLaunchSpec,
  type DesktopPlatform,
  type DesktopPreparedProfile,
} from "./contracts"
import { readDesktopText, revalidateDesktopSpec } from "./compatibility"
import { requireDesktopPlan } from "./planning"
import { requireDesktopApproval } from "./approval"
export { confirmDesktopApproval, requireDesktopApproval } from "./approval"
export { planDesktopProfile, requireDesktopPlan } from "./planning"
import { withDesktopPublication, type DesktopPublication } from "./publication"

const prepared = new WeakSet<object>()
const preparedByRoot = new Map<string, DesktopPreparedProfile>()

async function writeGrant(publication: DesktopPublication, approval: DesktopLaunchApproval, plan: DesktopLaunchPlan) {
  requireDesktopApproval(approval, plan, approval.phase, approval.sid)
  await publication.write(
    path.join("state", "grants", approval.nonce + ".json"),
    canonicalJson({
      phase: approval.phase,
      launchID: approval.launchID,
      approvalSha256: sha256Text(canonicalJson(approval)),
    }),
  )
}
export async function consumeDesktopGrant(profile: DesktopPreparedProfile, approval: DesktopLaunchApproval) {
  requireDesktopApproval(approval, profile.plan, "start-readonly", approval.sid)
  if (approval.phase !== "start-readonly" || approval.manifestSha256 !== profile.manifestSha256)
    throw new TypeError("TASK24_DESKTOP_PROFILE_BINDING")
  return withDesktopPublication(
    profile.plan.paths.root,
    "existing",
    async (publication) => {
      await revalidateDesktopProfile(profile)
      await writeGrant(publication, approval, profile.plan)
    },
    { parentIdentity: profile.directories[path.dirname(profile.plan.paths.root)], rootIdentity: profile.rootIdentity },
  )
}
export async function writeDesktopActiveLock(profile: DesktopPreparedProfile, approval: DesktopLaunchApproval) {
  requireDesktopApproval(approval, profile.plan, "start-readonly", approval.sid)
  return withDesktopPublication(
    profile.plan.paths.root,
    "existing",
    async (publication) => {
      await revalidateDesktopProfile(profile)
      return publication.write(
        path.join("state", "active.json"),
        canonicalJson({ launchID: approval.launchID, nonce: approval.nonce }),
      )
    },
    { parentIdentity: profile.directories[path.dirname(profile.plan.paths.root)], rootIdentity: profile.rootIdentity },
  )
}
export async function removeDesktopActiveLock(profile: DesktopPreparedProfile, lock: FileIdentity) {
  if (!prepared.has(profile) || lock.path !== path.join(profile.plan.paths.root, "state", "active.json"))
    throw new TypeError("TASK24_DESKTOP_ACTIVE_LOCK")
  return withDesktopPublication(
    profile.plan.paths.root,
    "existing",
    async (publication) => {
      await publication.remove(lock)
    },
    { parentIdentity: profile.directories[path.dirname(profile.plan.paths.root)], rootIdentity: profile.rootIdentity },
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
    requireDesktopApproval(approval, plan, "prepare-profile", approval.sid)
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
    return await withDesktopPublication(
      plan.paths.root,
      "create",
      async (publication) => {
        const rootIdentity = await directoryIdentity(plan.paths.root)
        const owner = await publication.write(
          "owner.json",
          canonicalJson({ schemaVersion: 1, nonce: approval.nonce, planSha256: plan.planSha256 }),
        )
        await writeGrant(publication, approval, plan)
        await publication.directories()
        const settingsFile = path.join(plan.paths.home, "AppData", "Roaming", "Docker", "settings-store.json")
        const settings = await publication.write(
          path.relative(plan.paths.root, settingsFile),
          canonicalJson(plan.settings),
        )
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
        const manifest = await publication.write("manifest.json", text)
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
      },
      { parentIdentity },
    )
  } catch (error) {
    return desktopBlocked(error instanceof Error ? error.message : "desktop_prepare_failed")
  }
}
export async function revalidateDesktopProfile(profile: DesktopPreparedProfile) {
  if (!prepared.has(profile)) throw new TypeError("TASK24_DESKTOP_PROFILE_AUTHORITY")
  requireDesktopPlan(profile.plan)
  const settings = await readDesktopText(
    path.join(profile.plan.paths.home, "AppData", "Roaming", "Docker", "settings-store.json"),
  )
  if (settings.sha256 !== profile.plan.settingsSha256 || settings.text !== canonicalJson(profile.plan.settings))
    throw new TypeError("TASK24_DESKTOP_SETTINGS_BINDING")
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
  const settings = await readDesktopText(settingsFile)
  if (settings.sha256 !== plan.settingsSha256 || settings.text !== canonicalJson(plan.settings))
    throw new TypeError("TASK24_DESKTOP_SETTINGS_BINDING")
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
