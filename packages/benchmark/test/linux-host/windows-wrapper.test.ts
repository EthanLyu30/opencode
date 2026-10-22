import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import { lstatSync, type BigIntStats } from "node:fs"
import path from "node:path"
import { directoryIdentity, fileIdentity } from "../../src/sandbox/storage"
import {
  decodeWindowsNativeResult,
  readWindowsSupervisorStream,
  runWindowsSandbox,
} from "../../src/sandbox/host-isolation/windows"

type NativeInput = { cwd: string; writable: string[]; tempIdentity: string; pins: string }
type NativePins = {
  exe: { path: string; fileID: string; sha256: string }
  directories: { path: string; fileID: string }[]
  profile: string
}
const errorProperty = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const sandbox = "D:\\OpenCode-Benchmark\\Task24\\tmp\\wrapper-unit"
const work = sandbox + "\\work"
const controller = sandbox + "\\controller"
const state = controller + "\\native-isolation-own\\state"
const abort = () => {
  const value = new AbortController()
  value.abort()
  return value.signal
}
const request = (changes: Record<string, unknown> = {}) => ({
  executable: {
    path: "D:\\OpenCode-Benchmark\\Task24\\toolchain\\own\\bun.exe",
    sha256: "a".repeat(64),
    fileID: "1:2:3",
  },
  argv: ["--no-env-file", "-e", "0"],
  cwd: work,
  readonly: [],
  writable: [work],
  ports: [],
  root: controller,
  timeoutMs: 1000,
  maxStdoutBytes: 1024,
  maxStderrBytes: 1024,
  signal: abort(),
  ...changes,
})
const response = (changes: Record<string, unknown> = {}) => ({
  started: true,
  exitCode: 0,
  stdout: "b2s=",
  stderr: "",
  truncated: false,
  containment: {
    appContainer: true,
    sid: "S-1-15-2-1-2-3-4-5-6-7",
    processTreeEnded: true,
    dynamicNetworkPolicy: true,
    cleanupCompleted: true,
    persistentNetworkPolicy: true,
    persistentPolicyRetired: true,
    policyJournal: path.dirname(state) + "\\network-policy.intent.json",
    profilePath: state + "\\Packages\\opencode.task24." + "a".repeat(32) + "\\AC",
  },
  ...changes,
})
const decode = (raw: unknown, stdoutLimit = 1024, stderrLimit = 1024) => {
  expect(decodeWindowsNativeResult).toBeFunction()
  return decodeWindowsNativeResult(raw, { stdoutLimit, stderrLimit, state })
}

test("wrapper permits an exact toolchain child read grant without touching disk for an already aborted call", async () => {
  expect(
    await runWindowsSandbox(request({ readonly: ["D:\\OpenCode-Benchmark\\Task24\\toolchain\\own"] })),
  ).toMatchObject({ execution: { started: false, exitCode: 130 } })
})

test("wrapper accepts the full two-MiB candidate stdout budget", async () => {
  expect(await runWindowsSandbox(request({ maxStdoutBytes: 2097152 }))).toMatchObject({
    execution: { started: false, exitCode: 130 },
  })
})

test("wrapper rejects controller overlap, unrelated cwd, and broad toolchain grants using complete valid requests", async () => {
  for (const changes of [
    { writable: [controller.toUpperCase()] },
    { writable: [sandbox] },
    { cwd: sandbox + "\\ungranted" },
    { readonly: ["D:\\OpenCode-Benchmark\\Task24\\toolchain"] },
    { readonly: [sandbox] },
    { readonly: [work.toUpperCase()] },
  ])
    await expect(runWindowsSandbox(request(changes))).rejects.toThrow("TASK24_ISOLATION_INPUT")
})

