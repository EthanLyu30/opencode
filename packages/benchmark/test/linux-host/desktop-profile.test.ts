import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { desktopFixture } from "./desktop-fixture"
import { auditDesktopCompatibility, decodeDesktopLaunchSpec } from "../../src/sandbox/desktop/compatibility"
import {
  planDesktopProfile,
  prepareDesktopProfile,
  confirmDesktopApproval,
  revalidateDesktopProfile,
  loadDesktopPreparedProfile,
} from "../../src/sandbox/desktop/profile"
import { fileIdentity } from "../../src/sandbox/storage"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"

export async function profileFixture() {
  const f = await desktopFixture()
  const report = await auditDesktopCompatibility(f.spec, f.platform)
  if (report.kind !== "ready") throw Error("FIXTURE_AUDIT")
  const planned = planDesktopProfile(f.spec, report.value)
  if (planned.kind !== "ready") throw Error("FIXTURE_PLAN")
  const raw = {
    schemaVersion: 1 as const,
    phase: "prepare-profile" as const,
    launchID: "fixture-desktop",
    nonce: sha256Text(crypto.randomUUID()),
    sid: "S-1-5-21-fixture",
    planSha256: planned.value.planSha256,
    compatibilitySha256: planned.value.compatibilitySha256,
    registration: f.spec.registration,
    disks: f.spec.disks,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    operations: ["prepare-profile"] as const,
    expectedProfileRoot: f.spec.profileRoot,
  }
  return {
    ...f,
    plan: planned.value,
    raw,
    async approve() {
      return confirmDesktopApproval(raw, async () => true)
    },
  }
}

test("serialized or declined approval never writes a profile", async () => {
  const f = await profileFixture()
  try {
    expect(
      (await prepareDesktopProfile({ spec: f.spec, plan: f.plan, approval: f.raw, platform: f.platform })).kind,
    ).toBe("blocked")
    expect(await fs.exists(f.spec.profileRoot)).toBe(false)
    await expect(confirmDesktopApproval(f.raw, async () => false)).rejects.toThrow()
    const approval = await f.approve()
    expect(
      (await prepareDesktopProfile({ spec: f.spec, plan: f.plan, approval: { ...approval }, platform: f.platform }))
        .kind,
    ).toBe("blocked")
  } finally {
    await f.close()
  }
})

test("owned D profile publishes only whitelisted settings and never inherits endpoint or credentials", async () => {
  const f = await profileFixture()
  try {
    const result = await prepareDesktopProfile({
      spec: f.spec,
      plan: f.plan,
      approval: await f.approve(),
      platform: f.platform,
    })
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") throw Error("PREPARE_FAILED")
    const settings = JSON.parse(
      await fs.readFile(path.join(f.plan.paths.home, "AppData", "Roaming", "Docker", "settings-store.json"), "utf8"),
    )
    expect(settings).toEqual({
      SettingsVersion: 44,
      CustomWslDistroDir: f.spec.dataRoot,
      WslEngineEnabled: true,
      UseWindowsContainers: false,
      AutoStart: false,
    })
    expect(f.plan.env.PINATA_HOME_DIRECTORY_OVERRIDE).toBe(path.join(f.spec.profileRoot, "home-oc-task24-dd479"))
    expect(f.plan.env.DOCKER_HOST).toBe("")
    expect(Object.keys(f.plan.env).some((key) => /API_KEY|TOKEN|SECRET/.test(key))).toBe(false)
    expect(f.spec.wslConfig.path).toBe(path.join(f.spec.windowsProfile, ".wslconfig"))
    await revalidateDesktopProfile(result.value)
    await fs.appendFile(path.join(f.plan.paths.home, "AppData", "Roaming", "Docker", "settings-store.json"), " ")
    await expect(revalidateDesktopProfile(result.value)).rejects.toThrow()
    expect(f.calls.start).toBe(0)
  } finally {
    await f.close()
  }
})

test("parent exchange and foreign owner never publish", async () => {
  const f = await profileFixture()
  try {
    await fs.mkdir(f.spec.profileRoot)
    await fs.writeFile(path.join(f.spec.profileRoot, "owner.json"), "user-owned")
    const result = await prepareDesktopProfile({
      spec: f.spec,
      plan: f.plan,
      approval: await f.approve(),
      platform: f.platform,
    })
    expect(result.kind).toBe("blocked")
    expect(await fs.readFile(path.join(f.spec.profileRoot, "owner.json"), "utf8")).toBe("user-owned")
    expect(await fs.exists(path.join(f.spec.profileRoot, "manifest.json"))).toBe(false)
  } finally {
    await f.close()
  }
})

