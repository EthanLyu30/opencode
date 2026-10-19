import path from "node:path"
export { planDesktopProfileV2, requireDesktopPlanV2 } from "./planning-v2"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { sha256Text } from "../../hash"
import { decodeDesktopLaunchSpec, requireDesktopReport } from "./compatibility"
import {
  desktopBlocked,
  type DesktopLaunchPlan,
  type DesktopLaunchSpec,
  type DesktopCompatibilityReport,
  type DesktopPlatform,
} from "./contracts"

const plans = new WeakMap<object, DesktopPlatform>()

export function requireDesktopPlan(plan: DesktopLaunchPlan, platform?: DesktopPlatform) {
  const authority = plans.get(plan)
  if (!authority || (platform && authority !== platform)) throw new TypeError("TASK24_DESKTOP_PLAN_AUTHORITY")
  return authority
}

export function planDesktopProfile(raw: DesktopLaunchSpec, report: DesktopCompatibilityReport) {
  try {
    const spec = decodeDesktopLaunchSpec(raw),
      platform = requireDesktopReport(spec, report)
    const paths = {
      root: spec.profileRoot,
      home: path.join(spec.profileRoot, "home-oc-task24-dd479"),
      frontend: path.join(spec.profileRoot, "frontend"),
      cli: path.join(spec.profileRoot, "cli"),
      temp: path.join(spec.profileRoot, "temp"),
    }
    const settings = {
      SettingsVersion: 44,
      CustomWslDistroDir: spec.dataRoot,
      WslEngineEnabled: true,
      UseWindowsContainers: false,
      AutoStart: false,
    }
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
      schemaVersion: 1 as const,
      assurance: report.assurance,
      spec,
      specSha256: sha256Text(canonicalJson(spec)),
      compatibilitySha256: sha256Text(canonicalJson(report)),
      paths,
      env,
      settings,
      settingsSha256: sha256Text(canonicalJson(settings)),
      endpoint: "npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine",
    }
    const plan = freeze({ ...body, planSha256: sha256Text(canonicalJson(body)) })
    plans.set(plan, platform)
    return { kind: "ready" as const, value: plan }
  } catch (error) {
    return desktopBlocked(error instanceof Error ? error.message : "desktop_plan_failed")
  }
}