test("wrapper rejects case-aliased reserved environment and out-of-grant application paths", async () => {
  for (const environment of [
    { temp: "C:\\outside" },
    { Path: "C:\\outside" },
    { XDG_DATA_HOME: "C:\\outside" },
    { XDG_DATA_HOME: sandbox + "\\ungranted" },
    { OPENCODE_CONFIG: "D:\\OpenCode-Benchmark\\Task24\\tmp\\outside\\config.json" },
    { OPENCODE_CONFIG_DIR: controller },
  ])
    await expect(runWindowsSandbox(request({ environment }))).rejects.toThrow("TASK24_ISOLATION_INPUT")
  expect(
    await runWindowsSandbox(
      request({
        environment: {
          OPENCODE_CONFIG: work + "\\config.json",
          XDG_DATA_HOME: work + "\\data",
          TASK24_BROKER_GRANT: "own-fixture-grant",
        },
      }),
    ),
  ).toMatchObject({ execution: { exitCode: 130 } })
})

test("wrapper rejects invalid signals and bounded protocol inputs before spawning", async () => {
  for (const changes of [
    { signal: { aborted: false } },
    { argv: ["a".repeat(32768)] },
    { argv: Array.from({ length: 257 }, () => "a") },
    { environment: { TASK24_BROKER_GRANT: "a".repeat(65537) } },
    { ports: Array.from({ length: 65 }, (_, i) => 2000 + i) },
  ])
    await expect(runWindowsSandbox(request(changes))).rejects.toThrow("TASK24_ISOLATION_INPUT")
})

test("native protocol accepts only fully cleaned containment and canonical bounded base64", () => {
  expect(decode(response())).toMatchObject({
    execution: { started: true, exitCode: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), truncated: false },
    containment: { cleanupCompleted: true, processTreeEnded: true },
  })
  expect(() => decode(response({ stdout: Buffer.alloc(1025).toString("base64") }))).toThrow("TASK24_ISOLATION_PROTOCOL")
  expect(() => decode(response({ stderr: Buffer.alloc(1025).toString("base64") }))).toThrow("TASK24_ISOLATION_PROTOCOL")
  for (const stdout of ["%%%", "b2s", "b2s=\n", "b2t=", "===="]) {
    expect(() => decode(response({ stdout }))).toThrow("TASK24_ISOLATION_PROTOCOL")
  }
})

test("native protocol admits only the exact cleaned prestart cancellation shape", () => {
  const cancelled = {
    started: false,
    exitCode: 130,
    stdout: "",
    stderr: "",
    truncated: false,
    containment: {
      appContainer: false,
      sid: "",
      processTreeEnded: true,
      dynamicNetworkPolicy: false,
      cleanupCompleted: true,
      persistentNetworkPolicy: false,
      persistentPolicyRetired: true,
      policyJournal: "",
      profilePath: "",
    },
  }
  expect(decode(cancelled)).toMatchObject({
    execution: { started: false, exitCode: 130 },
    containment: { cleanupCompleted: true },
  })
  for (const change of [
    { exitCode: 0 },
    { started: true },
    { stdout: "b2s=" },
    { stderr: "b2s=" },
    { truncated: true },
  ]) {
    expect(() => decode({ ...cancelled, ...change })).toThrow("TASK24_ISOLATION_PROTOCOL")
  }
})

test("native protocol supports maximum candidate payloads without relaxing byte limits", () => {
  const stdout = Buffer.alloc(2097152, 120),
    stderr = Buffer.alloc(65536, 121)
  const result = decode(
    response({ stdout: stdout.toString("base64"), stderr: stderr.toString("base64") }),
    2097152,
    65536,
  )
  expect(result.execution.stdout).toEqual(stdout)
  expect(result.execution.stderr).toEqual(stderr)
})

