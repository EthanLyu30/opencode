import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { stopOwnedProbe } from "./workflow-model-catalog-process"

test.skipIf(process.platform !== "win32")(
  "owned cmd wrapper termination also ends its actual worker",
  async () => {
    await using tmp = await tmpdir()
    const nonce = randomUUID()
    const worker = path.join(tmp.path, "worker.ts")
    const launcher = path.join(tmp.path, "launch space.cmd")
    await fs.writeFile(worker, "console.log(JSON.stringify({pid:process.pid})); setInterval(()=>{},1000)")
    await fs.writeFile(launcher, `@echo off\r\n"${process.execPath}" --no-env-file "${worker}" ${nonce}\r\n`)
    const child = Bun.spawn(["cmd.exe", "/d", "/c", launcher], {
      cwd: tmp.path,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    let workerPID: number | undefined
    let terminated = false
    const reader = child.stdout.getReader()
    try {
      const first = await reader.read()
      workerPID = JSON.parse(new TextDecoder().decode(first.value)).pid
      expect(workerPID).not.toBe(child.pid)
      await stopOwnedProbe(child, workerPID)
      expect(() => process.kill(workerPID!, 0)).toThrow()
      terminated = true
    } finally {
      // The RED wrapper-only implementation leaves this exact diagnostic worker alive.
      if (workerPID && !terminated) {
        const cleanup = Bun.spawn(["taskkill.exe", "/PID", String(workerPID), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
        })
        await cleanup.exited
      }
      if (child.exitCode === null) child.kill()
      await child.exited
      await reader.cancel()
      reader.releaseLock()
      await child.stderr.cancel()
    }
  },
  30_000,
)