test("aliases, overlapping roots and bad windows paths cannot become profile plans", async () => {
  const f = await profileFixture()
  try {
    for (const root of ["C:\\cache", "D:\\tmp\\..\\profile", "D:\\PROFIL~1", "D:\\tmp:stream", f.spec.dataRoot])
      expect(() => decodeDesktopLaunchSpec({ ...f.spec, profileRoot: root })).toThrow()
    const alias = path.join(f.root, "alias")
    await fs.symlink(f.spec.dataRoot, alias, "junction")
    const changed = { ...f.spec, profileRoot: path.join(alias, "profile") }
    const report = await auditDesktopCompatibility(changed, f.platform)
    if (report.kind === "ready") {
      const plan = planDesktopProfile(changed, report.value)
      if (plan.kind === "ready") {
        const approval = await confirmDesktopApproval(
          {
            ...f.raw,
            planSha256: plan.value.planSha256,
            compatibilitySha256: plan.value.compatibilitySha256,
            expectedProfileRoot: changed.profileRoot,
          },
          async () => true,
        )
        expect(
          (await prepareDesktopProfile({ spec: changed, plan: plan.value, approval, platform: f.platform })).kind,
        ).toBe("blocked")
      }
    }
    expect(await fs.exists(path.join(f.spec.dataRoot, "profile"))).toBe(false)
  } finally {
    await f.close()
  }
})

test("expired, overlong and mismatched grants fail before writes; report clones have no provenance", async () => {
  const f = await profileFixture()
  try {
    for (const patch of [
      { expiresAt: Date.now() - 1 },
      { expiresAt: Date.now() + 900001 },
      { planSha256: sha256Text("other") },
    ]) {
      const raw = { ...f.raw, ...patch }
      const approval = await confirmDesktopApproval(raw, async () => true).catch(() => raw)
      expect((await prepareDesktopProfile({ spec: f.spec, plan: f.plan, approval, platform: f.platform })).kind).toBe(
        "blocked",
      )
    }
    expect(await fs.exists(f.spec.profileRoot)).toBe(false)
    const report = await auditDesktopCompatibility(f.spec, f.platform)
    if (report.kind !== "ready") throw Error("AUDIT")
    expect(planDesktopProfile(f.spec, { ...report.value }).kind).toBe("blocked")
  } finally {
    await f.close()
  }
})

test("exact prepared retry is read-only, while a replaced manifest or replayed journal is never repaired", async () => {
  const f = await profileFixture()
  try {
    const request = { spec: f.spec, plan: f.plan, approval: await f.approve(), platform: f.platform }
    const first = await prepareDesktopProfile(request)
    expect(first.kind).toBe("ready")
    const before = await fs.stat(path.join(f.spec.profileRoot, "manifest.json"))
    const second = await prepareDesktopProfile(request)
    expect(second.kind).toBe("ready")
    expect((await fs.stat(path.join(f.spec.profileRoot, "manifest.json"))).mtimeMs).toBe(before.mtimeMs)
    await fs.appendFile(path.join(f.spec.profileRoot, "manifest.json"), "corrupt")
    expect((await prepareDesktopProfile(request)).kind).toBe("blocked")
    expect((await fs.readFile(path.join(f.spec.profileRoot, "manifest.json"), "utf8")).endsWith("corrupt")).toBe(true)
  } finally {
    await f.close()
  }
})

test("a self-consistent rewritten manifest cannot authorize settings different from the audited plan", async () => {
  const f = await profileFixture()
  try {
    const result = await prepareDesktopProfile({
      spec: f.spec,
      plan: f.plan,
      approval: await f.approve(),
      platform: f.platform,
    })
    if (result.kind !== "ready") throw Error("PREPARE")
    const settings = path.join(f.plan.paths.home, "AppData", "Roaming", "Docker", "settings-store.json")
    const manifest = path.join(f.spec.profileRoot, "manifest.json")
    await fs.writeFile(settings, canonicalJson({ ...f.plan.settings, CustomWslDistroDir: "C:\\foreign-data" }))
    const body = JSON.parse(await fs.readFile(manifest, "utf8"))
    body.files = await Promise.all(
      body.files.map(async (file: { path: string }) => (file.path === settings ? fileIdentity(settings) : file)),
    )
    await fs.writeFile(manifest, canonicalJson(body))
    await expect(loadDesktopPreparedProfile(f.plan)).rejects.toThrow("SETTINGS")
    expect(f.calls.start).toBe(0)
  } finally {
    await f.close()
  }
})
