import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import {
  DesktopObservation,
  type DesktopPlatform,
  type DesktopLaunchSession,
  type DesktopLaunchInventory,
} from "./contracts"
import { decodeDesktopSpecV2, type DesktopLaunchApprovalV2 } from "./v2-contracts"
import { readDesktopDirectoryV2, readDesktopFileV2 } from "./identity-v2"
import { parseDesktopSettingsJson } from "./settings-json"
import { auditDesktopCompatibilityV2 } from "./compatibility-v2"
import { planDesktopProfileV2 } from "./planning-v2"
import { checkDesktopApprovalRequestV2, confirmDesktopApprovalV2 } from "./approval-v2"
import {
  prepareDesktopProfileV2,
  loadDesktopPreparedProfileV2,
  revalidateDesktopProfileV2,
  requireDesktopConsumedGrantV2,
} from "./profile-v2"
import { isNativeDesktopPlatform } from "./platform"
import {
  boundedDesktopOperation,
  startDesktopReadonly,
  stopDesktopLaunch,
  readDesktopAttemptCleanup,
  readDesktopAttemptDiagnostics,
} from "./launch"
import { inspectDesktopLaunch } from "./inspection"
import { publishDesktopLaunchRecordV2 } from "./inventory"
import { desktopSettingsError } from "./settings-runtime"

