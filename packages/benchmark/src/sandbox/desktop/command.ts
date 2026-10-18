import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import {
  auditDesktopCompatibility,
  canonicalDesktopPath,
  decodeDesktopLaunchSpec,
  readDesktopText,
} from "./compatibility"
import {
  planDesktopProfile,
  prepareDesktopProfile,
  confirmDesktopApproval,
  loadDesktopPreparedProfile,
} from "./profile"
import { makeWindowsDesktopPlatform } from "./platform"
import { startDesktopReadonly, stopDesktopLaunch } from "./launch"
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
  return Schema.decodeUnknownSync(Schema.UnknownFromJsonString)((await readDesktopText(file, 1048576)).text)
}
export function makeDesktopLaunchController(
  platform: DesktopPlatform,
  verifyHumanConfirmation?: (approval: DesktopLaunchApproval) => Promise<boolean>,
) {
  const profiles = new Map<string, DesktopPreparedProfile>(),
    sessions = new Map<string, DesktopLaunchSession>()
  return async (argv: readonly string[]): Promise<CommandResult> => {
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
    for (let index = 1; index < argv.length; index += 2) {
      const flag = argv[index]!,
        value = argv[index + 1]
      if (
        !flag.startsWith("--") ||
        !allowed.includes(flag.slice(2)) ||
        !value ||
        value.startsWith("--") ||
        Object.hasOwn(args, flag.slice(2))
      )
        return response(1, "invalid_arguments")
      args[flag.slice(2)] = value
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
      if ((mode === "prepare-profile" || mode === "start-readonly") && !verifyHumanConfirmation)
        return response(2, "human_confirmation_required")
      const spec = decodeDesktopLaunchSpec(await readInput(args.spec!))
      const audited = await auditDesktopCompatibility(spec, platform)
      if (audited.kind !== "ready") return response(2, audited.code, { missing: audited.missing })
      if (mode === "audit") return response(2, "compatibility_observed_not_accepted", { report: audited.value })
      const planned = planDesktopProfile(spec, audited.value)
      if (planned.kind !== "ready") return response(2, planned.code, { missing: planned.missing })
      if (mode === "plan") return response(2, "profile_plan_not_prepared", { plan: planned.value })
      const approval = await confirmDesktopApproval(await readInput(args.approval!), verifyHumanConfirmation!)
      if (mode === "prepare-profile") {
        const prepared = await prepareDesktopProfile({ spec, plan: planned.value, approval, platform })
        if (prepared.kind !== "ready") return response(2, prepared.code, { missing: prepared.missing })
        profiles.set(spec.profileRoot, prepared.value)
        return response(0, "profile_prepared", {
          assurance: prepared.value.assurance,
          manifestSha256: prepared.value.manifestSha256,
        })
      }
      const profile = profiles.get(spec.profileRoot) ?? (await loadDesktopPreparedProfile(planned.value))
      const started = await startDesktopReadonly({
        spec,
        profile,
        approval,
        platform,
        signal: new AbortController().signal,
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
export function runDesktopLaunchCommand(argv: readonly string[]): Promise<CommandResult> {
  return run(argv)
}
