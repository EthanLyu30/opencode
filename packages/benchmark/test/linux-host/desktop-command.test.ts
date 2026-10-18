import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { profileFixture } from "./desktop-profile.test"
import { makeDesktopLaunchController, runDesktopLaunchCommand } from "../../src/sandbox/desktop/command"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import { runLinuxHostCommand } from "../../src/sandbox/command"

test("default and malformed launch commands do not prepare or start, and cannot turn into acceptance", async () => {
  for (const argv of [
    [],
    ["start-readonly"],
    ["prepare-profile"],
    ["inspect", "--launch-id", "fixture"],
    ["stop-owned", "--launch-id", "fixture"],
  ]) {
    const result = await runDesktopLaunchCommand(argv)
    expect(result.exitCode).toBe(2)
    expect(result.output).toMatchObject({
      engine_verified: false,
      tool_capability_verified: false,
      corpus_engine_ready: false,
    })
  }
  for (const argv of [
    ["accept"],
    ["calibrate"],
    ["run"],
    ["start-readonly", "--yes"],
    ["audit", "--spec", "C:\\config"],
    ["audit", "--spec", "D:\\x", "--spec", "D:\\y"],
    ["stop-owned", "--launch-id", "../../other"],
  ])
    expect((await runDesktopLaunchCommand(argv)).exitCode).toBe(1)
  expect((await runLinuxHostCommand(["desktop-launch"])).exitCode).toBe(1)
})

test("controller audit and plan remain diagnostic; serialized approval alone cannot prepare", async () => {
  const f = await profileFixture()
  try {
    const specFile = path.join(f.root, "spec.json"),
      approvalFile = path.join(f.root, "approval.json")
    await fs.writeFile(specFile, canonicalJson(f.spec))
    await fs.writeFile(approvalFile, canonicalJson(f.raw))
    const controller = makeDesktopLaunchController(f.platform)
    expect((await controller(["audit", "--spec", specFile])).exitCode).toBe(2)
    expect((await controller(["plan", "--spec", specFile])).exitCode).toBe(2)
    expect(await fs.exists(f.spec.profileRoot)).toBe(false)
    const denied = await controller(["prepare-profile", "--spec", specFile, "--approval", approvalFile])
    expect(denied.exitCode).toBe(2)
    expect(denied.output).toMatchObject({ code: "human_confirmation_required" })
    expect(await fs.exists(f.spec.profileRoot)).toBe(false)
    expect(f.calls.start).toBe(0)
  } finally {
    await f.close()
  }
})

test("trusted controller prepares then observes and always stops its fixture, never declaring readiness", async () => {
  const f = await profileFixture()
  try {
    const control = path.join(f.root, "control", "desktop-launch", f.raw.launchID)
    await fs.mkdir(control, { recursive: true })
    const specFile = path.join(control, "spec.json"),
      approvalFile = path.join(control, "prepare-approval.json"),
      startFile = path.join(control, "start-approval.json")
    await fs.writeFile(specFile, canonicalJson(f.spec))
    await fs.writeFile(approvalFile, canonicalJson(f.raw))
    const controller = makeDesktopLaunchController(f.platform, async () => true)
    const prepared = await controller([
      "prepare-profile",
      "--spec",
      specFile,
      "--approval",
      approvalFile,
      "--interactive",
    ])
    expect(prepared.exitCode).toBe(0)
    expect(prepared.output).toMatchObject({ code: "profile_prepared", assurance: "fixture", engine_verified: false })
    const { expectedProfileRoot, ...common } = f.raw
    const start = {
      ...common,
      phase: "start-readonly",
      nonce: sha256Text(crypto.randomUUID()),
      operations: ["start-readonly", "stop-owned"],
      manifestSha256: sha256Text(await fs.readFile(path.join(f.spec.profileRoot, "manifest.json"), "utf8")),
    }
    await fs.writeFile(startFile, canonicalJson(start))
    const restartedController = makeDesktopLaunchController(f.platform, async () => true)
    const result = await restartedController([
      "start-readonly",
      "--spec",
      specFile,
      "--approval",
      startFile,
      "--interactive",
    ])
    expect(result.exitCode).toBe(2)
    expect(result.output).toMatchObject({
      code: "desktop_inventory_blocked",
      engine_verified: false,
      tool_capability_verified: false,
      corpus_engine_ready: false,
    })
    expect(f.calls.start).toBe(1)
    expect(f.calls.stop).toBe(1)
    expect(await fs.exists(path.join(f.spec.profileRoot, "state", "active.json"))).toBe(false)
  } finally {
    await f.close()
  }
})

test("actual standalone script without inputs exits diagnostic-only and emits bounded JSON", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", path.resolve("script/desktop-launch.ts")], {
    cwd: process.cwd(),
    env: {
      HOME: process.env.HOME!,
      USERPROFILE: process.env.USERPROFILE!,
      TEMP: process.env.TEMP!,
      TMP: process.env.TMP!,
      SystemRoot: "C:\\Windows",
      PATH: process.env.PATH!,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME!,
      APPDATA: process.env.APPDATA!,
      LOCALAPPDATA: process.env.LOCALAPPDATA!,
    },
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await child.exited).toBe(2)
  const output = await new Response(child.stdout).text()
  expect(output.length).toBeLessThan(65536)
  expect(JSON.parse(output)).toMatchObject({ code: "operation_required", engine_verified: false })
  expect(await new Response(child.stderr).text()).toBe("")
})
