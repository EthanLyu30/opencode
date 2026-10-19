import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { sha256Text } from "../../hash"
import { Compatibility, desktopBlocked, type DesktopPlatform, type DesktopCompatibilityReport } from "./contracts"
import { isNativeDesktopPlatform } from "./platform"
import { selectDesktopSettingsPolicy, type DesktopSettingsPolicy } from "./settings-policy"
import { auditDesktopWorkloadBoundary, type DesktopWorkloadFact } from "./workload-boundary"
import { decodeDesktopSpecV2, type DesktopLaunchSpecV2 } from "./v2-contracts"

export const nativeDesktopMissingV2 = Object.freeze([
  "path_routing_unproved",
  "backend_environment_unproved",
  "registration_reuse_unproved",
  "stop_owned_unproved",
  "settings_mutation_unproved",
  "existing_workload_restart_unproved",
  "automatic_behavior_unproved",
])
const reports = new WeakMap<
  DesktopCompatibilityReport,
  { spec: DesktopLaunchSpecV2; platform: DesktopPlatform; policy: DesktopSettingsPolicy; workload: DesktopWorkloadFact }
>()

export function requireDesktopReportV2(spec: DesktopLaunchSpecV2, report: DesktopCompatibilityReport) {
  const state = reports.get(report)
  if (!state || canonicalJson(state.spec) !== canonicalJson(spec) || report.missing.length)
    throw new TypeError("TASK24_DESKTOP_V2_REPORT_AUTHORITY")
  return state
}
export async function auditDesktopCompatibilityV2(raw: unknown, platform: DesktopPlatform, signal?: AbortSignal) {
  try {
    if (signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
    const spec = decodeDesktopSpecV2(raw)
    if (isNativeDesktopPlatform(platform))
      return desktopBlocked("desktop_compatibility_blocked", nativeDesktopMissingV2)
    const policy = await selectDesktopSettingsPolicy(spec, platform),
      workload = await auditDesktopWorkloadBoundary(spec, platform, signal)
    if (policy.kind !== "ready" || workload.kind !== "ready")
      return desktopBlocked("desktop_compatibility_blocked", [
        ...new Set([
          ...(policy.kind === "blocked" ? policy.missing : []),
          ...(workload.kind === "blocked" ? workload.missing : []),
        ]),
      ])
    const value = Schema.decodeUnknownSync(Compatibility)(await platform.audit(spec, signal), {
      onExcessProperty: "error",
    })
    if (signal?.aborted || value.specSha256 !== sha256Text(canonicalJson(spec)) || value.missing.length)
      throw new TypeError("TASK24_DESKTOP_V2_REPORT_BINDING")
    for (const id of [
      "path_routing",
      "backend_environment",
      "registration_reuse",
      "stop_owned",
      "cli_default",
    ] as const) {
      const checks = value.checks.filter((c) => c.id === id)
      if (
        checks.length !== 1 ||
        checks[0]!.conclusion !== "proved" ||
        !Object.values(spec.install).some((f) => f.path === checks[0]!.source && f.sha256 === checks[0]!.sourceSha256)
      )
        throw new TypeError("TASK24_DESKTOP_V2_REPORT_BINDING")
    }
    const report = freeze({ ...value, assurance: "fixture" as const })
    reports.set(report, { spec, platform, policy: policy.value, workload: workload.value })
    return { kind: "ready" as const, value: report }
  } catch (error) {
    return desktopBlocked(
      error instanceof Error && /^[a-zA-Z0-9_.:-]{1,200}$/.test(error.message)
        ? error.message
        : "desktop_compatibility_blocked",
    )
  }
}
