import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { fileIdentity } from "../storage"
import { type Gate, type FileIdentity } from "../contracts"
import {
  DesktopObservation,
  ProcessIdentity,
  desktopBlocked,
  type DesktopLaunchSpec,
  type DesktopPlatform,
  type DesktopPreparedProfile,
  type DesktopLaunchApproval,
  type DesktopLaunchSession,
  type DesktopProcessIdentity,
} from "./contracts"
import {
  consumeDesktopGrant,
  requireDesktopPlan,
  requireDesktopApproval,
  revalidateDesktopProfile,
  writeDesktopActiveLock,
  removeDesktopActiveLock,
} from "./profile"
import { isNativeDesktopPlatform } from "./platform"

type LaunchState = {
  spec: DesktopLaunchSpec
  profile: DesktopPreparedProfile
  platform: DesktopPlatform
  assurance: "fixture" | "native"
  process: DesktopProcessIdentity
  approval: DesktopLaunchApproval
  lock: FileIdentity
  stopped: boolean
  stop?: Promise<Gate<"stopped">>
}
const sessions = new WeakMap<DesktopLaunchSession, LaunchState>()
export async function boundedDesktopOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TypeError("TASK24_DESKTOP_DEADLINE")), Math.max(1, timeoutMs))
    onAbort = () => reject(new TypeError("TASK24_DESKTOP_CANCELLED"))
    signal?.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, limit])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}
