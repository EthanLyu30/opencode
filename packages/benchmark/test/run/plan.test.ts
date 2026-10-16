import { describe, expect, test } from "bun:test"
import { planCampaignRuns, type CampaignPlanSource } from "../../src/run/plan"

const campaign: CampaignPlanSource = {
  id: "pilot-contract",
  preregistration: {
    primaryRepeats: 2,
    upstreamRepeats: 1,
    seed: "pilot-contract-seed",
    pilotTaskIDs: ["private-task", "design2code-task", "swe-task"],
  },
  tasks: ["private-task", "design2code-task", "swe-task", "other-task"].map((id) => ({ id })),
}

describe("Task24 stage run planning", () => {
  test("plans exactly one run per pilot task and arm, not full-campaign repetitions", () => {
    const runs = planCampaignRuns(campaign, "pilot")

    expect(runs).toHaveLength(15)
    expect(runs.every((run) => run.repetition === 0)).toBe(true)
    expect(new Set(runs.map((run) => run.runID)).size).toBe(15)
    for (const taskID of ["private-task", "design2code-task", "swe-task"]) {
      expect(
        runs
          .filter((run) => run.taskID === taskID)
          .map((run) => run.armID)
          .toSorted(),
      ).toEqual(["A", "B", "C", "D", "E"])
    }
    expect(runs.some((run) => run.taskID === "other-task")).toBe(false)
    expect(runs.map((run) => run.orderIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(planCampaignRuns(campaign, "pilot")).toEqual(runs)
  })

  test("does not repeat upstream pilot arms when the sealed campaign allows extra repetitions", () => {
    const runs = planCampaignRuns(
      {
        ...campaign,
        preregistration: { ...campaign.preregistration, primaryRepeats: 3, upstreamRepeats: 2 },
      },
      "pilot",
    )

    expect(runs).toHaveLength(15)
    expect(runs.every((run) => run.repetition === 0)).toBe(true)
  })

  test.each(["offline", "campaign"] as const)("preserves sealed repetitions for %s", (stage) => {
    const runs = planCampaignRuns(campaign, stage)

    expect(runs).toHaveLength(32)
    for (const taskID of ["private-task", "design2code-task", "swe-task", "other-task"]) {
      for (const armID of ["A", "B", "C"]) {
        expect(
          runs
            .filter((run) => run.taskID === taskID && run.armID === armID)
            .map((run) => run.repetition)
            .toSorted(),
        ).toEqual([0, 1])
      }
      for (const armID of ["D", "E"]) {
        expect(runs.filter((run) => run.taskID === taskID && run.armID === armID).map((run) => run.repetition)).toEqual(
          [0],
        )
      }
    }
  })

  test("still requires pilot tasks to be sealed and known", () => {
    expect(() =>
      planCampaignRuns(
        {
          ...campaign,
          preregistration: { ...campaign.preregistration, pilotTaskIDs: undefined },
        },
        "pilot",
      ),
    ).toThrow("TASK24_PILOT_TASKS_NOT_SEALED")
    expect(() =>
      planCampaignRuns(
        {
          ...campaign,
          preregistration: { ...campaign.preregistration, pilotTaskIDs: ["unknown-task"] },
        },
        "pilot",
      ),
    ).toThrow("TASK24_PILOT_TASKS_INVALID")
  })
})
