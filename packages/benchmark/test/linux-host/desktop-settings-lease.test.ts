import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { profileFixtureV2 } from "./desktop-v2-profile-fixture"

const api = await import("../../src/sandbox/desktop/settings-lease").catch(() => undefined)

test("partial acquisition cannot splice snapshots and releases held files", async () => {
  expect(api).toBeDefined()
  const f = await profileFixtureV2()
  try {
    const p = await f.prepareV2()
    await f.emitRuntime()
    let used = 0
    await api!.withDesktopSettingsParents(
      p,
      async (parents) => {
        for (const target of ["windows-daemon", "settings-store"] as const) {
          const held = await f.holdTarget(target)
          try {
            await expect(
              api!.withDesktopSettingsLease(
                parents,
                async () => {
                  used++
                },
                AbortSignal.timeout(5000),
              ),
            ).rejects.toThrow()
            expect(used).toBe(0)
            await fs.appendFile(p.runtimeTargets.daemon, " ")
          } finally {
            await held.release()
          }
        }
        await api!.withDesktopSettingsLease(
          parents,
          async () => {
            used++
          },
          AbortSignal.timeout(5000),
        )
        expect(used).toBe(1)
      },
      AbortSignal.timeout(15000),
    )
  } finally {
    await f.close()
  }
})

test("v2 group lease fixes all three files during use and releases targets between uses", async () => {
  expect(api).toBeDefined()
  const f = await profileFixtureV2()
  try {
    const p = await f.prepareV2()
    await f.emitRuntime()
    await api!.withDesktopSettingsParents(
      p,
      async (parents) => {
        await api!.withDesktopSettingsLease(
          parents,
          async (lease) => {
            expect(lease.files).toHaveLength(3)
            expect(lease.temporary).toHaveLength(0)
            for (const file of lease.files) await expect(fs.writeFile(file.identity.path, "bad")).rejects.toThrow()
            await expect(fs.rename(f.plan.paths.home, f.plan.paths.home + ".moved")).rejects.toThrow()
          },
          AbortSignal.timeout(5000),
        )
        const file = p.runtimeTargets["settings-store"]
        await fs.rename(file, file + ".old")
        await fs.writeFile(file, JSON.stringify(f.payload("settings-store")))
        await fs.unlink(file + ".old")
        await api!.withDesktopSettingsLease(
          parents,
          async (lease) => {
            expect(lease.files).toHaveLength(3)
          },
          AbortSignal.timeout(5000),
        )
      },
      AbortSignal.timeout(10000),
    )
  } finally {
    await f.close()
  }
})

test("v2 lease never calls use with an incomplete or invalid set and frees files after exceptions", async () => {
  expect(api).toBeDefined()
  const f = await profileFixtureV2()
  try {
    const p = await f.prepareV2()
    await f.emitRuntime()
    let uses = 0
    await api!.withDesktopSettingsParents(
      p,
      async (parents) => {
        const file = p.runtimeTargets.daemon
        await fs.unlink(file)
        await expect(
          api!.withDesktopSettingsLease(
            parents,
            async () => {
              uses++
            },
            AbortSignal.timeout(5000),
          ),
        ).rejects.toThrow()
        expect(uses).toBe(0)
        await fs.writeFile(file, JSON.stringify(f.payload("daemon")))
        await expect(
          api!.withDesktopSettingsLease(
            parents,
            async () => {
              throw Error("USE_FAILURE")
            },
            AbortSignal.timeout(5000),
          ),
        ).rejects.toThrow("USE_FAILURE")
        await fs.appendFile(file, " ")
        await fs.writeFile(path.join(path.dirname(file), "unknown.tmp"), "{}")
        await expect(
          api!.withDesktopSettingsLease(
            parents,
            async () => {
              uses++
            },
            AbortSignal.timeout(5000),
          ),
        ).rejects.toThrow()
        expect(uses).toBe(0)
      },
      AbortSignal.timeout(10000),
    )
  } finally {
    await f.close()
  }
})

test("v2 settings parents and completed leases cannot be cloned or replayed", async () => {
  expect(api).toBeDefined()
  const f = await profileFixtureV2()
  try {
    const p = await f.prepareV2()
    await f.emitRuntime()
    let escaped: unknown
    await expect(
      api!.withDesktopSettingsParents({ ...p }, async () => {}, AbortSignal.timeout(10000)),
    ).rejects.toThrow()
    await api!.withDesktopSettingsParents(
      p,
      async (parents) => {
        await expect(
          api!.withDesktopSettingsLease({ ...parents }, async () => {}, AbortSignal.timeout(5000)),
        ).rejects.toThrow()
        await api!.withDesktopSettingsLease(
          parents,
          async (lease) => {
            escaped = lease
            expect(api!.requireDesktopSettingsLease(lease).files).toHaveLength(3)
          },
          AbortSignal.timeout(5000),
        )
        expect(() =>
          api!.requireDesktopSettingsLease(
            escaped as Parameters<NonNullable<typeof api>["requireDesktopSettingsLease"]>[0],
          ),
        ).toThrow()
      },
      AbortSignal.timeout(10000),
    )
  } finally {
    await f.close()
  }
})