function requireOwnedProcess(raw: unknown, state: LaunchState, allowStarting = false) {
  const observed = Schema.decodeUnknownSync(DesktopObservation)(raw, { onExcessProperty: "error" })
  if (
    allowStarting &&
    observed.phase === "starting" &&
    !observed.pipe &&
    observed.sid === state.process.ownerSID &&
    canonicalJson(observed.process) === canonicalJson(state.process)
  )
    return observed
  if (
    observed.phase !== "running" ||
    !observed.process ||
    !observed.pipe ||
    observed.sid !== state.process.ownerSID ||
    canonicalJson(observed.process) !== canonicalJson(state.process) ||
    observed.pipe.endpoint !== state.profile.plan.endpoint ||
    canonicalJson(observed.pipe.owner.image) !== canonicalJson(state.spec.install.backend)
  )
    throw new TypeError("TASK24_DESKTOP_PROCESS_IDENTITY")
  const related = observed.related ?? []
  if (related.length > 256 || new Set(related.map((p) => p.pid)).size !== related.length)
    throw new TypeError("TASK24_DESKTOP_PROCESS_RELATIONSHIP")
  let child = observed.pipe.owner
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
  return observed
}
export async function revalidateDesktopLaunchSession(session: DesktopLaunchSession, signal?: AbortSignal) {
  const state = sessions.get(session)
  if (!state || state.stopped || state.approval.expiresAt <= Date.now())
    throw new TypeError("TASK24_DESKTOP_SESSION_AUTHORITY")
  await revalidateDesktopProfile(state.profile)
  if (canonicalJson(await fileIdentity(state.lock.path)) !== canonicalJson(state.lock))
    throw new TypeError("TASK24_DESKTOP_ACTIVE_LOCK")
  requireOwnedProcess(await boundedDesktopOperation(state.platform.observe(state.spec, signal), 15000, signal), state)
  return Object.freeze({
    spec: state.spec,
    profile: state.profile,
    platform: state.platform,
    assurance: state.assurance,
  })
}
export async function startDesktopReadonly(input: {
  spec: DesktopLaunchSpec
  profile: DesktopPreparedProfile
  approval: DesktopLaunchApproval
  platform: DesktopPlatform
  signal: AbortSignal
}): Promise<Gate<DesktopLaunchSession>> {
  let issued: DesktopLaunchSession | undefined
  let startAttempted = false
  let ownedLock: FileIdentity | undefined
  try {
    if (input.signal.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
    const deadline = Date.now() + 120000
    const run = <T>(operation: Promise<T>) => boundedDesktopOperation(operation, deadline - Date.now(), input.signal)
    requireDesktopPlan(input.profile.plan, input.platform)
    requireDesktopApproval(input.approval, input.profile.plan, "start-readonly", input.approval.sid)
    if (canonicalJson(input.spec) !== canonicalJson(input.profile.plan.spec))
      throw new TypeError("TASK24_DESKTOP_SPEC_DRIFT")
    await run(revalidateDesktopProfile(input.profile))
    const observed = Schema.decodeUnknownSync(DesktopObservation)(
      await run(input.platform.observe(input.spec, input.signal)),
      {
        onExcessProperty: "error",
      },
    )
    requireDesktopApproval(input.approval, input.profile.plan, "start-readonly", observed.sid)
    if (
      input.approval.phase !== "start-readonly" ||
      input.approval.manifestSha256 !== input.profile.manifestSha256 ||
      observed.runningDocker ||
      observed.runningWsl ||
      !["idle", "stopped"].includes(observed.phase)
    )
      throw new TypeError("TASK24_DESKTOP_START_CONFLICT")
    await run(consumeDesktopGrant(input.profile, input.approval))
    await run(revalidateDesktopProfile(input.profile))
    const lock = await writeDesktopActiveLock(input.profile, input.approval)
    ownedLock = lock
    if (input.signal.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
    startAttempted = true
    const process = Schema.decodeUnknownSync(ProcessIdentity)(await run(input.platform.start(input.profile.plan)), {
      onExcessProperty: "error",
    })
    if (
      process.ownerSID !== observed.sid ||
      !Object.values(input.spec.install).some((f) => canonicalJson(f) === canonicalJson(process.image))
    )
      throw new TypeError("TASK24_DESKTOP_START_IDENTITY")
    const session = Object.freeze({ launchID: input.approval.launchID })
    sessions.set(session, {
      spec: input.spec,
      profile: input.profile,
      platform: input.platform,
      assurance: isNativeDesktopPlatform(input.platform) ? "native" : "fixture",
      process,
      approval: input.approval,
      lock,
      stopped: false,
    })
    issued = session
    const state = sessions.get(session)!
    while (true) {
      await run(revalidateDesktopProfile(input.profile))
      const observation = requireOwnedProcess(await run(input.platform.observe(input.spec, input.signal)), state, true)
      if (observation.phase === "running") break
      await run(new Promise<void>((resolve) => setTimeout(resolve, 200)))
    }
    await run(revalidateDesktopLaunchSession(session, input.signal))
    return { kind: "ready", value: session }
  } catch (error) {
    if (issued) {
      const cleanup = await stopDesktopLaunch(issued)
      if (cleanup.kind !== "ready") return desktopBlocked("cleanup_uncertain")
    } else if (startAttempted) return desktopBlocked("cleanup_uncertain", ["start_identity_unobserved"])
    else if (ownedLock) {
      try {
        await removeDesktopActiveLock(input.profile, ownedLock)
      } catch {
        return desktopBlocked("cleanup_uncertain")
      }
    }
    return desktopBlocked(error instanceof Error ? error.message : "desktop_start_failed")
  }
}
export async function stopDesktopLaunch(session: DesktopLaunchSession): Promise<Gate<"stopped">> {
  const state = sessions.get(session)
  if (!state) return desktopBlocked("TASK24_DESKTOP_SESSION_AUTHORITY")
  if (state.stopped) return { kind: "ready", value: "stopped" }
  if (state.stop) return state.stop
  state.stop = (async () => {
    try {
      const deadline = Date.now() + 30000
      const cleanupSignal = AbortSignal.timeout(30000)
      const run = <T>(operation: Promise<T>) => boundedDesktopOperation(operation, deadline - Date.now())
      // Cleanup uses its consumed stop-owned authority even if the start grant has since expired.
      requireOwnedProcess(await run(state.platform.observe(state.spec, cleanupSignal)), state, true)
      if ((await run(state.platform.stop(state.process))) !== "stopped") return desktopBlocked("cleanup_uncertain")
      const after = Schema.decodeUnknownSync(DesktopObservation)(
        await run(state.platform.observe(state.spec, cleanupSignal)),
        {
          onExcessProperty: "error",
        },
      )
      if (after.runningDocker || after.runningWsl || after.process || after.pipe || after.phase !== "stopped")
        return desktopBlocked("cleanup_uncertain")
      await run(removeDesktopActiveLock(state.profile, state.lock))
      state.stopped = true
      return { kind: "ready" as const, value: "stopped" as const }
    } catch {
      return desktopBlocked("cleanup_uncertain")
    }
  })()
  return state.stop
}
