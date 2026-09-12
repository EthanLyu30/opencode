import { createHash } from "node:crypto"
import type { ArmID } from "../arms/types"

export interface OrderedRun {
  readonly taskID: string
  readonly repetition: number
  readonly armID: ArmID
  readonly position: number
  readonly orderIndex: number
}

export function buildBalancedOrder(input: {
  readonly seed: string
  readonly tasks: readonly string[]
  readonly repetitions: number
  readonly arms?: readonly ArmID[]
}): readonly OrderedRun[] {
  const arms = input.arms ?? (["A", "B", "C", "D", "E"] as const)
  if (
    input.seed.length === 0 ||
    input.tasks.length === 0 ||
    !Number.isSafeInteger(input.repetitions) ||
    input.repetitions <= 0
  ) {
    throw new TypeError("TASK24_ORDER_INPUT_INVALID")
  }
  if (arms.length < 2 || new Set(arms).size !== arms.length) throw new TypeError("TASK24_ORDER_ARMS_INVALID")
  const labels = [...arms].toSorted((left, right) => compareDigest(input.seed, left, right))
  const rows = williamsRows(labels)
  const offset = digestInt(`${input.seed}/row`) % rows.length
  const blocks = input.tasks.flatMap((taskID) =>
    Array.from({ length: input.repetitions }, (_, repetition) => ({ taskID, repetition })),
  )
  const result: OrderedRun[] = []
  for (const [blockIndex, block] of blocks.entries()) {
    const row = required(rows, (blockIndex + offset) % rows.length)
    for (const [position, armID] of row.entries()) {
      result.push({ taskID: block.taskID, repetition: block.repetition, armID, position, orderIndex: result.length })
    }
  }
  return Object.freeze(result.map((entry) => Object.freeze(entry)))
}

function williamsRows(labels: readonly ArmID[]): readonly (readonly ArmID[])[] {
  const count = labels.length
  const rows = Array.from({ length: count }, (_, start) =>
    Array.from({ length: count }, (_, position) => {
      if (position === 0) return required(labels, start)
      const offset = position % 2 === 1 ? (position + 1) / 2 : -position / 2
      return required(labels, (start + offset + count) % count)
    }),
  )
  return count % 2 === 0 ? rows : [...rows, ...rows.map((row) => [...row].reverse())]
}

function compareDigest(seed: string, left: string, right: string): number {
  const a = digest(`${seed}/${left}`)
  const b = digest(`${seed}/${right}`)
  return a < b ? -1 : a > b ? 1 : left < right ? -1 : 1
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function digestInt(value: string): number {
  return Number.parseInt(digest(value).slice(0, 8), 16)
}

function required<T>(values: readonly T[], index: number): T {
  const value = values[index]
  if (value === undefined) throw new TypeError("TASK24_ORDER_INTERNAL_INVALID")
  return value
}
