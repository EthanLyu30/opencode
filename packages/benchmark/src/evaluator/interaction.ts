export interface InteractionCheckpoint {
  readonly id: string
  readonly passed: boolean
}

export function interactionScore(values: readonly InteractionCheckpoint[]): number {
  if (values.length === 0 || values.length > 1_000) throw new TypeError("TASK24_INTERACTION_EMPTY")
  const ids = new Set<string>()
  let passed = 0
  for (const value of values) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.id) || typeof value.passed !== "boolean" || ids.has(value.id)) {
      throw new TypeError("TASK24_INTERACTION_INVALID")
    }
    ids.add(value.id)
    if (value.passed) passed++
  }
  return Math.round((passed / values.length) * 100_000_000) / 1_000_000
}
