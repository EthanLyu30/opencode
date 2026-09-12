import { afterEach, describe, expect, test } from "bun:test"
import { recoverExpiredRuns } from "../../src/run/lease"
import { RunStore } from "../../src/run/store"
import { plannedRuns, storeFixture } from "./fixture"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

describe("Task24 crash recovery", () => {
  test.each(["running", "evaluating"] as const)("recovers an expired %s lease without redispatch", async (state) => {
    const fixture = await storeFixture(`recovery-${state}`)
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 1,
      runs: plannedRuns.slice(0, 1),
    })
    const path = [
      "materializing",
      "ready",
      "reserved",
      "running",
      ...(state === "evaluating" ? ["evaluating"] : []),
    ] as const
    for (const next of path) {
      fixture.store.transition("run-a", next, new Date().toISOString())
      if (next === "running") fixture.store.beginAttempt("run-a", "attempt-old", 100)
    }
    fixture.store.acquireLease("run-a", "dead-owner", 100, 50)

    const result = await recoverExpiredRuns({
      store: fixture.store,
      now: 151,
      inspect: async () => ({
        processAlive: false,
        providerDisposition: "settled",
        workflowDisposition: "recoverable",
        workspaceIntact: true,
        evaluationComplete: false,
      }),
    })
    expect(result).toEqual([{ runID: "run-a", outcome: "resumable" }])
    expect(fixture.store.getRun("run-a")?.state).toBe("resumable")
    expect(() => fixture.store.beginAttempt("run-a", "attempt-resumed", 152)).not.toThrow()
    fixture.store.close()
  })

  test("requires adjudication for an unknown paid-call disposition", async () => {
    const fixture = await storeFixture("unknown-paid")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 1,
      runs: plannedRuns.slice(0, 1),
    })
    for (const next of ["materializing", "ready", "reserved", "running"] as const) {
      fixture.store.transition("run-a", next, new Date().toISOString())
    }
    fixture.store.beginAttempt("run-a", "attempt-old", 100)
    fixture.store.acquireLease("run-a", "dead-owner", 100, 50)
    const result = await recoverExpiredRuns({
      store: fixture.store,
      now: 151,
      inspect: async () => ({
        processAlive: false,
        providerDisposition: "unknown",
        workflowDisposition: "not_applicable",
        workspaceIntact: true,
        evaluationComplete: false,
      }),
    })
    expect(result).toEqual([{ runID: "run-a", outcome: "adjudication_required" }])
    expect(fixture.store.getRun("run-a")?.state).toBe("failed")
    expect(fixture.store.adjudications("run-a")).toHaveLength(1)
    expect(() => fixture.store.beginAttempt("run-a", "attempt-audit", 152)).toThrow(/state/i)
    fixture.store.close()
  })

  test("finishes a crashed cancellation only after the provider ledger is settled", async () => {
    const fixture = await storeFixture("cancel-recovery")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 1,
      runs: plannedRuns.slice(0, 1),
    })
    for (const next of ["materializing", "ready", "reserved", "running"] as const) {
      fixture.store.transition("run-a", next, new Date().toISOString())
    }
    fixture.store.beginAttempt("run-a", "attempt-old", 100)
    fixture.store.requestCancellation("run-a", 101)
    fixture.store.transition("run-a", "canceling", new Date().toISOString())
    fixture.store.acquireLease("run-a", "dead-owner", 100, 50)

    const result = await recoverExpiredRuns({
      store: fixture.store,
      now: 151,
      inspect: async () => ({
        processAlive: false,
        providerDisposition: "settled",
        workflowDisposition: "recoverable",
        workspaceIntact: true,
        evaluationComplete: false,
      }),
    })

    expect(result).toEqual([{ runID: "run-a", outcome: "canceled" }])
    expect(fixture.store.getRun("run-a")?.state).toBe("canceled")
    expect(fixture.store.cancellationRequested("run-a")).toBe(false)
    expect(fixture.store.lease("run-a")).toBeUndefined()
    fixture.store.close()
  })

  test("completes recovered evaluation only when immutable evaluation evidence already exists", async () => {
    const fixture = await storeFixture("evaluation-recovery")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 1,
      runs: plannedRuns.slice(0, 1),
    })
    for (const next of ["materializing", "ready", "reserved", "running"] as const) {
      fixture.store.transition("run-a", next, new Date().toISOString())
    }
    fixture.store.beginAttempt("run-a", "attempt-old", 100)
    fixture.store.transition("run-a", "evaluating", new Date().toISOString())
    fixture.store.recordEvaluation("run-a", "b".repeat(64), "c".repeat(64), 120)
    fixture.store.acquireLease("run-a", "dead-owner", 100, 50)

    const result = await recoverExpiredRuns({
      store: fixture.store,
      now: 151,
      inspect: async () => ({
        processAlive: false,
        providerDisposition: "settled",
        workflowDisposition: "completed",
        workspaceIntact: true,
        evaluationComplete: true,
      }),
    })

    expect(result).toEqual([{ runID: "run-a", outcome: "completed" }])
    expect(fixture.store.getRun("run-a")?.state).toBe("completed")
    expect(fixture.store.lease("run-a")).toBeUndefined()
    fixture.store.close()
  })

  test("does not hide an unknown paid settlement behind completed evaluation evidence", async () => {
    const fixture = await storeFixture("evaluation-unknown-paid")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "pilot",
      maxConcurrency: 1,
      runs: plannedRuns.slice(0, 1),
    })
    for (const next of ["materializing", "ready", "reserved", "running"] as const) {
      fixture.store.transition("run-a", next, new Date().toISOString())
    }
    fixture.store.beginAttempt("run-a", "attempt-old", 100)
    fixture.store.transition("run-a", "evaluating", new Date().toISOString())
    fixture.store.recordEvaluation("run-a", "b".repeat(64), "c".repeat(64), 120)
    fixture.store.acquireLease("run-a", "dead-owner", 100, 50)

    const result = await recoverExpiredRuns({
      store: fixture.store,
      now: 151,
      inspect: async () => ({
        processAlive: false,
        providerDisposition: "unknown",
        workflowDisposition: "completed",
        workspaceIntact: true,
        evaluationComplete: true,
      }),
    })

    expect(result).toEqual([{ runID: "run-a", outcome: "adjudication_required" }])
    expect(fixture.store.getRun("run-a")?.state).toBe("failed")
    fixture.store.close()
  })

  test("requires adjudication when product Workflow status cannot be reconstructed", async () => {
    const fixture = await storeFixture("unknown-workflow")
    cleanup.push(() => fixture.dispose())
    fixture.store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 1,
      runs: plannedRuns.slice(0, 1),
    })
    for (const next of ["materializing", "ready", "reserved", "running"] as const) {
      fixture.store.transition("run-a", next, new Date().toISOString())
    }
    fixture.store.beginAttempt("run-a", "attempt-old", 100)
    fixture.store.acquireLease("run-a", "dead-owner", 100, 50)

    const result = await recoverExpiredRuns({
      store: fixture.store,
      now: 151,
      inspect: async () => ({
        processAlive: false,
        providerDisposition: "settled",
        workflowDisposition: "unknown",
        workspaceIntact: true,
        evaluationComplete: false,
      }),
    })

    expect(result).toEqual([{ runID: "run-a", outcome: "adjudication_required" }])
    expect(fixture.store.getRun("run-a")?.state).toBe("failed")
    expect(fixture.store.adjudications("run-a")[0]?.reason).toBe("workflow_disposition_unknown")
    fixture.store.close()
  })

  test("reopens cleanly at every success boundary without duplicating admission or events", async () => {
    const fixture = await storeFixture("all-boundaries")
    cleanup.push(() => fixture.dispose())
    let store = fixture.store
    store.planCampaign({
      campaignID: "campaign-a",
      campaignSha256: "a".repeat(64),
      stage: "offline",
      maxConcurrency: 1,
      runs: plannedRuns.slice(0, 1),
    })
    for (const next of ["materializing", "ready", "reserved", "running", "evaluating"] as const) {
      store.close()
      store = RunStore.open(fixture.database)
      store.transition("run-a", next, new Date().toISOString())
    }
    store.recordEvaluation("run-a", "b".repeat(64), "c".repeat(64), 1_000)
    store.close()
    store = RunStore.open(fixture.database)
    store.transition("run-a", "completed", new Date().toISOString())
    expect(store.events("run-a").map((event) => event.to)).toEqual([
      "planned",
      "materializing",
      "ready",
      "reserved",
      "running",
      "evaluating",
      "completed",
    ])
    expect(store.listRuns("campaign-a")).toHaveLength(1)
    store.close()
  })
})
