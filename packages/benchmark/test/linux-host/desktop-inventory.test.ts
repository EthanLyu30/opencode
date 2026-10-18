import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { launchFixture } from "./desktop-launch.test"
import { interactiveFixture } from "./desktop-interactive-command.test"
import { desktopFeature } from "./desktop-native-fixture"
import { consumeDesktopGrant } from "../../src/sandbox/desktop/profile"
import { makeDesktopLaunchController } from "../../src/sandbox/desktop/command"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import { fileIdentity } from "../../src/sandbox/storage"
import { runLinuxHostCommand } from "../../src/sandbox/command"
import type { DesktopLaunchRecord } from "../../src/sandbox/desktop/inventory"

function record(f: Awaited<ReturnType<typeof launchFixture>>): DesktopLaunchRecord {
  return {
    schemaVersion: 1,
    launchID: f.approval.launchID,
    specSha256: f.plan.specSha256,
    planSha256: f.plan.planSha256,
    compatibilitySha256: f.plan.compatibilitySha256,
    manifestSha256: f.profile.manifestSha256,
    status: "blocked",
    code: "synthetic_attempt",
    missing: ["synthetic_attempt"],
    inventory: null,
    cleanup: "not_needed",
    engine_verified: false,
    tool_capability_verified: false,
    corpus_engine_ready: false,
  }
}
async function commandAttempt() {
  const f = await interactiveFixture()
  const run = makeDesktopLaunchController(f.platform, async () => true)
  const ready = await run(f.argv)
  if (ready.exitCode !== 0) throw Error("PREPARE")
  const { expectedProfileRoot, ...common } = f.raw
  const raw = {
    ...common,
    nonce: sha256Text(crypto.randomUUID()),
    phase: "start-readonly",
    operations: ["start-readonly", "stop-owned"],
    manifestSha256: sha256Text(await fs.readFile(path.join(f.spec.profileRoot, "manifest.json"), "utf8")),
  }
  await fs.writeFile(f.startFile, canonicalJson(raw))
  return {
    ...f,
    raw,
    run,
    startArgv: ["start-readonly", "--spec", f.specFile, "--approval", f.startFile, "--interactive"],
    report: path.join(f.root, "reports", "desktop-launch", raw.launchID, "inventory.json"),
  }
}

test("cancelled and unconsumed attempts publish nothing", async () => {
  const api = await desktopFeature<typeof import("../../src/sandbox/desktop/inventory")>("inventory")
  expect(api.publishDesktopLaunchRecord).toBeFunction()
  if (!api.publishDesktopLaunchRecord) return
  const f = await launchFixture()
  try {
    await expect(
      api.publishDesktopLaunchRecord({ profile: f.profile, approval: f.approval, record: record(f) }),
    ).rejects.toThrow()
    expect(await fs.exists(path.join(f.root, "reports"))).toBe(false)
    const grant = await desktopFeature<typeof import("../../src/sandbox/desktop/profile")>("profile")
    expect(() => grant.requireDesktopConsumedGrant!(f.profile, f.approval)).toThrow()
    await consumeDesktopGrant(f.profile, f.approval)
    expect(() => grant.requireDesktopConsumedGrant!(f.profile, f.approval)).not.toThrow()
    expect(() => grant.requireDesktopConsumedGrant!(f.profile, { ...f.approval })).toThrow()
    expect(() => grant.requireDesktopConsumedGrant!({ ...f.profile }, f.approval)).toThrow()
    for (const invalid of [
      { ...record(f), engine_verified: true },
      { ...record(f), env: "must-not-persist" },
      { ...record(f), code: "X".repeat(65537) },
    ]) {
      await expect(
        api.publishDesktopLaunchRecord({
          profile: f.profile,
          approval: f.approval,
          record: invalid as DesktopLaunchRecord,
        }),
      ).rejects.toThrow()
    }
    expect(await fs.exists(path.join(f.root, "reports"))).toBe(false)
  } finally {
    await f.close()
  }
})

