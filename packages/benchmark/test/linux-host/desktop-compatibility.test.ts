import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import { desktopFixture } from "./desktop-fixture"
import { auditDesktopCompatibility, decodeDesktopLaunchSpec } from "../../src/sandbox/desktop/compatibility"
import { makeWindowsDesktopPlatform } from "../../src/sandbox/desktop/platform"

test("unknown propagation or registration blocks native start", async () => {
  const f = await desktopFixture()
  try {
    f.checks[1]!.conclusion = "unproved"
    const result = await auditDesktopCompatibility(f.spec, f.platform)
    expect(result.kind).toBe("blocked")
    expect(result.kind === "blocked" && result.missing).toContain("backend_environment_unproved")
    expect(f.calls.start).toBe(0)
  } finally {
    await f.close()
  }
})

test("complete synthetic evidence stays fixture, while unknown versions and registrations fail closed", async () => {
  const f = await desktopFixture()
  try {
    const result = await auditDesktopCompatibility(f.spec, f.platform)
    expect(result.kind).toBe("ready")
    expect(result.kind === "ready" && result.value.assurance).toBe("fixture")
    for (const patch of [
      { version: "4.80.0" },
      { settingsVersion: 45 },
      { cliVersion: "29.6.0" },
      { registration: { ...f.spec.registration, distributionName: "another-engine" } },
    ]) {
      expect((await auditDesktopCompatibility({ ...f.spec, ...patch }, f.platform)).kind).toBe("blocked")
    }
    expect(() => decodeDesktopLaunchSpec({ ...f.spec, extra: "ignored?" })).toThrow()
    expect(f.calls.start).toBe(0)
  } finally {
    await f.close()
  }
})

test("changed install bytes and forged native provenance never authorize a launch", async () => {
  const f = await desktopFixture()
  try {
    const forged = {
      ...f.platform,
      audit: async () => ({ ...(await f.platform.audit(f.spec)), assurance: "native-static" as const }),
    }
    const report = await auditDesktopCompatibility(f.spec, forged)
    expect(report.kind === "ready" && report.value.assurance).toBe("fixture")
    await fs.appendFile(f.spec.install.asar.path, "X")
    expect((await auditDesktopCompatibility(f.spec, forged)).kind).toBe("blocked")
    expect(f.calls.start).toBe(0)
    await expect(makeWindowsDesktopPlatform().start({} as never)).rejects.toThrow("UNPROVED")
  } finally {
    await f.close()
  }
})

test("every missing path, stop and CLI rule blocks, and duplicate evidence cannot stand in for coverage", async () => {
  const f = await desktopFixture()
  try {
    for (const check of f.checks) {
      check.conclusion = "unproved"
      expect((await auditDesktopCompatibility(f.spec, f.platform)).kind).toBe("blocked")
      check.conclusion = "proved"
    }
    f.checks[4] = f.checks[0]!
    expect((await auditDesktopCompatibility(f.spec, f.platform)).kind).toBe("blocked")
  } finally {
    await f.close()
  }
})
