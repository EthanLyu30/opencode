// Isolated transport barriers around REAL issued resources; no native provenance or clock is injected.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { mock } from "bun:test"
import { profileFixtureV2 } from "./desktop-v2-profile-fixture"
const mode = process.argv.at(-1)!
assert(["active", "bootstrap", "workload-expiry"].includes(mode))
const f = await profileFixtureV2()
try {
  if (mode === "workload-expiry") {
    const { auditDesktopWorkloadBoundary, withDesktopWorkloadFact } = await import(
      "../../src/sandbox/desktop/workload-boundary"
    )
    const fact = await auditDesktopWorkloadBoundary(f.spec, f.platform)
    assert.equal(fact.kind, "ready")
    if (fact.kind !== "ready") throw Error("FACT")
    const timeout = AbortSignal.timeout,
      oldBudget = new AbortController()
    let independentDeadlines = 0
    // Observe the old helper-only budget in this child, not the caller's unchanged start deadline.
    AbortSignal.timeout = (milliseconds: number) => {
      if (milliseconds === 120000) {
        independentDeadlines++
        return oldBudget.signal
      }
      return timeout(milliseconds)
    }
    try {
      await withDesktopWorkloadFact(fact.value, f.spec, f.platform, async () => {
        oldBudget.abort()
        assert.equal(independentDeadlines, 0, "protection must not have an independent expiry")
        await assert.rejects(fs.appendFile(f.spec.disks.data.path, " "))
      })
    } finally {
      AbortSignal.timeout = timeout
    }
  } else {
    const profileAPI = await import("../../src/sandbox/desktop/profile-v2")
    const runtimeAPI = await import("../../src/sandbox/desktop/settings-runtime")
    let entered!: () => void, release!: () => void, resource: unknown
    const reached = new Promise<void>((yes) => {
        entered = yes
      }),
      gate = new Promise<void>((yes) => {
        release = yes
      })
    if (mode === "active") {
      const actual = profileAPI.writeDesktopActiveLockV2
      mock.module("../../src/sandbox/desktop/profile-v2", () => ({
        ...profileAPI,
        writeDesktopActiveLockV2: async (...args: Parameters<typeof actual>) => {
          resource = await actual(...args)
          entered()
          await gate
          return resource
        },
      }))
    } else {
      const actual = runtimeAPI.beginDesktopSettingsRuntime
      mock.module("../../src/sandbox/desktop/settings-runtime", () => ({
        ...runtimeAPI,
        beginDesktopSettingsRuntime: async (...args: Parameters<typeof actual>) => {
          resource = await actual(...args)
          entered()
          await gate
          return resource
        },
      }))
    }
    const { startDesktopReadonly } = await import("../../src/sandbox/desktop/launch")
    const { confirmDesktopApprovalV2 } = await import("../../src/sandbox/desktop/approval-v2")
    const profile = await f.prepareV2(),
      approval = await confirmDesktopApprovalV2(f.startRaw(profile.manifestSha256), async () => true),
      cancel = new AbortController()
    let operation: Promise<unknown> | undefined
    try {
      operation = startDesktopReadonly({ spec: f.spec, profile, approval, platform: f.platform, signal: cancel.signal })
      await reached
      cancel.abort()
      release()
      await operation
      assert.equal(f.calls.start, 0)
      assert.equal(
        await fs.exists(profile.plan.paths.root + "\\state\\active.json"),
        false,
        "late owned active lock must be removed",
      )
      const moved = profile.plan.paths.root + ".moved"
      await fs.rename(profile.plan.paths.root, moved)
      await fs.rename(moved, profile.plan.paths.root)
    } finally {
      release()
      await operation
      if (mode === "bootstrap" && resource)
        await runtimeAPI.finishDesktopSettingsRuntime(
          resource as Parameters<typeof runtimeAPI.finishDesktopSettingsRuntime>[0],
        )
    }
  }
} finally {
  await f.close()
}
process.stdout.write(JSON.stringify({ mode, status: "fixture_verified" }))
