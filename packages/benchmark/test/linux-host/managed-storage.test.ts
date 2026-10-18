import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import {
  StorageSource,
  decodeManagedRegistration,
  readManagedSettings,
  storageObservationScript,
  readWslConfigSnapshot,
  ext4SuperblockUUID,
} from "../../src/sandbox/storage-source"
import { hostFixture } from "./fixture"

function observation() {
  return {
    version: "4.79.0.230596",
    distributionName: "docker-desktop",
    basePath: "\\\\?\\D:\\Applications\\DockerWSL\\main",
    windowsProfile: "C:\\Users\\Fixture",
    settingsPath: "C:\\Users\\Fixture\\AppData\\Roaming\\Docker\\settings-store.json",
    settings: { SettingsVersion: 44 as const, CustomWslDistroDir: "D:\\Applications\\DockerWSL" },
    settingsModifiedAt: 1000,
    backendStartedAt: 2000,
    imagePath: "D:\\Applications\\DockerWSL\\disk\\docker_data.vhdx",
    attached: true,
    windowsFilesystemUUID: "01234567-89ab-cdef-0123-456789abcdef",
    guestFilesystemUUID: "01234567-89ab-cdef-0123-456789abcdef",
    guestEngineID: "actual-fixture-engine",
    daemonServerID: "actual-fixture-engine",
  }
}

// A regression to the legacy docker-desktop-data lookup must reject this genuine modern shape.
test("managed storage resolves the installed 4.79 layout without inventing a legacy distribution", () => {
  expect(decodeManagedRegistration(observation())).toEqual({
    version: "4.79.0.230596",
    distributionName: "docker-desktop",
    basePath: "D:\\Applications\\DockerWSL\\main",
    dataRoot: "D:\\Applications\\DockerWSL\\disk",
    diskPath: "D:\\Applications\\DockerWSL\\disk\\docker_data.vhdx",
    runtimeDiskPath: "D:\\Applications\\DockerWSL\\main\\ext4.vhdx",
  })
})

test("managed storage refuses unknown versions, foreign settings and an unattached or different disk", () => {
  for (const patch of [
    { version: "4.80.0" },
    { version: "4.29.0" },
    { version: "5.0.0" },
    { settings: { ...observation().settings, SettingsVersion: 45 } },
    { settings: { SettingsVersion: 44 } },
    { settings: { ...observation().settings, CustomWslDistroDir: "C:\\Docker" } },
    { settings: { ...observation().settings, CustomWslDistroDir: "D:\\Docker\\..\\DockerWSL" } },
    { settings: { ...observation().settings, WslEngineEnabled: false } },
    { settings: { ...observation().settings, UseWindowsContainers: true } },
    { distributionName: "Ubuntu-24.04" },
    { basePath: "D:\\another\\main" },
    { settingsPath: "D:\\arbitrary\\settings-store.json" },
    { settingsModifiedAt: 3000 },
    { attached: false },
    { imagePath: "C:\\Docker\\disk\\docker_data.vhdx" },
    { imagePath: "D:\\another\\docker_data.vhdx" },
    { windowsFilesystemUUID: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    { guestFilesystemUUID: "" },
    { guestEngineID: "an-unrelated-daemon" },
  ])
    expect(() => decodeManagedRegistration({ ...observation(), ...patch })).toThrow()
})

test("attached but unused VHD cannot substitute for the active daemon filesystem UUID", () => {
  expect(() =>
    decodeManagedRegistration({ ...observation(), guestFilesystemUUID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
  ).toThrow()
  const header = Buffer.alloc(2048)
  header.writeUInt16LE(0xef53, 1024 + 56)
  Buffer.from("0123456789abcdef0123456789abcdef", "hex").copy(header, 1024 + 104)
  expect(ext4SuperblockUUID(header)).toBe("01234567-89ab-cdef-0123-456789abcdef")
  expect(() => ext4SuperblockUUID(Buffer.alloc(2048))).toThrow()
  expect(() => ext4SuperblockUUID(header.subarray(0, 1000))).toThrow()
})

test("managed WSL config must be unchanged, from the actual profile and older than backend startup", async () => {
  const f = await hostFixture()
  try {
    const file = path.join(f.root, ".wslconfig")
    await fs.writeFile(file, "[wsl2]\nswap=0\n")
    const timestamp = Date.now() - 10000
    await fs.utimes(file, timestamp / 1000, timestamp / 1000)
    const snapshot = await readWslConfigSnapshot({ file, windowsProfile: f.root, backendStartedAt: Date.now() })
    expect(snapshot.swap).toEqual({ kind: "disabled" })
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/)
    await expect(
      readWslConfigSnapshot({ file, windowsProfile: f.root, backendStartedAt: timestamp - 1000 }),
    ).rejects.toThrow()
    await expect(
      readWslConfigSnapshot({ file, windowsProfile: path.dirname(f.root), backendStartedAt: Date.now() }),
    ).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})

test("managed settings reader binds the actual profile file, filters unrelated values and detects path aliases", async () => {
  const f = await hostFixture()
  try {
    const profile = path.join(f.root, "profile"),
      directory = path.join(profile, "AppData", "Roaming", "Docker"),
      file = path.join(directory, "settings-store.json")
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(file, JSON.stringify({ ...observation().settings, ProxyPassword: "synthetic-do-not-return" }))
    const first = await readManagedSettings({ file, windowsProfile: profile })
    expect(first.settings).toEqual(observation().settings)
    expect(JSON.stringify(first)).not.toContain("synthetic-do-not-return")
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/)
    await fs.writeFile(file, JSON.stringify({ ...observation().settings, CustomWslDistroDir: "D:\\different" }))
    expect((await readManagedSettings({ file, windowsProfile: profile })).sha256).not.toBe(first.sha256)
    await expect(readManagedSettings({ file, windowsProfile: f.root })).rejects.toThrow()
    const alias = path.join(f.root, "profile-alias")
    await fs.symlink(profile, alias, "junction")
    await expect(
      readManagedSettings({
        file: path.join(alias, "AppData", "Roaming", "Docker", "settings-store.json"),
        windowsProfile: alias,
      }),
    ).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})

test("managed source dispatch is explicit and its native observer parses without executing Docker or WSL", async () => {
  const f = await hostFixture()
  try {
    const source = Schema.decodeUnknownSync(StorageSource)(
      {
        kind: "desktop-wsl-managed",
        desktop: f.cli,
        backend: { ...f.cli, path: path.join(f.root, "resources", "backend.exe") },
        wslConfig: "C:\\Users\\Fixture\\.wslconfig",
        settingsFile: observation().settingsPath,
        allowEffectiveSwapProbe: true,
      },
      { onExcessProperty: "error" },
    )
    const script = storageObservationScript({ request: f.request, source })
    const child = Bun.spawn(
      [
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$inputText=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($inputText,[ref]$tokens,[ref]$errors);[Console]::Out.Write($errors.Count);if($errors.Count){exit 1}",
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: {
          SystemRoot: "C:\\Windows",
          TEMP: process.env.TEMP!,
          TMP: process.env.TEMP!,
          PSModuleAnalysisCachePath: "NUL",
        },
      },
    )
    child.stdin.write(script)
    await child.stdin.end()
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("0")
    expect(await new Response(child.stderr).text()).toBe("")
    expect(() =>
      storageObservationScript({ request: { ...f.request, endpoint: "npipe:////./pipe/x'; throw 'injected" }, source }),
    ).toThrow()
  } finally {
    await f.dispose()
  }
})
