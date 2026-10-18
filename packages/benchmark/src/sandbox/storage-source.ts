import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { FileIdentity, requireDPath, decodeHostRequest, type HostRequest, type StorageProof } from "./contracts"
import { fileIdentity, inspectStorage } from "./storage"
import { makeProcessRunner, makeDockerRunner } from "./docker"
import type { DesktopLaunchSession } from "./desktop/contracts"
const SourceFields = {
  desktop: FileIdentity,
  backend: FileIdentity,
  wslConfig: Schema.String,
  allowEffectiveSwapProbe: Schema.Literal(true),
}
export const StorageSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("desktop-wsl-legacy"), ...SourceFields }),
  Schema.Struct({ kind: Schema.Literal("desktop-wsl-managed"), ...SourceFields, settingsFile: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("desktop-wsl-managed-launch"),
    ...SourceFields,
    settingsFile: Schema.String,
    profileManifest: Schema.String,
  }),
])
const ManagedSettings = Schema.Struct({
  SettingsVersion: Schema.Literal(44),
  CustomWslDistroDir: Schema.String,
  WslEngineEnabled: Schema.optionalKey(Schema.Boolean),
  UseWindowsContainers: Schema.optionalKey(Schema.Boolean),
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
export function decodeManagedRegistration(raw: unknown) {
  const value = parseManagedRegistration(raw)
  return bindManagedRegistration(
    value,
    path.win32.join(value.windowsProfile, "AppData", "Roaming", "Docker", "settings-store.json"),
  )
}
export function decodeManagedLaunchRegistration(
  raw: unknown,
  authority: { windowsProfile: string; dockerProfile: string },
) {
  const value = parseManagedRegistration(raw)
  if (value.windowsProfile !== authority.windowsProfile) throw new TypeError("TASK24_DESKTOP_WINDOWS_PROFILE_BINDING")
  return bindManagedRegistration(
    value,
    path.win32.join(requireDPath(authority.dockerProfile), "AppData", "Roaming", "Docker", "settings-store.json"),
  )
}
function parseManagedRegistration(raw: unknown) {
  const value = Schema.decodeUnknownSync(
    Schema.Struct({
      version: Schema.String,
      distributionName: Schema.Literal("docker-desktop"),
      basePath: Schema.String,
      windowsProfile: Schema.String,
      settingsPath: Schema.String,
      settings: ManagedSettings,
      settingsModifiedAt: Schema.Number,
      backendStartedAt: Schema.Number,
      imagePath: Schema.String,
      attached: Schema.Boolean,
      windowsFilesystemUUID: Schema.String,
      guestFilesystemUUID: Schema.String,
      guestEngineID: Schema.String,
      daemonServerID: Schema.String,
    }),
  )(raw, { onExcessProperty: "error" })
  return value
}
function bindManagedRegistration(value: ReturnType<typeof parseManagedRegistration>, settingsPath: string) {
  if (!/^4\.79\.0(?:\.\d+)?$/.test(value.version)) throw new TypeError("TASK24_STORAGE_VERSION_UNSUPPORTED")
  const root = requireDPath(value.settings.CustomWslDistroDir),
    basePath = requireDPath(value.basePath.replace(/^\\\\\?\\/, "")),
    dataRoot = path.win32.join(root, "disk"),
    diskPath = path.win32.join(dataRoot, "docker_data.vhdx")
  if (
    value.settings.WslEngineEnabled === false ||
    value.settings.UseWindowsContainers === true ||
    basePath.toLowerCase() !== path.win32.join(root, "main").toLowerCase() ||
    path.win32.normalize(value.settingsPath) !== value.settingsPath ||
    value.settingsPath.toLowerCase() !== settingsPath.toLowerCase() ||
    !Number.isFinite(value.settingsModifiedAt) ||
    !Number.isFinite(value.backendStartedAt) ||
    value.settingsModifiedAt < 0 ||
    value.backendStartedAt <= 0 ||
    value.settingsModifiedAt > value.backendStartedAt ||
    !value.attached ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.windowsFilesystemUUID) ||
    value.windowsFilesystemUUID.toLowerCase() !== value.guestFilesystemUUID.toLowerCase() ||
    !value.daemonServerID ||
    value.guestEngineID !== value.daemonServerID ||
    requireDPath(value.imagePath).toLowerCase() !== diskPath.toLowerCase()
  )
    throw new TypeError("TASK24_MANAGED_STORAGE_BINDING")
  return {
    version: value.version,
    distributionName: value.distributionName,
    basePath,
    dataRoot,
    diskPath,
    runtimeDiskPath: path.win32.join(basePath, "ext4.vhdx"),
  }
}
export async function readManagedSettings(input: { file: string; windowsProfile: string }) {
  if (
    path.win32.normalize(input.file) !== input.file ||
    input.file.toLowerCase() !==
      path.win32.join(input.windowsProfile, "AppData", "Roaming", "Docker", "settings-store.json").toLowerCase()
  )
    throw new TypeError("TASK24_MANAGED_SETTINGS_PATH")
  if ((await fs.realpath(input.file)).toLowerCase() !== input.file.toLowerCase())
    throw new TypeError("TASK24_MANAGED_SETTINGS_LINK")
  const before = await fs.lstat(input.file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1048576)
    throw new TypeError("TASK24_MANAGED_SETTINGS_FILE")
  const text = await fs.readFile(input.file, "utf8"),
    settings = Schema.decodeUnknownSync(ManagedSettings)(JSON.parse(text)),
    after = await fs.lstat(input.file)
  if (
    [before.dev, before.ino, before.birthtimeMs, before.mtimeMs, before.size].join(":") !==
    [after.dev, after.ino, after.birthtimeMs, after.mtimeMs, after.size].join(":")
  )
    throw new TypeError("TASK24_MANAGED_SETTINGS_DRIFT")
  return {
    settings,
    sha256: sha256Text(text),
    modifiedAt: before.mtimeMs,
    fileID: `${before.dev}:${before.ino}:${before.birthtimeMs}`,
  }
}
export function ext4SuperblockUUID(bytes: Uint8Array): string {
  if (bytes.length !== 2048) throw new TypeError("TASK24_MANAGED_DISK_SUPERBLOCK")
  const data = Buffer.from(bytes)
  if (data.readUInt16LE(1024 + 56) !== 0xef53) throw new TypeError("TASK24_MANAGED_DISK_SUPERBLOCK")
  const hex = data.subarray(1024 + 104, 1024 + 120).toString("hex")
  if (/^0+$/.test(hex)) throw new TypeError("TASK24_MANAGED_DISK_SUPERBLOCK")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export async function readWslConfigSnapshot(input: { file: string; windowsProfile: string; backendStartedAt: number }) {
  if (
    path.win32.normalize(input.file) !== input.file ||
    input.file.toLowerCase() !== path.win32.join(input.windowsProfile, ".wslconfig").toLowerCase() ||
    (await fs.realpath(input.file)).toLowerCase() !== input.file.toLowerCase()
  )
    throw new TypeError("TASK24_STORAGE_USER_CONFIG")
  const before = await fs.lstat(input.file)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > 65536 ||
    !Number.isFinite(input.backendStartedAt) ||
    before.mtimeMs > input.backendStartedAt ||
    input.backendStartedAt <= 0
  )
    throw new TypeError("TASK24_WSL_CONFIG_NOT_LOADED")
  const text = await fs.readFile(input.file, "utf8"),
    after = await fs.lstat(input.file)
  if (
    [before.dev, before.ino, before.birthtimeMs, before.mtimeMs, before.size].join(":") !==
    [after.dev, after.ino, after.birthtimeMs, after.mtimeMs, after.size].join(":")
  )
    throw new TypeError("TASK24_WSL_CONFIG_DRIFT")
  return {
    swap: parseWslSwap(text),
    sha256: sha256Text(text),
    fileID: `${before.dev}:${before.ino}:${before.birthtimeMs}`,
    modifiedAt: before.mtimeMs,
  }
}
export function storageObservationScript(input: { request: HostRequest; source: StorageSource }): string {
  if (input.source.kind === "desktop-wsl-managed-launch") throw new TypeError("TASK24_DESKTOP_SESSION_REQUIRED")
  return buildStorageObservationScript(input)
}
export async function desktopStorageObservationScript(input: {
  request: HostRequest
  source: StorageSource
  launch: DesktopLaunchSession
}) {
  const { revalidateDesktopLaunchSession } = await import("./desktop/launch")
  const state = await revalidateDesktopLaunchSession(input.launch)
  if (
    input.source.kind !== "desktop-wsl-managed-launch" ||
    input.source.settingsFile !==
      path.join(state.profile.plan.paths.home, "AppData", "Roaming", "Docker", "settings-store.json") ||
    input.source.profileManifest !== path.join(state.spec.profileRoot, "manifest.json") ||
    input.source.wslConfig !== state.spec.wslConfig.path ||
    input.request.endpoint !== state.profile.plan.endpoint ||
    canonicalJson(input.source.desktop) !== canonicalJson(state.spec.install.desktop) ||
    canonicalJson(input.source.backend) !== canonicalJson(state.spec.install.backend)
  )
    throw new TypeError("TASK24_DESKTOP_STORAGE_SOURCE_BINDING")
  return buildStorageObservationScript(input, input.source.settingsFile)
}
function buildStorageObservationScript(
  input: { request: HostRequest; source: StorageSource },
  launchSettings?: string,
): string {
  const request = decodeHostRequest(input.request),
    source = Schema.decodeUnknownSync(StorageSource)(input.source, { onExcessProperty: "error" }),
    literal = source.desktop.path.replaceAll("'", "''"),
    pipe = request.endpoint.split("/").at(-1)!,
    distro = source.kind !== "desktop-wsl-legacy" ? "docker-desktop" : "docker-desktop-data",
    linux = String.raw`set -eu
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
pids=""
for p in /proc/[0-9]*; do
  comm="$(cat "$p/comm" 2>/dev/null || true)"
  [ "$comm" = dockerd ] && pids="$pids $(basename "$p")"
done
set -- $pids
[ "$#" -eq 1 ]
pid="$1"
device="$(awk -v target=/var/lib/docker '$5=="/" || target==$5 || index(target,$5 "/")==1 {if(length($5)>best){best=length($5);device=$3}} END{print device}' "/proc/$pid/mountinfo")"
printf '%s' "$device" | grep -Eq '^[0-9]+:[0-9]+$'
engine="$(cat "/proc/$pid/root/var/lib/docker/engine-id")"
uuid="$(nsenter -t "$pid" -m -- blkid -c /dev/null -p -s UUID -o value "/dev/block/$device")"
printf '%s\n%s\n' "$engine" "$uuid"`,
    managed =
      source.kind !== "desktop-wsl-legacy"
        ? `
if($v -notmatch '^4\\.79\\.0(?:\\.\\d+)?$'){throw 'unsupported-version'}
$settingsPath=${launchSettings ? "'" + launchSettings.replaceAll("'", "''") + "'" : "Join-Path $p 'AppData\\Roaming\\Docker\\settings-store.json'"};if($settingsPath -ine '${source.settingsFile.replaceAll("'", "''")}'){throw 'settings-path'}
$settings=Get-Content -LiteralPath $settingsPath -Raw|ConvertFrom-Json;if($settings.SettingsVersion -ne 44 -or $settings.CustomWslDistroDir -cnotmatch '^D:\\\\'){throw 'managed-settings'}
$imagePath=Join-Path $settings.CustomWslDistroDir 'disk\\docker_data.vhdx';$image=Get-DiskImage -ImagePath $imagePath
$prefix=[string][char]92+[char]92+'.'+[char]92+'PhysicalDrive';if(-not $image.Attached -or -not $image.DevicePath.StartsWith($prefix) -or $image.DevicePath.Substring($prefix.Length) -notmatch '^[0-9]+$'){throw 'active-disk-unobserved'}
$stream=[IO.File]::Open($image.DevicePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
try{$header=New-Object byte[] 2048;$offset=0;while($offset -lt 2048){$read=$stream.Read($header,$offset,2048-$offset);if($read -eq 0){throw 'disk-superblock'};$offset+=$read}}finally{$stream.Dispose()}
$guest=@(& "$env:SystemRoot\\System32\\wsl.exe" --distribution docker-desktop --exec /bin/sh -c '${linux.replaceAll("'", "''")}');if($LASTEXITCODE -ne 0 -or $guest.Count -ne 2){throw 'active-daemon-mount-unobserved'}
$observed.diskHeaderHex=[BitConverter]::ToString($header).Replace('-','').ToLowerInvariant();$observed.guestEngineID=$guest[0];$observed.guestFilesystemUUID=$guest[1]
$observed.imagePath=$image.ImagePath;$observed.attached=[bool]$image.Attached;$observed.backendStartedAt=([DateTimeOffset]$owner.CreationDate).ToUnixTimeMilliseconds()
`
        : ""
  return `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;public static class Task24Pipe{[DllImport("kernel32.dll",SetLastError=true)]public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint id);}'
$client=New-Object System.IO.Pipes.NamedPipeClientStream('.', '${pipe}', [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
try{$client.Connect(1000);[uint32]$ownerProcessID=0;if(-not [Task24Pipe]::GetNamedPipeServerProcessId($client.SafePipeHandle,[ref]$ownerProcessID)){throw 'owner'};$owner=Get-CimInstance Win32_Process -Filter "ProcessId=$ownerProcessID";$sid=(Invoke-CimMethod -InputObject $owner -MethodName GetOwnerSid).Sid;$ownerPath=$owner.ExecutablePath;$backendVersion=(Get-Item -LiteralPath $ownerPath).VersionInfo.ProductVersion}finally{$client.Dispose()}
$v=(Get-Item -LiteralPath '${literal}').VersionInfo.ProductVersion;$r=@(Get-ChildItem -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'|ForEach-Object{Get-ItemProperty -LiteralPath $_.PSPath}|Where-Object{$_.DistributionName -eq '${distro}'});if($r.Count -ne 1){throw 'registration'};$p=(Get-ItemProperty -LiteralPath 'HKCU:\\Volatile Environment').USERPROFILE
$running=@(& "$env:SystemRoot\\System32\\wsl.exe" --list --running --quiet|ForEach-Object{$_.Replace([string][char]0,'').Trim()});if($LASTEXITCODE -ne 0 -or $running -notcontains 'docker-desktop'){throw 'inactive'}
$swaps=(& "$env:SystemRoot\\System32\\wsl.exe" --distribution docker-desktop --exec /bin/cat /proc/swaps) -join "\n";if($LASTEXITCODE -ne 0){throw 'swap'}
$observed=@{version=$v;distributionName=$r[0].DistributionName;basePath=$r[0].BasePath;windowsProfile=$p;active=$true;swapsText=$swaps;ownerPath=$ownerPath;ownerSID=$sid;userSID=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;backendVersion=$backendVersion}
${managed}
$observed|ConvertTo-Json -Compress`
}
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
/** Separate versioned legacy/managed collectors; unknown layouts and Hyper-V remain blocked. */
export function makeStorageProbe(input: {
  request: HostRequest
  source: StorageSource
  launch?: DesktopLaunchSession
}) {
  return async (): Promise<StorageProof> => {
    const source = Schema.decodeUnknownSync(StorageSource)(input.source, { onExcessProperty: "error" })
    if (source.kind === "desktop-wsl-managed-launch") {
      const { readDesktopLaunchStorage } = await import("./desktop/inspection")
      if (!input.launch) throw new TypeError("TASK24_DESKTOP_SESSION_REQUIRED")
      return readDesktopLaunchStorage({ request: input.request, source, session: input.launch })
    }
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
    const script = storageObservationScript(input)
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
        distributionName: Schema.Literals(["docker-desktop-data", "docker-desktop"]),
        basePath: Schema.String,
        windowsProfile: Schema.String,
        active: Schema.Boolean,
        swapsText: Schema.String,
        ownerPath: Schema.String,
        ownerSID: Schema.String,
        userSID: Schema.String,
        backendVersion: Schema.String,
        imagePath: Schema.optionalKey(Schema.String),
        attached: Schema.optionalKey(Schema.Boolean),
        backendStartedAt: Schema.optionalKey(Schema.Number),
        diskHeaderHex: Schema.optionalKey(Schema.String),
        guestEngineID: Schema.optionalKey(Schema.String),
        guestFilesystemUUID: Schema.optionalKey(Schema.String),
      }),
    )(JSON.parse(Buffer.from(result.stdout).toString("utf8")), { onExcessProperty: "error" })
    const managedSettings =
      source.kind === "desktop-wsl-managed"
        ? await readManagedSettings({ file: source.settingsFile, windowsProfile: observed.windowsProfile })
        : undefined
    const legacyRegistration =
      source.kind === "desktop-wsl-legacy"
        ? decodeLegacyRegistration({
            version: observed.version,
            distributionName: observed.distributionName,
            basePath: observed.basePath,
          })
        : undefined
    if (
      observed.ownerPath.toLowerCase() !== source.backend.path.toLowerCase() ||
      !observed.ownerSID ||
      observed.ownerSID !== observed.userSID ||
      observed.version.match(/^4\.\d+\.\d+/)?.[0] !== observed.backendVersion.match(/^4\.\d+\.\d+/)?.[0]
    )
      throw new TypeError("TASK24_STORAGE_DAEMON_BINDING")
    if (
      source.kind === "desktop-wsl-managed" &&
      (!observed.diskHeaderHex || !/^[a-f0-9]{4096}$/.test(observed.diskHeaderHex))
    )
      throw new TypeError("TASK24_MANAGED_DISK_SUPERBLOCK")
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
    const registration =
      source.kind === "desktop-wsl-managed" && managedSettings
        ? decodeManagedRegistration({
            version: observed.version,
            distributionName: observed.distributionName,
            basePath: observed.basePath,
            windowsProfile: observed.windowsProfile,
            settingsPath: source.settingsFile,
            settings: managedSettings.settings,
            settingsModifiedAt: managedSettings.modifiedAt,
            backendStartedAt: observed.backendStartedAt,
            imagePath: observed.imagePath,
            attached: observed.attached,
            windowsFilesystemUUID: ext4SuperblockUUID(Buffer.from(observed.diskHeaderHex!, "hex")),
            guestFilesystemUUID: observed.guestFilesystemUUID,
            guestEngineID: observed.guestEngineID,
            daemonServerID: engine.ID,
          })
        : legacyRegistration!
    if (source.wslConfig.toLowerCase() !== path.win32.join(observed.windowsProfile, ".wslconfig").toLowerCase())
      throw new TypeError("TASK24_STORAGE_USER_CONFIG")
    const resolved = await fs.realpath(source.wslConfig)
    if (resolved.toLowerCase() !== source.wslConfig.toLowerCase()) throw new TypeError("TASK24_STORAGE_USER_CONFIG")
    const config = await fs.readFile(source.wslConfig, "utf8"),
      swap = parseWslSwap(config)
    const wslSnapshot =
      source.kind === "desktop-wsl-managed"
        ? await readWslConfigSnapshot({
            file: source.wslConfig,
            windowsProfile: observed.windowsProfile,
            backendStartedAt: observed.backendStartedAt!,
          })
        : undefined
    if (wslSnapshot && wslSnapshot.sha256 !== sha256Text(config)) throw new TypeError("TASK24_WSL_CONFIG_DRIFT")
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
    const runtimeDisk = "runtimeDiskPath" in registration ? await identity(registration.runtimeDiskPath) : undefined
    if (runtimeDisk && (await fs.realpath(runtimeDisk.path)).toLowerCase() !== runtimeDisk.path.toLowerCase())
      throw new TypeError("TASK24_STORAGE_PHYSICAL_IDENTITY")
    const proof: StorageProof = {
      backend: "wsl2",
      disk: await identity(
        "diskPath" in registration ? registration.diskPath : path.join(registration.basePath, "ext4.vhdx"),
      ),
      dataRoot: "dataRoot" in registration ? registration.dataRoot : registration.basePath,
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
          ...(managedSettings ? { managedSettings, runtimeDisk, wslSnapshot } : {}),
        }),
      ),
      observedAt: Date.now(),
    }
    if ((await inspectStorage(proof)).kind !== "ready") throw new TypeError("TASK24_STORAGE_PHYSICAL_IDENTITY")
    return proof
  }
}
