import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { profileFixture } from "./desktop-profile.test"
import { confirmDesktopApproval, prepareDesktopProfile } from "../../src/sandbox/desktop/profile"
import {
  startDesktopReadonly,
  stopDesktopLaunch,
  revalidateDesktopLaunchSession,
} from "../../src/sandbox/desktop/launch"
import { sha256Text } from "../../src/hash"

export async function launchFixture() {
  const f = await profileFixture()
  const prepared = await prepareDesktopProfile({
    spec: f.spec,
    plan: f.plan,
    approval: await f.approve(),
    platform: f.platform,
  })
  if (prepared.kind !== "ready") throw Error("FIXTURE_PREPARE")
  const raw = {
    ...f.raw,
    nonce: sha256Text(crypto.randomUUID()),
    phase: "start-readonly" as const,
    operations: ["start-readonly", "stop-owned"] as const,
    manifestSha256: prepared.value.manifestSha256,
  }
  const { expectedProfileRoot, ...startRaw } = raw
  const approval = await confirmDesktopApproval(startRaw, async () => true)
  return {
    ...f,
    profile: prepared.value,
    approval,
    request: {
      spec: f.spec,
      profile: prepared.value,
      approval,
      platform: f.platform,
      signal: new AbortController().signal,
    },
  }
}

test("single owned launch yields only fixture authority and stop is exact and idempotent", async () => {
  const f = await launchFixture()
  try {
    const started = await startDesktopReadonly(f.request)
    expect(started.kind).toBe("ready")
    if (started.kind !== "ready") throw Error("START")
    expect((await revalidateDesktopLaunchSession(started.value)).assurance).toBe("fixture")
    expect((await stopDesktopLaunch(started.value)).kind).toBe("ready")
    expect((await stopDesktopLaunch(started.value)).kind).toBe("ready")
    expect(f.calls.start).toBe(1)
    expect(f.calls.stop).toBe(1)
    await expect(revalidateDesktopLaunchSession({ ...started.value })).rejects.toThrow()
    expect((await startDesktopReadonly(f.request)).kind).toBe("blocked")
    expect(f.calls.start).toBe(1)
  } finally {
    await f.close()
  }
})

test("reused PID and consumed grant never stop or spawn", async () => {
  const f = await launchFixture()
  try {
    const started = await startDesktopReadonly(f.request)
    if (started.kind !== "ready") throw Error("START")
    const original = f.getObservation()
    const process = original.process as Record<string, unknown>
    f.setObservation({ ...original, process: { ...process, createdAt: Number(process.createdAt) + 1 } })
    expect((await stopDesktopLaunch(started.value)).kind).toBe("blocked")
    expect(f.calls.stop).toBe(0)
    f.setObservation({ phase: "idle", sid: "S-1-5-21-fixture", runningDocker: false, runningWsl: false })
    expect((await startDesktopReadonly(f.request)).kind).toBe("blocked")
    expect(f.calls.start).toBe(1)
  } finally {
    await f.close()
  }
})

test("existing Docker or WSL and changed install bytes stop before spawn", async () => {
  for (const conflict of ["docker", "wsl", "install", "sid"]) {
    const f = await launchFixture()
    try {
      f.setObservation({
        phase: "idle",
        sid: conflict === "sid" ? "foreign-SID" : "S-1-5-21-fixture",
        runningDocker: conflict === "docker",
        runningWsl: conflict === "wsl",
      })
      if (conflict === "install") await fs.appendFile(f.spec.install.desktop.path, "drift")
      expect((await startDesktopReadonly(f.request)).kind).toBe("blocked")
      expect(f.calls.start).toBe(0)
    } finally {
      await f.close()
    }
  }
})

test("cancelled or never-settling observation cannot spawn, and a late start is reported uncertain", async () => {
  const f = await launchFixture()
  try {
    const controller = new AbortController()
    controller.abort()
    expect((await startDesktopReadonly({ ...f.request, signal: controller.signal })).kind).toBe("blocked")
    expect(f.calls.start).toBe(0)
    const pending = new AbortController()
    f.platform.observe = async () => {
      queueMicrotask(() => pending.abort())
      return new Promise(() => {})
    }
    const result = await startDesktopReadonly({ ...f.request, signal: pending.signal })
    expect(result.kind).toBe("blocked")
    expect(f.calls.start).toBe(0)
  } finally {
    await f.close()
  }
})

test("cancellation after an unresolved start reports uncertainty and cannot reuse the durable grant", async () => {
  const f = await launchFixture()
  try {
    const controller = new AbortController()
    f.platform.start = async () => {
      f.calls.start++
      queueMicrotask(() => controller.abort())
      return new Promise(() => {})
    }
    const result = await startDesktopReadonly({ ...f.request, signal: controller.signal })
    expect(result.kind === "blocked" && result.code).toBe("cleanup_uncertain")
    expect(f.calls.stop).toBe(0)
    expect((await startDesktopReadonly(f.request)).kind).toBe("blocked")
    expect(f.calls.start).toBe(1)
  } finally {
    await f.close()
  }
})

test("slow owned startup is observed until its pipe appears; concurrent stop is performed once", async () => {
  const f = await launchFixture()
  try {
    const observe = f.platform.observe
    let pending = 0
    f.platform.observe = async (spec) => {
      const state = (await observe(spec)) as Record<string, unknown>
      if (state.phase === "running" && pending++ < 2) {
        const { pipe, ...rest } = state
        return { ...rest, phase: "starting" }
      }
      return state
    }
    const started = await startDesktopReadonly(f.request)
    expect(started.kind).toBe("ready")
    if (started.kind !== "ready") throw Error("START")
    const results = await Promise.all([stopDesktopLaunch(started.value), stopDesktopLaunch(started.value)])
    expect(results.map((r) => r.kind)).toEqual(["ready", "ready"])
    expect(f.calls.stop).toBe(1)
  } finally {
    await f.close()
  }
})

test("disk replacement and corrupt durable nonce are detected instead of repaired", async () => {
  const f = await launchFixture()
  try {
    await fs.unlink(f.spec.disks.data.path)
    await fs.writeFile(f.spec.disks.data.path, "different synthetic disk")
    expect((await startDesktopReadonly(f.request)).kind).toBe("blocked")
    expect(f.calls.start).toBe(0)
    expect(await fs.exists(path.join(f.spec.profileRoot, "state", "grants", f.approval.nonce + ".json"))).toBe(false)
  } finally {
    await f.close()
  }
})
