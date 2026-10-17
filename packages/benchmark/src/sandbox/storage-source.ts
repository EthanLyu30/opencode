import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { FileIdentity, requireDPath, type HostRequest, type StorageProof } from "./contracts"
import { fileIdentity, inspectStorage } from "./storage"
import { makeProcessRunner } from "./docker"
export const StorageSource = Schema.Struct({
  kind: Schema.Literal("desktop-wsl-legacy"),
  desktop: FileIdentity,
  wslConfig: Schema.String,
})
export type StorageSource = typeof StorageSource.Type
export function parseWslSwap(text: string): { kind: "disabled" } | { kind: "file"; path: string } {
  let section = "",
    swap: string | undefined,
    file: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    if (line.startsWith("[")) {
      section = line.toLowerCase()
      continue
    }
    if (section !== "[wsl2]") continue
    const index = line.indexOf("=")
    if (index < 0) continue
    const key = line.slice(0, index).trim().toLowerCase(),
      value = line.slice(index + 1).trim()
    if (key === "swap") {
      if (swap !== undefined) throw new TypeError("TASK24_STORAGE_DUPLICATE")
      swap = value
    }
    if (key === "swapfile") {
      if (file !== undefined) throw new TypeError("TASK24_STORAGE_DUPLICATE")
      file = value.replace(/\\\\/g, "\\")
    }
  }
  if (swap === "0" || swap === "0GB" || swap === "0MB") return { kind: "disabled" }
  if (!file || !swap || !/^\d+(?:MB|GB)$/i.test(swap)) throw new TypeError("TASK24_STORAGE_SWAP_UNKNOWN")
  return { kind: "file", path: requireDPath(file) }
}
export function decodeLegacyRegistration(raw: unknown) {
  const value = Schema.decodeUnknownSync(
    Schema.Struct({
      version: Schema.String,
      distributionName: Schema.Literal("docker-desktop-data"),
      basePath: Schema.String,
    }),
  )(raw, { onExcessProperty: "error" })
  const version = /^4\.(\d+)\./.exec(value.version)
  if (!version || Number(version[1]) > 29) throw new TypeError("TASK24_STORAGE_VERSION_UNSUPPORTED")
  return { ...value, basePath: requireDPath(value.basePath.replace(/^\\\\\?\\/, "")) }
}
/** Legacy WSL registry layout only. New managed VHD/Hyper-V layouts explicitly block. */
export function makeStorageProbe(input: { request: HostRequest; source: StorageSource }) {
  return async (): Promise<StorageProof> => {
    const source = Schema.decodeUnknownSync(StorageSource)(input.source, { onExcessProperty: "error" })
    if (
      canonicalJson(await fileIdentity(source.desktop.path)) !== canonicalJson(source.desktop) ||
      path.basename(source.wslConfig).toLowerCase() !== ".wslconfig"
    )
      throw new TypeError("TASK24_STORAGE_SOURCE")
    const cfg = await fs.lstat(source.wslConfig)
    if (!cfg.isFile() || cfg.isSymbolicLink() || cfg.nlink !== 1 || cfg.size > 65536)
      throw new TypeError("TASK24_STORAGE_SOURCE")
    const config = await fs.readFile(source.wslConfig, "utf8"),
      swap = parseWslSwap(config)
    const literal = source.desktop.path.replaceAll("'", "''")
    const script = `$ErrorActionPreference='Stop'; $v=(Get-Item -LiteralPath '${literal}').VersionInfo.ProductVersion; $r=@(Get-ChildItem -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DistributionName -eq 'docker-desktop-data' }); if($r.Count -ne 1){throw 'registration'}; @{version=$v;distributionName=$r[0].DistributionName;basePath=$r[0].BasePath}|ConvertTo-Json -Compress`
    const runner = makeProcessRunner({
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      argvPrefix: ["-NoProfile", "-NonInteractive"],
      cwd: input.request.roots.temp,
      env: {
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\Windows",
        TEMP: input.request.roots.temp,
        TMP: input.request.roots.temp,
        HOME: input.request.roots.config,
        USERPROFILE: input.request.roots.config,
        PATH: "C:\\Windows\\System32",
      },
    })
    const result = await runner.execute({
      argv: ["-Command", script],
      timeoutMs: 15000,
      maxStdoutBytes: 65536,
      maxStderrBytes: 65536,
      signal: new AbortController().signal,
    })
    if (!result.started || result.exitCode !== 0 || result.truncated)
      throw new TypeError("TASK24_STORAGE_NATIVE_OBSERVATION")
    const registration = decodeLegacyRegistration(JSON.parse(Buffer.from(result.stdout).toString("utf8")))
    const identity = async (file: string) => {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new TypeError("TASK24_STORAGE_DISK")
      return { path: file, fileID: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, volumeID: String(stat.dev) }
    }
    const proof: StorageProof = {
      backend: "wsl2",
      disk: await identity(path.join(registration.basePath, "ext4.vhdx")),
      dataRoot: registration.basePath,
      swap: swap.kind === "disabled" ? swap : { kind: "file", file: await identity(swap.path) },
      settingsSha256: sha256Text(canonicalJson({ desktop: source.desktop, registration, swap })),
      observedAt: Date.now(),
    }
    if ((await inspectStorage(proof)).kind !== "ready") throw new TypeError("TASK24_STORAGE_PHYSICAL_IDENTITY")
    return proof
  }
}
