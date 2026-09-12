import { afterEach, describe, expect, test } from "bun:test"
import { Scheduler } from "../../src/run/scheduler"
import { plannedRuns, storeFixture } from "./fixture"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

describe("Task24 scheduler leases and cancellation", () => {
  test("allows only one scheduler to claim the next sealed run", async () => {
    const fixture = await storeFixture("claim")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 2,
      runs: plannedRuns,
    })
    const first = new Scheduler({ store: fixture.store, ownerID: "owner-a", leaseMs: 100, now: () => 1_000 })
    const second = new Scheduler({ store: fixture.store, ownerID: "owner-b", leaseMs: 100, now: () => 1_000 })
    const claimed = await Promise.all([first.claimNext("campaign-a"), second.claimNext("campaign-a")])
    expect(claimed.filter((run) => run?.runID === "run-a")).toHaveLength(1)
    expect(claimed.filter(Boolean)).toHaveLength(2)
    fixture.store.close()
  })

  test("enforces a sealed campaign concurrency ceiling across scheduler owners", async () => {
    const fixture = await storeFixture("concurrency-one")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "pilot",
      maxConcurrency: 1,
      runs: plannedRuns,
    })
    const first = new Scheduler({ store: fixture.store, ownerID: "owner-a", leaseMs: 100, now: () => 1_000 })
    const second = new Scheduler({ store: fixture.store, ownerID: "owner-b", leaseMs: 100, now: () => 1_000 })

    const claimed = await Promise.all([first.claimNext("campaign-a"), second.claimNext("campaign-a")])

    expect(claimed.filter(Boolean)).toHaveLength(1)
    fixture.store.close()
  })

  test("blocks new claims until an expired lease has been inspected by recovery", async () => {
    const fixture = await storeFixture("expired-before-claim")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "pilot",
      maxConcurrency: 1,
      runs: plannedRuns,
    })
    const first = new Scheduler({ store: fixture.store, ownerID: "owner-a", leaseMs: 50, now: () => 100 })
    const afterExpiry = new Scheduler({ store: fixture.store, ownerID: "owner-b", leaseMs: 50, now: () => 151 })
    expect((await first.claimNext("campaign-a"))?.runID).toBe("run-a")

    expect(await afterExpiry.claimNext("campaign-a")).toBeUndefined()
    fixture.store.close()
  })

  test("never dispatches a run after a durable cancellation request", async () => {
    const fixture = await storeFixture("cancel-before-claim")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 1,
      runs: plannedRuns,
    })
    fixture.store.requestCancellation("run-a", 99)
    const scheduler = new Scheduler({ store: fixture.store, ownerID: "owner-a", leaseMs: 50, now: () => 100 })

    expect((await scheduler.claimNext("campaign-a"))?.runID).toBe("run-b")
    fixture.store.close()
  })

  test("cancels through canceling, terminates once, and releases the lease", async () => {
    const fixture = await storeFixture("cancel")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 1,
      runs: plannedRuns.slice(0, 1),
    })
    for (const state of ["materializing", "ready", "reserved", "running"] as const) {
      fixture.store.transition("run-a", state, new Date().toISOString())
    }
    fixture.store.acquireLease("run-a", "owner-a", 1_000, 100)
    let calls = 0
    const scheduler = new Scheduler({ store: fixture.store, ownerID: "owner-a", leaseMs: 100, now: () => 1_001 })
    await scheduler.cancel("run-a", async () => {
      calls++
    })
    expect(calls).toBe(1)
    expect(fixture.store.getRun("run-a")?.state).toBe("canceled")
    expect(fixture.store.lease("run-a")).toBeUndefined()
    fixture.store.close()
  })

  test("keeps the canceling lease when provider settlement fails so recovery owns the run", async () => {
    const fixture = await storeFixture("cancel-failure")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 1,
      runs: plannedRuns.slice(0, 1),
    })
    for (const state of ["materializing", "ready", "reserved", "running"] as const) {
      fixture.store.transition("run-a", state, new Date().toISOString())
    }
    fixture.store.acquireLease("run-a", "owner-a", 1_000, 100)
    const scheduler = new Scheduler({ store: fixture.store, ownerID: "owner-a", leaseMs: 100, now: () => 1_001 })

    await expect(
      scheduler.cancel("run-a", async () => Promise.reject(new Error("settlement unavailable"))),
    ).rejects.toThrow("settlement unavailable")

    expect(fixture.store.getRun("run-a")?.state).toBe("canceling")
    expect(fixture.store.lease("run-a")?.ownerID).toBe("owner-a")
    fixture.store.close()
  })
})
