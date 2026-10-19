import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import type { Gate, FileIdentity } from "../contracts"
import {
  DesktopObservation,
  ProcessIdentity,
  desktopBlocked,
  type DesktopLaunchSession,
  type DesktopPlatform,
  type DesktopProcessIdentity,
  type DesktopAttemptDiagnostics,
} from "./contracts"
import type {
  DesktopLaunchSpecV2,
  DesktopPreparedProfileV2,
  DesktopLaunchApprovalV2,
  DesktopSettingsPhase,
} from "./v2-contracts"
import {
  revalidateDesktopProfileV2,
  consumeDesktopGrantV2,
  writeDesktopActiveLockV2,
  removeDesktopActiveLockV2,
  requireDesktopActiveLockV2,
} from "./profile-v2"
import { requireDesktopPlanV2, readDesktopPlanAuthorityV2 } from "./planning-v2"
import { requireDesktopApprovalV2 } from "./approval-v2"
import { withDesktopWorkloadFact } from "./workload-boundary"
import { boundedDesktopOperation } from "./launch"
import {
  beginDesktopSettingsRuntime,
  bindDesktopSettingsRuntime,
  sealDesktopSettingsRuntime,
  finishDesktopSettingsRuntime,
  readDesktopSettingsFailure,
  withDesktopRuntimeSettings,
  observeDesktopStoppingSettings,
  withDesktopStoppingSettings,
  desktopSettingsError,
  type DesktopSettingsBootstrap,
  type DesktopSettingsSeal,
  requireDesktopSettingsSeal,
} from "./settings-runtime"

