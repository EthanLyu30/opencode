import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { sha256Text } from "../../hash"
import { fileIdentity } from "../storage"
import {
  DesktopSpec,
  Compatibility,
  desktopBlocked,
  type DesktopLaunchSpec,
  type DesktopCompatibilityReport,
  type DesktopPlatform,
} from "./contracts"
import { isNativeDesktopPlatform } from "./platform"

export const desktopRoot = "D:\\OpenCode-Benchmark\\Task24\\toolchain\\docker-launch-dd479"
const reports = new WeakMap<object, { specSha256: string; platform: DesktopPlatform }>()
export function canonicalDesktopPath(value: string, drive = "D") {
  if (
    !new RegExp(`^${drive}:\\\\`, "i").test(value) ||
    path.win32.normalize(value) !== value ||
    value
      .slice(3)
      .split("\\")
      .some(
        (v) =>
          !v || /[:~<>"|?*\x00-\x1f]/.test(v) || /[. ]$/.test(v) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(v),
      )
  )
    throw new TypeError("TASK24_DESKTOP_PATH")
  return value
}
export function decodeDesktopLaunchSpec(raw: unknown): DesktopLaunchSpec {
  const spec = Schema.decodeUnknownSync(DesktopSpec)(raw, { onExcessProperty: "error" })
  for (const value of [
    spec.profileRoot,
    spec.dataRoot,
    ...Object.values(spec.install).map((f) => f.path),
    spec.registration.basePath,
    ...Object.values(spec.disks).map((d) => d.path),
  ])
    canonicalDesktopPath(value)
  canonicalDesktopPath(spec.windowsProfile, /^[cC]:/.test(spec.windowsProfile) ? "C" : "D")
  if (
    spec.version !== "4.79.0.230596" ||
    spec.cliVersion !== "29.5.3" ||
    spec.settingsVersion !== 44 ||
    spec.registration.distributionName !== "docker-desktop" ||
    spec.registration.basePath.toLowerCase() !== path.win32.join(spec.dataRoot, "main").toLowerCase() ||
    spec.disks.runtime.path.toLowerCase() !== path.win32.join(spec.dataRoot, "main", "ext4.vhdx").toLowerCase() ||
    spec.disks.data.path.toLowerCase() !== path.win32.join(spec.dataRoot, "disk", "docker_data.vhdx").toLowerCase() ||
    spec.wslConfig.path.toLowerCase() !== path.win32.join(spec.windowsProfile, ".wslconfig").toLowerCase() ||
    [spec.dataRoot, spec.windowsProfile, ...Object.values(spec.install).map((f) => f.path)].some(
      (p) =>
        p.toLowerCase().startsWith(spec.profileRoot.toLowerCase() + "\\") ||
        spec.profileRoot.toLowerCase().startsWith(p.toLowerCase() + "\\") ||
        p.toLowerCase() === spec.profileRoot.toLowerCase(),
    )
  )
    throw new TypeError("TASK24_DESKTOP_SPEC_BINDING")
  return freeze(spec)
}
export async function readDesktopText(file: string, max = 65536) {
  canonicalDesktopPath(file, /^[cC]:/.test(file) ? "C" : "D")
  let current = path.parse(file).root
  for (const part of path.relative(current, path.dirname(file)).split(path.sep)) {
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(current)).toLowerCase() !== current.toLowerCase()
    )
      throw new TypeError("TASK24_DESKTOP_LINK")
  }
  const before = await fs.lstat(file)
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.isSymbolicLink() ||
    before.size > max ||
    (await fs.realpath(file)).toLowerCase() !== file.toLowerCase()
  )
    throw new TypeError("TASK24_DESKTOP_FILE")
  const text = await fs.readFile(file, "utf8"),
    after = await fs.lstat(file)
  const id = (s: typeof before) => `${s.dev}:${s.ino}:${s.birthtimeMs}:${s.mtimeMs}:${s.size}`
  if (id(before) !== id(after) || Buffer.byteLength(text) > max) throw new TypeError("TASK24_DESKTOP_DRIFT")
  return {
    text,
    modifiedAt: before.mtimeMs,
    fileID: `${before.dev}:${before.ino}:${before.birthtimeMs}`,
    sha256: sha256Text(text),
  }
}
export async function revalidateDesktopSpec(spec: DesktopLaunchSpec) {
  for (const expected of Object.values(spec.install)) {
    if (canonicalJson(await fileIdentity(expected.path)) !== canonicalJson(expected))
      throw new TypeError("TASK24_DESKTOP_INSTALL_DRIFT")
  }
  const config = await readDesktopText(spec.wslConfig.path)
  if (config.fileID !== spec.wslConfig.fileID || config.sha256 !== spec.wslConfig.sha256)
    throw new TypeError("TASK24_DESKTOP_WSL_DRIFT")
  for (const disk of Object.values(spec.disks)) {
    const s = await fs.lstat(disk.path)
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.isSymbolicLink() ||
      (await fs.realpath(disk.path)).toLowerCase() !== disk.path.toLowerCase() ||
      `${s.dev}:${s.ino}:${s.birthtimeMs}` !== disk.fileID ||
      String(s.dev) !== disk.volumeID
    )
      throw new TypeError("TASK24_DESKTOP_DISK_DRIFT")
  }
}
export function requireDesktopReport(spec: DesktopLaunchSpec, report: DesktopCompatibilityReport) {
  const issued = reports.get(report)
  if (!issued || issued.specSha256 !== sha256Text(canonicalJson(spec)) || report.missing.length)
    throw new TypeError("TASK24_DESKTOP_REPORT_AUTHORITY")
  return issued.platform
}
export async function auditDesktopCompatibility(raw: unknown, platform: DesktopPlatform, signal?: AbortSignal) {
  try {
    if (signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
    const spec = decodeDesktopLaunchSpec(raw)
    if (isNativeDesktopPlatform(platform)) {
      const base = "D:\\Applications\\Docker"
      const expected = {
        desktop: path.win32.join(base, "Docker Desktop.exe"),
        frontend: path.win32.join(base, "frontend", "Docker Desktop.exe"),
        backend: path.win32.join(base, "resources", "com.docker.backend.exe"),
        asar: path.win32.join(base, "frontend", "resources", "app.asar"),
        cli: path.win32.join(base, "resources", "bin", "docker.exe"),
      }
      if (
        spec.profileRoot !== desktopRoot ||
        spec.dataRoot !== "D:\\Applications\\DockerWSL" ||
        spec.windowsProfile !== "C:\\Users\\Administrator" ||
        Object.entries(expected).some(([key, value]) => spec.install[key as keyof typeof expected].path !== value) ||
        spec.install.asar.sha256 !== "607225828b3ca3921972052a4186b89e9fcce271a2c5af25ae2ea9924a14dada" ||
        spec.install.backend.sha256 !== "2856de9fd89456513e8b6c85bfe1fb2df791365b227297e58ed08fb3ffaa09fd"
      )
        throw new TypeError("TASK24_DESKTOP_NATIVE_IDENTITY")
    } else {
      const parent = canonicalDesktopPath(process.env.TMPDIR ?? "")
      if (
        !/^D:\\OpenCode-Benchmark\\Task24\\tmp\\bprep1-[^\\]+$/i.test(parent) ||
        !spec.profileRoot.toLowerCase().startsWith(parent.toLowerCase() + "\\") ||
        [spec.dataRoot, spec.windowsProfile, ...Object.values(spec.install).map((f) => f.path)].some(
          (p) => !p.toLowerCase().startsWith(parent.toLowerCase() + "\\"),
        )
      )
        throw new TypeError("TASK24_DESKTOP_FIXTURE_SCOPE")
    }
    await revalidateDesktopSpec(spec)
    const rawReport = Schema.decodeUnknownSync(Compatibility)(await platform.audit(spec, signal), {
      onExcessProperty: "error",
    })
    if (signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
    const missing = [...rawReport.missing]
    if (rawReport.specSha256 !== sha256Text(canonicalJson(spec))) missing.push("compatibility_spec_mismatch")
    for (const id of ["path_routing", "backend_environment", "registration_reuse", "stop_owned", "cli_default"]) {
      const matches = rawReport.checks.filter((c) => c.id === id)
      if (
        matches.length !== 1 ||
        matches[0]!.conclusion !== "proved" ||
        !Object.values(spec.install).some((f) => f.path === matches[0]!.source && f.sha256 === matches[0]!.sourceSha256)
      )
        missing.push(`${id}_unproved`)
    }
    if (missing.length) return desktopBlocked("desktop_compatibility_blocked", [...new Set(missing)])
    const report = freeze({
      ...rawReport,
      assurance: isNativeDesktopPlatform(platform) ? ("native-static" as const) : ("fixture" as const),
    })
    reports.set(report, { specSha256: rawReport.specSha256, platform })
    return { kind: "ready" as const, value: report }
  } catch (error) {
    return desktopBlocked(error instanceof Error ? error.message : "desktop_audit_failed")
  }
}