test("failed attempts retain cleanup authority and historical diagnostics", async () => {
  for (const kind of ["failed", "expired", "cancelled"]) {
    const f = await commandAttempt()
    const savedNow = Date.now
    const abort = new AbortController()
    try {
      if (kind === "failed")
        f.platform.start = async () => {
          f.calls.start++
          throw Error("synthetic_start_failure")
        }
      else if (kind === "expired") {
        const original = f.platform.start
        f.platform.start = async (plan) => {
          const result = await original(plan)
          Date.now = () => f.raw.expiresAt + 1
          return result
        }
      } else {
        const original = f.platform.observe
        let cancelled = false
        f.platform.observe = async (spec, signal) => {
          const result = await original(spec, signal)
          if (f.calls.start && !cancelled) {
            cancelled = true
            abort.abort()
          } else if (f.calls.start) expect(signal?.aborted).toBe(false)
          return result
        }
      }
      const result = await f.run(f.startArgv, abort.signal)
      Date.now = savedNow
      expect(result.exitCode).toBe(2)
      expect(await fs.exists(f.report)).toBe(true)
      const stored = JSON.parse(await fs.readFile(f.report, "utf8"))
      expect(stored.status).toBe(kind === "failed" ? "cleanup_uncertain" : "blocked")
      expect(stored.cleanup).toBe(kind === "failed" ? "uncertain" : "stopped")
      expect(stored.engine_verified).toBe(false)
      expect(f.calls.start).toBe(1)
      expect(f.calls.stop).toBe(kind === "failed" ? 0 : 1)
      const before = await fs.readFile(f.report, "utf8")
      await f.run(f.startArgv)
      expect(await fs.readFile(f.report, "utf8")).toBe(before)
      expect(f.calls.start).toBe(1)
    } finally {
      Date.now = savedNow
      await f.close()
    }
  }
})

test("report publication failure never bypasses finally cleanup", async () => {
  const f = await commandAttempt()
  try {
    const destination = path.dirname(f.report)
    await fs.mkdir(destination, { recursive: true })
    await fs.writeFile(f.report, "foreign-history")
    const before = await fileIdentity(f.report)
    const result = await f.run(f.startArgv)
    expect(result.exitCode).toBe(2)
    expect(result.output).toMatchObject({ code: "desktop_report_publication_failed", reportPublished: false })
    expect(f.calls.stop).toBe(1)
    expect(await fileIdentity(f.report)).toEqual(before)
    expect(await fs.readFile(f.report, "utf8")).toBe("foreign-history")
  } finally {
    await f.close()
  }
})

test("record publication pins parents and never adopts foreign files", async () => {
  const api = await desktopFeature<typeof import("../../src/sandbox/desktop/inventory")>("inventory")
  expect(api.publishDesktopLaunchRecord).toBeFunction()
  if (!api.publishDesktopLaunchRecord) return
  for (const kind of ["ordinary", "junction", "hardlink", "success"]) {
    const f = await launchFixture()
    try {
      await consumeDesktopGrant(f.profile, f.approval)
      const outside = path.join(f.root, "sentinel")
      await fs.writeFile(outside, "user-owned-sentinel")
      const before = await fileIdentity(outside)
      const directory = path.join(f.root, "reports", "desktop-launch", f.approval.launchID)
      if (kind === "ordinary") await fs.mkdir(directory, { recursive: true })
      if (kind === "junction") {
        const target = path.join(f.root, "outside")
        await fs.mkdir(target)
        await fs.symlink(target, path.join(f.root, "reports"), "junction")
      }
      if (kind === "hardlink") {
        await fs.mkdir(directory, { recursive: true })
        await fs.link(outside, path.join(directory, "inventory.json"))
      }
      const result = await api
        .publishDesktopLaunchRecord({ profile: f.profile, approval: f.approval, record: record(f) })
        .then(
          (value) => value,
          () => null,
        )
      if (kind === "success") {
        expect(result?.path).toBe(path.join(directory, "inventory.json"))
        expect(await fs.readdir(directory)).toEqual(["inventory.json"])
      } else expect(result).toBeNull()
      if (kind === "hardlink") await fs.unlink(path.join(directory, "inventory.json"))
      expect(await fileIdentity(outside)).toEqual(before)
      expect(await fs.readFile(outside, "utf8")).toBe("user-owned-sentinel")
    } finally {
      await f.close()
    }
  }
})

test("stale records cannot restore a live session", async () => {
  const f = await commandAttempt()
  try {
    const result = await f.run(f.startArgv)
    expect(result.exitCode).toBe(2)
    expect(await fs.exists(f.report)).toBe(true)
    const fresh = makeDesktopLaunchController(f.platform, async () => true)
    expect((await fresh(["inspect", "--launch-id", f.raw.launchID])).output).toMatchObject({
      code: "stale_record_not_live",
      engine_verified: false,
    })
    expect((await fresh(["stop-owned", "--launch-id", f.raw.launchID])).output).toMatchObject({
      code: "session_not_live",
    })
    expect((await runLinuxHostCommand(["accept", "--manifest", f.report])).exitCode).not.toBe(0)
    const stored = await fs.readFile(f.report, "utf8")
    expect(stored).not.toContain(f.raw.nonce)
    expect(stored).not.toContain("PINATA_")
    expect(stored).not.toContain("challenge")
    expect(f.calls).toEqual({ start: 1, stop: 1, execute: 0 })
    await fs.appendFile(f.report, "extra")
    expect((await fresh(["inspect", "--launch-id", f.raw.launchID])).output).not.toMatchObject({
      code: "stale_record_not_live",
    })
  } finally {
    await f.close()
  }
})
