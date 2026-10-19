import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { desktopV2Fixture } from "./desktop-v2-fixture"
import { canonicalJson } from "../../src/campaign/canonical"
import { makeWindowsDesktopPlatform } from "../../src/sandbox/desktop/platform"
import { auditDesktopCompatibility } from "../../src/sandbox/desktop/compatibility"

const api = await import("../../src/sandbox/desktop/workload-boundary").catch(() => undefined)

test("v2 compatibility report binds real fixture policy and workload provenance", async () => {
  const f = await desktopV2Fixture()
  try {
    await f.seedEmptyWorkload()
    const { requireDesktopReportV2 } = await import("../../src/sandbox/desktop/compatibility-v2")
    const gate = await auditDesktopCompatibility(f.spec, f.platform)
    expect(gate.kind).toBe("ready")
    if (gate.kind !== "ready") throw Error(gate.code)
    expect(requireDesktopReportV2(f.spec, gate.value).platform).toBe(f.platform)
    expect(() => requireDesktopReportV2(f.spec, { ...gate.value })).toThrow()
  } finally {
    await f.close()
  }
})

test("native workload proof is missing even with human claims and fixture JSON", async () => {
  expect(api).toBeDefined()
  const f = await desktopV2Fixture()
  try {
    await f.seedEmptyWorkload()
    const native = makeWindowsDesktopPlatform()
    const result = await api!.auditDesktopWorkloadBoundary(f.spec, native)
    expect(result).toMatchObject({
      kind: "blocked",
      missing: expect.arrayContaining(["existing_workload_restart_unproved"]),
    })
    const gate = await auditDesktopCompatibility(f.spec, native)
    expect(gate).toMatchObject({
      kind: "blocked",
      missing: expect.arrayContaining(["existing_workload_restart_unproved", "settings_mutation_unproved"]),
    })
    expect(f.calls.start).toBe(0)
  } finally {
    await f.close()
  }
})

test("workload fact needs all empty scopes and private current provenance", async () => {
  expect(api).toBeDefined()
  const f = await desktopV2Fixture()
  try {
    expect((await api!.auditDesktopWorkloadBoundary(f.spec, f.platform)).kind).toBe("blocked")
    const base = {
      schemaVersion: 1,
      fixtureKind: "task24-workload-state",
      scopes: { containers: [], swarm: [], kubernetes: [] },
    }
    for (const scope of ["containers", "swarm", "kubernetes"] as const) {
      const { [scope]: omitted, ...rest } = base.scopes
      for (const bad of [
        { ...base, scopes: rest },
        { ...base, scopes: { ...base.scopes, [scope]: ["existing"] } },
        { ...base, acceptedRisk: true },
      ]) {
        await fs.writeFile(f.spec.disks.data.path, canonicalJson(bad))
        expect((await api!.auditDesktopWorkloadBoundary(f.spec, f.platform)).kind).toBe("blocked")
      }
    }
    await f.seedEmptyWorkload()
    const gate = await api!.auditDesktopWorkloadBoundary(f.spec, f.platform)
    expect(gate.kind).toBe("ready")
    if (gate.kind !== "ready") throw Error(gate.code)
    await expect(api!.requireDesktopWorkloadFact({ ...gate.value }, f.spec, f.platform)).rejects.toThrow()
    await expect(api!.requireDesktopWorkloadFact(gate.value, f.spec, makeWindowsDesktopPlatform())).rejects.toThrow()
    expect(
      await api!.withDesktopWorkloadFact(gate.value, f.spec, f.platform, async () => {
        await expect(fs.writeFile(f.spec.disks.data.path, "would alter state")).rejects.toThrow()
        return "protected"
      }),
    ).toBe("protected")
    await fs.appendFile(f.spec.disks.data.path, " ")
    await expect(api!.requireDesktopWorkloadFact(gate.value, f.spec, f.platform)).rejects.toThrow()
  } finally {
    await f.close()
  }
})

test("same fileID size and mtime cannot hide changed workload content", async () => {
  expect(api).toBeDefined()
  const f = await desktopV2Fixture()
  try {
    await f.seedEmptyWorkload()
    const initial = (await fs.readFile(f.spec.disks.data.path, "utf8")) + " ".repeat(128),
      time = new Date("2026-01-01T00:00:00.000Z")
    await fs.writeFile(f.spec.disks.data.path, initial)
    await fs.utimes(f.spec.disks.data.path, time, time)
    const before = await fs.stat(f.spec.disks.data.path, { bigint: true }),
      fact = await api!.auditDesktopWorkloadBoundary(f.spec, f.platform)
    if (fact.kind !== "ready") throw Error(fact.code)
    const changed = canonicalJson({
      schemaVersion: 1,
      fixtureKind: "task24-workload-state",
      scopes: { containers: ["existing"], swarm: [], kubernetes: [] },
    }).padEnd(initial.length, " ")
    await fs.writeFile(f.spec.disks.data.path, changed)
    await fs.utimes(f.spec.disks.data.path, time, time)
    const after = await fs.stat(f.spec.disks.data.path, { bigint: true })
    expect([after.ino, after.size, after.mtimeNs]).toEqual([before.ino, before.size, before.mtimeNs])
    await expect(api!.requireDesktopWorkloadFact(fact.value, f.spec, f.platform)).rejects.toThrow()
  } finally {
    await f.close()
  }
})
