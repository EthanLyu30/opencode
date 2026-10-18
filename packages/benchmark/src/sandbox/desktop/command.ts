import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import {
  auditDesktopCompatibility,
  canonicalDesktopPath,
  decodeDesktopLaunchSpec,
  readDesktopText,
  revalidateDesktopSpec,
} from "./compatibility"
import {
  planDesktopProfile,
  prepareDesktopProfile,
  confirmDesktopApproval,
  loadDesktopPreparedProfile,
} from "./profile"
import { makeWindowsDesktopPlatform, isNativeDesktopPlatform } from "./platform"
import { startDesktopReadonly, stopDesktopLaunch, boundedDesktopOperation } from "./launch"
import { checkDesktopApprovalRequest, confirmDesktopInteractive } from "./approval"
import { readDesktopNativeDiagnostics } from "./native-audit"
import { canonicalJson } from "../../campaign/canonical"
import { directoryIdentity, fileIdentity } from "../storage"
import { DesktopObservation } from "./contracts"
import { inspectDesktopLaunch } from "./inspection"
import type {
  DesktopPlatform,
  DesktopLaunchApproval,
  DesktopLaunchSession,
  DesktopPreparedProfile,
  DesktopLaunchInventory,
} from "./contracts"

const readiness = { engine_verified: false, tool_capability_verified: false, corpus_engine_ready: false }
const modes = ["audit", "plan", "prepare-profile", "start-readonly", "inspect", "stop-owned"]
type CommandResult = { exitCode: 0 | 1 | 2; output: unknown }
function response(exitCode: 0 | 1 | 2, code: string, extra: Record<string, unknown> = {}): CommandResult {
  return { exitCode, output: { ...extra, code, ...readiness } }
}
async function readInput(file: string) {
  canonicalDesktopPath(file)
  if (!file.toLowerCase().startsWith("d:\\opencode-benchmark\\task24\\"))
    throw new TypeError("TASK24_DESKTOP_INPUT_ROOT")
  const text = await readDesktopText(file, 1048576)
  const identity = await fileIdentity(file)
  if (identity.fileID !== text.fileID || identity.sha256 !== text.sha256)
    throw new TypeError("TASK24_DESKTOP_INPUT_DRIFT")
  const parents: Record<string, string> = {}
  for (let parent = path.dirname(file); parent !== path.parse(parent).root; parent = path.dirname(parent))
    parents[parent] = await directoryIdentity(parent)
  return { raw: Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(text.text), identity, parents }
}
function requireControlLayout(
  specFile: string,
  approvalFile: string,
  mode: string,
  native: boolean,
  fixtureRoot?: string,
) {
  const base = native
    ? "D:\\OpenCode-Benchmark\\Task24\\control\\desktop-launch"
    : fixtureRoot
      ? path.join(fixtureRoot, "control", "desktop-launch")
      : undefined
  const directory = path.dirname(specFile),
    id = path.basename(directory)
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) ||
    path.basename(specFile) !== "spec.json" ||
    path.basename(approvalFile) !== (mode === "prepare-profile" ? "prepare-approval.json" : "start-approval.json") ||
    path.dirname(approvalFile) !== directory ||
    (base
      ? directory !== path.join(base, id)
      : !directory.startsWith(canonicalDesktopPath(process.env.TMPDIR ?? "") + path.sep) ||
        path.basename(path.dirname(directory)) !== "desktop-launch" ||
        path.basename(path.dirname(path.dirname(directory))) !== "control")
  )
    throw new TypeError("TASK24_DESKTOP_CONTROL_BINDING")
  return id
}
export function makeDesktopLaunchController(
  platform: DesktopPlatform,
  verifyHumanConfirmation?: (approval: DesktopLaunchApproval) => Promise<boolean>,
) {
  const sessions = new Map<string, DesktopLaunchSession>()
  return async (
    argv: readonly string[],
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CommandResult> => {
    const mode = argv[0]
    if (!mode) return response(2, "operation_required", { operations: modes })
    if (!modes.includes(mode)) return response(1, "unknown_operation")
    const allowed =
      mode === "inspect" || mode === "stop-owned"
        ? ["launch-id"]
        : mode === "audit" || mode === "plan"
          ? ["spec"]
          : ["spec", "approval"]
    const args: Record<string, string> = {}
    let interactive = false
    for (let index = 1; index < argv.length; ) {
      const flag = argv[index]!,
        value = argv[index + 1]
      if (flag === "--interactive") {
        if (interactive || !["prepare-profile", "start-readonly"].includes(mode))
          return response(1, "invalid_arguments")
        interactive = true
        index++
        continue
      }
      if (
        !flag.startsWith("--") ||
        !allowed.includes(flag.slice(2)) ||
        !value ||
        value.startsWith("--") ||
        Object.hasOwn(args, flag.slice(2))
      )
        return response(1, "invalid_arguments")
      args[flag.slice(2)] = value
      index += 2
    }
    if (allowed.some((key) => !args[key])) return response(2, "explicit_inputs_required")
    if (mode !== "inspect" && mode !== "stop-owned") {
      try {
        for (const file of Object.values(args)) canonicalDesktopPath(file)
      } catch {
        return response(1, "invalid_arguments")
      }
    }
    try {
      if (mode === "inspect" || mode === "stop-owned") {
        const id = args["launch-id"]!
        if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) return response(1, "invalid_launch_id")
        const session = sessions.get(id)
        if (!session) {
          if (mode === "stop-owned") return response(2, "session_not_live")
          const file = path.join("D:\\OpenCode-Benchmark\\Task24\\reports\\desktop-launch", id, "inventory.json")
          if (!(await fs.exists(file))) return response(2, "session_not_live")
          const record = await readDesktopText(file)
          return response(2, "stale_record_not_live", { recordSha256: record.sha256 })
        }
        if (mode === "stop-owned") {
          const stopped = await stopDesktopLaunch(session)
          return response(stopped.kind === "ready" ? 0 : 2, stopped.kind === "ready" ? "stopped" : stopped.code)
        }
        return response(2, "inventory_observed_not_accepted", { inventory: await inspectDesktopLaunch(session) })
      }
      const mutating = mode === "prepare-profile" || mode === "start-readonly"
      if (mutating && (!interactive || (!isNativeDesktopPlatform(platform) && !verifyHumanConfirmation)))
        return response(2, "human_confirmation_required")
      const checkCancelled = () => {
        if (signal.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
      }
      checkCancelled()
      if (mutating) requireControlLayout(args.spec!, args.approval!, mode, isNativeDesktopPlatform(platform))
      const snapshot = await readInput(args.spec!)
      const spec = decodeDesktopLaunchSpec(snapshot.raw)
      const launchID = mutating
        ? requireControlLayout(
            args.spec!,
            args.approval!,
            mode,
            isNativeDesktopPlatform(platform),
            path.dirname(spec.profileRoot),
          )
        : undefined
      const audited = await boundedDesktopOperation(auditDesktopCompatibility(spec, platform, signal), 45000, signal)
      if (audited.kind !== "ready")
        return response(2, audited.code, {
          missing: audited.missing,
          diagnostics: readDesktopNativeDiagnostics(platform) ?? null,
        })
      if (mode === "audit") return response(2, "compatibility_observed_not_accepted", { report: audited.value })
      const planned = planDesktopProfile(spec, audited.value)
      if (planned.kind !== "ready") return response(2, planned.code, { missing: planned.missing })
      if (mode === "plan") return response(2, "profile_plan_not_prepared", { plan: planned.value })
      const request = await readInput(args.approval!)
      const parentID = await directoryIdentity(path.dirname(spec.profileRoot))
      const profile: DesktopPreparedProfile | undefined =
        mode === "start-readonly" ? await loadDesktopPreparedProfile(planned.value) : undefined
      const observed = Schema.decodeUnknownSync(DesktopObservation)(
        await boundedDesktopOperation(platform.observe(spec, signal), 15000, signal),
        { onExcessProperty: "error" },
      )
      if (observed.runningDocker || observed.runningWsl || !["idle", "stopped"].includes(observed.phase))
        throw new TypeError("TASK24_DESKTOP_START_CONFLICT")
      const checked = checkDesktopApprovalRequest(request.raw, planned.value, observed.sid, profile?.manifestSha256)
      if (checked.phase !== mode || checked.launchID !== launchID)
        throw new TypeError("TASK24_DESKTOP_APPROVAL_BINDING")
      checkCancelled()
      const approval = isNativeDesktopPlatform(platform)
        ? await confirmDesktopInteractive({ raw: checked, plan: planned.value, profile, signal })
        : await boundedDesktopOperation(
            confirmDesktopApproval(checked, verifyHumanConfirmation!),
            Math.min(60000, checked.expiresAt - Date.now()),
            signal,
          )
      checkCancelled()
      if (
        canonicalJson(await readInput(args.spec!)) !== canonicalJson(snapshot) ||
        canonicalJson(await readInput(args.approval!)) !== canonicalJson(request) ||
        (await directoryIdentity(path.dirname(spec.profileRoot))) !== parentID
      )
        throw new TypeError("TASK24_DESKTOP_INPUT_DRIFT")
      await revalidateDesktopSpec(spec)
      if (profile) await (await import("./profile")).revalidateDesktopProfile(profile)
      const refreshed = await boundedDesktopOperation(auditDesktopCompatibility(spec, platform, signal), 45000, signal)
      if (refreshed.kind !== "ready" || canonicalJson(refreshed.value) !== canonicalJson(audited.value))
        throw new TypeError("TASK24_DESKTOP_COMPATIBILITY_DRIFT")
      const after = Schema.decodeUnknownSync(DesktopObservation)(
        await boundedDesktopOperation(platform.observe(spec, signal), 15000, signal),
        { onExcessProperty: "error" },
      )
      if (canonicalJson(after) !== canonicalJson(observed)) throw new TypeError("TASK24_DESKTOP_OBSERVATION_DRIFT")
      checkDesktopApprovalRequest(approval, planned.value, after.sid, profile?.manifestSha256)
      checkCancelled()
      if (mode === "prepare-profile") {
        const prepared = await prepareDesktopProfile({ spec, plan: planned.value, approval, platform, signal })
        if (prepared.kind !== "ready") return response(2, prepared.code, { missing: prepared.missing })
        return response(0, "profile_prepared", {
          assurance: prepared.value.assurance,
          manifestSha256: prepared.value.manifestSha256,
        })
      }
      if (!profile) throw new TypeError("TASK24_DESKTOP_PROFILE_REQUIRED")
      const started = await startDesktopReadonly({
        spec,
        profile,
        approval,
        platform,
        signal,
      })
      if (started.kind !== "ready") return response(2, started.code, { missing: started.missing })
      sessions.set(started.value.launchID, started.value)
      let inventory: DesktopLaunchInventory | undefined,
        failure: string | undefined,
        cleanup: Awaited<ReturnType<typeof stopDesktopLaunch>> | undefined
      try {
        inventory = await inspectDesktopLaunch(started.value)
      } catch (error) {
        failure = error instanceof Error ? error.message : "desktop_inspect_failed"
      } finally {
        cleanup = await stopDesktopLaunch(started.value)
      }
      if (cleanup.kind !== "ready") return response(2, "cleanup_uncertain")
      if (failure || !inventory) return response(2, failure ?? "desktop_inventory_missing")
      return response(2, inventory.missing.length ? "desktop_inventory_blocked" : "inventory_observed_not_accepted", {
        inventory,
      })
    } catch (error) {
      return response(2, error instanceof Error ? error.message : "desktop_operation_blocked")
    }
  }
}
const run = makeDesktopLaunchController(makeWindowsDesktopPlatform())
export function runDesktopLaunchCommand(argv: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
  return run(argv, signal)
}
