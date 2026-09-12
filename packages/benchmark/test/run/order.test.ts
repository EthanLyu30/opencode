import { describe, expect, test } from "bun:test"
import { buildBalancedOrder } from "../../src/run/order"

describe("Task24 deterministic arm order", () => {
  test("is seed-stable and position-balanced across the odd five-arm design", () => {
    const input = { seed: "task24-seed", tasks: ["t1", "t2", "t3", "t4", "t5"], repetitions: 2 } as const
    const first = buildBalancedOrder(input)
    expect(buildBalancedOrder(input)).toEqual(first)
    expect(buildBalancedOrder({ ...input, seed: "other-seed" })).not.toEqual(first)

    const counts = new Map<string, number>()
    for (const entry of first)
      counts.set(`${entry.position}/${entry.armID}`, (counts.get(`${entry.position}/${entry.armID}`) ?? 0) + 1)
    expect(new Set(counts.values())).toEqual(new Set([2]))
    expect(first).toHaveLength(50)
  })
})
