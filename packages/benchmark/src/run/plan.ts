import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import type { CampaignStage } from "./budget"
import { buildBalancedOrder } from "./order"

export interface CampaignPlanSource {
  readonly id: string
  readonly preregistration: Readonly<{
    readonly primaryRepeats: number
    readonly upstreamRepeats: number
    readonly seed: string
    readonly pilotTaskIDs?: readonly string[]
  }>
  readonly tasks: readonly Readonly<{ readonly id: string }>[]
}

export function planCampaignRuns(campaign: CampaignPlanSource, stage: CampaignStage) {
  const maximumRepeats = Math.max(campaign.preregistration.primaryRepeats, campaign.preregistration.upstreamRepeats)
  const pilotTaskIDs = campaign.preregistration.pilotTaskIDs
  if (stage === "pilot" && pilotTaskIDs === undefined) throw new TypeError("TASK24_PILOT_TASKS_NOT_SEALED")
  const taskIDs = stage === "pilot" && pilotTaskIDs !== undefined ? pilotTaskIDs : campaign.tasks.map((task) => task.id)
  const known = new Set(campaign.tasks.map((task) => task.id))
  if (taskIDs.length === 0 || taskIDs.some((taskID) => !known.has(taskID))) {
    throw new TypeError("TASK24_PILOT_TASKS_INVALID")
  }
  const ordered = buildBalancedOrder({
    seed: campaign.preregistration.seed,
    tasks: [...taskIDs],
    repetitions: maximumRepeats,
  }).filter((entry) =>
    entry.armID === "D" || entry.armID === "E"
      ? entry.repetition < campaign.preregistration.upstreamRepeats
      : entry.repetition < campaign.preregistration.primaryRepeats,
  )
  return ordered.map((entry, orderIndex) => ({
    runID: `run-${sha256Text(`${campaign.id}/${stage}/${entry.taskID}/${entry.armID}/${entry.repetition}`).slice(0, 24)}`,
    taskID: entry.taskID,
    armID: entry.armID,
    repetition: entry.repetition,
    orderIndex,
  }))
}

export function stageSha256(campaignID: string, campaignSha256: string, stage: CampaignStage): string {
  return sha256Text(canonicalJson({ schemaVersion: 1, campaignID, campaignSha256, stage }))
}
