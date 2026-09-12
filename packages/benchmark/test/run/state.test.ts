import { describe, expect, test } from "bun:test"
import { assertTransition, isTerminal } from "../../src/run/state"

describe("Task24 run state machine", () => {
  test("accepts the success, budget rejection, cancellation, and recovery paths", () => {
    for (const [from, to] of [
      ["planned", "materializing"],
      ["materializing", "ready"],
      ["ready", "reserved"],
      ["reserved", "running"],
      ["running", "evaluating"],
      ["evaluating", "completed"],
      ["ready", "rejected_budget"],
      ["running", "canceling"],
      ["canceling", "canceled"],
      ["running", "interrupted"],
      ["evaluating", "interrupted"],
      ["interrupted", "resumable"],
      ["interrupted", "failed"],
      ["resumable", "reserved"],
      ["resumable", "evaluating"],
    ] as const) {
      expect(assertTransition(from, to)).toBe(to)
    }
  })

  test("rejects backward, skipped, and terminal transitions", () => {
    for (const pair of [
      ["ready", "planned"],
      ["planned", "running"],
      ["completed", "running"],
      ["rejected_budget", "ready"],
    ] as const) {
      expect(() => assertTransition(...pair)).toThrow(/transition/i)
    }
    expect(isTerminal("completed")).toBe(true)
    expect(isTerminal("running")).toBe(false)
  })
})
