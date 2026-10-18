import { expect, test } from "bun:test"
import { desktopFixture } from "./desktop-fixture"
import { nativeQueryFixture, desktopFeature } from "./desktop-native-fixture"

const query = await desktopFeature<typeof import("../../src/sandbox/desktop/native-query")>("native-query")
const script = await desktopFeature<typeof import("../../src/sandbox/desktop/native-script")>("native-script")
const processProbe = await desktopFeature<typeof import("../../src/sandbox/desktop/native-process")>("native-process")

test("partial and localized observations never imply idle", async () => {
  const f = await desktopFixture()
  try {
    const q = nativeQueryFixture(f.spec)
    expect(query.decodeWslNames?.(q.all, q.snapshot.installedWsl)).toEqual(["docker-desktop", "Ubuntu-24.04"])
    expect(query.decodeWslNames?.(q.running, q.snapshot.installedWsl)).toEqual([])
    expect(query.decodeWslNames?.(Buffer.from("docker-desktop\n"), q.snapshot.installedWsl)).toEqual(["docker-desktop"])
    for (const bytes of [
      Buffer.from("没有运行的分发版\n"),
      Buffer.from("docker-desktop\ndocker-desktop\n"),
      Buffer.from([0xff]),
      Buffer.from("alien\n"),
      Buffer.from([0xd8, 0]),
    ])
      expect(() => query.decodeWslNames?.(bytes, q.snapshot.installedWsl)).toThrow()
    for (const patch of [
      { complete: false },
      { processes: null },
      { runningWsl: ["alien"] },
      { installedWsl: [] },
      { profileSID: "S-1-5-18" },
      { error: "access denied" },
      { sampledAt: Date.now() - 60000 },
    ])
      expect(() => query.decodeDesktopNativeSnapshot?.({ ...q.snapshot, ...patch }, f.spec)).toThrow()
  } finally {
    await f.close()
  }
})

test("services never confer engine ownership", async () => {
  const f = await desktopFixture()
  try {
    const q = nativeQueryFixture(f.spec)
    const decoded = query.decodeDesktopNativeSnapshot?.(
      {
        ...q.snapshot,
        processes: [
          {
            pid: 6404,
            parentPID: 1396,
            createdAt: 1792300000000,
            ownerSID: "S-1-5-18",
            imagePath: "D:\\Applications\\Docker\\com.docker.service",
            role: "service",
          },
        ],
      },
      f.spec,
    )
    expect(decoded?.processes[0]?.role).toBe("service")
    expect(decoded?.runningWsl).toEqual([])
    expect(decoded).not.toHaveProperty("process")
    expect(decoded).not.toHaveProperty("pipe")
    expect(decoded).not.toHaveProperty("session")
  } finally {
    await f.close()
  }
})

test("snapshot drift and swapped disks are rejected", async () => {
  const f = await desktopFixture()
  try {
    const q = nativeQueryFixture(f.spec)
    expect(query.decodeDesktopNativeSnapshot?.(q.snapshot, f.spec)?.registration.build).toBe(230596)
    for (const patch of [
      { windowsProfile: "C:\\Users\\Foreign" },
      { sid: "S-1-5-18" },
      { registration: { ...q.snapshot.registration, key: "foreign" } },
      { registration: { ...q.snapshot.registration, build: 230597 } },
      { disks: { ...q.snapshot.disks, data: { ...q.snapshot.disks.data, fileID: "replaced" } } },
      { disks: { ...q.snapshot.disks, runtime: { ...q.snapshot.disks.runtime, volumeID: "elsewhere" } } },
      {
        processes: [
          {
            pid: 1234,
            parentPID: 1000,
            createdAt: 1,
            ownerSID: q.snapshot.sid,
            imagePath: f.spec.install.backend.path,
            role: "backend",
          },
          {
            pid: 1234,
            parentPID: 1000,
            createdAt: 2,
            ownerSID: q.snapshot.sid,
            imagePath: f.spec.install.backend.path,
            role: "backend",
          },
        ],
      },
    ])
      expect(() => query.decodeDesktopNativeSnapshot?.({ ...q.snapshot, ...patch }, f.spec)).toThrow()
    const invalidCall = await query.queryDesktopWindows?.(f.spec, new AbortController().signal).then(
      () => false,
      () => true,
    )
    expect(invalidCall).toBe(true)
  } finally {
    await f.close()
  }
})

test("fixed native query has no launch verbs", async () => {
  const source = script.desktopNativeQueryScript?.()
  expect(typeof source).toBe("string")
  if (!source) return
  const parser =
    "$s=[Console]::In.ReadToEnd();$t=$null;$e=$null;$a=[System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e);if($e.Count){exit 1};@($a.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst]},$true)|ForEach-Object {$_.GetCommandName()})|ConvertTo-Json -Compress"
  const result = await processProbe.runDesktopProbe?.({
    exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    argv: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(parser, "utf16le").toString("base64"),
    ],
    input: source,
    timeoutMs: 10000,
    stdoutLimit: 8192,
    stderrLimit: 8192,
  })
  expect(result?.exitCode).toBe(0)
  const commands: unknown = JSON.parse(Buffer.from(result!.stdout).toString("utf8"))
  expect(Array.isArray(commands)).toBe(true)
  const allowed = new Set([
    "Get-CimInstance",
    "Invoke-CimMethod",
    "Get-Process",
    "Where-Object",
    "ForEach-Object",
    "ConvertTo-Json",
    "Sort-Object",
  ])
  expect((commands as string[]).filter((name) => !allowed.has(name))).toEqual([])
  expect(query.desktopNativeProbeCommands?.().map((v) => v.argv)).toEqual([
    ["--list", "--quiet"],
    ["--list", "--running", "--quiet"],
  ])
})

test("bounded probes reject oversized, cancelled and timed out own processes", async () => {
  const limit = await processProbe
    .runDesktopProbe?.({
      exe: process.execPath,
      argv: ["--no-env-file", "-e", 'process.stdout.write("X".repeat(8193))'],
      timeoutMs: 3000,
      stdoutLimit: 8192,
      stderrLimit: 8192,
    })
    .then(
      () => "accepted",
      (error: unknown) => (error instanceof Error ? error.message : "unknown"),
    )
  expect(limit).toBe("TASK24_DESKTOP_PROBE_LIMIT")
  const timeout = await processProbe
    .runDesktopProbe?.({
      exe: process.execPath,
      argv: ["--no-env-file", "-e", "setInterval(()=>{},1000)"],
      timeoutMs: 50,
      stdoutLimit: 8192,
      stderrLimit: 8192,
    })
    .then(
      () => "accepted",
      (error: unknown) => (error instanceof Error ? error.message : "unknown"),
    )
  expect(timeout).toBe("TASK24_DESKTOP_DEADLINE")
  const controller = new AbortController()
  controller.abort()
  const cancel = await processProbe
    .runDesktopProbe?.({
      exe: process.execPath,
      argv: ["--no-env-file", "-e", 'throw Error("must not execute")'],
      timeoutMs: 3000,
      stdoutLimit: 8192,
      stderrLimit: 8192,
      signal: controller.signal,
    })
    .then(
      () => "accepted",
      (error: unknown) => (error instanceof Error ? error.message : "unknown"),
    )
  expect(cancel).toBe("TASK24_DESKTOP_CANCELLED")
})
