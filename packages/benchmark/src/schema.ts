import { Schema } from "effect"

export const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).annotate({ identifier: "Sha256" })
export const IsoDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
).annotate({ identifier: "IsoDateTime" })
export const Decimal = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)).annotate({
  identifier: "Decimal",
})
export const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/)).annotate({
  identifier: "HttpsUrl",
})
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
export const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0))
export const CampaignID = Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/)).annotate({
  identifier: "CampaignID",
})
export const TaskID = Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/)).annotate({
  identifier: "TaskID",
})

export const ArmID = Schema.Literals(["A", "B", "C", "D", "E"])
export const RuntimeID = Schema.Literals(["modified", "upstream"])
export const ArmMode = Schema.Literals(["workflow", "direct"])
export const ProviderID = Schema.Literals(["kimi", "deepseek"])
export const Protocol = Schema.Literals(["chat_completions", "responses"])
export const ModelID = Schema.Literals(["kimi-k3", "deepseek-v4-pro", "deepseek-v4-flash"])
export const Effort = Schema.Literals(["high", "max"])
export const Role = Schema.Literals([
  "all",
  "design",
  "decompose",
  "implement",
  "test",
  "visual_review",
  "repair",
  "deliver",
])

export const RouteDefinition = Schema.Struct({
  role: Role,
  provider: ProviderID,
  model: ModelID,
  protocol: Protocol,
  effort: Effort,
})

export const ArmDefinition = Schema.Struct({
  id: ArmID,
  runtime: RuntimeID,
  mode: ArmMode,
  routes: Schema.NonEmptyArray(RouteDefinition),
})

export const Budget = Schema.Struct({
  aggregateInputTokens: PositiveInt,
  aggregateOutputTokens: PositiveInt,
  maxToolCalls: PositiveInt,
  maxRetries: PositiveInt,
  maxDurationMs: PositiveInt,
})

export const Preregistration = Schema.Struct({
  primaryTaskCount: PositiveInt,
  guardrailTaskCount: PositiveInt,
  primaryRepeats: PositiveInt,
  upstreamRepeats: PositiveInt,
  upstreamSecondPassThresholdPoints: PositiveFinite,
  bootstrapResamples: PositiveInt,
  minimumEffectPoints: PositiveFinite,
  visualQualifiedThreshold: PositiveFinite,
  viewportFloor: PositiveFinite,
  costRatioLimit: PositiveFinite,
  seed: Schema.NonEmptyString,
  budget: Budget,
})

export const BinaryLock = Schema.Struct({
  version: Schema.NonEmptyString,
  commit: Sha256,
  sha256: Sha256,
  sourceUrl: HttpsUrl,
})

export const SourceLock = Schema.Struct({
  id: CampaignID,
  kind: Schema.Literals(["git", "archive", "dataset"]),
  url: HttpsUrl,
  revision: Schema.NonEmptyString,
  sha256: Sha256,
  license: Schema.NonEmptyString,
})

export const SealedTask = Schema.Struct({
  id: TaskID,
  kind: Schema.Literals(["primary", "guardrail"]),
  stratum: Schema.Literals(["private", "design2code", "swebench-multimodal", "guardrail"]),
  family: Schema.NonEmptyString,
  bundleSha256: Sha256,
  goldSha256: Sha256,
})

export const PriceRevision = Schema.Struct({
  provider: ProviderID,
  currency: Schema.Literals(["CNY", "USD"]),
  sourceUrl: HttpsUrl,
  capturedAt: IsoDateTime,
  inputMicrosPerMillion: Decimal,
  cachedInputMicrosPerMillion: Decimal,
  outputMicrosPerMillion: Decimal,
  reasoningMicrosPerMillion: Decimal,
})

export const ExchangeRateLock = Schema.Struct({
  base: Schema.Literal("CNY"),
  quote: Schema.Literal("USD"),
  decimalRate: Decimal,
  sourceUrl: HttpsUrl,
  capturedAt: IsoDateTime,
})

export const ToolchainLock = Schema.Struct({
  bunVersion: Schema.NonEmptyString,
  nodeVersion: Schema.NonEmptyString,
  playwrightVersion: Schema.NonEmptyString,
  chromiumRevision: Schema.NonEmptyString,
  operatingSystem: Schema.NonEmptyString,
  sha256: Sha256,
})

const DiagnosticWeights = Schema.Struct({
  functional: PositiveFinite,
  visual: PositiveFinite,
  requirements: PositiveFinite,
  quality: PositiveFinite,
  accessibilityResponsive: PositiveFinite,
})

const VisualWeights = Schema.Struct({
  ssim: PositiveFinite,
  pixelColor: PositiveFinite,
  domGeometry: PositiveFinite,
  typographyStyle: PositiveFinite,
  responsiveInteraction: PositiveFinite,
})

export const EvaluatorLock = Schema.Struct({
  version: Schema.NonEmptyString,
  sha256: Sha256,
  diagnosticWeights: DiagnosticWeights,
  visualWeights: VisualWeights,
})

export const CampaignInput = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: CampaignID,
  createdAt: IsoDateTime,
  preregistration: Preregistration,
  binaries: Schema.Struct({ modified: BinaryLock, upstream: BinaryLock }),
  sources: Schema.NonEmptyArray(SourceLock),
  tasks: Schema.Array(SealedTask),
  arms: Schema.Array(ArmDefinition),
  pricing: Schema.Struct({ kimi: PriceRevision, deepseek: PriceRevision }),
  exchangeRate: ExchangeRateLock,
  toolchain: ToolchainLock,
  evaluator: EvaluatorLock,
})

export const SealedCampaign = Schema.Struct({
  ...CampaignInput.fields,
  sha256: Sha256,
})

export const RunRoots = Schema.Struct({
  runRoot: Schema.NonEmptyString,
  repo: Schema.NonEmptyString,
  data: Schema.NonEmptyString,
  config: Schema.NonEmptyString,
  cache: Schema.NonEmptyString,
  temp: Schema.NonEmptyString,
  output: Schema.NonEmptyString,
})

export const ArmLaunchSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  armID: ArmID,
  runtime: RuntimeID,
  mode: ArmMode,
  executable: Schema.NonEmptyString,
  executableSha256: Sha256,
  version: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
  roots: RunRoots,
  promptSha256: Sha256,
  referenceFiles: Schema.Array(Schema.NonEmptyString),
  routes: Schema.NonEmptyArray(RouteDefinition),
  budget: Budget,
  brokerOrigin: Schema.NonEmptyString,
  brokerGrantSha256: Sha256,
  expectedOutput: Schema.NonEmptyString,
})

export type CampaignInput = typeof CampaignInput.Type
export type SealedCampaign = typeof SealedCampaign.Type
export type ArmDefinition = typeof ArmDefinition.Type
export type ArmLaunchSnapshot = typeof ArmLaunchSnapshot.Type
