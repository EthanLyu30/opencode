import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { FileIdentity, requireDPath, type HostRequest, type StorageProof } from "./contracts"
import { fileIdentity, inspectStorage } from "./storage"
import { makeProcessRunner, makeDockerRunner } from "./docker"
export const StorageSource = Schema.Struct({
  kind: Schema.Literal("desktop-wsl-legacy"),
  desktop: FileIdentity,
  backend: FileIdentity,
  wslConfig: Schema.String,
  allowEffectiveSwapProbe: Schema.Literal(true),
})
export function bindEffectiveSwap(input: {
  sourcePath: string
  windowsProfile: string
  swap: { kind: "disabled" } | { kind: "file"; path: string }
  active: boolean
  swapsText: string
}) {
  if (
    path.win32.normalize(input.sourcePath) !== input.sourcePath ||
    input.sourcePath.toLowerCase() !== path.win32.join(input.windowsProfile, ".wslconfig").toLowerCase() ||
    !input.active ||
    input.swap.kind !== "disabled" ||
    input.swapsText.trim().split(/\r?\n/).length !== 1 ||
    !/^Filename\s+Type\s+Size\s+Used\s+Priority\s*$/.test(input.swapsText.trim())
  )
    throw new TypeError("TASK24_STORAGE_EFFECTIVE_SWAP_UNOBSERVED")
}
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
      canonicalJson(await fileIdentity(source.backend.path)) !== canonicalJson(source.backend) ||
      !source.backend.path.startsWith(path.dirname(source.desktop.path) + "\\") ||
      path.basename(source.wslConfig).toLowerCase() !== ".wslconfig"
    )
      throw new TypeError("TASK24_STORAGE_SOURCE")
    const cfg = await fs.lstat(source.wslConfig)
    if (!cfg.isFile() || cfg.isSymbolicLink() || cfg.nlink !== 1 || cfg.size > 65536)
      throw new TypeError("TASK24_STORAGE_SOURCE")
    const literal = source.desktop.path.replaceAll("'", "''")
    const pipe = input.request.endpoint.split("/").at(-1)!
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;public static class Task24Pipe{[DllImport("kernel32.dll",SetLastError=true)]public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint id);}'
$client=New-Object System.IO.Pipes.NamedPipeClientStream('.', '${pipe}', [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
try{$client.Connect(1000);[uint32]$ownerProcessID=0;if(-not [Task24Pipe]::GetNamedPipeServerProcessId($client.SafePipeHandle,[ref]$ownerProcessID)){throw 'owner'};$owner=Get-CimInstance Win32_Process -Filter "ProcessId=$ownerProcessID";$sid=(Invoke-CimMethod -InputObject $owner -MethodName GetOwnerSid).Sid;$ownerPath=$owner.ExecutablePath;$backendVersion=(Get-Item -LiteralPath $ownerPath).VersionInfo.ProductVersion}finally{$client.Dispose()}
$v=(Get-Item -LiteralPath '${literal}').VersionInfo.ProductVersion; $r=@(Get-ChildItem -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DistributionName -eq 'docker-desktop-data' }); if($r.Count -ne 1){throw 'registration'}; $p=(Get-ItemProperty -LiteralPath 'HKCU:\\Volatile Environment').USERPROFILE; $running=@(& "$env:SystemRoot\\System32\\wsl.exe" --list --running --quiet | ForEach-Object { $_.Replace([string][char]0,'').Trim() }); if($LASTEXITCODE -ne 0 -or $running -notcontains 'docker-desktop'){throw 'inactive'}; $swaps=(& "$env:SystemRoot\\System32\\wsl.exe" --distribution docker-desktop --exec /bin/cat /proc/swaps) -join "\n"; if($LASTEXITCODE -ne 0){throw 'swap'}; @{version=$v;distributionName=$r[0].DistributionName;basePath=$r[0].BasePath;windowsProfile=$p;active=$true;swapsText=$swaps;ownerPath=$ownerPath;ownerSID=$sid;userSID=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;backendVersion=$backendVersion}|ConvertTo-Json -Compress`
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
        APPDATA: input.request.roots.config,
        LOCALAPPDATA: input.request.roots.temp,
        PATH: "C:\\Windows\\System32",
        PSModuleAnalysisCachePath: path.join(input.request.roots.temp, "ModuleAnalysisCache"),
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
    const observed = Schema.decodeUnknownSync(
      Schema.Struct({
        version: Schema.String,
        distributionName: Schema.Literal("docker-desktop-data"),
        basePath: Schema.String,
        windowsProfile: Schema.String,
        active: Schema.Boolean,
        swapsText: Schema.String,
        ownerPath: Schema.String,
        ownerSID: Schema.String,
        userSID: Schema.String,
        backendVersion: Schema.String,
      }),
    )(JSON.parse(Buffer.from(result.stdout).toString("utf8")), { onExcessProperty: "error" })
    const registration = decodeLegacyRegistration({
      version: observed.version,
      distributionName: observed.distributionName,
      basePath: observed.basePath,
    })
    if (
      observed.ownerPath.toLowerCase() !== source.backend.path.toLowerCase() ||
      !observed.ownerSID ||
      observed.ownerSID !== observed.userSID ||
      observed.version.match(/^4\.\d+\.\d+/)?.[0] !== observed.backendVersion.match(/^4\.\d+\.\d+/)?.[0]
    )
      throw new TypeError("TASK24_STORAGE_DAEMON_BINDING")
    const engineResult = await makeDockerRunner({ request: input.request }).execute({
      argv: ["info", "--format", "{{json .}}"],
      timeoutMs: 15000,
      maxStdoutBytes: 1048576,
      maxStderrBytes: 65536,
      signal: new AbortController().signal,
    })
    if (!engineResult.started || engineResult.exitCode || engineResult.truncated)
      throw new TypeError("TASK24_STORAGE_DAEMON_BINDING")
    const engine = Schema.decodeUnknownSync(
      Schema.Struct({
        ID: Schema.String,
        KernelVersion: Schema.String,
        OperatingSystem: Schema.String,
        DockerRootDir: Schema.String,
      }),
    )(JSON.parse(Buffer.from(engineResult.stdout).toString("utf8")))
    if (
      !/microsoft.*wsl2/i.test(engine.KernelVersion) ||
      !/^Docker Desktop$/i.test(engine.OperatingSystem) ||
      engine.DockerRootDir !== "/var/lib/docker"
    )
      throw new TypeError("TASK24_STORAGE_DAEMON_BINDING")
    if (source.wslConfig.toLowerCase() !== path.win32.join(observed.windowsProfile, ".wslconfig").toLowerCase())
      throw new TypeError("TASK24_STORAGE_USER_CONFIG")
    const resolved = await fs.realpath(source.wslConfig)
    if (resolved.toLowerCase() !== source.wslConfig.toLowerCase()) throw new TypeError("TASK24_STORAGE_USER_CONFIG")
    const config = await fs.readFile(source.wslConfig, "utf8"),
      swap = parseWslSwap(config)
    bindEffectiveSwap({
      sourcePath: source.wslConfig,
      windowsProfile: observed.windowsProfile,
      swap,
      active: observed.active,
      swapsText: observed.swapsText,
    })
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
      settingsSha256: sha256Text(
        canonicalJson({
          desktop: source.desktop,
          backend: source.backend,
          daemon: engine,
          ownerSID: observed.ownerSID,
          registration,
          swap,
          windowsProfile: observed.windowsProfile,
          effectiveSwaps: observed.swapsText.trim(),
        }),
      ),
      observedAt: Date.now(),
    }
    if ((await inspectStorage(proof)).kind !== "ready") throw new TypeError("TASK24_STORAGE_PHYSICAL_IDENTITY")
    return proof
  }
}
