import { describe, expect, test } from "bun:test"
import { aggregateArms } from "../../src/statistics/aggregate"
import { clusteredBootstrap, type RunObservation } from "../../src/statistics/bootstrap"

describe("Task24 clustered bootstrap", () => {
  test("resamples task IDs while carrying every repeat and arm", () => {
    const observations = fixture({ A: true, B: false, C: false })
    const first = clusteredBootstrap(observations, { seed: "sealed-task24", iterations: 10_000 })
    const second = clusteredBootstrap(observations, { seed: "sealed-task24", iterations: 10_000 })
    expect(first).toEqual(second)
    expect(first.bestControl).toBe("B")
    expect(first.contrasts).toEqual([
      { label: "A-B", estimate: 1, lower95: 1, upper95: 1 },
      { label: "A-C", estimate: 1, lower95: 1, upper95: 1 },
      { label: "A-best-control", estimate: 1, lower95: 1, upper95: 1 },
    ])
  })

  test("reports clear loss and interval-crossing-zero fixtures without pooling D/E", () => {
    const observations = [
      ...fixture({ A: false, B: true, C: true }),
      { ...fixture({ A: true, B: true, C: true })[0]!, armID: "D" as const },
    ]
    const result = clusteredBootstrap(observations, { seed: "sealed-task24", iterations: 10_000 })
    expect(result.contrasts[0]).toEqual({ label: "A-B", estimate: -1, lower95: -1, upper95: -1 })

    const mixed = clusteredBootstrap(mixedFixture(), { seed: "sealed-task24", iterations: 10_000 })
    expect(mixed.contrasts[0]!.estimate).toBe(0.5)
    expect(mixed.contrasts[0]!.lower95).toBe(0)
    expect(mixed.contrasts[0]!.upper95).toBe(1)
  })

  test("aggregates rates, diagnostics, and functional success by arm", () => {
    expect(aggregateArms(mixedFixture())).toContainEqual({
      armID: "B",
      runs: 4,
      qualifiedSuccesses: 2,
      qualifiedRate: 0.5,
      functionalRate: 1,
      meanDiagnosticScore: 80,
    })
  })
})

function fixture(status: Record<"A" | "B" | "C", boolean>): RunObservation[] {
  return ["task-1", "task-2"].flatMap((taskID, taskIndex) =>
    (["A", "B", "C"] as const).flatMap((armID) =>
      [0, 1].map((repeat) => ({
        taskID,
        family: taskIndex === 0 ? "dashboard" : "checkout",
        armID,
        repeat,
        qualifiedSuccess: status[armID],
        functionalSuccess: true,
        diagnosticScore: status[armID] ? 100 : 40,
      })),
    ),
  )
}

function mixedFixture(): RunObservation[] {
  return fixture({ A: true, B: false, C: false }).map((item) =>
    item.taskID === "task-2" && item.armID === "B"
      ? { ...item, qualifiedSuccess: true, diagnosticScore: 100 }
      : item.armID === "B"
        ? { ...item, diagnosticScore: 60 }
        : item,
  )
}