test("native protocol rejects partial, extra, malformed and C-drive containment evidence", () => {
  const good = response()
  for (const raw of [
    { ...good, extra: true },
    { ...good, started: "yes" },
    { ...good, exitCode: 0.5 },
    { ...good, containment: { ...good.containment, cleanupCompleted: false } },
    { ...good, containment: { ...good.containment, processTreeEnded: false } },
    { ...good, containment: { ...good.containment, appContainer: false } },
    { ...good, containment: { ...good.containment, dynamicNetworkPolicy: false } },
    { ...good, containment: { ...good.containment, persistentNetworkPolicy: false } },
    { ...good, containment: { ...good.containment, persistentPolicyRetired: false } },
    { ...good, containment: { ...good.containment, policyJournal: "C:\\policy.json" } },
    { ...good, containment: { ...good.containment, sid: "S-1-15-2-1" } },
    { ...good, containment: { ...good.containment, profilePath: "C:\\Users\\own\\Packages\\AC" } },
    { ...good, containment: { ...good.containment, profilePath: sandbox + "\\unrelated" } },
    { ...good, containment: { ...good.containment, profilePath: state + "\\..\\outside" } },
  ])
    expect(() => decode(raw)).toThrow("TASK24_ISOLATION_PROTOCOL")
})

test("supervisor stream is bounded while reading rather than after full buffering", async () => {
  const read = readWindowsSupervisorStream
  expect(read).toBeFunction()
  const encoded = new TextEncoder().encode("own")
  const finite = new ReadableStream<Uint8Array>({
    start(value) {
      value.enqueue(encoded)
      value.close()
    },
  })
  expect(await read(finite, 3)).toEqual(encoded)
  let cancelled = false
  let pulls = 0
  const excessive = new ReadableStream<Uint8Array>({
    pull(value) {
      pulls++
      value.enqueue(new Uint8Array(8192))
    },
    cancel() {
      cancelled = true
    },
  })
  await expect(read(excessive, 1024)).rejects.toThrow("TASK24_ISOLATION_STREAM_LIMIT")
  expect(cancelled).toBe(true)
  expect(pulls).toBeLessThan(4)
})

