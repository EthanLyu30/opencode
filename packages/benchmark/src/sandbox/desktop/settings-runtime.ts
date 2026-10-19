import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { sha256Text } from "../../hash"
import type { Gate } from "../contracts"
import { desktopBlocked, type DesktopLaunchSession } from "./contracts"
import type { DesktopLaunchApprovalV2, DesktopPreparedProfileV2 } from "./v2-contracts"
import { requireDesktopActiveLockV2, requireDesktopConsumedGrantV2 } from "./profile-v2"
import {
  withDesktopSettingsParents,
  withDesktopSettingsLease,
  sampleDesktopSettingsLease,
  type DesktopSettingsParents,
  type DesktopSettingsLease,
  requireDesktopSettingsLease,
} from "./settings-lease"
import type { DesktopSettingsSemantics } from "./settings-policy"
import { requireDesktopSettingsSession } from "./launch-v2"

export type DesktopSettingsBootstrap = Readonly<{ launchID: string }>
export type DesktopSettingsSeal = Readonly<{
  intentSha256: string
  policySha256: string
  planSha256: string
  manifestSha256: string
  sequence: number
  phase: "observed"
  semantics: DesktopSettingsSemantics
  sha256: string
}>
type Runtime = {
  profile: DesktopPreparedProfileV2
  approval: DesktopLaunchApprovalV2
  parents: DesktopSettingsParents
  close: () => void
  done: Promise<void>
  closed: boolean
  busy: boolean
  session?: DesktopLaunchSession
  seal?: DesktopSettingsSeal
  failure: string | null
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
  stopping: boolean
  stoppingParents?: DesktopSettingsParents
  stoppingSignal?: AbortSignal
  transitionChecked: boolean
}
const bootstraps = new WeakMap<DesktopSettingsBootstrap, Runtime>()
const begun = new WeakSet<DesktopLaunchApprovalV2>()
const sessions = new WeakMap<DesktopLaunchSession, Runtime>()
const seals = new WeakMap<DesktopSettingsSeal, { session: DesktopLaunchSession; lease: DesktopSettingsLease }>()
export function desktopSettingsError(error: unknown): string {
  return error instanceof Error && /^[a-zA-Z0-9_.:-]{1,200}$/.test(error.message)
    ? error.message
    : "TASK24_DESKTOP_SETTINGS_INVALID"
}
export async function beginDesktopSettingsRuntime(input: {
  profile: DesktopPreparedProfileV2
  approval: DesktopLaunchApprovalV2
  signal?: AbortSignal
}): Promise<DesktopSettingsBootstrap> {
  if (input.signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
  requireDesktopConsumedGrantV2(input.profile, input.approval)
  if (begun.has(input.approval)) throw new TypeError("TASK24_DESKTOP_SETTINGS_BOOTSTRAP_AUTHORITY")
  begun.add(input.approval)
  await requireDesktopActiveLockV2(input.profile, input.approval)
  if (input.approval.expiresAt <= Date.now()) throw new TypeError("TASK24_DESKTOP_SETTINGS_EXPIRED")
  let resolve!: (value: DesktopSettingsParents) => void, reject!: (error: unknown) => void, close!: () => void
  const ready = new Promise<DesktopSettingsParents>((yes, no) => {
    resolve = yes
    reject = no
  })
  const closing = new Promise<void>((yes) => {
    close = yes
  })
  const controller = new AbortController()
  const onAcquireAbort = () => {
    close()
    controller.abort()
  }
  input.signal?.addEventListener("abort", onAcquireAbort, { once: true })
  if (input.signal?.aborted) onAcquireAbort()
  const done = withDesktopSettingsParents(
    input.profile,
    async (parents) => {
      resolve(parents)
      await closing
    },
    controller.signal,
  )
  void done.catch(reject)
  try {
    const parents = await ready
    if (input.signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
    const state: Runtime = {
      ...input,
      parents,
      close,
      done,
      closed: false,
      busy: false,
      failure: null,
      stopping: false,
      transitionChecked: false,
      controller,
      timer: setTimeout(
        () => {
          state.closed = true
          close()
          controller.abort()
        },
        Math.min(120000, input.approval.expiresAt - Date.now()),
      ),
    }
    const token = Object.freeze({ launchID: input.approval.launchID })
    bootstraps.set(token, state)
    return token
  } catch (error) {
    close()
    controller.abort()
    await done.catch(() => {})
    throw error
  } finally {
    input.signal?.removeEventListener("abort", onAcquireAbort)
  }
}
export function bindDesktopSettingsRuntime(bootstrap: DesktopSettingsBootstrap, session: DesktopLaunchSession): void {
  const state = bootstraps.get(bootstrap),
    context = requireDesktopSettingsSession(session)
  if (
    !state ||
    state.closed ||
    state.session ||
    state.profile !== context.profile ||
    context.phase !== "starting" ||
    bootstrap.launchID !== session.launchID
  )
    throw new TypeError("TASK24_DESKTOP_SETTINGS_BOOTSTRAP_AUTHORITY")
  state.session = session
  sessions.set(session, state)
}
function requireRuntime(session: DesktopLaunchSession, starting = false) {
  const state = sessions.get(session),
    context = requireDesktopSettingsSession(session)
  if (
    !state ||
    state.closed ||
    state.failure ||
    (starting ? context.phase !== "starting" : context.phase !== "observed")
  )
    throw new TypeError(state?.failure ?? "TASK24_DESKTOP_SETTINGS_RUNTIME_AUTHORITY")
  if (Date.now() >= Math.min(context.startDeadline, state.approval.expiresAt))
    throw new TypeError("TASK24_DESKTOP_SETTINGS_EXPIRED")
  return state
}
export function readDesktopSettingsFailure(session: DesktopLaunchSession): string | null {
  return sessions.get(session)?.failure ?? null
}
export function requireDesktopSettingsSeal(session: DesktopLaunchSession, seal: DesktopSettingsSeal) {
  const state = requireRuntime(session),
    issued = seals.get(seal)
  if (!issued || issued.session !== session || state.seal?.sha256 !== seal.sha256)
    throw new TypeError("TASK24_DESKTOP_SETTINGS_SEAL_AUTHORITY")
  requireDesktopSettingsLease(issued.lease)
  return seal
}
function sealView(state: Runtime, lease: DesktopSettingsLease, sequence: number): DesktopSettingsSeal {
  const plan = state.profile.plan
  const body = {
    intentSha256: plan.intentSha256,
    policySha256: plan.policySha256,
    planSha256: plan.planSha256,
    manifestSha256: state.profile.manifestSha256,
    sequence,
    phase: "observed" as const,
    semantics: lease.semantics,
  }
  return freeze({ ...body, sha256: sha256Text(canonicalJson(body)) })
}
export async function sealDesktopSettingsRuntime(
  session: DesktopLaunchSession,
  signal: AbortSignal,
): Promise<Gate<DesktopSettingsSeal>> {
  let state: Runtime | undefined
  try {
    state = requireRuntime(session, true)
    if (state.busy || state.seal) throw new TypeError("TASK24_DESKTOP_SETTINGS_SEAL_AUTHORITY")
    state.busy = true
    try {
      const value = await sampleDesktopSettingsLease(
        state.parents,
        async (lease) => sealView(state!, lease, 1),
        signal,
        true,
      )
      state.seal = value
      return { kind: "ready", value }
    } catch (error) {
      if (desktopSettingsError(error) === "TASK24_DESKTOP_SETTINGS_INCOMPLETE")
        return desktopBlocked("settings_pending")
      throw error
    }
  } catch (error) {
    if (state && !state.seal) state.failure ??= desktopSettingsError(error)
    return desktopBlocked(desktopSettingsError(error))
  } finally {
    if (state) state.busy = false
  }
}
export async function withDesktopRuntimeSettings<T>(
  session: DesktopLaunchSession,
  use: (seal: DesktopSettingsSeal) => Promise<T>,
  signal = AbortSignal.timeout(15000),
): Promise<T> {
  const state = requireRuntime(session)
  if (!state.seal || state.busy) throw new TypeError("TASK24_DESKTOP_SETTINGS_RUNTIME_AUTHORITY")
  state.busy = true
  try {
    return await withDesktopSettingsLease(
      state.parents,
      async (lease) => {
        requireRuntime(session)
        const seal = sealView(state, lease, state.seal!.sequence)
        if (seal.sha256 !== state.seal!.sha256) throw new TypeError("TASK24_DESKTOP_SETTINGS_OBSERVED_DRIFT")
        seals.set(seal, { session, lease })
        const value = await use(seal)
        requireDesktopSettingsSeal(session, seal)
        return value
      },
      signal,
    )
  } catch (error) {
    state.failure ??= desktopSettingsError(error)
    throw error
  } finally {
    state.busy = false
  }
}
// Independent stop authority pins the chain across shutdown, not only across sampling.
export async function withDesktopStoppingSettings<T>(session: DesktopLaunchSession, use: () => Promise<T>): Promise<T> {
  const state = sessions.get(session),
    context = requireDesktopSettingsSession(session)
  if (!state || state.stopping || context.phase !== "stopping" || !context.stopConsumed || !context.stopDeadline)
    throw new TypeError("TASK24_DESKTOP_SETTINGS_STOP_AUTHORITY")
  state.stopping = true
  let entered = false
  const signal = AbortSignal.timeout(Math.max(1, context.stopDeadline - Date.now()))
  try {
    return await withDesktopSettingsParents(
      state.profile,
      async (parents) => {
        entered = true
        state.stoppingParents = parents
        state.stoppingSignal = signal
        try {
          return await use()
        } finally {
          state.stoppingParents = undefined
          state.stoppingSignal = undefined
        }
      },
      signal,
    )
  } catch (error) {
    if (entered) throw error
    state.failure ??= desktopSettingsError(error)
    // Configuration protection cannot revoke the already consumed, re-owned stop target.
    return use()
  } finally {
    state.stopping = false
  }
}
// Stop validates settings only for diagnostics, never to grant or veto process cleanup.
export async function observeDesktopStoppingSettings(session: DesktopLaunchSession): Promise<void> {
  const state = sessions.get(session),
    context = requireDesktopSettingsSession(session)
  if (!state || context.phase !== "stopping" || !context.stopConsumed || !context.stopDeadline)
    throw new TypeError("TASK24_DESKTOP_SETTINGS_STOP_AUTHORITY")
  try {
    if (!state.stoppingParents || !state.stoppingSignal) throw new TypeError("TASK24_DESKTOP_SETTINGS_STOP_PARENTS")
    const transition = !state.transitionChecked
    state.transitionChecked = true
    await withDesktopSettingsLease(
      state.stoppingParents,
      async (lease) => {
        if (transition && state.seal && sealView(state, lease, state.seal.sequence).sha256 !== state.seal.sha256)
          throw new TypeError("TASK24_DESKTOP_SETTINGS_OBSERVED_DRIFT")
      },
      state.stoppingSignal,
    )
  } catch (error) {
    state.failure ??= desktopSettingsError(error)
  }
}
export async function finishDesktopSettingsRuntime(
  subject: DesktopLaunchSession | DesktopSettingsBootstrap,
): Promise<void> {
  const state = sessions.get(subject) ?? bootstraps.get(subject)
  if (!state) throw new TypeError("TASK24_DESKTOP_SETTINGS_RUNTIME_AUTHORITY")
  state.closed = true
  clearTimeout(state.timer)
  state.close()
  try {
    await state.done
  } finally {
    state.controller.abort()
  }
}
