import { describe, expect, test } from "bun:test"
import { runRecoveryMatrix } from "../../src/offline/recovery"
import { Task24Root } from "../../src/root"

describe("Task24 offline crash and recovery matrix", () => {
  const integration = process.env.TASK24_EXACT_RECOVERY === "1" ? test : test.skip
  integration("converges eight crash points without duplicate dispatch or conflicting results", async () => {
    const results = await runRecoveryMatrix(Task24Root.ensure())
    expect(results.map((result) => result.caseID)).toEqual([
      "during_materialization",
      "after_reservation",
      "mid_stream",
      "after_terminal_usage",
      "during_workflow_recovery",
      "during_capture",
      "during_evaluation_publication",
      "during_report_write",
    ])
    expect(results.every((result) => result.duplicateDispatches === 0 && result.conflictingResults === 0)).toBe(true)
    expect(results.every((result) => Reflect.get(result, "execution") === "exact-offline-command")).toBe(true)
    expect(results.find((result) => result.caseID === "after_reservation")?.outcome).toBe("adjudication_required")
    expect(results.find((result) => result.caseID === "during_evaluation_publication")?.outcome).toBe("completed")
  }, 3_600_000)
})
