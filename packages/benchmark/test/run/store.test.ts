import { afterEach, describe, expect, test } from "bun:test"
import { storeFixture, plannedRuns } from "./fixture"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

describe("Task24 durable run store", () => {
  test("persists exactly-once admission and monotonic state events across restart", async () => {
    const fixture = await storeFixture("restart")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 1,
      runs: plannedRuns,
    })
    fixture.store.transition("run-a", "materializing", "2026-09-12T12:00:00.000Z")
    fixture.store.close()

    const reopened = (await import("../../src/run/store")).RunStore.open(fixture.database)
    expect(reopened.getRun("run-a")?.state).toBe("materializing")
    reopened.transition("run-a", "ready", "2026-09-12T12:01:00.000Z")
    expect(reopened.events("run-a").map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(() =>
      reopened.planCampaign({
        campaignID: "campaign-a",
        campaignSha256: "b".repeat(64),
        stage: "offline",
        maxConcurrency: 1,
        runs: plannedRuns,
      }),
    ).toThrow(/campaign|seal|conflict/i)
    reopened.close()
  })

  test("enforces one active attempt and one lease owner", async () => {
    const fixture = await storeFixture("attempt")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 1,
      runs: plannedRuns,
    })
    expect(fixture.store.acquireLease("run-a", "owner-a", 100, 50)).toBe(true)
    expect(fixture.store.acquireLease("run-a", "owner-b", 120, 50)).toBe(false)
    expect(fixture.store.acquireLease("run-a", "owner-b", 151, 50)).toBe(true)
    for (const state of ["materializing", "ready", "reserved"] as const) {
      fixture.store.transition("run-a", state, new Date().toISOString())
    }
    fixture.store.beginAttempt("run-a", "attempt-a", 151)
    expect(() => fixture.store.beginAttempt("run-a", "attempt-b", 152)).toThrow(/attempt|active/i)
    fixture.store.finishAttempt("attempt-a", "completed", 200)
    expect(() => fixture.store.beginAttempt("run-a", "attempt-b", 201)).not.toThrow()
    fixture.store.close()
  })

  test("cannot complete without immutable evaluation evidence", async () => {
    const fixture = await storeFixture("evaluation")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 1,
      runs: plannedRuns.slice(0, 1),
    })
    for (const state of ["materializing", "ready", "reserved", "running", "evaluating"] as const) {
      fixture.store.transition("run-a", state, new Date().toISOString())
    }
    expect(() => fixture.store.transition("run-a", "completed", new Date().toISOString())).toThrow(/evaluation/i)
    fixture.store.recordEvaluation("run-a", "b".repeat(64), "c".repeat(64), 1_000)
    expect(fixture.store.transition("run-a", "completed", new Date().toISOString()).state).toBe("completed")
    expect(() => fixture.store.recordEvaluation("run-a", "b".repeat(64), "c".repeat(64), 1_001)).toThrow()
    fixture.store.close()
  })
})
