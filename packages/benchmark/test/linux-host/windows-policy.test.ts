import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileIdentity } from "../../src/sandbox/storage"

const journal = "D:\\OpenCode-Benchmark\\Task24\\tmp\\policy-unit\\network-policy.intent.json"
const observed = () => ({
  policyJournal: journal,
  kind: "appid",
  jobName: "Global\\opencode-task24-policy-" + "a".repeat(32),
  jobState: "empty",
  jobActiveProcesses: 0,
  supervisorPID: 721,
  supervisorCreatedFileTime: "123456789",
  supervisorState: "dead",
  persistentNetworkPolicy: false,
  persistentPolicyRetired: true,
  objects: { sublayer: false, ipv4: false, ipv6: false },
  retirementPerformed: true,
  recoveryScope: "network-policy-only",
})
async function decode(value: unknown, recover = true) {
  const module = await import("../../src/sandbox/host-isolation/windows")
  const fn = Reflect.get(module, "decodeWindowsPolicyState")
  expect(fn).toBeFunction()
  return fn(value, { journal, recover })
}

test("network-policy recovery requires a dead original supervisor and an existing empty job", async () => {
  expect(await decode(observed())).toMatchObject({ persistentPolicyRetired: true, jobState: "empty" })
  for (const change of [
    { jobState: "absent", jobActiveProcesses: null },
    { jobState: "active", jobActiveProcesses: 1 },
    { supervisorState: "alive" },
    { supervisorState: "unknown" },
    { jobState: "empty", jobActiveProcesses: 1 },
    { supervisorCreatedFileTime: "1.25" },
    { policyJournal: "C:\\foreign.json" },
  ])
    await expect(decode({ ...observed(), ...change })).rejects.toThrow("TASK24_WINDOWS_POLICY_PROTOCOL")
})

test("policy inspection distinguishes absence from safe recovery and rejects partial or contradictory objects", async () => {
  expect(
    await decode({ ...observed(), jobState: "absent", jobActiveProcesses: null, retirementPerformed: false }, false),
  ).toMatchObject({ jobState: "absent" })
  const installed = {
    ...observed(),
    supervisorState: "alive",
    persistentNetworkPolicy: true,
    persistentPolicyRetired: false,
    objects: { sublayer: true, ipv4: true, ipv6: true },
    retirementPerformed: false,
  }
  expect(await decode(installed, false)).toMatchObject({ persistentNetworkPolicy: true })
  for (const value of [
    { ...installed, objects: { sublayer: true, ipv4: true, ipv6: false } },
    { ...installed, persistentPolicyRetired: true },
    { ...observed(), retirementPerformed: false, extra: true },
    { ...observed(), recoveryScope: "all-resources-recovered" },
    { ...observed(), retirementPerformed: true },
  ])
    await expect(decode(value, false)).rejects.toThrow("TASK24_WINDOWS_POLICY_PROTOCOL")
})

test("policy operations reject C paths and an aborted request before reading a journal or spawning", async () => {
  const module = await import("../../src/sandbox/host-isolation/windows")
  const fn = Reflect.get(module, "inspectWindowsNetworkPolicy")
  expect(fn).toBeFunction()
  const abort = new AbortController()
  abort.abort()
  const input = {
    journal: { path: journal, sha256: "a".repeat(64), fileID: "1:2:3" },
    root: "D:\\OpenCode-Benchmark\\Task24\\tmp\\policy-unit",
    signal: abort.signal,
  }
  await expect(fn({ ...input, root: "C:\\outside" })).rejects.toThrow("TASK24_WINDOWS_POLICY_INPUT")
  await expect(fn(input)).rejects.toThrow("TASK24_WINDOWS_POLICY_ABORTED")
})

