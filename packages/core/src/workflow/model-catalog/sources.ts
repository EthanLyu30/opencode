export * as WorkflowModelSources from "./sources"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { Schema } from "effect"
import { WorkflowModelCatalogPolicy } from "./policy"
import { WorkflowBusinessArtifact } from "../artifacts/business"

// Reviewed projection contracts, not hashes of a live account reply or evidence of model compatibility.
export const contracts = Object.freeze({
  kimi: Object.freeze({
    url: "https://platform.kimi.com/docs/api/list-models",
    endpoint: "https://api.moonshot.cn/v1/models",
    revision: "kimi-list-models-reviewed-2026-10-11",
    fields: Object.freeze([
      "id",
      "object",
      "owned_by",
      "created",
      "context_length",
      "supports_image_in",
      "supports_video_in",
      "supports_reasoning",
    ]),
  }),
  deepseek: Object.freeze({
    url: "https://api-docs.deepseek.com/api/list-models/",
    endpoint: "https://api.deepseek.com/models",
    revision: "deepseek-list-models-reviewed-2026-10-11",
    fields: Object.freeze([
      "id",
      "object",
      "owned_by",
      "name?",
      "context_window?",
      "max_output_tokens?",
      "input_modalities?",
      "output_modalities?",
      "effort?",
      "api_capabilities?",
    ]),
  }),
})

export function metadataEvidence(
  providerID: WorkflowModelCatalog.ProviderID,
  observedAt: number,
): WorkflowModelCatalog.SourceEvidence {
  const contract = contracts[providerID]
  return {
    url: contract.url,
    sha256: WorkflowBusinessArtifact.hash(contract),
    observedAt,
    contractRevision: contract.revision,
  }
}

export function verify(
  entry: WorkflowModelCatalog.ModelEntry,
  evidence: readonly WorkflowModelCatalog.SourceEvidence[],
): WorkflowModelCatalog.ModelEntry {
  const decoded = Schema.decodeUnknownOption(WorkflowModelCatalog.ModelEntry)({ ...entry, evidence })
  if (decoded._tag === "None") throw new WorkflowModelCatalog.CatalogError({ code: "invalid_metadata" })
  const origins =
    entry.providerID === "kimi"
      ? ["platform.kimi.com", "api.moonshot.cn"]
      : ["api-docs.deepseek.com", "api.deepseek.com"]
  if (!evidence.every((source) => origins.includes(new URL(source.url).hostname)))
    throw new WorkflowModelCatalog.CatalogError({ code: "invalid_metadata" })
  return {
    ...decoded.value,
    family: "unknown",
    predecessor: null,
    advertisedRevision: null,
    protocol: null,
    adapterProfileID: null,
    adapterProfileSha256: null,
    priceSha256: null,
    compatibility: "unverified",
  }
}

// Only trusted runtime composition may inject reviewed model/price contracts. No HTTP/API DTO accepts them.
// The empty production authority deliberately cannot infer these contracts from the model-list schema.
export function reviewed(entries: readonly WorkflowModelCatalog.ModelEntry[]) {
  const copies = entries.map((entry) => {
    const validated = WorkflowModelCatalogPolicy.normalizeCatalogue(
      { schemaVersion: 1, scopeSha256: "0".repeat(64), observedAt: 0, sha256: "0".repeat(64), models: [entry] },
      "0".repeat(64),
    ).models[0]!
    if (validated.compatibility !== "supported" || validated.evidence.length === 0)
      throw new WorkflowModelCatalog.CatalogError({ code: "unverified_contract" })
    return structuredClone(validated)
  })
  return Object.freeze({
    verify(entry: WorkflowModelCatalog.ModelEntry, evidence: readonly WorkflowModelCatalog.SourceEvidence[]) {
      const candidate = verify(entry, evidence)
      const contract = copies.find(
        (item) => item.providerID === candidate.providerID && item.modelID === candidate.modelID,
      )
      if (
        !contract ||
        !contract.evidence.every((source) =>
          evidence.some(
            (proof) =>
              proof.url === source.url &&
              proof.sha256 === source.sha256 &&
              proof.contractRevision === source.contractRevision,
          ),
        )
      )
        return candidate
      return {
        ...structuredClone(contract),
        capabilities: contract.capabilities.filter(
          (capability) => capability !== "vision_input" || candidate.capabilities.includes(capability),
        ),
        effortLevels:
          candidate.effortLevels.length > 0
            ? contract.effortLevels.filter((effort) => candidate.effortLevels.includes(effort))
            : [...contract.effortLevels],
        availability: candidate.availability,
        missingObservation: candidate.missingObservation,
        contextWindow: candidate.contextWindow,
        maxOutputTokens: candidate.maxOutputTokens,
        evidence: [...evidence],
      }
    },
  })
}
