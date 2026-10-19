import path from "node:path"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { sha256Text } from "../../hash"
import { desktopBlocked, type DesktopPlatform, type DesktopCompatibilityReport } from "./contracts"
import { requireDesktopReportV2 } from "./compatibility-v2"
import {
  decodeDesktopSpecV2,
  decodeDesktopIntentV2,
  desktopRuntimeTargetsV2,
  desktopSettingsLimitsV2,
  type DesktopLaunchSpecV2,
  type DesktopLaunchPlanV2,
} from "./v2-contracts"

const plans = new WeakMap<DesktopLaunchPlanV2, ReturnType<typeof requireDesktopReportV2>>()
export function readDesktopPlanAuthorityV2(plan: DesktopLaunchPlanV2) {
  const state = plans.get(plan)
  if (!state) throw new TypeError("TASK24_DESKTOP_V2_PLAN_AUTHORITY")
  return state
}
export function requireDesktopPlanV2(plan: DesktopLaunchPlanV2, platform?: DesktopPlatform) {
  const state = readDesktopPlanAuthorityV2(plan)
  if (platform && state.platform !== platform) throw new TypeError("TASK24_DESKTOP_V2_PLAN_AUTHORITY")
  return state.platform
}
export function planDesktopProfileV2(raw: DesktopLaunchSpecV2, report: DesktopCompatibilityReport) {
  try {
    const spec = decodeDesktopSpecV2(raw),
      authority = requireDesktopReportV2(spec, report)
    const paths = {
      root: spec.profileRoot,
      home: path.join(spec.profileRoot, "home-oc-task24-dd479"),
      frontend: path.join(spec.profileRoot, "frontend"),
      cli: path.join(spec.profileRoot, "cli"),
      temp: path.join(spec.profileRoot, "temp"),
    }
    const expected = {
      SettingsVersion: 44 as const,
      CustomWslDistroDir: spec.dataRoot,
      WslEngineEnabled: true as const,
      UseWindowsContainers: false as const,
      AutoStart: false as const,
    }
    const intent = decodeDesktopIntentV2(
      canonicalJson({
        schemaVersion: 2,
        policyID: authority.policy.id,
        policySha256: authority.policy.sha256,
        expected,
      }),
      { dataRoot: spec.dataRoot, policyID: authority.policy.id, policySha256: authority.policy.sha256 },
    )
    const env = {
      PINATA_HOME_DIRECTORY_OVERRIDE: paths.home,
      PINATA_USER_DATA_DIR_OVERRIDE: paths.frontend,
      PINATA_SINGLE_INSTANCE_LOCK: "true",
      HOME: paths.home,
      USERPROFILE: paths.home,
      APPDATA: path.join(paths.home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(paths.home, "AppData", "Local"),
      TEMP: paths.temp,
      TMP: paths.temp,
      DOCKER_CONFIG: paths.cli,
      DOCKER_HOST: "",
      DOCKER_CONTEXT: "default",
      DOCKER_TLS_VERIFY: "",
      DOCKER_CERT_PATH: "",
      BUILDX_BUILDER: "",
      BUILDKIT_HOST: "",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      PATH: path.dirname(spec.install.cli.path) + ";C:\\Windows\\System32",
      PSModuleAnalysisCachePath: path.join(paths.temp, "ModuleAnalysisCache"),
    }
    const body = {
      schemaVersion: 2 as const,
      assurance: report.assurance,
      spec,
      specSha256: sha256Text(canonicalJson(spec)),
      compatibilitySha256: sha256Text(canonicalJson(report)),
      paths,
      env,
      endpoint: "npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine",
      intent,
      intentSha256: sha256Text(canonicalJson(intent)),
      policyID: authority.policy.id,
      policySha256: authority.policy.sha256,
      seedSha256: sha256Text(canonicalJson(expected)),
      runtimeTargets: desktopRuntimeTargetsV2(paths.root),
      phases: ["starting", "observed", "stopping"] as const,
      limits: desktopSettingsLimitsV2,
    }
    const plan = freeze({ ...body, planSha256: sha256Text(canonicalJson(body)) })
    plans.set(plan, authority)
    return { kind: "ready" as const, value: plan }
  } catch (error) {
    return desktopBlocked(
      error instanceof Error && /^[a-zA-Z0-9_.:-]{1,200}$/.test(error.message)
        ? error.message
        : "TASK24_DESKTOP_V2_PLAN",
    )
  }
}
