import path from "node:path"
export {
  checkDesktopApprovalRequestV2,
  confirmDesktopApprovalV2,
  requireDesktopApprovalV2,
  desktopConfirmationPanelV2,
} from "./approval-v2"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { sha256Text } from "../../hash"
import {
  DesktopApproval,
  DesktopObservation,
  type DesktopLaunchApproval,
  type DesktopLaunchPlan,
  type DesktopPreparedProfile,
} from "./contracts"
import { requireDesktopPlan } from "./planning"
import { isNativeDesktopPlatform } from "./platform"
import { revalidateDesktopSpec } from "./compatibility"
import { readDesktopConsoleDecision } from "./console"

type Source = "fixture-callback" | "native-console"
const approvals = new WeakMap<
  object,
  { hash: string; source: Source; plan?: DesktopLaunchPlan; controllerID?: string }
>()
export function isDesktopApprovalSourceAllowed(source: Source | undefined, required: "fixture" | "native") {
  return required === "native" ? source === "native-console" : source === "fixture-callback"
}
function decode(raw: unknown) {
  const value = freeze(Schema.decodeUnknownSync(DesktopApproval)(raw, { onExcessProperty: "error" }))
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.launchID) ||
    !Number.isFinite(value.issuedAt) ||
    !Number.isFinite(value.expiresAt) ||
    value.issuedAt > Date.now() ||
    value.expiresAt <= Date.now() ||
    value.expiresAt - value.issuedAt > 900000
  )
    throw new TypeError("TASK24_DESKTOP_CONFIRMATION_REQUIRED")
  return value
}
export function checkDesktopApprovalRequest(
  raw: unknown,
  plan: DesktopLaunchPlan,
  sid: string,
  manifestSha256?: string,
) {
  requireDesktopPlan(plan)
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
    throw new TypeError("TASK24_DESKTOP_APPROVAL_BINDING")
  return value
}
/** Embedding callbacks are fixture-only, even when they return true asynchronously. */
export async function confirmDesktopApproval(
  raw: unknown,
  verify: (approval: DesktopLaunchApproval) => Promise<boolean>,
) {
  const approval = decode(raw)
  if (!(await verify(approval))) throw new TypeError("TASK24_DESKTOP_CONFIRMATION_REQUIRED")
  decode(approval)
  approvals.set(approval, { hash: sha256Text(canonicalJson(approval)), source: "fixture-callback" })
  return approval
}
export function requireDesktopApproval(
  approval: DesktopLaunchApproval,
  plan: DesktopLaunchPlan,
  phase: DesktopLaunchApproval["phase"],
  sid: string,
) {
  const platform = requireDesktopPlan(plan)
  const authority = approvals.get(approval)
  if (
    !authority ||
    authority.hash !== sha256Text(canonicalJson(approval)) ||
    !isDesktopApprovalSourceAllowed(authority.source, isNativeDesktopPlatform(platform) ? "native" : "fixture") ||
    (authority.source === "native-console" && (authority.plan !== plan || !authority.controllerID)) ||
    approval.phase !== phase
  )
    throw new TypeError("TASK24_DESKTOP_APPROVAL_AUTHORITY")
  checkDesktopApprovalRequest(
    approval,
    plan,
    sid,
    approval.phase === "start-readonly" ? approval.manifestSha256 : undefined,
  )
}

