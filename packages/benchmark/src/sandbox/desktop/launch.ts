import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
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
  type DesktopAttemptDiagnostics,
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
import {
  isDesktopSessionV2,
  startDesktopReadonlyV2,
  stopDesktopLaunchV2,
  revalidateDesktopLaunchSessionV2,
  readDesktopAttemptDiagnosticsV2,
  readDesktopAttemptCleanupV2,
} from "./launch-v2"
import type { DesktopLaunchSpecV2, DesktopPreparedProfileV2, DesktopLaunchApprovalV2 } from "./v2-contracts"
export { requireDesktopSettingsSession } from "./launch-v2"

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
  last?: typeof DesktopObservation.Type
  failureCode?: string
}
const sessions = new WeakMap<DesktopLaunchSession, LaunchState>()
const attemptCleanup = new WeakMap<object, "stopped" | "uncertain" | "not_needed">()
const diagnosticFacts = new WeakMap<object, DesktopAttemptDiagnostics>()
function diagnosticCode(value: unknown) {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : "desktop_operation_failed"
  return /^[a-zA-Z0-9_.:-]{1,200}$/.test(text) ? text : "desktop_operation_failed"
}
function diagnostic(
  state?: LaunchState,
  failureCode: string | null = state?.failureCode ?? null,
  cleanupCode: string | null = null,
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
export function readDesktopAttemptDiagnostics(result: object) {
  return diagnosticFacts.get(result) ?? readDesktopAttemptDiagnosticsV2(result)
}
export function readDesktopAttemptCleanup(result: object) {
  return attemptCleanup.get(result) ?? readDesktopAttemptCleanupV2(result) ?? "uncertain"
}
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
  state.last = observed
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
  if (isDesktopSessionV2(session)) return revalidateDesktopLaunchSessionV2(session, signal)
  return revalidateDesktopLaunchSessionV1(session, signal)
}
export async function revalidateDesktopLaunchSessionV1(session: DesktopLaunchSession, signal?: AbortSignal) {
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
export function startDesktopReadonly(input: {
  spec: DesktopLaunchSpecV2
  profile: DesktopPreparedProfileV2
  approval: DesktopLaunchApprovalV2
  platform: DesktopPlatform
  signal: AbortSignal
}): Promise<Gate<DesktopLaunchSession>>
export function startDesktopReadonly(input: {
  spec: DesktopLaunchSpec
  profile: DesktopPreparedProfile
  approval: DesktopLaunchApproval
  platform: DesktopPlatform
  signal: AbortSignal
}): Promise<Gate<DesktopLaunchSession>>
export async function startDesktopReadonly(
  input:
    | {
        spec: DesktopLaunchSpec
        profile: DesktopPreparedProfile
        approval: DesktopLaunchApproval
        platform: DesktopPlatform
        signal: AbortSignal
      }
    | {
        spec: DesktopLaunchSpecV2
        profile: DesktopPreparedProfileV2
        approval: DesktopLaunchApprovalV2
        platform: DesktopPlatform
        signal: AbortSignal
      },
): Promise<Gate<DesktopLaunchSession>> {
  if (input.spec.schemaVersion === 2)
    return startDesktopReadonlyV2(input as Parameters<typeof startDesktopReadonlyV2>[0])
  return startDesktopReadonlyV1(input as Parameters<typeof startDesktopReadonlyV1>[0])
}
async function startDesktopReadonlyV1(input: {
  spec: DesktopLaunchSpec
  profile: DesktopPreparedProfile
  approval: DesktopLaunchApproval
  platform: DesktopPlatform
  signal: AbortSignal
}): Promise<Gate<DesktopLaunchSession>> {
  let issued: DesktopLaunchSession | undefined
  let startAttempted = false
  let ownedLock: FileIdentity | undefined
  let consuming = false
  let failure: string | null = null
  const blocked = (code: string, cleanup: "stopped" | "uncertain" | "not_needed", missing?: readonly string[]) => {
    const result = desktopBlocked(code, missing)
    attemptCleanup.set(result, cleanup)
    diagnosticFacts.set(
      result,
      diagnostic(
        issued ? sessions.get(issued) : undefined,
        failure,
        cleanup === "uncertain" ? (missing?.[0] ?? "cleanup_uncertain") : null,
      ),
    )
    return result
  }
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
    consuming = true
    await run(consumeDesktopGrant(input.profile, input.approval))
    consuming = false
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
    failure = diagnosticCode(error)
    if (issued) sessions.get(issued)!.failureCode = failure
    let outcome: "stopped" | "not_needed" = "not_needed"
    if (issued) {
      const cleanup = await stopDesktopLaunch(issued)
      if (cleanup.kind !== "ready") {
        const result = blocked("cleanup_uncertain", "uncertain", [failure, ...cleanup.missing])
        diagnosticFacts.set(
          result,
          diagnosticFacts.get(cleanup) ?? diagnostic(sessions.get(issued), failure, "cleanup_uncertain"),
        )
        return result
      }
      outcome = "stopped"
    } else if (startAttempted) return blocked("cleanup_uncertain", "uncertain", ["start_identity_unobserved", failure])
    else if (consuming) return blocked("cleanup_uncertain", "not_needed", ["grant_consumption_unobserved"])
    else if (ownedLock) {
      try {
        await removeDesktopActiveLock(input.profile, ownedLock)
      } catch {
        return blocked("cleanup_uncertain", "uncertain")
      }
    }
    return blocked(error instanceof Error ? error.message : "desktop_start_failed", outcome)
  }
}
export async function stopDesktopLaunch(session: DesktopLaunchSession): Promise<Gate<"stopped">> {
  if (isDesktopSessionV2(session)) return stopDesktopLaunchV2(session)
  const state = sessions.get(session)
  if (!state) return desktopBlocked("TASK24_DESKTOP_SESSION_AUTHORITY")
  if (state.stopped) return { kind: "ready", value: "stopped" }
  if (state.stop) return state.stop
  state.stop = (async () => {
    const result = (code?: string) => {
      const value = code
        ? desktopBlocked("cleanup_uncertain", [code])
        : { kind: "ready" as const, value: "stopped" as const }
      diagnosticFacts.set(value, diagnostic(state, state.failureCode ?? null, code ?? null))
      return value
    }
    try {
      const deadline = Date.now() + 30000
      const cleanupSignal = AbortSignal.timeout(30000)
      const run = <T>(operation: Promise<T>) => boundedDesktopOperation(operation, deadline - Date.now())
      // Cleanup uses its consumed stop-owned authority even if the start grant has since expired.
      requireOwnedProcess(await run(state.platform.observe(state.spec, cleanupSignal)), state, true)
      if ((await run(state.platform.stop(state.process))) !== "stopped") return result("stop_not_confirmed")
      const after = Schema.decodeUnknownSync(DesktopObservation)(
        await run(state.platform.observe(state.spec, cleanupSignal)),
        {
          onExcessProperty: "error",
        },
      )
      state.last = after
      if (after.runningDocker || after.runningWsl || after.process || after.pipe || after.phase !== "stopped")
        return result("stop_residuals_observed")
      await run(removeDesktopActiveLock(state.profile, state.lock))
      state.stopped = true
      return result()
    } catch (error) {
      return result(diagnosticCode(error))
    }
  })()
  return state.stop
}
