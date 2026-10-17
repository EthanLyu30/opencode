import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import type { HostManifest, FileIdentity } from "./contracts"
import { makeProcessRunner } from "./docker"
/** Existing OS font inputs may be read on C; managed profiles/caches/generated files remain D-scoped. */
export function validateFontPath(file: string) {
  if (
    !/^[CD]:\\/i.test(file) ||
    path.win32.normalize(file) !== file ||
    !/\.(?:ttf|ttc|otf|woff2?|fon|fnt)$/i.test(file) ||
    /[\0\r\n]/.test(file)
  )
    throw new TypeError("TASK24_FONT_SOURCE_PATH")
  return file
}
async function fontIdentity(file: string): Promise<FileIdentity> {
  validateFontPath(file)
  if ((await fs.realpath(file)).toLowerCase() !== file.toLowerCase()) throw new TypeError("TASK24_FONT_SOURCE_LINK")
  const before = await fs.lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.size > 67108864)
    throw new TypeError("TASK24_FONT_SOURCE_FILE")
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  const after = await fs.lstat(file)
  if (
    [before.dev, before.ino, before.size, before.mtimeMs, before.birthtimeMs].join(":") !==
    [after.dev, after.ino, after.size, after.mtimeMs, after.birthtimeMs].join(":")
  )
    throw new TypeError("TASK24_FONT_SOURCE_DRIFT")
  return { path: file, sha256: hash.digest("hex"), fileID: `${before.dev}:${before.ino}:${before.birthtimeMs}` }
}
export async function observeBrowserFonts(manifest: HostManifest) {
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);function Read-FontKey($hive,$key){$k=$hive.OpenSubKey($key);$data=@{};if($null -ne $k){try{foreach($name in $k.GetValueNames()){$v=$k.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($v -isnot [string] -and $v -isnot [string[]]){throw 'font-kind'};$data[$name]=$v}}finally{$k.Dispose()}};return $data};$p=(Get-ItemProperty -LiteralPath 'HKCU:\\Volatile Environment').USERPROFILE;@{profile=$p;machine=(Read-FontKey ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts');user=(Read-FontKey ([Microsoft.Win32.Registry]::CurrentUser) 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts');substitutes=(Read-FontKey ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\FontSubstitutes');links=(Read-FontKey ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\FontLink\\SystemLink')}|ConvertTo-Json -Depth 5 -Compress`
  const result = await makeProcessRunner({
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    argvPrefix: ["-NoProfile", "-NonInteractive"],
    cwd: manifest.roots.temp,
    env: {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      HOME: manifest.roots.config,
      USERPROFILE: manifest.roots.config,
      APPDATA: manifest.roots.config,
      LOCALAPPDATA: manifest.roots.temp,
      TEMP: manifest.roots.temp,
      TMP: manifest.roots.temp,
      PSModuleAnalysisCachePath: path.join(manifest.roots.temp, "ModuleAnalysisCache"),
      PATH: "C:\\Windows\\System32",
    },
  }).execute({
    argv: ["-Command", script],
    timeoutMs: 15000,
    maxStdoutBytes: 1048576,
    maxStderrBytes: 65536,
    signal: new AbortController().signal,
  })
  if (!result.started || result.exitCode || result.truncated) throw new TypeError("TASK24_FONT_REGISTRY_UNOBSERVED")
  const Values = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    registry = Schema.decodeUnknownSync(
      Schema.Struct({ profile: Schema.String, machine: Values, user: Values, substitutes: Values, links: Values }),
    )(JSON.parse(Buffer.from(result.stdout).toString("utf8")), { onExcessProperty: "error" })
  const roots = [
      "C:\\Windows\\Fonts",
      path.join(registry.profile, "AppData", "Local", "Microsoft", "Windows", "Fonts"),
    ],
    names = new Map<string, string>()
  for (const root of roots) {
    const stat = await fs.lstat(root).catch(() => null)
    if (!stat) continue
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(root)).toLowerCase() !== root.toLowerCase())
      throw new TypeError("TASK24_FONT_ROOT")
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ttf|ttc|otf|woff2?|fon|fnt)$/i.test(entry.name)) continue
      const file = path.join(root, entry.name)
      names.set(file.toLowerCase(), file)
    }
  }
  for (const [kind, values] of [
    ["machine", registry.machine],
    ["user", registry.user],
  ] as const)
    for (const raw of Object.values(values)) {
      if (typeof raw !== "string") throw new TypeError("TASK24_FONT_REGISTRY_VALUE")
      const expanded = raw
        .replace(/%SystemRoot%|%windir%/gi, "C:\\Windows")
        .replace(/%USERPROFILE%/gi, registry.profile)
      if (expanded.includes("%")) throw new TypeError("TASK24_FONT_SOURCE_PATH")
      const file = path.win32.isAbsolute(expanded)
        ? expanded
        : path.join(kind === "machine" ? roots[0]! : roots[1]!, expanded)
      validateFontPath(file)
      names.set(file.toLowerCase(), file)
    }
  if (!names.size || names.size > 10000) throw new TypeError("TASK24_FONT_COVERAGE")
  const files = []
  for (const file of [...names.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())))
    files.push(await fontIdentity(file))
  const registrySha256 = sha256Text(canonicalJson(registry))
  return { files, registrySha256, fontSha256: sha256Text(canonicalJson({ files, registrySha256 })) }
}
