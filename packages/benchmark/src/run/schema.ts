import { Schema } from "effect"
import type { ArmID } from "../arms/types"
import type { CampaignStage } from "./budget"
import type { RunState } from "./state"

export const RunStateSchema = Schema.Literals([
  "planned",
  "materializing",
  "ready",
  "reserved",
  "running",
  "evaluating",
  "completed",
  "rejected_budget",
  "canceling",
  "canceled",
  "interrupted",
  "resumable",
  "failed",
])

export interface PlannedRun {
  readonly runID: string
  readonly taskID: string
  readonly armID: ArmID
  readonly repetition: number
  readonly orderIndex: number
}

export interface RunRecord extends PlannedRun {
  readonly campaignID: string
  readonly state: RunState
}

export interface StateEvent {
  readonly runID: string
  readonly sequence: number
  readonly from: RunState | null
  readonly to: RunState
  readonly at: string
}

export interface LeaseRecord {
  readonly runID: string
  readonly ownerID: string
  readonly acquiredAt: number
  readonly expiresAt: number
  readonly generation: number
}

export interface AdjudicationRecord {
  readonly runID: string
  readonly reason: string
  readonly createdAt: number
}

export interface CampaignPlan {
  readonly campaignID: string
  readonly campaignSha256: string
  readonly stage: CampaignStage
  readonly maxConcurrency: number
  readonly runs: readonly PlannedRun[]
}
