export * as WorkflowModelCatalog from "./workflow-model-catalog"

import { Schema } from "effect"
import { DesignArtifact } from "./design-artifact"
import { NonNegativeInt, PositiveInt } from "./schema"
import { WorkflowRole } from "./workflow-role"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
export const Sha256 = DesignArtifact.Sha256
export const ProviderID = Schema.Literals(["kimi", "deepseek"]).annotate({
  identifier: "WorkflowModelCatalog.ProviderID",
})
export type ProviderID = typeof ProviderID.Type
export const SelectedFamily = Schema.Literals(["kimi-flagship", "deepseek-pro", "deepseek-flash"]).annotate({
  identifier: "WorkflowModelCatalog.SelectedFamily",
})
export type SelectedFamily = typeof SelectedFamily.Type
export const Family = Schema.Literals(["kimi-flagship", "deepseek-pro", "deepseek-flash", "unknown"]).annotate({
  identifier: "WorkflowModelCatalog.Family",
})
export type Family = typeof Family.Type
export const ModelID = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)).annotate({
  identifier: "WorkflowModelCatalog.ModelID",
})

const safe = Schema.makeFilter<unknown>((value) => {
  const unsafe = (item: unknown): boolean => {
    if (typeof item === "string") return /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/.test(item)
    if (Array.isArray(item)) return item.some(unsafe)
    if (item === null || typeof item !== "object") return false
    return Object.entries(item).some(
      ([key, child]) =>
        /^(authorization|api[-_]?key|secret|password|cookie|provider[-_]?response[-_]?body)$/i.test(key) ||
        unsafe(child),
    )
  }
  return unsafe(value) ? "Model catalogue contains sensitive fields" : undefined
})

export const AdapterProfile = Schema.Struct({
  id: Schema.Literals(["kimi-chat-k3-v1", "deepseek-responses-v4-v1"]),
  providerID: ProviderID,
  protocol: WorkflowRole.Protocol,
  capabilities: Schema.Array(Schema.NonEmptyString),
  effortLevels: Schema.Array(Schema.NonEmptyString),
  wireContractSha256: Sha256,
}).annotate({ identifier: "WorkflowModelCatalog.AdapterProfile", ...exact })
export interface AdapterProfile extends Schema.Schema.Type<typeof AdapterProfile> {}

// Fingerprints of the compiled, historical wire descriptors, not assertions about newly discovered models.
const profiles: readonly AdapterProfile[] = Object.freeze([
  Object.freeze({
    id: "kimi-chat-k3-v1",
    providerID: "kimi",
    protocol: "openai-chat",
    capabilities: Object.freeze([
      "chat",
      "reasoning_replay",
      "required_tool_choice",
      "structured_output",
      "vision_input",
    ]),
    effortLevels: Object.freeze(["high", "low", "max"]),
    wireContractSha256: "1dbb4bbeb17dfd793e1ab73617bf1410b5268ab9c70c9b54561b4b5de4560f18",
  }),
  Object.freeze({
    id: "deepseek-responses-v4-v1",
    providerID: "deepseek",
    protocol: "openai-responses",
    capabilities: Object.freeze(["chat", "required_tool_choice", "responses", "structured_output"]),
    effortLevels: Object.freeze(["high", "max"]),
    wireContractSha256: "c688edea870c60178af66153baf00d9e6b6159b33caa3a1f75b092d2230314a7",
  }),
])

export function adapterProfile(id: string): AdapterProfile | undefined {
  return profiles.find((profile) => profile.id === id)
}

const OfficialURL = Schema.NonEmptyString.check(
  Schema.makeFilter<string>((value) => {
    const url = URL.parse(value)
    return url &&
      url.protocol === "https:" &&
      ["api.deepseek.com", "api-docs.deepseek.com", "api.moonshot.cn", "platform.kimi.com"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash
      ? undefined
      : "Evidence must use a first-party HTTPS URL"
  }),
)

export const SourceEvidence = Schema.Struct({
  url: OfficialURL,
  sha256: Sha256,
  observedAt: NonNegativeInt,
  contractRevision: Schema.NonEmptyString,
})
  .check(safe)
  .annotate({ identifier: "WorkflowModelCatalog.SourceEvidence", ...exact })
export interface SourceEvidence extends Schema.Schema.Type<typeof SourceEvidence> {}

const MissingObservation = Schema.Struct({ firstAt: NonNegativeInt, lastAt: NonNegativeInt, count: PositiveInt })
  .check(
    Schema.makeFilter((value) =>
      value.lastAt >= value.firstAt ? undefined : "Observation time cannot move backwards",
    ),
  )
  .annotate(exact)
export const ModelEntry = Schema.Struct({
  providerID: ProviderID,
  modelID: ModelID,
  displayName: Schema.NonEmptyString,
  family: Family,
  predecessor: Schema.NullOr(ModelID),
  advertisedRevision: Schema.NullOr(Schema.NonEmptyString),
  contextWindow: Schema.NullOr(PositiveInt),
  maxOutputTokens: Schema.NullOr(PositiveInt),
  capabilities: Schema.Array(Schema.NonEmptyString),
  effortLevels: Schema.Array(Schema.NonEmptyString),
  protocol: Schema.NullOr(WorkflowRole.Protocol),
  adapterProfileID: Schema.NullOr(Schema.NonEmptyString),
  adapterProfileSha256: Schema.NullOr(Sha256),
  priceSha256: Schema.NullOr(Sha256),
  evidence: Schema.Array(SourceEvidence),
  availability: Schema.Literals(["available", "missing", "unknown"]),
  compatibility: Schema.Literals(["unverified", "supported", "incompatible"]),
  lifecycle: Schema.Literals(["current", "superseded", "deprecated"]),
  missingObservation: Schema.NullOr(MissingObservation),
})
  .check(safe)
  .annotate({ identifier: "WorkflowModelCatalog.ModelEntry", ...exact })
export interface ModelEntry extends Schema.Schema.Type<typeof ModelEntry> {}

export const Catalogue = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scopeSha256: Sha256,
  observedAt: NonNegativeInt,
  models: Schema.Array(ModelEntry).check(Schema.isMaxLength(256)),
  sha256: Sha256,
})
  .check(safe)
  .annotate({ identifier: "WorkflowModelCatalog.Catalogue", ...exact })
