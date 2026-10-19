import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { sha256Text } from "../../hash"
import type { FileIdentity } from "../contracts"
import { DesktopObservation, desktopBlocked, type DesktopPlatform } from "./contracts"
import {
  DesktopManifestV2,
  decodeDesktopIntentV2,
  desktopRuntimeTargetsV2,
  type DesktopLaunchSpecV2,
  type DesktopLaunchPlanV2,
  type DesktopLaunchApprovalV2,
  type DesktopPreparedProfileV2,
} from "./v2-contracts"
import { readDesktopPlanAuthorityV2, requireDesktopPlanV2 } from "./planning-v2"
import { requireDesktopApprovalV2 } from "./approval-v2"
import { revalidateDesktopSettingsPolicy } from "./settings-policy"
import { requireDesktopWorkloadFact } from "./workload-boundary"
import { readDesktopDirectoryV2, readDesktopFileV2 } from "./identity-v2"
import { withDesktopPublicationV2, desktopProfileLayoutV2, type DesktopPublicationV2 } from "./publication-v2"
import type { DesktopRecordAnchor } from "./publication"
import { parseDesktopSettingsJson } from "./settings-json"

const prepared = new WeakSet<DesktopPreparedProfileV2>()
const byRoot = new Map<string, DesktopPreparedProfileV2>()
const consumed = new WeakMap<
  DesktopLaunchApprovalV2,
  { profile: DesktopPreparedProfileV2; anchor: DesktopRecordAnchor }
>()
const active = new WeakMap<DesktopPreparedProfileV2, FileIdentity>()
const usedStartNonces = new Map<string, Set<string>>()
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes)
function fail(error: unknown) {
  return desktopBlocked(
    error instanceof Error && /^[a-zA-Z0-9_.:-]{1,200}$/.test(error.message)
      ? error.message
      : "TASK24_DESKTOP_V2_PROFILE",
  )
}
async function planFacts(plan: DesktopLaunchPlanV2) {
  const authority = readDesktopPlanAuthorityV2(plan)
  await revalidateDesktopSettingsPolicy(authority.policy)
  await requireDesktopWorkloadFact(authority.workload, plan.spec, authority.platform)
}
async function writeGrant(io: DesktopPublicationV2, approval: DesktopLaunchApprovalV2) {
  return io.write(
    path.join("state", "grants", approval.nonce + ".json"),
    canonicalJson({
      phase: approval.phase,
      launchID: approval.launchID,
      approvalSha256: sha256Text(canonicalJson(approval)),
    }),
  )
}
function requireProfile(profile: DesktopPreparedProfileV2) {
  if (!prepared.has(profile)) throw new TypeError("TASK24_DESKTOP_V2_PROFILE_AUTHORITY")
  requireDesktopPlanV2(profile.plan)
}
export function requireDesktopPreparedProfileV2(profile: DesktopPreparedProfileV2) {
  requireProfile(profile)
}

export async function revalidateDesktopProfileV2(profile: DesktopPreparedProfileV2, mode: "prepared" | "immutable") {
  requireProfile(profile)
  if (!["prepared", "immutable"].includes(mode)) throw new TypeError("TASK24_DESKTOP_V2_PROFILE_MODE")
  const plan = profile.plan
  await revalidateDesktopSettingsPolicy(readDesktopPlanAuthorityV2(plan).policy)
  for (const [directory, id] of Object.entries(profile.directories))
    if ((await readDesktopDirectoryV2(directory)).fileID !== id)
      throw new TypeError("TASK24_DESKTOP_V2_DIRECTORY_DRIFT")
  for (const file of profile.immutableFiles)
    if (
      canonicalJson(
        (await readDesktopFileV2(file.path, file.path === path.join(plan.paths.root, "intent.json") ? 16384 : 1048576))
          .identity,
      ) !== canonicalJson(file)
    )
      throw new TypeError("TASK24_DESKTOP_V2_IMMUTABLE_DRIFT")
  const intent = await readDesktopFileV2(path.join(plan.paths.root, "intent.json"), 16384)
  decodeDesktopIntentV2(text(intent.bytes), {
    dataRoot: plan.spec.dataRoot,
    policyID: plan.policyID,
    policySha256: plan.policySha256,
  })
  if (intent.identity.sha256 !== plan.intentSha256) throw new TypeError("TASK24_DESKTOP_V2_INTENT_BINDING")
  if (mode === "immutable") return
  const seed = await readDesktopFileV2(profile.seed.path)
  if (
    canonicalJson(seed.identity) !== canonicalJson(profile.seed) ||
    seed.identity.sha256 !== plan.seedSha256 ||
    text(seed.bytes) !== canonicalJson(plan.intent.expected)
  )
    throw new TypeError("TASK24_DESKTOP_V2_SEED_DRIFT")
  for (const file of [plan.runtimeTargets.daemon, plan.runtimeTargets["windows-daemon"]])
    if (await fs.exists(file)) throw new TypeError("TASK24_DESKTOP_V2_PREPARED_RUNTIME")
}

