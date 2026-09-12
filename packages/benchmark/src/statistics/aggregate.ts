import type { RunObservation } from "./bootstrap"

export interface ArmSummary {
  readonly armID: RunObservation["armID"]
  readonly runs: number
  readonly qualifiedSuccesses: number
  readonly qualifiedRate: number
  readonly functionalRate: number
  readonly meanDiagnosticScore: number
}

export function aggregateArms(values: readonly RunObservation[]): readonly ArmSummary[] {
  validateObservations(values)
  const groups = new Map<RunObservation["armID"], RunObservation[]>()
  for (const value of values) {
    const group = groups.get(value.armID) ?? []
    group.push(value)
    groups.set(value.armID, group)
  }
  return Object.freeze(
    [...groups]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([armID, runs]) => {
        const qualifiedSuccesses = runs.filter((item) => item.qualifiedSuccess).length
        return Object.freeze({
          armID,
          runs: runs.length,
          qualifiedSuccesses,
          qualifiedRate: round(qualifiedSuccesses / runs.length),
          functionalRate: round(runs.filter((item) => item.functionalSuccess).length / runs.length),
          meanDiagnosticScore: round(runs.reduce((sum, item) => sum + item.diagnosticScore, 0) / runs.length),
        })
      }),
  )
}

export function validateObservations(values: readonly RunObservation[]): void {
  if (values.length === 0 || values.length > 100_000) throw new TypeError("TASK24_OBSERVATIONS_INVALID")
  const identities = new Set<string>()
  for (const value of values) {
    const identity = `${value.taskID}\0${value.armID}\0${value.repeat}`
    if (
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.taskID) ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.family) ||
      !/^[A-E]$/.test(value.armID) ||
      !Number.isSafeInteger(value.repeat) ||
      value.repeat < 0 ||
      typeof value.qualifiedSuccess !== "boolean" ||
      typeof value.functionalSuccess !== "boolean" ||
      !Number.isFinite(value.diagnosticScore) ||
      value.diagnosticScore < 0 ||
      value.diagnosticScore > 100 ||
      identities.has(identity)
    ) {
      throw new TypeError("TASK24_OBSERVATIONS_INVALID")
    }
    identities.add(identity)
  }
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
