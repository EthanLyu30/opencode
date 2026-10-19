import fs from "node:fs/promises"
import { expect, test } from "bun:test"
import { profileFixtureV2 } from "./desktop-v2-profile-fixture"
import { confirmDesktopApprovalV2 } from "../../src/sandbox/desktop/approval-v2"
import {
  startDesktopReadonly,
  stopDesktopLaunch,
  readDesktopAttemptDiagnostics,
} from "../../src/sandbox/desktop/launch"
import {
  withDesktopRuntimeSettings,
  sealDesktopSettingsRuntime,
  readDesktopSettingsFailure,
} from "../../src/sandbox/desktop/settings-runtime"

async function start(f: Awaited<ReturnType<typeof profileFixtureV2>>, validMs = 60000) {
  const profile = await f.prepareV2()
  const approval = await confirmDesktopApprovalV2(f.startRaw(profile.manifestSha256, validMs), async () => true)
  const result = await startDesktopReadonly({
    spec: f.spec,
    profile,
    approval,
    platform: f.platform,
    signal: AbortSignal.timeout(120000),
  })
  if (result.kind !== "ready") throw Error(JSON.stringify(result))
  return { session: result.value, approval }
}

test("v2 bootstrap accepts complete formatted replacement; seals cannot escape their use", async () => {
  const f = await profileFixtureV2()
  try {
    f.onStart(() => f.emitRuntime())
    const { session } = await start(f)
    let escaped: unknown
    await withDesktopRuntimeSettings(session, async (seal) => {
      escaped = seal
      expect(seal.phase).toBe("observed")
      expect(seal.sequence).toBe(1)
    })
    expect(escaped).toBeDefined()
    await expect(withDesktopRuntimeSettings({ ...session }, async () => "bad")).rejects.toThrow()
    expect((await sealDesktopSettingsRuntime(session, AbortSignal.timeout(5000))).kind).toBe("blocked")
    expect(await stopDesktopLaunch(session)).toEqual({ kind: "ready", value: "stopped" })
    await expect(withDesktopRuntimeSettings(session, async () => "bad")).rejects.toThrow()
    expect(f.calls.start).toBe(1)
    expect(f.calls.stop).toBe(1)
  } finally {
    await f.close()
  }
}, 30000)

test("corrupt settings block use but retain consumed cleanup after start grant expiry", async () => {
  const f = await profileFixtureV2()
  try {
    f.onStart(() => f.emitRuntime())
    const { session, approval } = await start(f, 5000)
    expect(Date.now()).toBeLessThan(approval.expiresAt)
    await fs.writeFile(f.plan.runtimeTargets.daemon, "{")
    await expect(withDesktopRuntimeSettings(session, async () => "used")).rejects.toThrow()
    expect(readDesktopSettingsFailure(session)).not.toBeNull()
    const remaining = Math.max(0, approval.expiresAt - Date.now() + 1)
    expect(remaining).toBeLessThanOrEqual(5000)
    await Bun.sleep(remaining)
    const [one, two] = await Promise.all([stopDesktopLaunch(session), stopDesktopLaunch(session)])
    expect(one).toEqual({ kind: "ready", value: "stopped" })
    expect(two).toEqual(one)
    expect(f.calls.stop).toBe(1)
    expect(readDesktopAttemptDiagnostics(one)?.failureCode).not.toBeNull()
  } finally {
    await f.close()
  }
}, 30000)

test("stable malformed partial bootstrap fails immediately and uses exact owned cleanup", async () => {
  const f = await profileFixtureV2()
  try {
    const profile = await f.prepareV2()
    f.onStart(async () => {
      await fs.writeFile(f.plan.runtimeTargets["settings-store"], "{")
    })
    const approval = await confirmDesktopApprovalV2(f.startRaw(profile.manifestSha256), async () => true)
    const result = await startDesktopReadonly({
      spec: f.spec,
      profile,
      approval,
      platform: f.platform,
      signal: AbortSignal.timeout(10000),
    })
    expect(result.kind).toBe("blocked")
    expect(f.calls.start).toBe(1)
    expect(f.calls.stop).toBe(1)
    expect(readDesktopAttemptDiagnostics(result)?.failureCode).not.toBeNull()
  } finally {
    await f.close()
  }
}, 30000)

test("post-seal byte-only drift fails; unknown process ownership never invokes stop", async () => {
  const f = await profileFixtureV2()
  try {
    f.onStart(() => f.emitRuntime())
    const { session } = await start(f)
    await fs.appendFile(f.plan.runtimeTargets.daemon, " \n")
    await expect(withDesktopRuntimeSettings(session, async () => "bad")).rejects.toThrow()
    const raw = f.readObservation() as any
    raw.process.createdAt++
    f.setObservation(raw)
    const result = await stopDesktopLaunch(session)
    expect(result.kind).toBe("blocked")
    expect(f.calls.stop).toBe(0)
    expect(readDesktopAttemptDiagnostics(result)?.cleanupCode).toBeDefined()
  } finally {
    await f.close()
  }
}, 30000)

test("pending bootstrap waits for one complete set; stop saving invalid settings retains the failure", async () => {
  const f = await profileFixtureV2()
  let saved: Promise<void> | undefined
  try {
    f.onStart(async () => {
      saved = Bun.sleep(400).then(() => f.emitRuntime())
    })
    const { session } = await start(f)
    await saved
    f.onStop(async () => {
      await fs.writeFile(f.plan.runtimeTargets.daemon, '{"unknown":true}')
    })
    const result = await stopDesktopLaunch(session)
    expect(result).toEqual({ kind: "ready", value: "stopped" })
    expect(f.calls.stop).toBe(1)
    expect(readDesktopAttemptDiagnostics(result)?.failureCode).not.toBeNull()
    expect((await sealDesktopSettingsRuntime(session, AbortSignal.timeout(5000))).kind).toBe("blocked")
  } finally {
    await saved
    await f.close()
  }
}, 30000)