export async function prepareDesktopProfileV2(input: {
  spec: DesktopLaunchSpecV2
  plan: DesktopLaunchPlanV2
  approval: DesktopLaunchApprovalV2
  platform: DesktopPlatform
  signal?: AbortSignal
}) {
  try {
    const plan = input.plan,
      approval = input.approval
    if (input.signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
    requireDesktopPlanV2(plan, input.platform)
    requireDesktopApprovalV2(approval, plan, "prepare-profile", approval.sid)
    if (canonicalJson(input.spec) !== canonicalJson(plan.spec)) throw new TypeError("TASK24_DESKTOP_SPEC_DRIFT")
    await planFacts(plan)
    const state = Schema.decodeUnknownSync(DesktopObservation)(await input.platform.observe(plan.spec, input.signal), {
      onExcessProperty: "error",
    })
    requireDesktopApprovalV2(approval, plan, "prepare-profile", state.sid)
    if (state.runningDocker || state.runningWsl || !["idle", "stopped"].includes(state.phase))
      throw new TypeError("TASK24_DESKTOP_START_CONFLICT")
    if (await fs.exists(plan.paths.root)) {
      const old = byRoot.get(plan.paths.root)
      if (!old || old.ownerNonce !== approval.nonce || old.plan.planSha256 !== plan.planSha256)
        throw new TypeError("TASK24_DESKTOP_PROFILE_EXISTS")
      await revalidateDesktopProfileV2(old, "prepared")
      return { kind: "ready" as const, value: old }
    }
    const parent = await readDesktopDirectoryV2(path.dirname(plan.paths.root))
    return await withDesktopPublicationV2(
      {
        root: plan.paths.root,
        mode: "create-profile",
        parents: parent.parents,
        signal: input.signal ?? AbortSignal.timeout(30000),
      },
      async (io) => {
        requireDesktopApprovalV2(approval, plan, "prepare-profile", state.sid)
        await planFacts(plan)
        const directories = await io.directories(),
          rootIdentity = directories[plan.paths.root]!
        const owner = await io.write(
          "owner.json",
          canonicalJson({ schemaVersion: 2, nonce: approval.nonce, planSha256: plan.planSha256 }),
        )
        const grant = await writeGrant(io, approval)
        const intent = await io.write("intent.json", canonicalJson(plan.intent))
        const seed = await io.write(
          path.relative(plan.paths.root, plan.runtimeTargets["settings-store"]),
          canonicalJson(plan.intent.expected),
        )
        const body = {
          schemaVersion: 2 as const,
          planSha256: plan.planSha256,
          compatibilitySha256: plan.compatibilitySha256,
          intentSha256: plan.intentSha256,
          policySha256: plan.policySha256,
          rootIdentity,
          ownerNonce: approval.nonce,
          immutableFiles: [owner, grant, intent],
          seed,
          runtimeTargets: plan.runtimeTargets,
          directories,
        }
        const manifest = await io.write("manifest.json", canonicalJson(body))
        const result = freeze({
          assurance: plan.assurance,
          plan,
          manifestSha256: manifest.sha256,
          ownerNonce: approval.nonce,
          rootIdentity,
          immutableFiles: [owner, grant, intent, manifest],
          seed,
          runtimeTargets: plan.runtimeTargets,
          directories,
        })
        prepared.add(result)
        await revalidateDesktopProfileV2(result, "prepared")
        byRoot.set(plan.paths.root, result)
        return { kind: "ready" as const, value: result }
      },
    )
  } catch (error) {
    return fail(error)
  }
}

export async function loadDesktopPreparedProfileV2(plan: DesktopLaunchPlanV2): Promise<DesktopPreparedProfileV2> {
  requireDesktopPlanV2(plan)
  await planFacts(plan)
  const liveEntry = await fs.lstat(path.join(plan.paths.root, "state", "active.json")).then(
    () => true,
    (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
      throw error
    },
  )
  if (liveEntry) throw new TypeError("TASK24_DESKTOP_V2_ACTIVE_NOT_PREPARED")
  const file = await readDesktopFileV2(path.join(plan.paths.root, "manifest.json"))
  const body = Schema.decodeUnknownSync(DesktopManifestV2)(parseDesktopSettingsJson(file.bytes, 1048576), {
    onExcessProperty: "error",
  })
  const expected = ["owner.json", "intent.json", path.join("state", "grants", body.ownerNonce + ".json")]
    .map((p) => path.join(plan.paths.root, p))
    .sort()
  const actual = body.immutableFiles.map((f) => f.path).sort()
  const dirs = await readDesktopDirectoryV2(plan.paths.root)
  const names = [
    ...new Set([...Object.keys(dirs.parents), ...desktopProfileLayoutV2.map((p) => path.join(plan.paths.root, p))]),
  ].sort()
  if (
    body.planSha256 !== plan.planSha256 ||
    body.compatibilitySha256 !== plan.compatibilitySha256 ||
    body.intentSha256 !== plan.intentSha256 ||
    body.policySha256 !== plan.policySha256 ||
    canonicalJson(actual) !== canonicalJson(expected) ||
    canonicalJson(Object.keys(body.directories).sort()) !== canonicalJson(names) ||
    canonicalJson(body.runtimeTargets) !== canonicalJson(plan.runtimeTargets) ||
    body.seed.path !== plan.runtimeTargets["settings-store"] ||
    body.seed.sha256 !== plan.seedSha256 ||
    body.rootIdentity !== dirs.fileID
  )
    throw new TypeError("TASK24_DESKTOP_V2_MANIFEST_BINDING")
  const owner = await readDesktopFileV2(path.join(plan.paths.root, "owner.json"))
  const expectedOwner = canonicalJson({ schemaVersion: 2, nonce: body.ownerNonce, planSha256: plan.planSha256 })
  if (text(owner.bytes) !== expectedOwner) throw new TypeError("TASK24_DESKTOP_V2_OWNER_BINDING")
  const result = freeze({
    assurance: plan.assurance,
    plan,
    manifestSha256: file.identity.sha256,
    ownerNonce: body.ownerNonce,
    rootIdentity: body.rootIdentity,
    immutableFiles: [...body.immutableFiles, file.identity],
    seed: body.seed,
    runtimeTargets: desktopRuntimeTargetsV2(plan.paths.root),
    directories: body.directories,
  })
  prepared.add(result)
  await revalidateDesktopProfileV2(result, "prepared")
  return result
}

export function requireDesktopConsumedGrantV2(profile: DesktopPreparedProfileV2, approval: DesktopLaunchApprovalV2) {
  requireProfile(profile)
  if (consumed.get(approval)?.profile !== profile || approval.phase !== "start-readonly")
    throw new TypeError("TASK24_DESKTOP_V2_CONSUMPTION_AUTHORITY")
}
export function readDesktopConsumedRecordAnchorV2(
  profile: DesktopPreparedProfileV2,
  approval: DesktopLaunchApprovalV2,
): DesktopRecordAnchor {
  requireDesktopConsumedGrantV2(profile, approval)
  return freeze(structuredClone(consumed.get(approval)!.anchor))
}
export async function consumeDesktopGrantV2(profile: DesktopPreparedProfileV2, approval: DesktopLaunchApprovalV2) {
  requireProfile(profile)
  requireDesktopApprovalV2(approval, profile.plan, "start-readonly", approval.sid)
  if (approval.phase !== "start-readonly" || approval.manifestSha256 !== profile.manifestSha256)
    throw new TypeError("TASK24_DESKTOP_PROFILE_BINDING")
  await revalidateDesktopProfileV2(profile, "prepared")
  await planFacts(profile.plan)
  const anchor = path.dirname(profile.plan.paths.root),
    anchorID = (await readDesktopDirectoryV2(anchor)).fileID
  const proof = await readDesktopDirectoryV2(profile.plan.paths.root)
  const key = profile.plan.paths.root + ":" + profile.rootIdentity
  const used = usedStartNonces.get(key) ?? new Set<string>()
  if (used.has(approval.nonce)) throw new TypeError("TASK24_DESKTOP_V2_NONCE_REPLAY")
  // Burn the attempt before publication awaits: neither deletion nor concurrent requests can retry it.
  used.add(approval.nonce)
  usedStartNonces.set(key, used)
  await withDesktopPublicationV2(
    { root: profile.plan.paths.root, mode: "profile", parents: proof.parents, signal: AbortSignal.timeout(30000) },
    async (io) => {
      await revalidateDesktopProfileV2(profile, "prepared")
      requireDesktopApprovalV2(approval, profile.plan, "start-readonly", approval.sid)
      await writeGrant(io, approval)
    },
  )
  consumed.set(approval, { profile, anchor: { path: anchor, identity: anchorID } })
}
export async function writeDesktopActiveLockV2(
  profile: DesktopPreparedProfileV2,
  approval: DesktopLaunchApprovalV2,
): Promise<FileIdentity> {
  requireDesktopConsumedGrantV2(profile, approval)
  requireDesktopApprovalV2(approval, profile.plan, "start-readonly", approval.sid)
  const parents = (await readDesktopDirectoryV2(profile.plan.paths.root)).parents
  const lock = await withDesktopPublicationV2(
    { root: profile.plan.paths.root, mode: "profile", parents, signal: AbortSignal.timeout(30000) },
    async (io) => {
      await revalidateDesktopProfileV2(profile, "prepared")
      return io.write(
        path.join("state", "active.json"),
        canonicalJson({ launchID: approval.launchID, nonce: approval.nonce }),
      )
    },
  )
  active.set(profile, lock)
  return lock
}
export async function removeDesktopActiveLockV2(profile: DesktopPreparedProfileV2, lock: FileIdentity): Promise<void> {
  requireProfile(profile)
  if (active.get(profile) !== lock || lock.path !== path.join(profile.plan.paths.root, "state", "active.json"))
    throw new TypeError("TASK24_DESKTOP_V2_ACTIVE_LOCK")
  const requireParents = async () => {
    const state = await readDesktopDirectoryV2(path.join(profile.plan.paths.root, "state"))
    if (Object.entries(state.parents).some(([name, id]) => profile.directories[name] !== id))
      throw new TypeError("TASK24_DESKTOP_V2_ACTIVE_PARENT_DRIFT")
  }
  await requireParents()
  const parents = (await readDesktopDirectoryV2(profile.plan.paths.root)).parents
  await withDesktopPublicationV2(
    { root: profile.plan.paths.root, mode: "profile", parents, signal: AbortSignal.timeout(30000) },
    async (io) => {
      await requireParents()
      await io.remove(lock)
    },
  )
  active.delete(profile)
}
export async function requireDesktopActiveLockV2(profile: DesktopPreparedProfileV2, approval: DesktopLaunchApprovalV2) {
  requireDesktopConsumedGrantV2(profile, approval)
  const lock = active.get(profile)
  if (!lock || canonicalJson((await readDesktopFileV2(lock.path)).identity) !== canonicalJson(lock))
    throw new TypeError("TASK24_DESKTOP_V2_ACTIVE_LOCK")
  return lock
}
