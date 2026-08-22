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
  readonly start: (input: {
    readonly identity: Identity
    readonly plan: PreviewPlan.PreviewPlan
    readonly tempRoot: string
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
