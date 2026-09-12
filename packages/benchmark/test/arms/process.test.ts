import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { superviseProcess } from "../../src/arms/process"
import { sha256File } from "../../src/hash"
import { Task24Root } from "../../src/root"

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length > 0) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

async function directory() {
  const root = path.join(Task24Root.ensure().tmp, `arms-process-${crypto.randomUUID()}`)
  cleanup.push(root)
  await fs.mkdir(root)
  return root
}

describe("Task24 process supervisor", () => {
  test("spawns without a shell and bounds D-owned stdout/stderr", async () => {
    const root = await directory()
    const result = await superviseProcess({
      executable: process.execPath,
      expectedExecutableSha256: await sha256File(process.execPath),
      args: ["-e", 'process.stdout.write("o".repeat(100)); process.stderr.write("e".repeat(100))'],
      cwd: root,
      environment: { PATH: process.env.PATH ?? "" },
      stdoutFile: path.join(root, "stdout.log"),
      stderrFile: path.join(root, "stderr.log"),
      maximumCaptureBytes: 32,
      maximumDurationMs: 10_000,
    })
    expect(result.classification).toBe("exited")
    expect(result.exitCode).toBe(0)
    expect(result.executableSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.startedAt).toMatch(/Z$/)
    expect(result.stdoutBytes).toBe(100)
    expect(result.stdoutCapturedBytes).toBe(32)
    expect(result.stdoutTruncated).toBe(true)
    expect((await fs.readFile(path.join(root, "stderr.log"))).byteLength).toBe(32)
  })

  test("terminates a timed-out process tree with a distinct classification", async () => {
    const root = await directory()
    const result = await superviseProcess({
      executable: process.execPath,
      expectedExecutableSha256: await sha256File(process.execPath),
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      environment: { PATH: process.env.PATH ?? "" },
      stdoutFile: path.join(root, "stdout.log"),
      stderrFile: path.join(root, "stderr.log"),
      maximumCaptureBytes: 1024,
      maximumDurationMs: 50,
    })
    expect(result.classification).toBe("timeout")
    expect(result.durationMs).toBeLessThan(5_000)
  })

  test("distinguishes user cancellation and rejects a changed binary before spawn", async () => {
    const root = await directory()
    await expect(
      superviseProcess({
        executable: process.execPath,
        expectedExecutableSha256: "0".repeat(64),
        args: ["-e", "process.exit(0)"],
        cwd: root,
        environment: { PATH: process.env.PATH ?? "" },
        stdoutFile: path.join(root, "wrong-stdout.log"),
        stderrFile: path.join(root, "wrong-stderr.log"),
        maximumCaptureBytes: 1024,
        maximumDurationMs: 10_000,
      }),
    ).rejects.toThrow(/BINARY_HASH/i)

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 25)
    const result = await superviseProcess({
      executable: process.execPath,
      expectedExecutableSha256: await sha256File(process.execPath),
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      environment: { PATH: process.env.PATH ?? "" },
      stdoutFile: path.join(root, "cancel-stdout.log"),
      stderrFile: path.join(root, "cancel-stderr.log"),
      maximumCaptureBytes: 1024,
      maximumDurationMs: 10_000,
      signal: controller.signal,
    })
    expect(result.classification).toBe("cancelled")
  })
})