test.skipIf(process.platform !== "win32")(
  "policy admission rejects oversized journals before identity hashing or native startup",
  async () => {
    const parent = process.env.TMPDIR
    if (!parent || !/^D:\\OpenCode-Benchmark\\Task24\\tmp\\[^\\]+/.test(parent)) throw Error("owned D fixture required")
    const root = await fs.mkdtemp(path.join(parent, "policy-admission-"))
    const journal = path.join(root, "network-policy.intent.json")
    try {
      await fs.writeFile(journal, Buffer.alloc(65537))
      const module = await import("../../src/sandbox/host-isolation/windows")
      await expect(
        module.inspectWindowsNetworkPolicy({
          journal: { path: journal, sha256: "0".repeat(64), fileID: "1:2:3" },
          root,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("TASK24_WINDOWS_POLICY_JOURNAL_LIMIT")
      expect(await fs.readdir(root)).toEqual(["network-policy.intent.json"])
      await fs.writeFile(journal, "{}")
      const identity = await fileIdentity(journal)
      await expect(
        module.inspectWindowsNetworkPolicy({
          journal: { ...identity, sha256: "0".repeat(64) },
          root,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("TASK24_WINDOWS_POLICY_JOURNAL_CHANGED")
      expect(await fs.readdir(root)).toEqual(["network-policy.intent.json"])
    } finally {
      if ((await fs.realpath(root)) !== root || !root.startsWith(parent + path.sep))
        throw Error("own admission fixture alias")
      await fs.unlink(journal)
      await fs.rmdir(root)
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "policy cancellation interrupts a blocked stdin flush and reclaims only the ended helper's temp root",
  async () => {
    const parent = process.env.TMPDIR
    if (!parent || !/^D:\\OpenCode-Benchmark\\Task24\\tmp\\[^\\]+/.test(parent)) throw Error("owned D fixture required")
    const root = await fs.mkdtemp(path.join(parent, "policy-cancel-"))
    const journal = path.join(root, "network-policy.intent.json")
    await fs.writeFile(journal, "{}")
    const identity = await fileIdentity(journal),
      control = new AbortController()
    let release!: () => void, entered!: () => void, exit!: (code: number) => void
    const flushed = new Promise<void>((resolve) => {
        release = resolve
      }),
      flushing = new Promise<void>((resolve) => {
        entered = resolve
      })
    let exitCode: number | null = null,
      kills = 0
    const child = {
      stdout: new Blob([]).stream(),
      stderr: new Blob([]).stream(),
      exited: new Promise<number>((resolve) => {
        exit = resolve
      }),
      get exitCode() {
        return exitCode
      },
      stdin: {
        write() {
          return 0
        },
        flush() {
          entered()
          return flushed
        },
        end() {
          return 0
        },
      },
      kill() {
        kills++
        exitCode = 137
        exit(137)
      },
    }
    const spawn = spyOn(Bun, "spawn").mockImplementation(
      () => child as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">,
    )
    let pending: Promise<unknown> | undefined, timer: ReturnType<typeof setTimeout> | undefined
    try {
      const module = await import("../../src/sandbox/host-isolation/windows")
      pending = module.inspectWindowsNetworkPolicy({ journal: identity, root, signal: control.signal })
      void pending.catch(() => {})
      await flushing
      control.abort()
      const interrupted = await Promise.race([
        pending.then(
          () => false,
          (error) => error instanceof Error && error.message.includes("TASK24_WINDOWS_POLICY_ABORTED"),
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000)
        }),
      ])
      release()
      await pending.catch(() => {})
      expect(interrupted).toBe(true)
      expect(kills).toBe(1)
      expect(await fs.readdir(root)).toEqual(["network-policy.intent.json"])
    } finally {
      clearTimeout(timer)
      release()
      await pending?.catch(() => {})
      spawn.mockRestore()
      if ((await fs.realpath(root)) !== root || !root.startsWith(parent + path.sep))
        throw Error("own cancel fixture alias")
      await fs.unlink(journal)
      await fs.rmdir(root)
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "policy cleanup retains and reports its own root when a hard-linked file appears",
  async () => {
    const parent = process.env.TMPDIR
    if (!parent || !/^D:\\OpenCode-Benchmark\\Task24\\tmp\\[^\\]+/.test(parent)) throw Error("owned D fixture required")
    const root = await fs.mkdtemp(path.join(parent, "policy-cleanup-"))
    const journal = path.join(root, "network-policy.intent.json"),
      sentinel = path.join(root, "own-sentinel")
    await fs.writeFile(journal, "{}")
    await fs.writeFile(sentinel, "preserve")
    const identity = await fileIdentity(journal)
    let operationRoot = "",
      exit!: (code: number) => void,
      output!: ReadableStreamDefaultController<Uint8Array>
    let exitCode: number | null = null
    const child = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          output = controller
        },
      }),
      stderr: new Blob([]).stream(),
      exited: new Promise<number>((resolve) => {
        exit = resolve
      }),
      get exitCode() {
        return exitCode
      },
      stdin: {
        write(value: string) {
          operationRoot = JSON.parse(value).cwd
          return value.length
        },
        async flush() {
          await fs.link(sentinel, path.join(operationRoot, "state", "own-link"))
          output.enqueue(
            Buffer.from(JSON.stringify({ ...observed(), policyJournal: journal, retirementPerformed: false })),
          )
          output.close()
          exitCode = 0
          exit(0)
        },
        end() {
          return 0
        },
      },
      kill() {
        throw Error("ended helper must not be killed")
      },
    }
    const spawn = spyOn(Bun, "spawn").mockImplementation(
      () => child as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">,
    )
    try {
      const module = await import("../../src/sandbox/host-isolation/windows")
      await expect(
        module.inspectWindowsNetworkPolicy({ journal: identity, root, signal: new AbortController().signal }),
      ).rejects.toMatchObject({
        cleanupUncertain: true,
        root: expect.stringContaining("policy-operation-"),
        policyJournal: journal,
      })
      expect(await fs.readFile(sentinel, "utf8")).toBe("preserve")
      expect((await fs.lstat(sentinel)).nlink).toBe(2)
      expect((await fs.stat(path.join(operationRoot, "owner.json"))).isFile()).toBe(true)
    } finally {
      spawn.mockRestore()
      if (
        (await fs.realpath(root)) !== root ||
        !root.startsWith(parent + path.sep) ||
        !operationRoot.startsWith(root + path.sep)
      )
        throw Error("own cleanup fixture alias")
      await fs.unlink(path.join(operationRoot, "state", "own-link"))
      for (const name of ["state", "compiler"]) await fs.rmdir(path.join(operationRoot, name))
      await fs.unlink(path.join(operationRoot, "owner.json"))
      await fs.rmdir(operationRoot)
      await fs.unlink(journal)
      await fs.unlink(sentinel)
      await fs.rmdir(root)
    }
  },
)