type State = {
  spec: DesktopLaunchSpecV2
  profile: DesktopPreparedProfileV2
  approval: DesktopLaunchApprovalV2
  platform: DesktopPlatform
  process: DesktopProcessIdentity
  lock: FileIdentity
  phase: DesktopSettingsPhase
  startDeadline: number
  stopDeadline: number | null
  stopConsumed: boolean
  stop?: Promise<Gate<"stopped">>
  failureCode?: string
  last?: typeof DesktopObservation.Type
}
const states = new WeakMap<DesktopLaunchSession, State>()
const diagnostics = new WeakMap<object, DesktopAttemptDiagnostics>()
const cleanups = new WeakMap<object, "stopped" | "uncertain" | "not_needed">()
export const isDesktopSessionV2 = (session: DesktopLaunchSession) => states.has(session)
export const readDesktopAttemptDiagnosticsV2 = (result: object) => diagnostics.get(result)
export const readDesktopAttemptCleanupV2 = (result: object) => cleanups.get(result)
export function requireDesktopSettingsSession(session: DesktopLaunchSession) {
  const state = states.get(session)
  if (!state) throw new TypeError("TASK24_DESKTOP_SESSION_AUTHORITY")
  if (state.phase === "observed" && state.approval.expiresAt <= Date.now()) state.phase = "stale"
  return Object.freeze({
    spec: state.spec,
    profile: state.profile,
    platform: state.platform,
    process: state.process,
    phase: state.phase,
    startDeadline: state.startDeadline,
    stopDeadline: state.stopDeadline,
    stopConsumed: state.stopConsumed,
  })
}
function diagnostic(
  state: State | undefined,
  failureCode: string | null,
  cleanupCode: string | null,
): DesktopAttemptDiagnostics {
  const last = state?.last
  return freeze(
    structuredClone({
      failureCode,
      cleanupCode,
      ownedProcess: state?.process ?? null,
      lastObservation: last
        ? {
            phase: last.phase,
            runningDocker: last.runningDocker,
            runningWsl: last.runningWsl,
            process: last.process ?? null,
            pipe: last.pipe ?? null,
            related: (last.related ?? []).slice(0, 16),
            relatedOmitted: Math.max(0, (last.related?.length ?? 0) - 16),
          }
        : null,
    }),
  )
}
function owned(raw: unknown, state: State, starting = false) {
  const value = Schema.decodeUnknownSync(DesktopObservation)(raw, { onExcessProperty: "error" })
  state.last = value
  if (
    starting &&
    value.phase === "starting" &&
    !value.pipe &&
    value.sid === state.process.ownerSID &&
    canonicalJson(value.process) === canonicalJson(state.process)
  )
    return value
  if (
    value.phase !== "running" ||
    !value.process ||
    !value.pipe ||
    value.sid !== state.process.ownerSID ||
    canonicalJson(value.process) !== canonicalJson(state.process) ||
    value.pipe.endpoint !== state.profile.plan.endpoint ||
    canonicalJson(value.pipe.owner.image) !== canonicalJson(state.spec.install.backend)
  )
    throw new TypeError("TASK24_DESKTOP_PROCESS_IDENTITY")
  const related = value.related ?? []
  if (related.length > 256 || new Set(related.map((p) => p.pid)).size !== related.length)
    throw new TypeError("TASK24_DESKTOP_PROCESS_RELATIONSHIP")
  let child = value.pipe.owner
  const visited = new Set<number>()
  while (child.pid !== state.process.pid) {
    if (
      visited.has(child.pid) ||
      !related.some((p) => canonicalJson(p) === canonicalJson(child)) ||
      child.ownerSID !== state.process.ownerSID ||
      !Object.values(state.spec.install).some((f) => canonicalJson(f) === canonicalJson(child.image))
    )
      throw new TypeError("TASK24_DESKTOP_PROCESS_RELATIONSHIP")
    visited.add(child.pid)
    const parent = related.find((p) => p.pid === child.parentPID)
    if (!parent) throw new TypeError("TASK24_DESKTOP_PROCESS_RELATIONSHIP")
    child = parent
  }
  if (canonicalJson(child) !== canonicalJson(state.process)) throw new TypeError("TASK24_DESKTOP_PROCESS_IDENTITY")
  return value
}
export async function revalidateDesktopLaunchSessionV2(session: DesktopLaunchSession, signal?: AbortSignal) {
  const state = states.get(session),
    context = requireDesktopSettingsSession(session)
  if (!state || context.phase !== "observed") throw new TypeError("TASK24_DESKTOP_SESSION_AUTHORITY")
  await withDesktopRuntimeSettings(session, (seal) => observeDesktopLaunchSessionV2(session, seal, signal), signal)
  return Object.freeze({
    spec: state.spec,
    profile: state.profile,
    platform: state.platform,
    assurance: "fixture" as const,
  })
}
export async function observeDesktopLaunchSessionV2(
  session: DesktopLaunchSession,
  seal: DesktopSettingsSeal,
  signal?: AbortSignal,
) {
  const state = states.get(session)
  requireDesktopSettingsSeal(session, seal)
  if (!state) throw new TypeError("TASK24_DESKTOP_SESSION_AUTHORITY")
  await requireDesktopActiveLockV2(state.profile, state.approval)
  const value = owned(await boundedDesktopOperation(state.platform.observe(state.spec, signal), 15000, signal), state)
  requireDesktopSettingsSeal(session, seal)
  return value
}
export async function startDesktopReadonlyV2(input: {
  spec: DesktopLaunchSpecV2
  profile: DesktopPreparedProfileV2
  approval: DesktopLaunchApprovalV2
  platform: DesktopPlatform
  signal: AbortSignal
}): Promise<Gate<DesktopLaunchSession>> {
  let session: DesktopLaunchSession | undefined,
    bootstrap: DesktopSettingsBootstrap | undefined,
    lock: FileIdentity | undefined,
    attempted = false,
    consuming = false,
    creatingLock = false
  let startOperation: Promise<unknown> | undefined
  const deadline = Date.now() + 120000
  const run = <T>(operation: Promise<T>) =>
    boundedDesktopOperation(operation, Math.min(deadline, input.approval.expiresAt) - Date.now(), input.signal)
  try {
    if (input.signal.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
    requireDesktopPlanV2(input.profile.plan, input.platform)
    requireDesktopApprovalV2(input.approval, input.profile.plan, "start-readonly", input.approval.sid)
    if (canonicalJson(input.spec) !== canonicalJson(input.profile.plan.spec))
      throw new TypeError("TASK24_DESKTOP_SPEC_DRIFT")
    await run(revalidateDesktopProfileV2(input.profile, "prepared"))
    const observation = Schema.decodeUnknownSync(DesktopObservation)(
      await run(input.platform.observe(input.spec, input.signal)),
      { onExcessProperty: "error" },
    )
    requireDesktopApprovalV2(input.approval, input.profile.plan, "start-readonly", observation.sid)
    if (
      input.approval.phase !== "start-readonly" ||
      input.approval.manifestSha256 !== input.profile.manifestSha256 ||
      observation.runningDocker ||
      observation.runningWsl ||
      !["idle", "stopped"].includes(observation.phase)
    )
      throw new TypeError("TASK24_DESKTOP_START_CONFLICT")
    const authority = readDesktopPlanAuthorityV2(input.profile.plan)
    const stageSignal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(Math.max(1, Math.min(deadline, input.approval.expiresAt) - Date.now())),
    ])
    const checkStart = () => {
      if (stageSignal.aborted || Date.now() >= Math.min(deadline, input.approval.expiresAt))
        throw new TypeError("TASK24_DESKTOP_CANCELLED")
    }
    startOperation = withDesktopWorkloadFact(
      authority.workload,
      input.spec,
      input.platform,
      async () => {
        checkStart()
        consuming = true
        // Resource-producing operations acknowledge completion/cancellation before ownership is discarded.
        await consumeDesktopGrantV2(input.profile, input.approval, stageSignal)
        consuming = false
        checkStart()
        creatingLock = true
        lock = await writeDesktopActiveLockV2(input.profile, input.approval, stageSignal)
        creatingLock = false
        checkStart()
        bootstrap = await beginDesktopSettingsRuntime({ ...input, signal: stageSignal })
        requireDesktopApprovalV2(input.approval, input.profile.plan, "start-readonly", observation.sid)
        checkStart()
        attempted = true
        // The caller's deadline may return uncertainty, but cannot release the protected
        // workload while an already invoked start still has not actually returned.
        return input.platform.start(input.profile.plan)
      },
      stageSignal,
    )
    const process = Schema.decodeUnknownSync(ProcessIdentity)(await run(startOperation), { onExcessProperty: "error" })
    if (
      process.ownerSID !== observation.sid ||
      !Object.values(input.spec.install).some((f) => canonicalJson(f) === canonicalJson(process.image))
    )
      throw new TypeError("TASK24_DESKTOP_START_IDENTITY")
    session = Object.freeze({ launchID: input.approval.launchID })
    const state: State = {
      ...input,
      process,
      lock: lock!,
      phase: "starting",
      startDeadline: deadline,
      stopDeadline: null,
      stopConsumed: true,
    }
    states.set(session, state)
    bindDesktopSettingsRuntime(bootstrap!, session)
    let settingsSealed = false
    while (true) {
      const observation = owned(await run(input.platform.observe(input.spec, input.signal)), state, true)
      if (!settingsSealed) {
        const sealed = await run(sealDesktopSettingsRuntime(session, input.signal))
        if (sealed.kind !== "ready" && sealed.code !== "settings_pending") throw new TypeError(sealed.code)
        settingsSealed = sealed.kind === "ready"
      }
      if (observation.phase === "running" && settingsSealed) break
      await run(new Promise<void>((resolve) => setTimeout(resolve, 200)))
    }
    state.phase = "observed"
    await run(revalidateDesktopLaunchSessionV2(session, input.signal))
    return { kind: "ready", value: session }
  } catch (error) {
    // Before an actual start there is no unbounded external effect: drain all resource
    // acquisition acknowledgments so a late lock/bootstrap is still owned by this catch.
    if (startOperation && !attempted) await startOperation.catch(() => {})
    const failure = desktopSettingsError(error)
    const resourceUncertain = consuming
      ? "grant_consumption_unobserved"
      : creatingLock
        ? "active_publication_unobserved"
        : null
    let cleanup: "stopped" | "uncertain" | "not_needed" = attempted || resourceUncertain ? "uncertain" : "not_needed",
      cleanupCode: string | null = attempted ? "start_identity_unobserved" : resourceUncertain
    if (session) {
      states.get(session)!.failureCode = failure
      const stopped = await stopDesktopLaunchV2(session)
      cleanup = stopped.kind === "ready" ? "stopped" : "uncertain"
      cleanupCode = readDesktopAttemptDiagnosticsV2(stopped)?.cleanupCode ?? null
    } else {
      if (bootstrap) {
        try {
          await finishDesktopSettingsRuntime(bootstrap)
        } catch {
          cleanupCode ??= "settings_close_failed"
        }
      }
      if (!attempted && lock) {
        try {
          await removeDesktopActiveLockV2(input.profile, lock)
        } catch {
          cleanup = "uncertain"
          cleanupCode = "active_lock_retained"
        }
      }
    }
    const result = desktopBlocked(cleanup === "uncertain" ? "cleanup_uncertain" : failure, [
      failure,
      ...(cleanupCode ? [cleanupCode] : []),
    ])
    diagnostics.set(result, diagnostic(session ? states.get(session) : undefined, failure, cleanupCode))
    cleanups.set(result, cleanup)
    return result
  }
}
export async function stopDesktopLaunchV2(session: DesktopLaunchSession): Promise<Gate<"stopped">> {
  const state = states.get(session)
  if (!state) return desktopBlocked("TASK24_DESKTOP_SESSION_AUTHORITY")
  if (state.stop) return state.stop
  state.stop = (async () => {
    let cleanupCode: string | null = null
    state.stopDeadline = Date.now() + 30000
    const signal = AbortSignal.timeout(30000),
      run = <T>(operation: Promise<T>) => boundedDesktopOperation(operation, state.stopDeadline! - Date.now())
    try {
      if (!state.stopConsumed) throw new TypeError("TASK24_DESKTOP_STOP_AUTHORITY")
      // Ownership, not mutable configuration or grant expiry, is the stop prerequisite.
      owned(await run(state.platform.observe(state.spec, signal)), state, true)
      state.phase = "stopping"
      await withDesktopStoppingSettings(session, async () => {
        try {
          await run(observeDesktopStoppingSettings(session))
        } catch (error) {
          state.failureCode ??= desktopSettingsError(error)
        }
        if ((await run(state.platform.stop(state.process))) !== "stopped") throw new TypeError("stop_not_confirmed")
        try {
          await run(observeDesktopStoppingSettings(session))
        } catch (error) {
          state.failureCode ??= desktopSettingsError(error)
        }
        const after = Schema.decodeUnknownSync(DesktopObservation)(
          await run(state.platform.observe(state.spec, signal)),
          { onExcessProperty: "error" },
        )
        state.last = after
        if (after.runningDocker || after.runningWsl || after.process || after.pipe || after.phase !== "stopped")
          throw new TypeError("stop_residuals_observed")
      })
    } catch (error) {
      cleanupCode = desktopSettingsError(error)
    } finally {
      try {
        await run(finishDesktopSettingsRuntime(session))
      } catch (error) {
        cleanupCode ??= desktopSettingsError(error)
      }
    }
    if (!cleanupCode) {
      try {
        await run(removeDesktopActiveLockV2(state.profile, state.lock))
      } catch (error) {
        cleanupCode = desktopSettingsError(error)
      }
    }
    state.failureCode ??= readDesktopSettingsFailure(session) ?? undefined
    state.phase = cleanupCode ? "stale" : "stopped"
    const result = cleanupCode
      ? desktopBlocked("cleanup_uncertain", [cleanupCode])
      : { kind: "ready" as const, value: "stopped" as const }
    diagnostics.set(result, diagnostic(state, state.failureCode ?? null, cleanupCode))
    cleanups.set(result, cleanupCode ? "uncertain" : "stopped")
    return result
  })()
  return state.stop
}