export function desktopConfirmationPanel(
  plan: DesktopLaunchPlan,
  approval: DesktopLaunchApproval,
  profile?: DesktopPreparedProfile,
) {
  const platform = requireDesktopPlan(plan)
  checkDesktopApprovalRequest(approval, plan, approval.sid, profile?.manifestSha256)
  // No executable candidate or guessed stop method is presented while native lifecycle rules are unknown.
  if (approval.phase === "start-readonly" && isNativeDesktopPlatform(platform))
    throw new TypeError("TASK24_DESKTOP_NATIVE_RULES_UNPROVED")
  const settings = canonicalJson(plan.settings)
  if (isNativeDesktopPlatform(platform) && Buffer.byteLength(settings) !== 144)
    throw new TypeError("TASK24_DESKTOP_SETTINGS_SIZE")
  const directories = [
    ...new Set([
      plan.paths.root,
      plan.paths.home,
      path.join(plan.paths.home, "AppData"),
      path.join(plan.paths.home, "AppData", "Roaming"),
      path.join(plan.paths.home, "AppData", "Roaming", "Docker"),
      path.join(plan.paths.home, "AppData", "Local"),
      path.join(plan.paths.home, "AppData", "Local", "Docker"),
      plan.paths.frontend,
      plan.paths.cli,
      plan.paths.temp,
      path.join(plan.paths.root, "state"),
      path.join(plan.paths.root, "state", "grants"),
    ]),
  ]
  const body = [
    "TASK24 DESKTOP — LOCAL SINGLE OPERATION; NOT LINUX ACCEPTANCE",
    `Operation: ${approval.phase}\nSID: ${approval.sid}\nLaunchID: ${approval.launchID}\nExpires: ${approval.expiresAt}`,
    `Source SHA256: ${plan.spec.sourceSha256}\nSpecifications SHA256: ${plan.spec.specSha256}\nImplementation plans SHA256: ${plan.spec.planSha256}\nRequest spec SHA256: ${plan.specSha256}\nProfile plan SHA256: ${plan.planSha256}\nCompatibility SHA256: ${plan.compatibilitySha256}\nRequest SHA256: ${sha256Text(canonicalJson(approval))}`,
    `Install: ${canonicalJson(plan.spec.install)}\nWSL config identity: ${canonicalJson(plan.spec.wslConfig)}\nRegistration: ${canonicalJson(plan.spec.registration)}\nDisks (metadata only): ${canonicalJson(plan.spec.disks)}`,
    `Target: ${plan.paths.root}\nSettings (all five): ${settings}\nEnvironment whitelist: ${canonicalJson(plan.env)}\nPINATA_SINGLE_INSTANCE_LOCK=true`,
    approval.phase === "prepare-profile"
      ? `Creates 12 directories:\n${directories.join("\n")}\nCreates 4 files:\n${["owner.json", `state/grants/${approval.nonce}.json`, "home-oc-task24-dd479/AppData/Roaming/Docker/settings-store.json", "manifest.json"].map((f) => path.join(plan.paths.root, f)).join("\n")}\nSettings bytes: ${Buffer.byteLength(settings)}; conservative payload bound: 3145728 + ${Buffer.byteLength(settings)} bytes (not NTFS allocation or runtime growth).\nControl inputs: ${path.join("D:\\OpenCode-Benchmark\\Task24\\control\\desktop-launch", approval.launchID, "spec.json")} and prepare-approval.json\nNo engine start. Old C trees and existing VHDs are not modified.`
      : `Manifest SHA256: ${profile?.manifestSha256}\nFixture lifecycle only; no native executable/argv is authorized.\nObservation: owned process/pipe/storage inventory, no containers.\nStart deadline: 120 seconds; finally stop-owned deadline: 30 seconds.\nOutput: ${path.join("D:\\OpenCode-Benchmark\\Task24\\reports\\desktop-launch", approval.launchID, "inventory.json")}`,
  ].join("\n\n")
  if (
    Buffer.byteLength(body) > 12288 ||
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(body) ||
    Object.values(approval).some((v) => typeof v === "string" && /[\r\n]/.test(v))
  )
    throw new TypeError("TASK24_DESKTOP_PANEL_UNSAFE")
  return body
}

/** Only this fixed native chain may register console provenance; strings/exit codes are not capabilities. */
export async function confirmDesktopInteractive(input: {
  raw: unknown
  plan: DesktopLaunchPlan
  profile?: DesktopPreparedProfile
  signal: AbortSignal
}) {
  const platform = requireDesktopPlan(input.plan)
  if (!isNativeDesktopPlatform(platform)) throw new TypeError("TASK24_DESKTOP_NATIVE_CONFIRMATION_SOURCE")
  if (input.signal.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
  await revalidateDesktopSpec(input.plan.spec)
  const before = Schema.decodeUnknownSync(DesktopObservation)(await platform.observe(input.plan.spec, input.signal), {
    onExcessProperty: "error",
  })
  if (before.runningDocker || before.runningWsl || !["idle", "stopped"].includes(before.phase))
    throw new TypeError("TASK24_DESKTOP_START_CONFLICT")
  if (input.profile) {
    if (input.profile.plan !== input.plan) throw new TypeError("TASK24_DESKTOP_PROFILE_BINDING")
    await (await import("./profile")).revalidateDesktopProfile(input.profile)
  }
  const approval = checkDesktopApprovalRequest(input.raw, input.plan, before.sid, input.profile?.manifestSha256)
  const panel = desktopConfirmationPanel(input.plan, approval, input.profile)
  const controllerID = crypto.randomUUID()
  const decision = await readDesktopConsoleDecision(
    {
      panel,
      panelSha256: sha256Text(panel),
      requestSha256: sha256Text(canonicalJson(approval)),
      controllerID,
      launchID: approval.launchID,
      phase: approval.phase,
      expiresAt: approval.expiresAt,
    },
    input.signal,
  )
  if (decision !== "confirmed" || input.signal.aborted)
    throw new TypeError(decision === "unavailable" ? "TASK24_DESKTOP_CONSOLE_UNAVAILABLE" : "TASK24_DESKTOP_CANCELLED")
  await revalidateDesktopSpec(input.plan.spec)
  const after = Schema.decodeUnknownSync(DesktopObservation)(await platform.observe(input.plan.spec, input.signal), {
    onExcessProperty: "error",
  })
  if (canonicalJson(before) !== canonicalJson(after)) throw new TypeError("TASK24_DESKTOP_OBSERVATION_DRIFT")
  if (input.profile) await (await import("./profile")).revalidateDesktopProfile(input.profile)
  checkDesktopApprovalRequest(approval, input.plan, after.sid, input.profile?.manifestSha256)
  approvals.set(approval, {
    hash: sha256Text(canonicalJson(approval)),
    source: "native-console",
    plan: input.plan,
    controllerID,
  })
  return approval
}
