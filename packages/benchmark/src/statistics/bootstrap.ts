import { createHash } from "node:crypto"
import { aggregateArms, validateObservations } from "./aggregate"

export interface RunObservation {
  readonly taskID: string
  readonly family: string
  readonly armID: "A" | "B" | "C" | "D" | "E"
  readonly repeat: number
  readonly qualifiedSuccess: boolean
  readonly functionalSuccess: boolean
  readonly diagnosticScore: number
}

export interface BootstrapContrast {
  readonly label: "A-B" | "A-C" | "A-best-control"
  readonly estimate: number
  readonly lower95: number
  readonly upper95: number
}

export interface BootstrapResult {
  readonly iterations: 10_000
  readonly seedSha256: string
  readonly bestControl: "B" | "C"
  readonly contrasts: readonly BootstrapContrast[]
}

export function clusteredBootstrap(
  observations: readonly RunObservation[],
  options: { readonly seed: string; readonly iterations: 10_000 },
): BootstrapResult {
  validateObservations(observations)
  if (options.iterations !== 10_000 || options.seed.length < 8 || options.seed.length > 512) {
    throw new TypeError("TASK24_BOOTSTRAP_OPTIONS_INVALID")
  }
  const primary = observations.filter((item) => item.armID === "A" || item.armID === "B" || item.armID === "C")
  const tasks = taskRates(primary)
  const summaries = aggregateArms(primary)
  const b = summaries.find((item) => item.armID === "B")
  const c = summaries.find((item) => item.armID === "C")
  if (!b || !c) throw new TypeError("TASK24_BOOTSTRAP_ARMS_INCOMPLETE")
  const bestControl: "B" | "C" = b.qualifiedRate >= c.qualifiedRate ? "B" : "C"
  const random = mulberry32(seedNumber(options.seed))
  const samples = { B: [] as number[], C: [] as number[], best: [] as number[] }
  for (let iteration = 0; iteration < options.iterations; iteration++) {
    let ab = 0
    let ac = 0
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[Math.floor(random() * tasks.length)]!
      ab += task.A - task.B
      ac += task.A - task.C
    }
    samples.B.push(ab / tasks.length)
    samples.C.push(ac / tasks.length)
    samples.best.push((bestControl === "B" ? ab : ac) / tasks.length)
  }
  const estimateAB = mean(tasks.map((task) => task.A - task.B))
  const estimateAC = mean(tasks.map((task) => task.A - task.C))
  return Object.freeze({
    iterations: 10_000,
    seedSha256: sha256(options.seed),
    bestControl,
    contrasts: Object.freeze([
      interval("A-B", estimateAB, samples.B),
      interval("A-C", estimateAC, samples.C),
      interval("A-best-control", bestControl === "B" ? estimateAB : estimateAC, samples.best),
    ]),
  })
}

function taskRates(values: readonly RunObservation[]) {
  const tasks = new Map<string, RunObservation[]>()
  for (const value of values) {
    const group = tasks.get(value.taskID) ?? []
    group.push(value)
    tasks.set(value.taskID, group)
  }
  return [...tasks]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([taskID, runs]) => {
      const family = new Set(runs.map((item) => item.family))
      if (family.size !== 1) throw new TypeError("TASK24_BOOTSTRAP_TASK_FAMILY_INVALID")
      return {
        taskID,
        A: armRate(runs, "A"),
        B: armRate(runs, "B"),
        C: armRate(runs, "C"),
      }
    })
}

function armRate(values: readonly RunObservation[], armID: "A" | "B" | "C"): number {
  const arm = values.filter((item) => item.armID === armID)
  if (arm.length === 0) throw new TypeError("TASK24_BOOTSTRAP_ARMS_INCOMPLETE")
  return mean(arm.map((item) => (item.qualifiedSuccess ? 1 : 0)))
}

function interval(label: BootstrapContrast["label"], estimate: number, samples: number[]): BootstrapContrast {
  samples.sort((left, right) => left - right)
  return Object.freeze({
    label,
    estimate: round(estimate),
    lower95: round(percentile(samples, 0.025)),
    upper95: round(percentile(samples, 0.975)),
  })
}

function percentile(values: readonly number[], probability: number): number {
  return values[Math.floor((values.length - 1) * probability)]!
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new TypeError("TASK24_BOOTSTRAP_EMPTY")
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function seedNumber(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32LE(0)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
