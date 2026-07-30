export * as WorkflowState from "./state"

import { Workflow } from "@opencode-ai/schema/workflow"

export class InvalidStageTransition extends Error {
  constructor(readonly transition: string) {
    super(`Invalid workflow stage transition: ${transition}`)
  }
}

const transitions: Record<Workflow.StageStatus, ReadonlyArray<Workflow.StageStatus>> = {
  pending: ["leased", "cancelled", "skipped"],
  leased: ["running", "retry_wait", "waiting_approval", "cancelled"],
  running: ["succeeded", "retry_wait", "waiting_approval", "failed", "cancelled"],
  retry_wait: ["leased", "cancelled"],
  waiting_input: ["retry_wait", "failed", "cancelled"],
  waiting_approval: ["retry_wait", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: [],
} as const satisfies Record<Workflow.StageStatus, ReadonlyArray<Workflow.StageStatus>>

export function assertStageTransition(from: Workflow.StageStatus, to: Workflow.StageStatus): void {
  if ((transitions[from] as ReadonlyArray<Workflow.StageStatus>).includes(to)) return
  throw new InvalidStageTransition(`${from} -> ${to}`)
}

export function isTerminal(status: Workflow.StageStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "skipped"
}

export function previousStagesComplete(
  stages: ReadonlyArray<{ readonly ordinal: number; readonly status: Workflow.StageStatus }>,
  candidate: { readonly ordinal: number },
): boolean {
  return stages
    .filter((s) => s.ordinal < candidate.ordinal)
    .every((s) => s.status === "succeeded" || s.status === "skipped")
}
