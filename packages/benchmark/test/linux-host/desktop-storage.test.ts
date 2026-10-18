import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { launchFixture } from "./desktop-launch.test"
import { hostFixture } from "./fixture"
import { startDesktopReadonly, stopDesktopLaunch } from "../../src/sandbox/desktop/launch"
import {
  inspectDesktopLaunch,
  decodeDesktopStorageObservation,
  makeDesktopProfileRunner,
} from "../../src/sandbox/desktop/inspection"
import {
  makeStorageProbe,
  readManagedSettings,
  desktopStorageObservationScript,
} from "../../src/sandbox/storage-source"
import { isRealDockerRunner } from "../../src/sandbox/docker"

export function desktopStorageObservation(f: Awaited<ReturnType<typeof launchFixture>>) {
  const startedAt = (f.getObservation().process as { createdAt: number }).createdAt
  return {
    schemaVersion: 1,
    manifestSha256: f.profile.manifestSha256,
    registration: f.spec.registration,
    runtimeDisk: f.spec.disks.runtime,
    dataDisk: f.spec.disks.data,
    settingsSha256: f.plan.settingsSha256,
    wslConfig: { ...f.spec.wslConfig, modifiedAt: 1 },
    swapsText: "Filename\tType\tSize\tUsed\tPriority\n",
    active: true,
    binding: {
      version: f.spec.version,
      distributionName: "docker-desktop",
      basePath: f.spec.registration.basePath,
      windowsProfile: f.spec.windowsProfile,
      settingsPath: path.join(f.plan.paths.home, "AppData", "Roaming", "Docker", "settings-store.json"),
      settings: {
        SettingsVersion: 44,
        CustomWslDistroDir: f.spec.dataRoot,
        WslEngineEnabled: true,
        UseWindowsContainers: false,
      },
      settingsModifiedAt: 1,
      backendStartedAt: startedAt,
      imagePath: f.spec.disks.data.path,
      attached: true,
      windowsFilesystemUUID: "01234567-89ab-cdef-0123-456789abcdef",
      guestFilesystemUUID: "01234567-89ab-cdef-0123-456789abcdef",
      guestEngineID: "fixture-engine",
      daemonServerID: "fixture-engine",
    },
  }
}

test("D settings cannot authorize a fake Windows profile or a mismatched active disk", async () => {
  const f = await launchFixture()
  try {
    const started = await startDesktopReadonly(f.request)
    if (started.kind !== "ready") throw Error("START")
    const raw = desktopStorageObservation(f)
    const context = { spec: f.spec, profile: f.profile }
    expect(decodeDesktopStorageObservation(raw, context).disk).toEqual(f.spec.disks.data)
    await expect(
      readManagedSettings({ file: raw.binding.settingsPath, windowsProfile: f.spec.windowsProfile }),
    ).rejects.toThrow()
    for (const patch of [
      { binding: { ...raw.binding, windowsProfile: f.plan.paths.home } },
      { binding: { ...raw.binding, guestFilesystemUUID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } },
      { binding: { ...raw.binding, guestEngineID: "foreign-engine" } },
      { binding: { ...raw.binding, version: "4.79.0.999999" } },
      { binding: { ...raw.binding, settingsModifiedAt: raw.binding.backendStartedAt + 1 } },
      { wslConfig: { ...raw.wslConfig, path: path.join(f.plan.paths.home, ".wslconfig") } },
      { runtimeDisk: { ...raw.runtimeDisk, fileID: "replaced-runtime" } },
      { swapsText: "Filename Type Size Used Priority\n/swap file 10 0 -2\n" },
    ])
      expect(() => decodeDesktopStorageObservation({ ...raw, ...patch }, context)).toThrow()
    expect((await stopDesktopLaunch(started.value)).kind).toBe("ready")
  } finally {
    await f.close()
  }
})

test("profile endpoint cannot stand in for production default", async () => {
  const f = await launchFixture()
  try {
    const started = await startDesktopReadonly(f.request)
    if (started.kind !== "ready") throw Error("START")
    f.setObservation({
      ...f.getObservation(),
      storage: desktopStorageObservation(f),
      profileEndpoint: f.plan.endpoint,
      productionDefaultEndpoint: "npipe:////./pipe/docker_engine",
    })
    const inventory = await inspectDesktopLaunch(started.value)
    expect(inventory.assurance).toBe("fixture")
    expect(inventory.production_default_compatible).toBe(false)
    expect(inventory.missing).toContain("production_default_endpoint_mismatch")
    expect(inventory.engine_verified).toBe(false)
    expect(inventory.tool_capability_verified).toBe(false)
    expect(inventory.corpus_engine_ready).toBe(false)
    await stopDesktopLaunch(started.value)
  } finally {
    await f.close()
  }
})

test("launch source requires an actual native session and the profile runner cannot mutate Docker", async () => {
  const f = await launchFixture(),
    host = await hostFixture()
  try {
    const source = {
      kind: "desktop-wsl-managed-launch" as const,
      desktop: f.spec.install.desktop,
      backend: f.spec.install.backend,
      wslConfig: f.spec.wslConfig.path,
      allowEffectiveSwapProbe: true as const,
      settingsFile: path.join(f.plan.paths.home, "AppData", "Roaming", "Docker", "settings-store.json"),
      profileManifest: path.join(f.spec.profileRoot, "manifest.json"),
    }
    await expect(makeStorageProbe({ request: host.request, source })()).rejects.toThrow()
    const started = await startDesktopReadonly(f.request)
    if (started.kind !== "ready") throw Error("START")
    await expect(makeStorageProbe({ request: host.request, source, launch: started.value })()).rejects.toThrow()
    const request = {
      ...host.request,
      cli: f.spec.install.cli,
      context: "default",
      endpoint: f.plan.endpoint,
      roots: { ...host.request.roots, temp: f.plan.paths.temp, config: f.plan.paths.cli },
    }
    const runner = makeDesktopProfileRunner({ request, session: started.value })
    expect(isRealDockerRunner(runner)).toBe(false)
    for (const argv of [
      ["container", "ls"],
      ["image", "pull", "alpine"],
      ["desktop", "start"],
      ["volume", "prune"],
      ["--context", "foreign", "info", "--format", "{{json .}}"],
    ]) {
      await expect(
        runner.execute({
          argv,
          timeoutMs: 1000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow()
    }
    const script = await desktopStorageObservationScript({ request, source, launch: started.value })
    const child = Bun.spawn(
      [
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$text=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors);[Console]::Out.Write($errors.Count);if($errors.Count){exit 1}",
      ],
      {
        windowsHide: true,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          SystemRoot: "C:\\Windows",
          TEMP: process.env.TEMP!,
          TMP: process.env.TMP!,
          PSModuleAnalysisCachePath: "NUL",
        },
      },
    )
    child.stdin.write(script)
    await child.stdin.end()
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("0")
    expect(await new Response(child.stderr).text()).toBe("")
    await stopDesktopLaunch(started.value)
  } finally {
    await f.close()
    await host.dispose()
  }
})
