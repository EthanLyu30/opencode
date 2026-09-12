export type ArmID = "A" | "B" | "C" | "D" | "E"
export type RuntimeID = "modified" | "upstream"
export type ArmMode = "workflow" | "direct"
export type ProviderID = "kimi" | "deepseek"
export type Protocol = "chat_completions" | "responses"
export type ModelID = "kimi-k3" | "deepseek-v4-pro" | "deepseek-v4-flash"
export type Effort = "high" | "max"

export interface ArmRoute {
  readonly role: "all" | "design" | "decompose" | "implement" | "test" | "visual_review" | "repair" | "deliver"
  readonly provider: ProviderID
  readonly model: ModelID
  readonly protocol: Protocol
  readonly effort: Effort
}

export interface BinaryAuthority {
  readonly runtime: RuntimeID
  readonly executable: string
  readonly version: string
  readonly sha256: string
}

export interface RunRoots {
  readonly runRoot: string
  readonly repo: string
  readonly data: string
  readonly config: string
  readonly cache: string
  readonly temp: string
  readonly output: string
}

export interface ArmBudget {
  readonly aggregateInputTokens: number
  readonly aggregateOutputTokens: number
  readonly maxToolCalls: number
  readonly maxRetries: number
  readonly maxDurationMs: number
}

export interface ArmInput {
  readonly armID: ArmID
  readonly campaignID: string
  readonly runID: string
  readonly binary: BinaryAuthority
  readonly roots: RunRoots
  readonly prompt: string
  readonly referenceFiles: readonly string[]
  readonly brokerOrigin: string
  readonly brokerGrant: string
  readonly grantExpiresAt: number
  readonly budget: ArmBudget
}

export interface LaunchSnapshot {
  readonly schemaVersion: 1
  readonly armID: ArmID
  readonly runtime: RuntimeID
  readonly mode: ArmMode
  readonly executable: string
  readonly executableSha256: string
  readonly version: string
  readonly cwd: string
  readonly roots: RunRoots
  readonly promptSha256: string
  readonly referenceFiles: readonly string[]
  readonly routes: readonly ArmRoute[]
  readonly budget: ArmBudget
  readonly brokerOrigin: string
  readonly brokerGrantSha256: string
  readonly expectedOutput: string
}

export interface ArmLaunch {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly snapshot: LaunchSnapshot
}

export interface DirectArmLaunch extends ArmLaunch {
  readonly configFile: string
}

export interface WorkflowArmLaunch extends ArmLaunch {
  readonly transportFile: string
}
