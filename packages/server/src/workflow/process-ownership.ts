export * as ProcessOwnership from "./process-ownership"

import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"

export interface Identity extends WorkflowVisualHost.PreviewLeaseAuthority {
  readonly hostID: WorkflowVisualHost.HostID
  readonly nonce: string
}

export interface OwnedProcess {
  readonly origin: string
  readonly exited: Promise<number>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
}

export interface RecoveryInput {
  readonly identity: Identity
  /** Re-read durable lease authority immediately before each destructive operation. */
  readonly finalGate: () => Promise<boolean>
}

export interface Service {
  readonly available: boolean
  /**
   * Phase-B implementations must authenticate the returned handle, honor the signal, and settle no later than the
   * absolute deadline without creating a process after cancellation or rejection.
   */
  readonly start: (input: {
    readonly identity: Identity
    readonly plan: PreviewPlan.PreviewPlan
    /** Exact host-materialized Snapshot root; never the mutable admitted Location. */
    readonly workspaceRoot?: string
    /** Exact sealed bytes imported into the owned container; excludes any mutable host bind. */
    readonly archive?: WorkflowWorkspaceMaterialization.Archive
    readonly tempRoot: string
    readonly signal: AbortSignal
    readonly deadline: number
  }) => Promise<OwnedProcess>
  readonly stop: (input: {
    readonly identity: Identity
    readonly process: OwnedProcess
    /** Replacement recovery re-reads durable authority before each destructive operation. */
    readonly finalGate?: () => Promise<boolean>
  }) => Promise<void>
  readonly recover: (input: RecoveryInput) => Promise<void>
}

export const unavailable: Service = Object.freeze({
  available: false,
  start: async () => {
    throw new Error("Authenticated preview process ownership is unavailable")
  },
  stop: async () => undefined,
  recover: async () => {
    throw new Error("Authenticated preview process ownership is unavailable")
  },
})
