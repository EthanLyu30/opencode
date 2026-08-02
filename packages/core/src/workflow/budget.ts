export * as WorkflowBudget from "./budget"

import { Workflow } from "@opencode-ai/schema/workflow"

export type Dimension = "tokens" | "turns" | "toolCalls" | "attempts" | "duration"

export interface Threshold {
  readonly percent: 50 | 80 | 100
  readonly dimension: Dimension
}

export function evaluate(input: {
  readonly budget: Workflow.Budget
  readonly usage: Workflow.Usage
  readonly notified: number
  readonly elapsedMs: number
}): { readonly exhausted: boolean; readonly thresholds: ReadonlyArray<Threshold> } {
  const ratios = [
    ratio("tokens", input.usage.tokens, input.budget.maxTokens),
    ratio("turns", input.usage.turns, input.budget.maxTurns),
    ratio("toolCalls", input.usage.toolCalls, input.budget.maxToolCalls),
    ratio("attempts", input.usage.attempts, input.budget.maxAttempts),
    ratio("duration", input.elapsedMs, input.budget.maxDurationMs),
  ].filter((item): item is { readonly dimension: Dimension; readonly value: number } => item !== undefined)
  if (ratios.length === 0) return { exhausted: false, thresholds: [] }

  const highest = ratios.reduce((current, item) => (item.value > current.value ? item : current))
  const thresholds = (
    [
      { percent: 50, ratio: 0.5, bit: 1 },
      { percent: 80, ratio: 0.8, bit: 2 },
      { percent: 100, ratio: 1, bit: 4 },
    ] as const
  )
    .filter((threshold) => highest.value >= threshold.ratio && (input.notified & threshold.bit) === 0)
    .map((threshold) => ({ percent: threshold.percent, dimension: highest.dimension }))

  return { exhausted: ratios.some((item) => item.value >= 1), thresholds }
}

export function validateIncrease(input: {
  readonly current: Workflow.Budget
  readonly next: Workflow.Budget
  readonly usage: Workflow.Usage
  readonly elapsedMs: number
}): boolean {
  const dimensions = [
    { key: "maxTokens", consumed: input.usage.tokens },
    { key: "maxTurns", consumed: input.usage.turns },
    { key: "maxToolCalls", consumed: input.usage.toolCalls },
    { key: "maxAttempts", consumed: input.usage.attempts },
    { key: "maxDurationMs", consumed: input.elapsedMs },
  ] as const

  if (!dimensions.some((dimension) => input.next[dimension.key] !== input.current[dimension.key])) return false
  return dimensions.every((dimension) => {
    const current = input.current[dimension.key]
    const next = input.next[dimension.key]
    if (current !== undefined && (next === undefined || next < current)) return false
    if (next !== undefined && next < dimension.consumed) return false
    return true
  })
}

function ratio(dimension: Dimension, consumed: number, limit: number | undefined) {
  if (limit === undefined) return undefined
  return { dimension, value: limit === 0 ? Number.POSITIVE_INFINITY : consumed / limit }
}
