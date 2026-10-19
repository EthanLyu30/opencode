import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { profileFixtureV2 } from "./desktop-v2-profile-fixture"
import { canonicalJson } from "../../src/campaign/canonical"
import { desktopRuntimeTargetsV2 } from "../../src/sandbox/desktop/v2-contracts"

const profile = await import("../../src/sandbox/desktop/profile-v2").catch(() => undefined)
const approval = await import("../../src/sandbox/desktop/approval-v2").catch(() => undefined)

test("v2 prepares exactly 13 directories and five files without daemon defaults or live seals", async () => {
  expect(profile).toBeDefined()
  const f = await profileFixtureV2()
  try {
    const p = await f.prepareV2()
    expect(await f.profileOutputCounts()).toEqual({ directories: 13, files: 5 })
    for (const file of [
      desktopRuntimeTargetsV2(f.spec.profileRoot).daemon,
      desktopRuntimeTargetsV2(f.spec.profileRoot)["windows-daemon"],
      path.join(f.spec.profileRoot, "settings-policy.json"),
      path.join(f.spec.profileRoot, "runtime-seal.json"),
    ])
      expect(await fs.exists(file)).toBe(false)
    const body = JSON.parse(await fs.readFile(path.join(f.spec.profileRoot, "manifest.json"), "utf8"))
    expect(body.schemaVersion).toBe(2)
    expect(body.manifestSha256).toBeUndefined()
    expect(p.seed.sha256).toBe(f.plan.seedSha256)
    await expect(profile!.revalidateDesktopProfileV2({ ...p }, "prepared")).rejects.toThrow()
    await expect(profile!.revalidateDesktopProfileV2(p, "prepared")).resolves.toBeUndefined()
    const loaded = await profile!.loadDesktopPreparedProfileV2(f.plan)
    expect(loaded.manifestSha256).toBe(p.manifestSha256)
    for (const file of ["intent.json", "owner.json", "manifest.json"]) {
      const full = path.join(f.spec.profileRoot, file),
        text = await fs.readFile(full, "utf8")
      await fs.writeFile(full, text + " ")
      await expect(profile!.revalidateDesktopProfileV2(p, "immutable")).rejects.toThrow()
      await fs.writeFile(full, text)
    }
    await fs.appendFile(p.seed.path, " ")
    await expect(profile!.revalidateDesktopProfileV2(p, "prepared")).rejects.toThrow()
  } finally {
    await f.close()
  }
})

test("v2 approvals cannot be cloned, expired, overlong or rebound to another plan", async () => {
  expect(profile).toBeDefined()
  expect(approval).toBeDefined()
  const f = await profileFixtureV2()
  try {
    for (const raw of [
      { ...f.raw, expiresAt: Date.now() - 1 },
      { ...f.raw, expiresAt: f.raw.issuedAt + 900001 },
      { ...f.raw, schemaVersion: 1 },
      { ...f.raw, extra: true },
    ])
      await expect(approval!.confirmDesktopApprovalV2(raw, async () => true)).rejects.toThrow()
    await expect(approval!.confirmDesktopApprovalV2(f.raw, async () => false)).rejects.toThrow()
    const confirmed = await approval!.confirmDesktopApprovalV2(f.raw, async () => true)
    expect(
      (
        await profile!.prepareDesktopProfileV2({
          spec: f.spec,
          plan: f.plan,
          approval: { ...confirmed },
          platform: f.platform,
        })
      ).kind,
    ).toBe("blocked")
    expect(await fs.exists(f.spec.profileRoot)).toBe(false)
    const panel = approval!.desktopConfirmationPanelV2(f.plan, confirmed)
    expect(Buffer.byteLength(panel)).toBeLessThanOrEqual(12288)
    for (const text of [
      "13 directories",
      "5 files",
      "intent.json",
      "6291456",
      "16384",
      "120000",
      "30000",
      f.plan.policySha256,
    ])
      expect(panel).toContain(text)
    expect(canonicalJson(f.plan)).not.toContain('"settingsSha256"')
  } finally {
    await f.close()
  }
})

