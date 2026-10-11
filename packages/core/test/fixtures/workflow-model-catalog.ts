import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowModelCatalogPolicy } from "../../src/workflow/model-catalog/policy"

export const fixtureScope = "a".repeat(64)

export function fixtureEntry(
  family: WorkflowModelCatalog.SelectedFamily,
  overrides: Partial<WorkflowModelCatalog.ModelEntry> = {},
): WorkflowModelCatalog.ModelEntry {
  const providerID = family === "kimi-flagship" ? "kimi" : "deepseek"
  const profile = WorkflowModelCatalog.adapterProfile(
    providerID === "kimi" ? "kimi-chat-k3-v1" : "deepseek-responses-v4-v1",
  )!
  return {
    providerID,
    modelID: family === "kimi-flagship" ? "kimi-k3" : `deepseek-v4-${family === "deepseek-pro" ? "pro" : "flash"}`,
    displayName: "Offline fixture only",
    family,
    predecessor: null,
    advertisedRevision: "offline-fixture-v1",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    capabilities: [...profile.capabilities],
    effortLevels: [...profile.effortLevels],
    protocol: profile.protocol,
    adapterProfileID: profile.id,
    adapterProfileSha256: profile.wireContractSha256,
    priceSha256: "b".repeat(64),
    evidence: [
      {
        url:
          providerID === "kimi"
            ? "https://platform.kimi.com/docs/api/overview"
            : "https://api-docs.deepseek.com/api/create-response/",
        sha256: "c".repeat(64),
        observedAt: 0,
        contractRevision: "offline-fixture-only",
      },
    ],
    availability: "available",
    compatibility: "supported",
    lifecycle: "current",
    missingObservation: null,
    ...overrides,
  }
}

export function fixtureCatalogue(
  overrides: Partial<WorkflowModelCatalog.Catalogue> = {},
): WorkflowModelCatalog.Catalogue {
  return WorkflowModelCatalogPolicy.normalizeCatalogue(
    {
      schemaVersion: 1,
      scopeSha256: fixtureScope,
      observedAt: 0,
      models: [fixtureEntry("kimi-flagship"), fixtureEntry("deepseek-pro"), fixtureEntry("deepseek-flash")],
      sha256: "0".repeat(64),
      ...overrides,
    },
    overrides.scopeSha256 ?? fixtureScope,
  )
}

export function fixturePolicy(catalogue: WorkflowModelCatalog.Catalogue): WorkflowModelCatalog.Policy {
  const choices = {
    "kimi-flagship": { providerID: "kimi", modelID: "kimi-k3" },
    "deepseek-pro": { providerID: "deepseek", modelID: "deepseek-v4-pro" },
    "deepseek-flash": { providerID: "deepseek", modelID: "deepseek-v4-flash" },
  } as const
  return WorkflowModelCatalogPolicy.sealPolicy({ schemaVersion: 1, scopeSha256: catalogue.scopeSha256, choices })
}

export function fixtureDiscovery(
  providerID: WorkflowModelCatalog.ProviderID,
  entries: readonly WorkflowModelCatalog.ModelEntry[],
): unknown {
  return {
    object: "list",
    data: entries
      .filter((entry) => entry.providerID === providerID)
      .map((entry) =>
        providerID === "kimi"
          ? {
              id: entry.modelID,
              object: "model",
              owned_by: "moonshot",
              created: 123,
              context_length: entry.contextWindow ?? 65536,
              supports_image_in: true,
              supports_video_in: false,
              supports_reasoning: true,
            }
          : { id: entry.modelID, object: "model", owned_by: providerID },
      ),
  }
}