async function fixture() {
  const parent = process.env.TMPDIR
  if (!parent || !/^D:\\OpenCode-Benchmark\\Task24\\tmp\\[^\\]+(?:\\.*)?$/i.test(parent))
    throw new Error("owned D fixture required")
  const root = await fs.mkdtemp(path.join(parent, "windows-wrapper-"))
  const identity = await directoryIdentity(root)
  const work = path.join(root, "work"),
    controller = path.join(root, "controller")
  await fs.mkdir(work)
  await fs.mkdir(controller)
  const binary = path.join(root, "own.exe")
  await fs.copyFile(process.execPath, binary, fs.constants.COPYFILE_EXCL)
  const executable = await fileIdentity(binary)
  return {
    root,
    work,
    controller,
    async input(signal = new AbortController().signal) {
      return request({ executable, cwd: work, root: controller, writable: [work], signal })
    },
    async dispose() {
      if (
        (await fs.realpath(root)) !== root ||
        !root.startsWith(parent + path.sep) ||
        (await directoryIdentity(root)) !== identity
      )
        throw new Error("own fixture identity changed: " + root)
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

/** Only the process boundary is replaced: request preparation, file identities and cleanup remain real. */
function supervisor(mode: "success" | "cancel" | "crash", control?: AbortController) {
  let stdout!: ReadableStreamDefaultController<Uint8Array>, stderr!: ReadableStreamDefaultController<Uint8Array>
  let resolveExit!: (code: number) => void
  let initial!: NativeInput
  let ended = false,
    cancelled = false,
    exitCode: number | null = null,
    endedBeforeResponse = false
  let flushed = false,
    cancelledBeforeFirstFlush = false
  const writes: string[] = []
  const finish = (code: number) => {
    if (ended) return
    ended = true
    const result = response({
      exitCode: code,
      containment: {
        ...response().containment,
        profilePath: initial.writable[0] + "\\Packages\\own\\AC",
        policyJournal: initial.cwd + "\\network-policy.intent.json",
      },
    })
    stdout.enqueue(Buffer.from(mode === "crash" ? "malformed native result" : JSON.stringify(result)))
    stdout.close()
    stderr.close()
    exitCode = mode === "crash" ? 1 : 0
    resolveExit(exitCode)
  }
  const child = {
    stdout: new ReadableStream<Uint8Array>({
      start(value) {
        stdout = value
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(value) {
        stderr = value
      },
    }),
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve
    }),
    get exitCode() {
      return exitCode
    },
    stdin: {
      write(value: string) {
        writes.push(value)
        if (value === "cancel\n") {
          cancelled = true
          finish(130)
        } else initial = JSON.parse(value) as NativeInput
        return Buffer.byteLength(value)
      },
      flush() {
        if (!flushed) {
          flushed = true
          cancelledBeforeFirstFlush = cancelled
        }
        if (mode === "cancel") control!.abort()
        else finish(0)
        return 0
      },
      end() {
        if (!ended) endedBeforeResponse = true
        return 0
      },
    },
    kill() {
      if (!ended) {
        ended = true
        stdout.close()
        stderr.close()
        exitCode = 137
        resolveExit(137)
      }
    },
  }
  return {
    child,
    process: child as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">,
    writes,
    get initial() {
      return initial
    },
    get cancelled() {
      return cancelled
    },
    get endedBeforeResponse() {
      return endedBeforeResponse
    },
    get cancelledBeforeFirstFlush() {
      return cancelledBeforeFirstFlush
    },
  }
}

test("wrapper sends clone and directory pins while retaining stdin until cleaned response, then removes only its private root", async () => {
  const own = await fixture(),
    helper = supervisor("success")
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => helper.process)
  try {
    const input = await own.input()
    expect(await runWindowsSandbox(input)).toMatchObject({
      execution: { exitCode: 0 },
      containment: { cleanupCompleted: true },
    })
    expect(helper.endedBeforeResponse).toBe(false)
    const pins = JSON.parse(helper.initial.pins) as NativePins
    expect(pins.exe.sha256).toBe(input.executable.sha256)
    expect(pins.exe.path.startsWith(own.controller + path.sep)).toBe(true)
    const stat = await fs.lstat(own.work, { bigint: true })
    expect(pins.directories).toContainEqual({ path: own.work, fileID: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` })
    expect(pins.profile).toMatch(/^opencode\.task24\.[a-f0-9]{32}$/)
    expect(await fs.readdir(own.controller)).toEqual([])
    expect((await fs.stat(own.work)).isDirectory()).toBe(true)
  } finally {
    spawn.mockRestore()
    await own.dispose()
  }
})

test("native wire pins retain exact BigInt NTFS identities without altering external storage identities", async () => {
  const own = await fixture(),
    helper = supervisor("success")
  const input = await own.input()
  const externalIdentity = { ...input.executable }
  let rootStat!: BigIntStats
  let exeStat!: typeof rootStat
  const spawn = spyOn(Bun, "spawn").mockImplementation((_command, options) => {
    const cwd = options?.cwd
    if (typeof cwd !== "string") throw new Error("expected controller cwd")
    rootStat = lstatSync(cwd, { bigint: true })
    exeStat = lstatSync(path.join(cwd, "runtime", path.basename(input.executable.path)), { bigint: true })
    return helper.process
  })
  try {
    expect(await runWindowsSandbox(input)).toMatchObject({ execution: { exitCode: 0 } })
    const pins = JSON.parse(helper.initial.pins) as NativePins
    const workStat = await fs.lstat(own.work, { bigint: true })
    expect(helper.initial.tempIdentity).toBe(`${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeNs}`)
    expect(pins.directories).toContainEqual({
      path: helper.initial.cwd,
      fileID: `${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeNs}`,
    })
    expect(pins.directories).toContainEqual({
      path: own.work,
      fileID: `${workStat.dev}:${workStat.ino}:${workStat.birthtimeNs}`,
    })
    expect(pins.exe.fileID).toBe(`${exeStat.dev}:${exeStat.ino}:${exeStat.birthtimeNs}`)
    const workPin = pins.directories.find((item: { path: string }) => item.path === own.work)
    if (!workPin) throw new Error("expected workspace pin")
    for (const [identity, stat] of [
      [helper.initial.tempIdentity, rootStat],
      [pins.exe.fileID, exeStat],
      [workPin.fileID, workStat],
    ] as const) {
      expect(BigInt(identity.split(":")[1]!)).toBe(stat.ino)
      if (stat.ino > BigInt(Number.MAX_SAFE_INTEGER) && BigInt(Number(stat.ino)) !== stat.ino)
        expect(BigInt(identity.split(":")[1]!)).not.toBe(BigInt(Number(stat.ino)))
    }
    expect(input.executable).toEqual(externalIdentity)
    expect(await fileIdentity(input.executable.path)).toEqual(externalIdentity)
  } finally {
    spawn.mockRestore()
    await own.dispose()
  }
})

test("wrapper cancels over the still-open control pipe and accepts evidence only after clean native cancellation", async () => {
  const own = await fixture(),
    control = new AbortController(),
    helper = supervisor("cancel", control)
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => helper.process)
  try {
    expect(await runWindowsSandbox(await own.input(control.signal))).toMatchObject({
      execution: { exitCode: 130 },
      containment: { cleanupCompleted: true, processTreeEnded: true },
    })
    expect(helper.cancelled).toBe(true)
    expect(helper.writes[1]).toBe("cancel\n")
    expect(helper.endedBeforeResponse).toBe(false)
    expect(await fs.readdir(own.controller)).toEqual([])
  } finally {
    spawn.mockRestore()
    await own.dispose()
  }
})

test("wrapper preserves its ownership record when native cleanup cannot be proven", async () => {
  const own = await fixture(),
    helper = supervisor("crash")
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => helper.process)
  try {
    let failure: unknown
    try {
      await runWindowsSandbox(await own.input())
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ cleanupUncertain: true, root: helper.initial.cwd })
    const cause = errorProperty(failure, "cause"),
      root = errorProperty(failure, "root")
    if (!(cause instanceof Error) || typeof root !== "string") throw new Error("expected structured native failure")
    expect(cause.message).toContain("exit=1 emergency=false")
    const owner = JSON.parse(await fs.readFile(path.join(root, "owner.json"), "utf8")) as { profile: string }
    expect(owner.profile).toBe((JSON.parse(helper.initial.pins) as NativePins).profile)
    expect(await fs.readdir(own.controller)).toEqual([path.basename(root)])
  } finally {
    spawn.mockRestore()
    await own.dispose()
  }
})

test("supervisor-finalization failure retains structured uncertainty and ownership metadata", async () => {
  const own = await fixture(),
    helper = supervisor("crash")
  helper.child.exited = Promise.reject(new Error("own injected supervisor-finalization failure"))
  void helper.child.exited.catch(() => {})
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => helper.process)
  try {
    let failure: unknown
    try {
      await runWindowsSandbox(await own.input())
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      cleanupUncertain: true,
      root: helper.initial.cwd,
      profile: (JSON.parse(helper.initial.pins) as NativePins).profile,
    })
    expect(failure).toBeInstanceOf(AggregateError)
    const root = errorProperty(failure, "root"),
      profile = errorProperty(failure, "profile")
    if (typeof root !== "string" || typeof profile !== "string")
      throw new Error("expected finalization ownership metadata")
    expect((JSON.parse(await fs.readFile(path.join(root, "owner.json"), "utf8")) as { profile: string }).profile).toBe(
      profile,
    )
    expect(await fs.readdir(own.controller)).toEqual([path.basename(root)])
  } finally {
    spawn.mockRestore()
    await own.dispose()
  }
})

test("abort between spawn and listener registration is delivered before the initial flush can launch native work", async () => {
  const own = await fixture(),
    control = new AbortController(),
    helper = supervisor("success")
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    control.abort()
    return helper.process
  })
  try {
    expect(await runWindowsSandbox(await own.input(control.signal))).toMatchObject({ execution: { exitCode: 130 } })
    expect(helper.cancelledBeforeFirstFlush).toBe(true)
    expect(await fs.readdir(own.controller)).toEqual([])
  } finally {
    spawn.mockRestore()
    await own.dispose()
  }
})

test("wrapper removes its partial acquisition when a pre-native copy operation fails", async () => {
  const own = await fixture()
  const copy = spyOn(fs, "copyFile").mockRejectedValue(new Error("own injected acquisition failure"))
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("must not spawn")
  })
  try {
    await expect(runWindowsSandbox(await own.input())).rejects.toThrow("own injected acquisition failure")
    expect(await fs.readdir(own.controller)).toEqual([])
  } finally {
    copy.mockRestore()
    spawn.mockRestore()
    await own.dispose()
  }
})

test("grant-tree admission rejects an actual own hardlink before spawning or creating a controller runtime", async () => {
  const own = await fixture()
  let spawnCount = 0
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    spawnCount++
    throw new Error("must not spawn")
  })
  try {
    const outside = path.join(own.root, "outside-own-canary")
    await fs.writeFile(outside, "own-unchanged-canary", { flag: "wx" })
    await fs.link(outside, path.join(own.work, "linked-canary"))
    await expect(runWindowsSandbox(await own.input())).rejects.toThrow("TASK24_ISOLATION_TREE")
    expect(spawnCount).toBe(0)
    expect(await fs.readdir(own.controller)).toEqual([])
    expect(await fs.readFile(outside, "utf8")).toBe("own-unchanged-canary")
  } finally {
    spawn.mockRestore()
    await own.dispose()
  }
})

test("grant-tree admission rejects an actual own junction without traversing or modifying its outside target", async () => {
  const own = await fixture()
  let spawnCount = 0
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    spawnCount++
    throw new Error("must not spawn")
  })
  try {
    const outside = path.join(own.root, "outside-own-directory")
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, "canary"), "own-unchanged-canary", { flag: "wx" })
    await fs.symlink(outside, path.join(own.work, "junction"), "junction")
    await expect(runWindowsSandbox(await own.input())).rejects.toThrow("TASK24_ISOLATION_TREE")
    expect(spawnCount).toBe(0)
    expect(await fs.readdir(own.controller)).toEqual([])
    expect(await fs.readFile(path.join(outside, "canary"), "utf8")).toBe("own-unchanged-canary")
  } finally {
    spawn.mockRestore()
    await own.dispose()
  }
})

test("grant-tree admission permits ordinary runtime assets larger than eight MiB", async () => {
  const own = await fixture(),
    helper = supervisor("success")
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => helper.process)
  try {
    const readonly = path.join(own.root, "readonly")
    await fs.mkdir(readonly)
    await fs.writeFile(path.join(readonly, "own-large-runtime.exe"), Buffer.alloc(9 * 1048576), { flag: "wx" })
    expect(await runWindowsSandbox({ ...(await own.input()), readonly: [readonly] })).toMatchObject({
      execution: { exitCode: 0 },
      containment: { cleanupCompleted: true },
    })
    expect((await fs.stat(path.join(readonly, "own-large-runtime.exe"))).size).toBe(9437184)
  } finally {
    spawn.mockRestore()
    await own.dispose()
  }
})

test("grant-tree admission rejects excessive depth before spawning", async () => {
  const own = await fixture()
  let spawnCount = 0
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    spawnCount++
    throw new Error("must not spawn")
  })
  try {
    await fs.mkdir(path.join(own.work, ...Array.from({ length: 129 }, () => "d")), { recursive: true })
    await expect(runWindowsSandbox(await own.input())).rejects.toThrow("TASK24_ISOLATION_TREE")
    expect(spawnCount).toBe(0)
    expect(await fs.readdir(own.controller)).toEqual([])
  } finally {
    spawn.mockRestore()
    await own.dispose()
  }
})
