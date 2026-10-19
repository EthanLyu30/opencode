import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Bytes } from "../../hash"
import { readDesktopDirectoryV2 } from "./identity-v2"
import { requireDesktopPreparedProfileV2, revalidateDesktopProfileV2 } from "./profile-v2"
import { readDesktopPlanAuthorityV2 } from "./planning-v2"
import {
  desktopTemporaryNames,
  validateDesktopSettingsSet,
  type DesktopSettingsPolicy,
  type DesktopSettingsBytes,
  type DesktopSettingsSemantics,
} from "./settings-policy"
import { withDesktopPublicationV2, type DesktopPublicationV2 } from "./publication-v2"
import type { DesktopPreparedProfileV2, DesktopSettingsTarget } from "./v2-contracts"

export type DesktopSettingsParents = Readonly<{ rootIdentity: string }>
export type DesktopSettingsLease = Readonly<{
  files: readonly DesktopSettingsBytes[]
  temporary: readonly DesktopSettingsBytes[]
  semantics: DesktopSettingsSemantics
  signal: AbortSignal
}>
type ParentState = {
  profile: DesktopPreparedProfileV2
  policy: DesktopSettingsPolicy
  io: DesktopPublicationV2
  signal: AbortSignal
  live: boolean
  leased: boolean
}
const parents = new WeakMap<DesktopSettingsParents, ParentState>()
const leases = new WeakMap<DesktopSettingsLease, { parent: ParentState; live: boolean }>()

export async function withDesktopSettingsParents<T>(
  profile: DesktopPreparedProfileV2,
  use: (parents: DesktopSettingsParents, signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  requireDesktopPreparedProfileV2(profile)
  if (signal.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
  await revalidateDesktopProfileV2(profile, "immutable")
  const authority = readDesktopPlanAuthorityV2(profile.plan)
  return withDesktopPublicationV2(
    { root: profile.plan.paths.root, mode: "profile", parents: profile.directories, signal },
    async (io) => {
      for (const file of profile.immutableFiles) await io.pin(file)
      const state: ParentState = { profile, policy: authority.policy, io, signal, live: true, leased: false }
      const token = Object.freeze({ rootIdentity: profile.rootIdentity })
      parents.set(token, state)
      try {
        return await use(token, signal)
      } finally {
        state.live = false
      }
    },
  )
}

function requireParents(token: DesktopSettingsParents) {
  const state = parents.get(token)
  if (!state || !state.live || state.signal.aborted) throw new TypeError("TASK24_DESKTOP_SETTINGS_PARENTS_AUTHORITY")
  return state
}
export function requireDesktopSettingsLease(lease: DesktopSettingsLease) {
  const state = leases.get(lease)
  if (
    !state ||
    !state.live ||
    !state.parent.live ||
    lease.signal.aborted ||
    [...lease.files, ...lease.temporary].some((f) => sha256Bytes(f.bytes) !== f.identity.sha256)
  )
    throw new TypeError("TASK24_DESKTOP_SETTINGS_LEASE_AUTHORITY")
  return lease
}
async function inventory(state: ParentState) {
  const root = state.profile.plan.paths.root,
    targets = state.profile.plan.runtimeTargets
  const finals = Object.entries(targets).map(([target, file]) => ({
    target: target as DesktopSettingsTarget,
    relative: path.relative(root, file),
  }))
  const temporary = desktopTemporaryNames(state.policy),
    allowed = [...finals, ...temporary]
  const entries: typeof allowed = []
  for (const directory of [...new Set(Object.values(targets).map((f) => path.dirname(f)))]) {
    if ((await readDesktopDirectoryV2(directory)).fileID !== state.profile.directories[directory])
      throw new TypeError("TASK24_DESKTOP_SETTINGS_DIRECTORY_DRIFT")
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = path.relative(root, path.join(directory, entry.name)),
        known = allowed.find((f) => f.relative === relative)
      if (!known || !entry.isFile() || entry.isSymbolicLink())
        throw new TypeError("TASK24_DESKTOP_SETTINGS_UNKNOWN_FILE")
      const stat = await fs.lstat(path.join(root, relative), { bigint: true })
      if (stat.nlink !== 1n || stat.isSymbolicLink() || stat.size > 1048576n)
        throw new TypeError("TASK24_DESKTOP_SETTINGS_FILE")
      entries.push(known)
    }
  }
  if (finals.some((f) => !entries.some((e) => e.relative === f.relative)))
    throw new TypeError("TASK24_DESKTOP_SETTINGS_INCOMPLETE")
  if (entries.length > 6) throw new TypeError("TASK24_DESKTOP_SETTINGS_SET_LIMIT")
  return entries.sort((a, b) => (a.relative < b.relative ? -1 : 1))
}

export async function withDesktopSettingsLease<T>(
  token: DesktopSettingsParents,
  use: (lease: DesktopSettingsLease) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const state = requireParents(token)
  if (state.leased || signal.aborted) throw new TypeError("TASK24_DESKTOP_SETTINGS_LEASE_BUSY")
  state.leased = true
  let acquired = false,
    lease: DesktopSettingsLease | undefined
  try {
    await revalidateDesktopProfileV2(state.profile, "immutable")
    const names = await inventory(state)
    await state.io.acquire(names.map((f) => f.relative))
    acquired = true
    if (canonicalJson(names) !== canonicalJson(await inventory(state)))
      throw new TypeError("TASK24_DESKTOP_SETTINGS_UNSTABLE")
    const files: DesktopSettingsBytes[] = [],
      temporary: DesktopSettingsBytes[] = []
    for (const entry of names) {
      const file = await state.io.read(entry.relative)
      const value = Object.freeze({
        ...entry,
        bytes: Uint8Array.from(file.bytes),
        identity: Object.freeze(file.identity),
      })
      ;(state.profile.plan.runtimeTargets[entry.target] === file.identity.path ? files : temporary).push(value)
    }
    const semantics = validateDesktopSettingsSet({
      policy: state.policy,
      intent: state.profile.plan.intent,
      files,
      temporary,
      phase: "observed",
    })
    lease = Object.freeze({
      files: Object.freeze(files),
      temporary: Object.freeze(temporary),
      semantics,
      signal: AbortSignal.any([state.signal, signal]),
    })
    leases.set(lease, { parent: state, live: true })
    requireDesktopSettingsLease(lease)
    const result = await use(lease)
    requireDesktopSettingsLease(lease)
    if (canonicalJson(names) !== canonicalJson(await inventory(state)))
      throw new TypeError("TASK24_DESKTOP_SETTINGS_UNSTABLE")
    for (const original of [...files, ...temporary]) {
      const current = await state.io.read(original.relative)
      if (canonicalJson(current.identity) !== canonicalJson(original.identity))
        throw new TypeError("TASK24_DESKTOP_SETTINGS_UNSTABLE")
    }
    await revalidateDesktopProfileV2(state.profile, "immutable")
    return result
  } finally {
    if (lease) leases.get(lease)!.live = false
    try {
      if (acquired) await state.io.release()
    } finally {
      state.leased = false
    }
  }
}
