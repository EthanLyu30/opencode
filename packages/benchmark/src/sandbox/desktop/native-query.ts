import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { directoryIdentity } from "../storage"
import { canonicalDesktopPath, decodeDesktopLaunchSpec, desktopRoot } from "./compatibility"
import type { DesktopLaunchSpec } from "./contracts"
import { runDesktopProbe } from "./native-process"
import { readDesktopProbeImage } from "./probe-image"
import { desktopNativeQueryScript } from "./native-script"

const Text = Schema.NonEmptyString
const Disk = Schema.Struct({ path: Text, fileID: Text, volumeID: Text })
const Snapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  complete: Schema.Literal(true),
  sampledAt: Schema.Finite,
  sid: Text,
  profileSID: Text,
  windowsProfile: Text,
  registration: Schema.Struct({
    key: Text,
    distributionName: Text,
    basePath: Text,
    version: Schema.Literal(2),
    build: Schema.Literal(230596),
  }),
  disks: Schema.Struct({ runtime: Disk, data: Disk }),
  processes: Schema.Array(
    Schema.Struct({
      pid: Schema.Int,
      parentPID: Schema.Int,
      createdAt: Schema.Finite,
      ownerSID: Text,
      imagePath: Text,
      role: Schema.Literals(["desktop", "backend", "service", "vm"]),
    }),
  ),
  pipes: Schema.Array(Schema.Struct({ endpoint: Text, present: Schema.Boolean })),
  installedWsl: Schema.Array(Text),
  runningWsl: Schema.Array(Text),
})
export type DesktopNativeSnapshot = typeof Snapshot.Type
const endpoints = [
  "npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine",
  "npipe:////./pipe/dockerDesktopEngine",
  "npipe:////./pipe/docker_engine",
]

export function decodeWslNames(bytes: Uint8Array, known: readonly string[]) {
  if (bytes.byteLength > 8192 || new Set(known).size !== known.length) throw new TypeError("TASK24_DESKTOP_WSL_NAMES")
  const candidates = ["utf-8", "utf-16le"].flatMap((encoding) => {
    try {
      if (encoding === "utf-16le" && bytes.byteLength % 2) return []
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(text)) return []
      const names = text.split(/\r?\n/).filter((n) => n !== "")
      if (new Set(names).size !== names.length || names.some((n) => !known.includes(n))) return []
      return [names]
    } catch {
      return []
    }
  })
  const results = [...new Set(candidates.map((c) => canonicalJson(c)))]
  if (results.length !== 1) throw new TypeError("TASK24_DESKTOP_WSL_NAMES")
  return freeze(candidates[0]!)
}

export function decodeDesktopNativeSnapshot(raw: unknown, spec: DesktopLaunchSpec): DesktopNativeSnapshot {
  const state = Schema.decodeUnknownSync(Snapshot)(raw, { onExcessProperty: "error" })
  if (
    !/^S-1-\d+(?:-\d+)+$/.test(state.sid) ||
    state.profileSID !== state.sid ||
    state.windowsProfile !== spec.windowsProfile ||
    state.sampledAt > Date.now() + 1000 ||
    state.sampledAt < Date.now() - 15000 ||
    state.registration.key !== spec.registration.fileID ||
    state.registration.distributionName !== spec.registration.distributionName ||
    state.registration.basePath !== spec.registration.basePath ||
    canonicalJson(state.disks) !== canonicalJson(spec.disks) ||
    state.processes.length > 256 ||
    new Set(state.processes.map((p) => p.pid)).size !== state.processes.length ||
    state.processes.some(
      (p) =>
        p.pid < 1 ||
        p.parentPID < 1 ||
        p.parentPID === p.pid ||
        p.createdAt <= 0 ||
        !/^S-1-\d+(?:-\d+)+$/.test(p.ownerSID),
    ) ||
    canonicalJson(state.pipes.map((p) => p.endpoint).sort()) !== canonicalJson([...endpoints].sort()) ||
    !state.installedWsl.includes("docker-desktop") ||
    new Set(state.installedWsl).size !== state.installedWsl.length ||
    new Set(state.runningWsl).size !== state.runningWsl.length ||
    state.runningWsl.some((n) => !state.installedWsl.includes(n))
  )
    throw new TypeError("TASK24_DESKTOP_NATIVE_SNAPSHOT")
  for (const p of state.processes) canonicalDesktopPath(p.imagePath, /^[cC]:/.test(p.imagePath) ? "C" : "D")
  return freeze(state)
}

export function desktopNativeProbeCommands() {
  return freeze([
    { exe: "C:\\Windows\\System32\\wsl.exe", argv: ["--list", "--quiet"] },
    { exe: "C:\\Windows\\System32\\wsl.exe", argv: ["--list", "--running", "--quiet"] },
  ])
}

