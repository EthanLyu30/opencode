import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import { runtimeFixtureV2 } from "./desktop-v2-runtime-fixture"
import { stopDesktopLaunch, readDesktopAttemptDiagnostics } from "../../src/sandbox/desktop/launch"
import { finishDesktopSettingsRuntime } from "../../src/sandbox/desktop/settings-runtime"

test("review: stop directly after observed Rename retains the primary drift failure", async () => {
  const f = await runtimeFixtureV2()
  try {
    const file = f.plan.runtimeTargets.daemon,
      temp = file + ".fixture-01.tmp"
    await fs.writeFile(temp, await fs.readFile(file))
    await fs.rename(temp, file)
    const result = await stopDesktopLaunch(f.session)
    expect(result).toEqual({ kind: "ready", value: "stopped" })
    expect(readDesktopAttemptDiagnostics(result)?.failureCode).toBe("TASK24_DESKTOP_SETTINGS_OBSERVED_DRIFT")
    expect(f.calls.stop).toBe(1)
  } finally {
    await stopDesktopLaunch(f.session)
    await f.close()
  }
}, 30000)

test(
  "review: independent stopping parents span the save after start expiry",
  async () => {
    const f = await runtimeFixtureV2(undefined, process.platform === "win32" ? 15000 : 5000)
    try {
      expect(Date.now()).toBeLessThan(f.approval.expiresAt)
      await Bun.sleep(Math.max(0, f.approval.expiresAt - Date.now() + 1))
      await finishDesktopSettingsRuntime(f.session)
      f.onStop(async () => {
        const directory = path.dirname(f.plan.runtimeTargets.daemon),
          moved = directory + ".moved"
        let renamed = false,
          blocked = false
        try {
          await fs.rename(directory, moved)
          renamed = true
        } catch {
          blocked = true
        } finally {
          if (renamed) await fs.rename(moved, directory)
        }
        expect(blocked).toBe(true)
        const file = f.plan.runtimeTargets.daemon,
          temp = file + ".fixture-01.tmp"
        await fs.writeFile(temp, JSON.stringify(f.payload("daemon")) + "\n")
        await fs.rename(temp, file)
      })
      const result = await stopDesktopLaunch(f.session)
      expect(result).toEqual({ kind: "ready", value: "stopped" })
      expect(readDesktopAttemptDiagnostics(result)?.failureCode).toBeNull()
      expect(f.calls.stop).toBe(1)
    } finally {
      await stopDesktopLaunch(f.session)
      await f.close()
    }
  },
  process.platform === "win32" ? 45000 : 30000,
)

for (const mode of ["active", "bootstrap", "workload-expiry"] as const)
  test(`review: isolated real-resource ${mode} lifetime`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        path.join(import.meta.dir, "desktop-v2-lifecycle-regression-worker.ts"),
        mode,
      ],
      {
        cwd: process.env.TMPDIR,
        env: process.env,
        windowsHide: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, out, err }).toEqual({ code: 0, out: JSON.stringify({ mode, status: "fixture_verified" }), err: "" })
  }, 30000)