export interface Catalogue extends Schema.Schema.Type<typeof Catalogue> {}
const Choice = Schema.Struct({ providerID: ProviderID, modelID: ModelID }).annotate(exact)
export const Policy = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scopeSha256: Sha256,
  choices: Schema.Struct({ "kimi-flagship": Choice, "deepseek-pro": Choice, "deepseek-flash": Choice }).annotate(exact),
  sha256: Sha256,
})
  .check(safe)
  .annotate({ identifier: "WorkflowModelCatalog.Policy", ...exact })
export interface Policy extends Schema.Schema.Type<typeof Policy> {}
export const Head = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scopeSha256: Sha256,
  generation: PositiveInt,
  catalogueSha256: Sha256,
  policySha256: Sha256,
  sha256: Sha256,
}).annotate({ identifier: "WorkflowModelCatalog.Head", ...exact })
export interface Head extends Schema.Schema.Type<typeof Head> {}
export const View = Schema.Struct({
  head: Schema.NullOr(Head),
  catalogue: Schema.NullOr(Catalogue),
  policy: Schema.NullOr(Policy),
  stale: Schema.Boolean,
  refreshStatus: Schema.Literals(["idle", "refreshing", "failed"]),
  failureCode: Schema.NullOr(Schema.NonEmptyString),
})
  .check(safe)
  .annotate({ identifier: "WorkflowModelCatalog.View", ...exact })
export interface View extends Schema.Schema.Type<typeof View> {}
const Replacement = Schema.Struct({ family: SelectedFamily, providerID: ProviderID, modelID: ModelID }).annotate(exact)
export const ActivationInput = Schema.Struct({
  expectedHeadSha256: Sha256,
  replacements: Schema.NonEmptyArray(Replacement).check(
    Schema.isMaxLength(3),
    Schema.makeFilter((value) =>
      new Set(value.map((entry) => entry.family)).size === value.length
        ? undefined
        : "Each family may be replaced only once",
    ),
  ),
})
  .check(safe)
  .annotate({ identifier: "WorkflowModelCatalog.ActivationInput", ...exact })
export interface ActivationInput extends Schema.Schema.Type<typeof ActivationInput> {}
export const RefreshInput = Schema.Struct({ force: Schema.Boolean }).annotate({
  identifier: "WorkflowModelCatalog.RefreshInput",
  ...exact,
})
export interface RefreshInput extends Schema.Schema.Type<typeof RefreshInput> {}
export const RouteSelection = Schema.Struct({
  providerID: ProviderID,
  modelID: ModelID,
  protocol: WorkflowRole.Protocol,
  reasoningEffort: WorkflowRole.ReasoningEffort,
  requiredCapabilities: Schema.Array(Schema.NonEmptyString),
  adapterProfileID: Schema.NonEmptyString,
  adapterProfileSha256: Sha256,
  priceSha256: Sha256,
  advertisedRevision: Schema.NullOr(Schema.NonEmptyString),
})
  .check(safe)
  .annotate({ identifier: "WorkflowModelCatalog.RouteSelection", ...exact })
export interface RouteSelection extends Schema.Schema.Type<typeof RouteSelection> {}
export const AdmissionSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  catalogueSha256: Sha256,
  policySha256: Sha256,
  scopeSha256: Sha256,
  routes: Schema.Struct({
    design: RouteSelection,
    decompose: RouteSelection,
    implement: RouteSelection,
    test: RouteSelection,
    visual_review: RouteSelection,
    repair: RouteSelection,
    deliver: RouteSelection,
  }).annotate(exact),
  sha256: Sha256,
})
  .check(safe)
  .annotate({ identifier: "WorkflowModelCatalog.AdmissionSnapshot", ...exact })
export interface AdmissionSnapshot extends Schema.Schema.Type<typeof AdmissionSnapshot> {}

export const ErrorCode = Schema.Literals([
  "invalid_metadata",
  "discovery_failed",
  "unverified_contract",
  "selection_required",
  "selection_conflict",
  "model_unavailable",
  "scope_mismatch",
  "snapshot_corrupt",
  "approval_mismatch",
])
export type ErrorCode = typeof ErrorCode.Type
export class CatalogError extends Schema.TaggedErrorClass<CatalogError>()("WorkflowModelCatalog.CatalogError", {
  code: ErrorCode,
}) {
  override get message() {
    return `Workflow model catalogue: ${this.code}`
  }
}