export function requireDesktopNativeSpec(raw: DesktopLaunchSpec) {
  const spec = decodeDesktopLaunchSpec(raw),
    base = "D:\\Applications\\Docker"
  const expected = {
    desktop: path.join(base, "Docker Desktop.exe"),
    frontend: path.join(base, "frontend", "Docker Desktop.exe"),
    backend: path.join(base, "resources", "com.docker.backend.exe"),
    asar: path.join(base, "frontend", "resources", "app.asar"),
    cli: path.join(base, "resources", "bin", "docker.exe"),
  }
  if (
    process.platform !== "win32" ||
    spec.profileRoot !== desktopRoot ||
    spec.windowsProfile !== "C:\\Users\\Administrator" ||
    spec.dataRoot !== "D:\\Applications\\DockerWSL" ||
    Object.entries(expected).some(([key, value]) => spec.install[key as keyof typeof expected].path !== value) ||
    spec.install.asar.sha256 !== "607225828b3ca3921972052a4186b89e9fcce271a2c5af25ae2ea9924a14dada" ||
    spec.install.backend.sha256 !== "2856de9fd89456513e8b6c85bfe1fb2df791365b227297e58ed08fb3ffaa09fd"
  )
    throw new TypeError("TASK24_DESKTOP_NATIVE_IDENTITY")
  return spec
}

export async function queryDesktopWindows(raw: DesktopLaunchSpec, signal: AbortSignal) {
  const spec = requireDesktopNativeSpec(raw)
  if (signal.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)])
  const systemImages = {
    powershell: await readDesktopProbeImage("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
    wsl: await readDesktopProbeImage("C:\\Windows\\System32\\wsl.exe"),
  }
  const disks = async () => {
    const result = await Promise.all(
      Object.entries(spec.disks).map(async ([key, disk]) => {
        await directoryIdentity(path.dirname(disk.path))
        const stat = await fs.lstat(disk.path)
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          (await fs.realpath(disk.path)).toLowerCase() !== disk.path.toLowerCase()
        )
          throw new TypeError("TASK24_DESKTOP_DISK_DRIFT")
        return [
          key,
          { path: disk.path, fileID: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, volumeID: String(stat.dev) },
        ] as const
      }),
    )
    return { runtime: result.find(([key]) => key === "runtime")![1], data: result.find(([key]) => key === "data")![1] }
  }
  const before = await disks()
  const result = await runDesktopProbe({
    image: systemImages.powershell,
    exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    argv: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(desktopNativeQueryScript(), "utf16le").toString("base64"),
    ],
    timeoutMs: 5000,
    stdoutLimit: 262144,
    stderrLimit: 8192,
    signal: deadline,
  })
  if (result.exitCode || result.stderr.length) throw new TypeError("TASK24_DESKTOP_NATIVE_QUERY")
  const metadata = Schema.decodeUnknownSync(
    Schema.Struct({ ...Snapshot.fields, disks: Schema.optionalKey(Schema.Struct({ runtime: Disk, data: Disk })) }),
  )(
    Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(
      new TextDecoder("utf8", { fatal: true }).decode(result.stdout),
    ),
    { onExcessProperty: "error" },
  )
  const [list, running] = desktopNativeProbeCommands()
  const allResult = await runDesktopProbe({
    image: systemImages.wsl,
    ...list!,
    timeoutMs: 5000,
    stdoutLimit: 8192,
    stderrLimit: 8192,
    signal: deadline,
  })
  if (allResult.exitCode || allResult.stderr.length) throw new TypeError("TASK24_DESKTOP_WSL_QUERY")
  const installedWsl = decodeWslNames(allResult.stdout, metadata.installedWsl)
  if (canonicalJson([...installedWsl].sort()) !== canonicalJson([...metadata.installedWsl].sort()))
    throw new TypeError("TASK24_DESKTOP_WSL_PARTIAL")
  const runningResult = await runDesktopProbe({
    image: systemImages.wsl,
    ...running!,
    timeoutMs: 5000,
    stdoutLimit: 8192,
    stderrLimit: 8192,
    signal: deadline,
  })
  if (runningResult.exitCode || runningResult.stderr.length) throw new TypeError("TASK24_DESKTOP_WSL_QUERY")
  if (canonicalJson(before) !== canonicalJson(await disks()) || deadline.aborted)
    throw new TypeError("TASK24_DESKTOP_NATIVE_DRIFT")
  return decodeDesktopNativeSnapshot(
    { ...metadata, disks: before, installedWsl, runningWsl: decodeWslNames(runningResult.stdout, installedWsl) },
    spec,
  )
}
