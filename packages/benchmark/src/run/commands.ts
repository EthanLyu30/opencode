import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { verifyCampaign } from "../campaign/seal"
import { sha256Text } from "../hash"
import type { Task24Layout } from "../root"
import type { SealedCampaign } from "../schema"
import { decodeStageApproval, requireStageApproval, type CampaignStage } from "./budget"
import { buildBalancedOrder } from "./order"
import { RunStore } from "./store"

export interface RuntimeCommandService {
  readonly status: (layout: Task24Layout) => Promise<unknown>
  readonly run: (layout: Task24Layout, stage: CampaignStage) => Promise<unknown>
  readonly resume: (layout: Task24Layout) => Promise<unknown>
  readonly cancel: (layout: Task24Layout, runID: string) => Promise<unknown>
}

const runtimeCommands: RuntimeCommandService = {
  async status(layout) {
    const campaign = await loadCampaign(layout)
    const stages: Record<string, Record<string, number>> = {}
    for (const stage of ["offline", "pilot", "campaign"] as const) {
      const database = databasePath(layout, campaign.id, stage)
      if (!(await Bun.file(database).exists())) continue
      const store = RunStore.open(database)
      try {
        const states: Record<string, number> = {}
        for (const run of store.listRuns(campaign.id)) states[run.state] = (states[run.state] ?? 0) + 1
        stages[stage] = states
      } finally {
        store.close()
      }
    }
    return {
      command: "status",
      campaignID: campaign.id,
      campaignSha256: campaign.sha256,
      planned: Object.keys(stages).length > 0,
      stages,
    }
  },
  async run(layout, stage) {
    const campaign = await loadCampaign(layout)
    const campaignRoot = path.join(layout.runs, campaign.id)
    if (stage !== "offline") {
      const approval = decodeStageApproval(
        JSON.parse(await fs.readFile(path.join(campaignRoot, `${stage}.approval.json`), "utf8")),
      )
      const expected = {
        campaignID: campaign.id,
        campaignSha256: campaign.sha256,
        stage,
        stageSha256: sha256Text(
          canonicalJson({ schemaVersion: 1, campaignID: campaign.id, campaignSha256: campaign.sha256, stage }),
        ),
        expiresAt: approval.expiresAt,
        ceilings: approval.ceilings,
      }
      requireStageApproval(stage, approval, expected, process.env.TASK24_APPROVAL_SECRET, Date.now())
    }
    const runs = campaignRuns(campaign, stage)
    await fs.mkdir(path.join(campaignRoot, "scheduler"), { recursive: true })
    const store = RunStore.open(databasePath(layout, campaign.id, stage))
    try {
      store.planCampaign({
        campaignID: campaign.id,
        campaignSha256: campaign.sha256,
        stage,
        maxConcurrency: stage === "pilot" ? 1 : campaign.preregistration.maxConcurrency,
        runs,
      })
      return {
        command: "run",
        stage,
        campaignID: campaign.id,
        campaignSha256: campaign.sha256,
        plannedRuns: runs.length,
      }
    } finally {
      store.close()
    }
  },
  async resume(layout) {
    const campaign = await loadCampaign(layout)
    const resumable: string[] = []
    for (const stage of ["offline", "pilot", "campaign"] as const) {
      const database = databasePath(layout, campaign.id, stage)
      if (!(await Bun.file(database).exists())) continue
      const store = RunStore.open(database)
      try {
        resumable.push(
          ...store
            .listRuns(campaign.id)
            .filter((run) => run.state === "planned" || run.state === "resumable")
            .map((run) => run.runID),
        )
      } finally {
        store.close()
      }
    }
    return { command: "resume", campaignID: campaign.id, resumable }
  },
  async cancel(layout, runID) {
    const campaign = await loadCampaign(layout)
    for (const stage of ["offline", "pilot", "campaign"] as const) {
      const database = databasePath(layout, campaign.id, stage)
      if (!(await Bun.file(database).exists())) continue
      const store = RunStore.open(database)
      try {
        const run = store.getRun(runID)
        if (!run || run.campaignID !== campaign.id) continue
        store.requestCancellation(runID, Date.now())
        return { command: "cancel", campaignID: campaign.id, runID, requested: true }
      } finally {
        store.close()
      }
    }
    throw new TypeError("TASK24_CANCEL_RUN_NOT_FOUND")
  },
}

export const RuntimeCommands: RuntimeCommandService = Object.freeze(runtimeCommands)

function campaignRuns(campaign: SealedCampaign, stage: CampaignStage) {
  const maximumRepeats = Math.max(campaign.preregistration.primaryRepeats, campaign.preregistration.upstreamRepeats)
  const ordered = buildBalancedOrder({
    seed: campaign.preregistration.seed,
    tasks: campaign.tasks.map((task) => task.id),
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

async function loadCampaign(layout: Task24Layout): Promise<SealedCampaign> {
  const pointer: unknown = JSON.parse(await fs.readFile(path.join(layout.runs, "current-campaign.json"), "utf8"))
  if (!isObject(pointer) || typeof pointer.id !== "string" || typeof pointer.sha256 !== "string") {
    throw new TypeError("TASK24_CAMPAIGN_POINTER_INVALID")
  }
  const raw: unknown = JSON.parse(await fs.readFile(path.join(layout.runs, pointer.id, "campaign.sealed.json"), "utf8"))
  const result = verifyCampaign(raw)
  if (!result.ok) throw new TypeError(result.reason)
  if (result.campaign.id !== pointer.id || result.campaign.sha256 !== pointer.sha256) {
    throw new TypeError("CAMPAIGN_POINTER_MISMATCH")
  }
  return result.campaign
}

function databasePath(layout: Task24Layout, campaignID: string, stage: CampaignStage): string {
  return path.join(layout.runs, campaignID, "scheduler", `${stage}.sqlite`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
