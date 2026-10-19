import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { runtimeFixtureV2 } from "./desktop-v2-runtime-fixture"
import { withDesktopRuntimeSettings, type DesktopSettingsSeal } from "../../src/sandbox/desktop/settings-runtime"
import { stopDesktopLaunch } from "../../src/sandbox/desktop/launch"
import { decodeDesktopStorageObservationV2, inspectDesktopLaunch } from "../../src/sandbox/desktop/inspection"
import { publishDesktopLaunchRecordV2, readDesktopLaunchRecord } from "../../src/sandbox/desktop/inventory"

test("v2 storage requires a current opaque lease and exact runtime/physical chain", async () => {
  const f = await runtimeFixtureV2()
  try {
    const raw = await f.storageSnapshot()
    let expired!: DesktopSettingsSeal
    await withDesktopRuntimeSettings(f.session, async (seal) => {
      expired = seal
      const context = { spec: f.spec, profile: f.profile, session: f.session, seal }
      const proof = decodeDesktopStorageObservationV2(raw, context)
      expect(proof.disk).toEqual(f.spec.disks.data)
      expect(proof.settingsSha256).not.toBe(f.plan.seedSha256)
      for (const patch of [
        { runtimeSealSha256: f.plan.seedSha256 },
        { sequence: 2 },
        { schemaVersion: 1 },
        { intentSha256: "0".repeat(64) },
        { registration: { ...raw.registration, fileID: "changed" } },
        { dataDisk: { ...raw.dataDisk, fileID: "changed" } },
        { binding: { ...raw.binding, guestFilesystemUUID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } },
        { binding: { ...raw.binding, daemonServerID: "foreign" } },
        { binding: { ...raw.binding, settings: { ...raw.binding.settings, AutoStart: true } } },
        { swapsText: "Filename Type Size Used Priority\n/swap file 10 0 -2\n" },
      ])
        expect(() => decodeDesktopStorageObservationV2({ ...raw, ...patch }, context)).toThrow()
      expect(() => decodeDesktopStorageObservationV2(raw, { ...context, seal: { ...seal } })).toThrow()
      expect(() => decodeDesktopStorageObservationV2(raw, { ...context, session: { ...f.session } })).toThrow()
    })
    expect(() =>
      decodeDesktopStorageObservationV2(raw, { spec: f.spec, profile: f.profile, session: f.session, seal: expired }),
    ).toThrow()
    f.setObservation({ ...f.readObservation(), storage: raw })
    const inventory = await inspectDesktopLaunch(f.session)
    expect(inventory.status).toBe("inventory_observed_not_accepted")
    expect([inventory.engine_verified, inventory.tool_capability_verified, inventory.corpus_engine_ready]).toEqual([
      false,
      false,
      false,
    ])
    f.setObservation({ ...f.readObservation(), productionDefaultEndpoint: "npipe:////./pipe/other" })
    expect((await inspectDesktopLaunch(f.session)).missing).toContain("production_default_endpoint_mismatch")
  } finally {
    await stopDesktopLaunch(f.session)
    await f.close()
  }
}, 30000)

test("v2 observation never runs without the complete group lease and cannot silently reseal", async () => {
  const f = await runtimeFixtureV2()
  const observe = f.platform.observe
  try {
    const raw = await f.storageSnapshot()
    f.setObservation({ ...f.readObservation(), storage: raw })
    let calls = 0
    f.platform.observe = async (spec, signal) => {
      calls++
      await expect(fs.appendFile(f.plan.runtimeTargets.daemon, " ")).rejects.toThrow()
      return observe(spec, signal)
    }
    const holder = await f.holdTarget("windows-daemon")
    try {
      await expect(inspectDesktopLaunch(f.session)).rejects.toThrow()
      expect(calls).toBe(0)
    } finally {
      await holder.release()
    }
    // A failed lease is terminal for this session; it cannot silently reseal and resume use.
    await expect(inspectDesktopLaunch(f.session)).rejects.toThrow()
    expect(calls).toBe(0)
  } finally {
    f.platform.observe = observe
    await stopDesktopLaunch(f.session)
    await f.close()
  }
}, 30000)

test("v2 diagnostic publication is bounded history, not a session or stop capability", async () => {
  const f = await runtimeFixtureV2()
  try {
    const raw = await f.storageSnapshot()
    f.setObservation({ ...f.readObservation(), storage: raw })
    const inventory = await inspectDesktopLaunch(f.session)
    const cleanup = await stopDesktopLaunch(f.session)
    expect(cleanup.kind).toBe("ready")
    const record = {
      schemaVersion: 2 as const,
      launchID: f.session.launchID,
      specSha256: f.plan.specSha256,
      planSha256: f.plan.planSha256,
      compatibilitySha256: f.plan.compatibilitySha256,
      manifestSha256: f.profile.manifestSha256,
      intentSha256: f.plan.intentSha256,
      policySha256: f.plan.policySha256,
      status: "inventory_observed_not_accepted" as const,
      code: "inventory_observed_not_accepted",
      missing: [],
      inventory,
      cleanup: "stopped" as const,
      engine_verified: false as const,
      tool_capability_verified: false as const,
      corpus_engine_ready: false as const,
    }
    const file = await publishDesktopLaunchRecordV2({ profile: f.profile, approval: f.approval, record })
    expect(file.fileID.startsWith("v2:")).toBe(true)
    const saved = await readDesktopLaunchRecord(f.platform, f.session.launchID)
    expect(saved?.live).toBe(false)
    expect(saved?.record.schemaVersion).toBe(2)
    await expect(withDesktopRuntimeSettings({ ...f.session }, async () => "bad")).rejects.toThrow()
    await expect(
      publishDesktopLaunchRecordV2({ profile: f.profile, approval: { ...f.approval }, record }),
    ).rejects.toThrow()
  } finally {
    await stopDesktopLaunch(f.session)
    await f.close()
  }
}, 30000)
