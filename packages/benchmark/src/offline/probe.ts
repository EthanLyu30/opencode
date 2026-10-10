import type { SealedCampaign } from "../schema"
import { sealCampaign } from "../campaign/seal"
import { planCampaignRuns } from "../run/plan"

/** Private offline acceptance scope; never accepted by campaign sealing. */
export function recoveryProbeID(): string | undefined {
  const id = process.env.TASK24_INTERNAL_RECOVERY_PROBE
  if (id === undefined) return undefined
  if (process.env.TASK24_INTERNAL_CRASH_TEST !== "task24-owned-v1" || !/^recovery-[a-f0-9]{32}-[a-z_]+$/.test(id)) {
    throw new TypeError("TASK24_RECOVERY_PROBE_INVALID")
  }
  return id
}

export function scopeRecoveryCampaign(campaign: SealedCampaign): SealedCampaign {
  const id = recoveryProbeID()
  if (!id) return campaign
  const { sha256: _sha256, ...body } = campaign
  return sealCampaign({ ...body, id })
}

export function offlineRuns(campaign: SealedCampaign) {
  const id = recoveryProbeID()
  const runs = planCampaignRuns(campaign, "offline")
  if (!id) return runs
  const selected = runs.filter((run) => run.taskID === "private-analytics-dashboard")
  const firstArm = id.endsWith("during_workflow_recovery") ? "A" : "C"
  return selected.toSorted((a, b) => Number(b.armID === firstArm) - Number(a.armID === firstArm))
    .map((run, orderIndex) => ({ ...run, orderIndex }))
}

export function offlinePointerName(): string {
  const id = recoveryProbeID()
  return id ? `${id}.json` : "current.json"
}
