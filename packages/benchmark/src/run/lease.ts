import type { Service as RunStoreService } from "./store"

export interface RecoveryInspection {
  readonly processAlive: boolean
  readonly providerDisposition: "none" | "settled" | "unknown"
  readonly workflowDisposition: "not_applicable" | "completed" | "recoverable" | "unknown"
  readonly workspaceIntact: boolean
  readonly evaluationComplete: boolean
}

export type RecoveryOutcome =
  | "resumable"
  | "completed"
  | "canceled"
  | "adjudication_required"
  | "failed"
  | "live_process"

export async function recoverExpiredRuns(input: {
  readonly store: RunStoreService
  readonly now: number
  readonly inspect: (runID: string) => Promise<RecoveryInspection>
}): Promise<readonly { readonly runID: string; readonly outcome: RecoveryOutcome }[]> {
  const results: Array<{ readonly runID: string; readonly outcome: RecoveryOutcome }> = []
  for (const lease of input.store.expiredLeases(input.now)) {
    const run = input.store.getRun(lease.runID)
    if (!run || (run.state !== "running" && run.state !== "evaluating" && run.state !== "canceling")) {
      input.store.releaseLease(lease.runID, lease.ownerID)
      continue
    }
    const inspection = await input.inspect(run.runID)
    if (inspection.processAlive) {
      results.push({ runID: run.runID, outcome: "live_process" })
      continue
    }
    if (run.state === "canceling") {
      const reason = unknownDisposition(inspection)
      if (reason) {
        if (!input.store.adjudications(run.runID).some((item) => item.reason === reason)) {
          input.store.addAdjudication(run.runID, reason, input.now)
        }
        results.push({ runID: run.runID, outcome: "adjudication_required" })
        continue
      }
      input.store.interruptActiveAttempt(run.runID, input.now)
      input.store.transition(run.runID, "canceled", new Date(input.now).toISOString())
      input.store.completeCancellation(run.runID)
      input.store.releaseLease(run.runID, lease.ownerID)
      results.push({ runID: run.runID, outcome: "canceled" })
      continue
    }
    input.store.interruptActiveAttempt(run.runID, input.now)
    const reason = unknownDisposition(inspection)
    if (reason) {
      input.store.transition(run.runID, "interrupted", new Date(input.now).toISOString())
      input.store.addAdjudication(run.runID, reason, input.now)
      input.store.transition(run.runID, "failed", new Date(input.now).toISOString())
      input.store.releaseLease(run.runID, lease.ownerID)
      results.push({ runID: run.runID, outcome: "adjudication_required" })
      continue
    }
    if (run.state === "evaluating" && inspection.evaluationComplete) {
      input.store.transition(run.runID, "completed", new Date(input.now).toISOString())
      input.store.releaseLease(run.runID, lease.ownerID)
      results.push({ runID: run.runID, outcome: "completed" })
      continue
    }
    input.store.transition(run.runID, "interrupted", new Date(input.now).toISOString())
    if (inspection.workspaceIntact) {
      input.store.transition(run.runID, "resumable", new Date(input.now).toISOString())
      input.store.releaseLease(run.runID, lease.ownerID)
      results.push({ runID: run.runID, outcome: "resumable" })
      continue
    }
    input.store.transition(run.runID, "failed", new Date(input.now).toISOString())
    input.store.releaseLease(run.runID, lease.ownerID)
    results.push({ runID: run.runID, outcome: "failed" })
  }
  return Object.freeze(results.map((result) => Object.freeze(result)))
}

function unknownDisposition(inspection: RecoveryInspection): string | undefined {
  if (inspection.providerDisposition === "unknown") return "provider_disposition_unknown"
  if (inspection.workflowDisposition === "unknown") return "workflow_disposition_unknown"
  return undefined
}
