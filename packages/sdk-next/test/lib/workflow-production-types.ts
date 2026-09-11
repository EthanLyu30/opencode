export const systems = {
  design:
    "Return only the strict design envelope. Provide the design specification and complete reference source text; never provide a preview URL or build command.",
  decompose:
    "Return only the strict decomposition envelope. Provide semantic tasks and acceptance criteria; never provide workflow, revision, snapshot, or hash authority.",
  implement:
    "Return only the strict implementation envelope. Use the admitted tools for workspace work; never claim manifest, snapshot, workspace, source, selector, or URL authority.",
  test: "Return only the strict test envelope. Use the admitted tools for testing; never self-report logs, manifests, previews, or host identity.",
  visual_review:
    "Return only the strict visual-review envelope. Propose verdict, score, and findings; evidence, limits, usage, revision, selectors, and identities are host supplied.",
  repair:
    "Return only the strict repair envelope. Use the admitted tools for workspace work; never claim manifest, snapshot, workspace, source, selector, or URL authority.",
  deliver:
    "Return only the strict delivery envelope with a bounded summary; all artifact hashes and current-workspace facts are host supplied.",
} as const

export const frozenStages = Object.freeze([
  ["design", 0, "kimi", "kimi-k3", "openai-chat", "max"],
  ["decompose", 0, "kimi", "kimi-k3", "openai-chat", "high"],
  ["implement", 0, "deepseek", "deepseek-v4-pro", "openai-responses", "max"],
  ["test", 0, "deepseek", "deepseek-v4-flash", "openai-responses", "high"],
  ["repair", 1, "deepseek", "deepseek-v4-pro", "openai-responses", "max"],
  ["test", 1, "deepseek", "deepseek-v4-flash", "openai-responses", "high"],
  ["visual_review", 1, "kimi", "kimi-k3", "openai-chat", "max"],
  ["repair", 2, "deepseek", "deepseek-v4-pro", "openai-responses", "max"],
  ["test", 2, "deepseek", "deepseek-v4-flash", "openai-responses", "high"],
  ["visual_review", 2, "kimi", "kimi-k3", "openai-chat", "max"],
  ["deliver", 2, "deepseek", "deepseek-v4-pro", "openai-responses", "high"],
] as const)

export type Role = keyof typeof systems

export interface ToolScript {
  readonly name: string
  readonly callID: string
  readonly input: unknown
}

export interface RecordingStage {
  readonly role: Role
  readonly revision: number
  readonly provider: "kimi" | "deepseek"
  readonly model: "kimi-k3" | "deepseek-v4-flash" | "deepseek-v4-pro"
  readonly protocol: "openai-chat" | "openai-responses"
  readonly effort: "high" | "max"
  readonly semantic: Readonly<Record<string, unknown>>
  readonly toolScript: readonly ToolScript[]
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number }
  readonly terminal: { readonly finishReason: "stop"; readonly hostTestExit?: 0 | 1 }
}

export interface ProductionRecording {
  readonly version: 1
  readonly stages: readonly RecordingStage[]
  readonly expectedArtifacts: readonly {
    readonly role: Role
    readonly revision: number
    readonly kind: string
    readonly count: number
  }[]
  readonly expectedPreviews: readonly {
    readonly kind: "reference" | "implementation"
    readonly revision: number
    readonly sha256: string
    readonly size: number
  }[]
  readonly terminal: {
    readonly workflowStatus: "succeeded"
    readonly responseStatus: "completed"
    readonly responseStore: true
    readonly source: {
      readonly role: "deliver"
      readonly revision: 2
      readonly provider: "deepseek"
      readonly model: "deepseek-v4-pro"
      readonly protocol: "openai-responses"
    }
    readonly providerStages: 11
    readonly preallocatedStages: 12
    readonly skippedStages: 1
    readonly skippedStage: { readonly role: "visual_review"; readonly revision: 0; readonly ordinal: 4 }
  }
}

export interface RuntimeCounters {
  providerCalls: number
  credentialReads: number
  outboundCalls: number
  browserCaptures: number
  browserCloses: number
  functionalTests: number
  processStarts: number
  processStops: number
  processRecovers: number
}

export interface ProviderRequestObservation {
  readonly role: Role
  readonly revision: number
  readonly phase: "initial" | "after-tool"
  readonly messageRoles: readonly string[]
  readonly messages: readonly {
    readonly role: string
    readonly parts: readonly Readonly<Record<string, unknown>>[]
  }[]
  readonly tools: readonly string[]
}

export interface RuntimeObservation {
  readonly workflowID: string
  readonly responseID: string
  readonly workflowStatus: string
  readonly responseStatus: string
  readonly stages: readonly {
    readonly ordinal: number
    readonly role: string
    readonly revision: number
    readonly status: string
    readonly attempt: number
  }[]
  readonly artifacts: readonly {
    readonly kind: string
    readonly stageID: string
    readonly sha256: string
    readonly size: number
  }[]
  readonly counters: RuntimeCounters
  readonly browserBodies: readonly {
    readonly kind: "reference" | "implementation"
    readonly revision: number
    readonly sha256: string
    readonly size: number
  }[]
  readonly frozenTests: readonly {
    readonly revision: number
    readonly sha256: string
    readonly size: number
    readonly exit: number
  }[]
  readonly evidence: readonly {
    readonly kind: string
    readonly revision: number
    readonly state: string
    readonly bytes: number
  }[]
  readonly evidenceBytes: number
  readonly responseItems: readonly string[]
  readonly responseItemKinds: readonly string[]
  readonly responseUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number }
  readonly toolContinuations: readonly {
    readonly role: string
    readonly revision: number
    readonly callID: string
    readonly name: string
  }[]
  readonly workflowSessionVisibility: string | null
  readonly conversationCount: number
  readonly finalWorkspaceSha256: string
  readonly secretScanPassed: true
  readonly providerRequests: readonly ProviderRequestObservation[]
  readonly replay: {
    readonly eventCount: number
    readonly batchCount: number
    readonly incompleteCases: number
    readonly secondReplayIdempotent: true
  }
}

export interface ToolAmbiguityObservation {
  readonly workflowStatus: string
  readonly responseStatus: string
  readonly stage: {
    readonly role: string
    readonly revision: number
    readonly status: string
    readonly error: { readonly code: string }
  }
  readonly providerCalls: number
  readonly toolContinuations: number
  readonly workspaceSha256: string
}

export interface ProductionCrashOptions {
  readonly boundary:
    | "admission-postcommit-prewake"
    | "provider-result-checkpoint"
    | "pending-tool-intent"
    | "settled-tool-result"
    | "preview-start-intent"
    | "png-staged-before-event"
    | "terminal-before-publish"
  readonly markerPath: string
}
