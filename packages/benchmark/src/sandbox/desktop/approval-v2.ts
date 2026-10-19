import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { sha256Text } from "../../hash"
import { isNativeDesktopPlatform } from "./platform"
import { requireDesktopPlanV2 } from "./planning-v2"
import { desktopProfileLayoutV2 } from "./publication-v2"
import {
  DesktopApprovalV2,
  type DesktopLaunchApprovalV2,
  type DesktopLaunchPlanV2,
  type DesktopPreparedProfileV2,
} from "./v2-contracts"

const approvals = new WeakMap<DesktopLaunchApprovalV2, { sha256: string; source: "fixture-callback" }>()
function decode(raw: unknown) {
  const value = freeze(Schema.decodeUnknownSync(DesktopApprovalV2)(raw, { onExcessProperty: "error" }))
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.launchID) ||
    !/^[a-zA-Z0-9-]{1,200}$/.test(value.sid) ||
    !Number.isFinite(value.issuedAt) ||
    !Number.isFinite(value.expiresAt) ||
    value.issuedAt > Date.now() ||
    value.expiresAt <= Date.now() ||
    value.expiresAt - value.issuedAt > 900000
  )
    throw new TypeError("TASK24_DESKTOP_CONFIRMATION_REQUIRED")
  return value
}
export function checkDesktopApprovalRequestV2(
  raw: unknown,
  plan: DesktopLaunchPlanV2,
  sid: string,
  manifestSha256?: string,
) {
  requireDesktopPlanV2(plan)
  const value = decode(raw)
  if (
    value.sid !== sid ||
    value.planSha256 !== plan.planSha256 ||
    value.compatibilitySha256 !== plan.compatibilitySha256 ||
    canonicalJson(value.registration) !== canonicalJson(plan.spec.registration) ||
    canonicalJson(value.disks) !== canonicalJson(plan.spec.disks) ||
    (value.phase === "prepare-profile"
      ? value.expectedProfileRoot !== plan.paths.root
      : value.manifestSha256 !== manifestSha256)
  )
    throw new TypeError("TASK24_DESKTOP_V2_APPROVAL_BINDING")
  return value
}
export async function confirmDesktopApprovalV2(
  raw: unknown,
  verify: (approval: DesktopLaunchApprovalV2) => Promise<boolean>,
) {
  const value = decode(raw)
  if (!(await verify(value))) throw new TypeError("TASK24_DESKTOP_CONFIRMATION_REQUIRED")
  decode(value)
  approvals.set(value, { sha256: sha256Text(canonicalJson(value)), source: "fixture-callback" })
  return value
}
export function requireDesktopApprovalV2(
  value: DesktopLaunchApprovalV2,
  plan: DesktopLaunchPlanV2,
  phase: DesktopLaunchApprovalV2["phase"],
  sid: string,
) {
  const platform = requireDesktopPlanV2(plan),
    state = approvals.get(value)
  if (
    !state ||
    state.sha256 !== sha256Text(canonicalJson(value)) ||
    value.phase !== phase ||
    isNativeDesktopPlatform(platform) ||
    state.source !== "fixture-callback"
  )
    throw new TypeError("TASK24_DESKTOP_V2_APPROVAL_AUTHORITY")
  checkDesktopApprovalRequestV2(value, plan, sid, value.phase === "start-readonly" ? value.manifestSha256 : undefined)
}
export function desktopConfirmationPanelV2(
  plan: DesktopLaunchPlanV2,
  value: DesktopLaunchApprovalV2,
  profile?: DesktopPreparedProfileV2,
) {
  const platform = requireDesktopPlanV2(plan)
  checkDesktopApprovalRequestV2(value, plan, value.sid, profile?.manifestSha256)
  if (isNativeDesktopPlatform(platform)) throw new TypeError("TASK24_DESKTOP_NATIVE_RULES_UNPROVED")
  const files = [
    "owner.json",
    `state\\grants\\${value.nonce}.json`,
    "intent.json",
    "home-oc-task24-dd479\\AppData\\Roaming\\Docker\\settings-store.json",
    "manifest.json",
  ]
  const body = [
    "TASK24 DESKTOP V2 — FIXTURE; NOT NATIVE START OR LINUX ACCEPTANCE",
    `Phase: ${value.phase}\nSID: ${value.sid}\nLaunchID: ${value.launchID}\nExpires: ${value.expiresAt}`,
    `Source/documents: ${canonicalJson({ source: plan.spec.sourceSha256, specs: plan.spec.specSha256, plans: plan.spec.planSha256 })}\nInstall: ${canonicalJson(plan.spec.install)}\nWSL config: ${canonicalJson(plan.spec.wslConfig)}\nRegistration: ${canonicalJson(plan.spec.registration)}\nDisks metadata only: ${canonicalJson(plan.spec.disks)}`,
    `Plan: ${plan.planSha256}\nCompatibility: ${plan.compatibilitySha256}\nManifest: ${profile?.manifestSha256 ?? "not prepared"}\nRequest: ${sha256Text(canonicalJson(value))}`,
    `Intent: ${canonicalJson(plan.intent)}\nIntent SHA256: ${plan.intentSha256}\nPolicy: ${plan.policyID} ${plan.policySha256}\nSeed SHA256: ${plan.seedSha256}\nRuntime targets: ${canonicalJson(plan.runtimeTargets)}\nPhases: ${canonicalJson(plan.phases)}\nLimits: ${canonicalJson(plan.limits)}`,
    `Environment: ${canonicalJson(plan.env)}\nStart deadline: 120000ms; polling 200ms; finally stop deadline 30000ms. Confirmation wait 60000ms; request max 900000ms.`,
    value.phase === "prepare-profile"
      ? `13 directories:\n${desktopProfileLayoutV2.map((p) => path.join(plan.paths.root, p)).join("\n")}\n5 files:\n${files.map((p) => path.join(plan.paths.root, p)).join("\n")}\nConditional audit/control total: 17 directories / 8 files. Fixed native conservative payload: 3162256 bytes (144-byte seed); fixture seed bytes: ${Buffer.byteLength(canonicalJson(plan.intent.expected))}. Not a filesystem quota or complete startup write budget.`
      : "Fixture observation only; current native START remains blocked.",
    "Old C trees and existing VHDs are not migrated/deleted; no model API, real acceptance, or deployment replacement.",
  ].join("\n\n")
  return validateDesktopPanelV2(body)
}
export function validateDesktopPanelV2(body: string) {
  if (Buffer.byteLength(body) > 12288 || /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(body))
    throw new TypeError("TASK24_DESKTOP_PANEL_UNSAFE")
  return body
}