const readiness = { engine_verified: false, tool_capability_verified: false, corpus_engine_ready: false }
const response = (exitCode: 0 | 1 | 2, code: string, extra: Record<string, unknown> = {}) => ({
  exitCode,
  output: { ...extra, code, ...readiness },
})
async function readInput(file: string) {
  if (!file.toLowerCase().startsWith("d:\\opencode-benchmark\\task24\\"))
    throw new TypeError("TASK24_DESKTOP_INPUT_ROOT")
  const data = await readDesktopFileV2(file),
    parents = (await readDesktopDirectoryV2(path.dirname(file))).parents
  return { raw: parseDesktopSettingsJson(data.bytes, 1048576), identity: data.identity, parents }
}
export async function runDesktopCommandV2(input: {
  mode: string
  specFile: string
  approvalFile?: string
  platform: DesktopPlatform
  interactive: boolean
  verify?: (approval: DesktopLaunchApprovalV2) => Promise<boolean>
  signal: AbortSignal
  sessions: Map<string, DesktopLaunchSession>
}) {
  const { platform, signal, mode } = input
  const check = () => {
    if (signal.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
  }
  try {
    check()
    const snapshot = await readInput(input.specFile),
      spec = decodeDesktopSpecV2(snapshot.raw),
      native = isNativeDesktopPlatform(platform)
    const mutating = ["prepare-profile", "start-readonly"].includes(mode)
    let launchID: string | undefined
    if (mutating) {
      const directory = path.dirname(input.specFile)
      launchID = path.basename(directory)
      const base = native ? "D:\\OpenCode-Benchmark\\Task24" : path.dirname(spec.profileRoot)
      if (
        !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(launchID) ||
        directory !== path.join(base, "control", "desktop-launch", launchID) ||
        path.basename(input.specFile) !== "spec.json" ||
        !input.approvalFile ||
        path.dirname(input.approvalFile) !== directory ||
        path.basename(input.approvalFile) !==
          (mode === "prepare-profile" ? "prepare-approval.json" : "start-approval.json")
      )
        throw new TypeError("TASK24_DESKTOP_CONTROL_BINDING")
    }
    const audited = await boundedDesktopOperation(auditDesktopCompatibilityV2(spec, platform, signal), 45000, signal)
    if (audited.kind !== "ready") return response(2, audited.code, { missing: audited.missing })
    if (mode === "audit") return response(2, "compatibility_observed_not_accepted", { report: audited.value })
    const planned = planDesktopProfileV2(spec, audited.value)
    if (planned.kind !== "ready") return response(2, planned.code, { missing: planned.missing })
    if (mode === "plan") return response(2, "profile_plan_not_prepared", { plan: planned.value })
    if (!mutating || !input.interactive || !input.verify || native) return response(2, "human_confirmation_required")
    const request = await readInput(input.approvalFile!),
      parent = (await readDesktopDirectoryV2(path.dirname(spec.profileRoot))).fileID
    const profile = mode === "start-readonly" ? await loadDesktopPreparedProfileV2(planned.value) : undefined
    const observed = Schema.decodeUnknownSync(DesktopObservation)(
      await boundedDesktopOperation(platform.observe(spec, signal), 15000, signal),
      { onExcessProperty: "error" },
    )
    if (observed.runningDocker || observed.runningWsl || !["idle", "stopped"].includes(observed.phase))
      throw new TypeError("TASK24_DESKTOP_START_CONFLICT")
    const checked = checkDesktopApprovalRequestV2(request.raw, planned.value, observed.sid, profile?.manifestSha256)
    if (checked.phase !== mode || checked.launchID !== launchID) throw new TypeError("TASK24_DESKTOP_APPROVAL_BINDING")
    check()
    const approval = await boundedDesktopOperation(
      confirmDesktopApprovalV2(checked, input.verify),
      Math.min(60000, checked.expiresAt - Date.now()),
      signal,
    )
    check()
    if (
      canonicalJson(snapshot) !== canonicalJson(await readInput(input.specFile)) ||
      canonicalJson(request) !== canonicalJson(await readInput(input.approvalFile!)) ||
      parent !== (await readDesktopDirectoryV2(path.dirname(spec.profileRoot))).fileID
    )
      throw new TypeError("TASK24_DESKTOP_INPUT_DRIFT")
    if (profile) await revalidateDesktopProfileV2(profile, "prepared")
    const refreshed = await boundedDesktopOperation(auditDesktopCompatibilityV2(spec, platform, signal), 45000, signal)
    if (refreshed.kind !== "ready" || canonicalJson(refreshed.value) !== canonicalJson(audited.value))
      throw new TypeError("TASK24_DESKTOP_COMPATIBILITY_DRIFT")
    const after = Schema.decodeUnknownSync(DesktopObservation)(
      await boundedDesktopOperation(platform.observe(spec, signal), 15000, signal),
      { onExcessProperty: "error" },
    )
    if (canonicalJson(after) !== canonicalJson(observed)) throw new TypeError("TASK24_DESKTOP_OBSERVATION_DRIFT")
    checkDesktopApprovalRequestV2(approval, planned.value, after.sid, profile?.manifestSha256)
    check()
    if (mode === "prepare-profile") {
      const prepared = await prepareDesktopProfileV2({ spec, plan: planned.value, approval, platform, signal })
      return prepared.kind === "ready"
        ? response(0, "profile_prepared", {
            assurance: prepared.value.assurance,
            manifestSha256: prepared.value.manifestSha256,
          })
        : response(2, prepared.code, { missing: prepared.missing })
    }
    if (!profile) throw new TypeError("TASK24_DESKTOP_PROFILE_REQUIRED")
    const started = await startDesktopReadonly({ spec, profile, approval, platform, signal })
    let inventory: DesktopLaunchInventory | undefined,
      failure: string | undefined,
      cleanup: Awaited<ReturnType<typeof stopDesktopLaunch>> | undefined
    if (started.kind === "ready") {
      input.sessions.set(started.value.launchID, started.value)
      try {
        inventory = await boundedDesktopOperation(inspectDesktopLaunch(started.value), 15000, signal)
      } catch (error) {
        failure = desktopSettingsError(error)
      } finally {
        cleanup = await stopDesktopLaunch(started.value)
        if (cleanup.kind === "ready") input.sessions.delete(started.value.launchID)
      }
    }
    const outcome =
      started.kind === "ready"
        ? cleanup?.kind === "ready"
          ? "stopped"
          : "uncertain"
        : readDesktopAttemptCleanup(started)
    const diagnostics = readDesktopAttemptDiagnostics(cleanup ?? started)
    const code =
      outcome === "uncertain"
        ? "cleanup_uncertain"
        : started.kind === "blocked"
          ? started.code
          : (failure ??
            diagnostics?.failureCode ??
            (!inventory
              ? "desktop_inventory_missing"
              : inventory.missing.length
                ? "desktop_inventory_blocked"
                : "inventory_observed_not_accepted"))
    const missing = [
      ...new Set([
        ...(started.kind === "blocked" ? started.missing : failure ? [failure] : (inventory?.missing ?? [])),
        ...(diagnostics?.failureCode ? [diagnostics.failureCode] : []),
        ...(diagnostics?.cleanupCode ? [diagnostics.cleanupCode] : []),
        ...(outcome === "uncertain" ? ["cleanup_uncertain"] : []),
      ]),
    ]
    try {
      requireDesktopConsumedGrantV2(profile, approval)
    } catch {
      return response(2, code, { missing, reportPublished: false })
    }
    try {
      const file = await publishDesktopLaunchRecordV2({
        profile,
        approval,
        record: {
          schemaVersion: 2,
          launchID: approval.launchID,
          specSha256: profile.plan.specSha256,
          planSha256: profile.plan.planSha256,
          compatibilitySha256: profile.plan.compatibilitySha256,
          manifestSha256: profile.manifestSha256,
          intentSha256: profile.plan.intentSha256,
          policySha256: profile.plan.policySha256,
          status:
            code === "cleanup_uncertain"
              ? "cleanup_uncertain"
              : code === "inventory_observed_not_accepted"
                ? "inventory_observed_not_accepted"
                : "blocked",
          code,
          missing,
          inventory: inventory ?? null,
          cleanup: outcome,
          ...(diagnostics ? { diagnostics } : {}),
          engine_verified: false,
          tool_capability_verified: false,
          corpus_engine_ready: false,
        },
      })
      return response(2, code, { missing, inventory, diagnostics, reportPublished: true, record: file })
    } catch {
      return response(2, code === "cleanup_uncertain" ? code : "desktop_report_publication_failed", {
        missing,
        inventory,
        diagnostics,
        attemptCode: code,
        reportPublished: false,
      })
    }
  } catch (error) {
    return response(2, desktopSettingsError(error))
  }
}