test("v2 grant and active state retain one-time consumption without repairing replay", async () => {
  expect(profile).toBeDefined()
  expect(approval).toBeDefined()
  const f = await profileFixtureV2()
  try {
    const p = await f.prepareV2(),
      start = await approval!.confirmDesktopApprovalV2(f.startRaw(p.manifestSha256), async () => true)
    await profile!.consumeDesktopGrantV2(p, start)
    await expect(profile!.consumeDesktopGrantV2(p, start)).rejects.toThrow()
    const active = await profile!.writeDesktopActiveLockV2(p, start)
    await expect(profile!.loadDesktopPreparedProfileV2(f.plan)).rejects.toThrow()
    await expect(profile!.removeDesktopActiveLockV2(p, { ...active })).rejects.toThrow()
    await profile!.removeDesktopActiveLockV2(p, active)
    expect(await fs.exists(active.path)).toBe(false)
    expect(await fs.exists(path.join(f.spec.profileRoot, "state", "grants", start.nonce + ".json"))).toBe(true)
  } finally {
    await f.close()
  }
})

test("v2 active cleanup refuses a substituted root even if its owned lock was moved there", async () => {
  expect(profile).toBeDefined()
  expect(approval).toBeDefined()
  const f = await profileFixtureV2()
  try {
    const p = await f.prepareV2(),
      start = await approval!.confirmDesktopApprovalV2(f.startRaw(p.manifestSha256), async () => true)
    await profile!.consumeDesktopGrantV2(p, start)
    const lock = await profile!.writeDesktopActiveLockV2(p, start),
      old = f.spec.profileRoot + ".original"
    await fs.rename(f.spec.profileRoot, old)
    const { desktopProfileLayoutV2 } = await import("../../src/sandbox/desktop/publication-v2")
    for (const rel of desktopProfileLayoutV2) await fs.mkdir(path.join(f.spec.profileRoot, rel), { recursive: true })
    await fs.rename(path.join(old, "state", "active.json"), lock.path)
    await expect(profile!.removeDesktopActiveLockV2(p, lock)).rejects.toThrow()
    expect(await fs.exists(lock.path)).toBe(true)
  } finally {
    await f.close()
  }
})

test("v2 refuses existing roots and changed directory identities without migration", async () => {
  expect(profile).toBeDefined()
  expect(approval).toBeDefined()
  const f = await profileFixtureV2()
  try {
    await fs.mkdir(f.spec.profileRoot)
    const confirmed = await approval!.confirmDesktopApprovalV2(f.raw, async () => true)
    expect(
      (
        await profile!.prepareDesktopProfileV2({
          spec: f.spec,
          plan: f.plan,
          approval: confirmed,
          platform: f.platform,
        })
      ).kind,
    ).toBe("blocked")
    expect(await fs.readdir(f.spec.profileRoot)).toEqual([])
  } finally {
    await f.close()
  }
})

test("v2 refuses duplicate manifest keys on reload and byte-identical immutable replacement", async () => {
  expect(profile).toBeDefined()
  const f = await profileFixtureV2()
  try {
    const p = await f.prepareV2(),
      manifest = path.join(f.spec.profileRoot, "manifest.json"),
      saved = await fs.readFile(manifest, "utf8")
    await fs.writeFile(manifest, saved.replace('"schemaVersion":2', '"schemaVersion":1,"schemaVersion":2'))
    await expect(profile!.loadDesktopPreparedProfileV2(f.plan)).rejects.toThrow()
    await fs.writeFile(manifest, saved)
    const file = path.join(f.spec.profileRoot, "intent.json"),
      bytes = await fs.readFile(file)
    await fs.rename(file, file + ".original")
    await fs.writeFile(file, bytes)
    await expect(profile!.revalidateDesktopProfileV2(p, "immutable")).rejects.toThrow()
  } finally {
    await f.close()
  }
})

test("v2 immutable directories cannot be replaced and unsafe confirmation text is rejected", async () => {
  expect(profile).toBeDefined()
  expect(approval).toBeDefined()
  const f = await profileFixtureV2()
  try {
    const p = await f.prepareV2(),
      home = f.plan.paths.home
    await fs.rename(home, home + ".original")
    await fs.mkdir(home)
    await expect(profile!.revalidateDesktopProfileV2(p, "immutable")).rejects.toThrow()
    expect(approval!.validateDesktopPanelV2("a".repeat(12288))).toHaveLength(12288)
    for (const text of ["a".repeat(12289), "hidden\u202e", "escape\u001b"]) {
      expect(() => approval!.validateDesktopPanelV2(text)).toThrow()
    }
  } finally {
    await f.close()
  }
})
