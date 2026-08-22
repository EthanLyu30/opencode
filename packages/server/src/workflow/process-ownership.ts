export * as ProcessOwnership from "./process-ownership"

import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"

export interface Identity {
  readonly hostID: WorkflowVisualHost.HostID
  readonly nonce: string
}

export interface OwnedProcess {
  readonly exited: Promise<number>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
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
    readonly tempRoot: string
    readonly signal: AbortSignal
    readonly deadline: number
  }) => Promise<OwnedProcess>
  readonly stop: (input: { readonly identity: Identity; readonly process: OwnedProcess }) => Promise<void>
  readonly recover: (identity: Identity) => Promise<void>
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
