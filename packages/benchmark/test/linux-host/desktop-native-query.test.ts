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

test("probe environments reject unrelated or unowned D temporary directories", async () => {
  const { desktopFixture } = await import("./desktop-fixture")
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const f = await desktopFixture(),
    previous = process.env.TEMP
  try {
    const temp = path.join(f.root, "unowned-temp")
    await fs.mkdir(temp)
    process.env.TEMP = temp
    const failed = await processProbe.desktopProbeEnvironment!().then(
      () => false,
      () => true,
    )
    expect(failed).toBe(true)
  } finally {
    process.env.TEMP = previous
    await f.close()
  }
})

test("probe environment ownership rejects equal-byte ancestor replacement", async () => {
  const api = await desktopFeature<typeof import("../../src/sandbox/desktop/probe-root")>("probe-root")
  expect(api.revalidateDesktopProbeEnvironment).toBeFunction()
  if (!api.desktopProbeEnvironment || !api.revalidateDesktopProbeEnvironment) return
  const { desktopFixture } = await import("./desktop-fixture")
  const fs = await import("node:fs/promises"),
    path = await import("node:path")
  const f = await desktopFixture(),
    previous = process.env.TEMP
  try {
    const temp = path.join(f.root, "owned-temp")
    await fs.mkdir(temp)
    const owner = await fs.readFile(path.join(process.env.TMPDIR!, "owner.json"))
    await fs.writeFile(path.join(temp, "owner.json"), owner)
    process.env.TEMP = temp
    const env = await api.desktopProbeEnvironment()
    await fs.rename(temp, temp + "-original")
    await fs.mkdir(temp)
    await fs.writeFile(path.join(temp, "owner.json"), owner)
    await expect(api.revalidateDesktopProbeEnvironment(env)).rejects.toThrow()
  } finally {
    process.env.TEMP = previous
    await f.close()
  }
})

test("probe identity mismatch rejects before executing even an owned copied image", async () => {
  const { desktopFixture } = await import("./desktop-fixture")
  const fs = await import("node:fs/promises"),
    path = await import("node:path")
  const { fileIdentity } = await import("../../src/sandbox/storage")
  const f = await desktopFixture()
  try {
    const exe = path.join(f.root, "copied-cmd.exe")
    await fs.copyFile("C:\\Windows\\System32\\cmd.exe", exe)
    const image = { ...(await fileIdentity(exe)), sha256: "0".repeat(64) }
    const failed = await processProbe.runDesktopProbe!({
      exe,
      image,
      argv: ["/d", "/c", "echo drift-must-not-execute"],
      timeoutMs: 5000,
      stdoutLimit: 8192,
      stderrLimit: 8192,
    }).then(
      () => false,
      () => true,
    )
    expect(failed).toBe(true)
  } finally {
    await f.close()
  }
})

test("cancelled probes reclaim only their owned inherited-pipe descendants", async () => {
  const { desktopFixture } = await import("./desktop-fixture")
  const fs = await import("node:fs/promises"),
    path = await import("node:path")
  const f = await desktopFixture(),
    abort = new AbortController()
  const heartbeat = path.join(f.root, "child-heartbeat"),
    done = path.join(f.root, "child-finished")
  const childCode = `import('node:fs').then(fs=>{let n=0;fs.writeFileSync(${JSON.stringify(heartbeat)},String(n));const t=setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(++n)),20);setTimeout(()=>{clearInterval(t);fs.writeFileSync(${JSON.stringify(done)},'finished');process.exit(0)},2000)})`
  const encoded = Buffer.from(childCode).toString("base64")
  const code = `$p=[Diagnostics.ProcessStartInfo]::new();$p.FileName='${process.execPath}';$p.Arguments='--no-env-file -e "eval(Buffer.from(''${encoded}'',''base64'').toString())"';$p.UseShellExecute=$false;$p.CreateNoWindow=$true;[Diagnostics.Process]::Start($p)|Out-Null;[Threading.Thread]::Sleep(10000)`
  const result = processProbe.runDesktopProbe!({
    exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    argv: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(code, "utf16le").toString("base64"),
    ],
    timeoutMs: 10000,
    stdoutLimit: 8192,
    stderrLimit: 8192,
    signal: abort.signal,
  }).then(
    () => "accepted",
    (e: unknown) => (e instanceof Error ? e.message : "unknown"),
  )
  try {
    const limit = Date.now() + 5000
    while (!(await fs.exists(heartbeat)) && Date.now() < limit) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await fs.exists(heartbeat)).toBe(true)
    const began = Date.now()
    abort.abort()
    expect(await result).toBe("TASK24_DESKTOP_CANCELLED")
    expect(Date.now() - began).toBeLessThan(1500)
    expect(await fs.exists(done)).toBe(false)
    const stopped = await fs.readFile(heartbeat, "utf8")
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await fs.readFile(heartbeat, "utf8")).toBe(stopped)
  } finally {
    abort.abort()
    await result
    await f.close()
  }
})
