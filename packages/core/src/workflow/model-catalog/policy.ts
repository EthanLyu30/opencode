export * as WorkflowModelCatalogPolicy from "./policy"

import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Option, Schema } from "effect"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowSecretGuard } from "../secret-guard"

const kimiCapabilities = ["chat", "reasoning_replay", "structured_output", "required_tool_choice"] as const
const responsesCapabilities = ["responses", "structured_output", "required_tool_choice"] as const

export const requirements = {
  design: {
    family: "kimi-flagship",
    providerID: "kimi",
    protocol: "openai-chat",
    reasoningEffort: "max",
    capabilities: kimiCapabilities,
  },
  decompose: {
    family: "kimi-flagship",
    providerID: "kimi",
    protocol: "openai-chat",
    reasoningEffort: "high",
    capabilities: kimiCapabilities,
  },
  visual_review: {
    family: "kimi-flagship",
    providerID: "kimi",
    protocol: "openai-chat",
    reasoningEffort: "max",
    capabilities: [...kimiCapabilities, "vision_input"],
  },
  implement: {
    family: "deepseek-pro",
    providerID: "deepseek",
    protocol: "openai-responses",
    reasoningEffort: "max",
    capabilities: responsesCapabilities,
  },
  repair: {
    family: "deepseek-pro",
    providerID: "deepseek",
    protocol: "openai-responses",
    reasoningEffort: "max",
    capabilities: responsesCapabilities,
  },
  deliver: {
    family: "deepseek-pro",
    providerID: "deepseek",
    protocol: "openai-responses",
    reasoningEffort: "high",
    capabilities: responsesCapabilities,
  },
  test: {
    family: "deepseek-flash",
    providerID: "deepseek",
    protocol: "openai-responses",
    reasoningEffort: "high",
    capabilities: responsesCapabilities,
  },
} as const satisfies Record<
  WorkflowRole.Role,
  {
    family: WorkflowModelCatalog.SelectedFamily
    providerID: WorkflowModelCatalog.ProviderID
    protocol: WorkflowRole.Protocol
    reasoningEffort: WorkflowRole.ReasoningEffort
    capabilities: readonly string[]
  }
>

const deniedKimi = (entry: WorkflowModelCatalog.ModelEntry) =>
  entry.providerID === "kimi" && /^(?:kimi[-_:])?k?2(?:[._:-]|$)/i.test(entry.modelID)
const key = (entry: { providerID: string; modelID: string }) => `${entry.providerID}\u0000${entry.modelID}`
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const error = (code: WorkflowModelCatalog.ErrorCode = "invalid_metadata") =>
  new WorkflowModelCatalog.CatalogError({ code })

export function normalizeCatalogue(input: unknown, scopeSha256: string): WorkflowModelCatalog.Catalogue {
  const decoded = Schema.decodeUnknownOption(WorkflowModelCatalog.Catalogue)(input)
  if (Option.isNone(decoded)) throw error()
  const value = decoded.value
  if (value.scopeSha256 !== scopeSha256) throw error("scope_mismatch")
  if (new Set(value.models.map(key)).size !== value.models.length) throw error()
  const models = value.models
    .map((entry) => {
      if (
        new Set(entry.capabilities).size !== entry.capabilities.length ||
        new Set(entry.effortLevels).size !== entry.effortLevels.length
      )
        throw error()
      if (entry.predecessor === entry.modelID) throw error()
      const normalized = {
        ...entry,
        capabilities: [...entry.capabilities].sort(compare),
        effortLevels: [...entry.effortLevels].sort(compare),
        evidence: [...entry.evidence].sort((a, b) =>
          compare(`${a.url}\u0000${a.sha256}\u0000${a.observedAt}`, `${b.url}\u0000${b.sha256}\u0000${b.observedAt}`),
        ),
      }
      if (entry.compatibility === "supported" && !validProfile(normalized)) throw error("unverified_contract")
      return normalized
    })
    .sort((a, b) => compare(key(a), key(b)))
  for (const entry of models) {
    const seen = new Set<string>([entry.modelID])
    let predecessor = entry.predecessor
    while (predecessor !== null) {
      if (seen.has(predecessor)) throw error()
      seen.add(predecessor)
      const parent = models.find((model) => model.providerID === entry.providerID && model.modelID === predecessor)
      if (!parent) break // Incomplete lineage stays a visible candidate, but cannot activate.
      if (parent.family !== entry.family) throw error()
      predecessor = parent.predecessor
    }
  }
  const content = { schemaVersion: 1 as const, scopeSha256: value.scopeSha256, observedAt: value.observedAt, models }
  WorkflowSecretGuard.assertSafe(content)
  return { ...content, sha256: WorkflowBusinessArtifact.hash(content) }
}
export function sealPolicy(input: Omit<WorkflowModelCatalog.Policy, "sha256">): WorkflowModelCatalog.Policy {
  const value = Schema.decodeUnknownOption(WorkflowModelCatalog.Policy)({ ...input, sha256: "0".repeat(64) })
  if (Option.isNone(value)) throw error()
  if (
    value.value.choices["kimi-flagship"].providerID !== "kimi" ||
    value.value.choices["deepseek-pro"].providerID !== "deepseek" ||
    value.value.choices["deepseek-flash"].providerID !== "deepseek"
  )
    throw error()
  const content = { schemaVersion: 1 as const, scopeSha256: value.value.scopeSha256, choices: value.value.choices }
  return { ...content, sha256: WorkflowBusinessArtifact.hash(content) }
}
export function eligible(entry: WorkflowModelCatalog.ModelEntry, role: WorkflowRole.Role): boolean {
  const decoded = Schema.decodeUnknownOption(WorkflowModelCatalog.ModelEntry)(entry)
  if (Option.isNone(decoded)) return false
  const required = requirements[role]
  return (
    !deniedKimi(entry) &&
    entry.family === required.family &&
    entry.providerID === required.providerID &&
    entry.protocol === required.protocol &&
    entry.availability === "available" &&
    entry.compatibility === "supported" &&
    entry.lifecycle === "current" &&
    entry.priceSha256 !== null &&
    validProfile(entry) &&
    entry.effortLevels.includes(required.reasoningEffort) &&
    required.capabilities.every((capability) => entry.capabilities.includes(capability))
  )
}
export function mergeObservation(
  previous: WorkflowModelCatalog.Catalogue | null,
  observed: WorkflowModelCatalog.Catalogue,
  now: number,
): WorkflowModelCatalog.Catalogue {
  if (!Number.isSafeInteger(now) || now < 0 || now < (previous?.observedAt ?? 0) || now < observed.observedAt)
    throw error()
  const current = normalizeCatalogue(observed, observed.scopeSha256)
  if (previous === null) return normalizeCatalogue({ ...current, observedAt: now }, current.scopeSha256)
  const before = normalizeCatalogue(previous, current.scopeSha256)
  const identities = new Set(current.models.map(key))
  const models = [
    ...current.models.map((entry) => {
      const old = before.models.find((item) => key(item) === key(entry))
      return {
        ...entry,
        availability: "available" as const,
        missingObservation: null,
        lifecycle: old?.lifecycle === "superseded" || old?.lifecycle === "deprecated" ? old.lifecycle : entry.lifecycle,
      }
    }),
    ...before.models
      .filter((entry) => !identities.has(key(entry)))
      .map((entry) => {
        const firstAt = entry.missingObservation?.firstAt ?? now
        const count = (entry.missingObservation?.count ?? 0) + (entry.missingObservation?.lastAt === now ? 0 : 1)
        return {
          ...entry,
          availability: count >= 2 && now - firstAt >= 3600000 ? ("missing" as const) : entry.availability,
          missingObservation: { firstAt, lastAt: now, count },
        }
      }),
  ]
  return normalizeCatalogue({ ...current, observedAt: now, models }, current.scopeSha256)
}
export function replacePolicy(input: {
  catalogue: WorkflowModelCatalog.Catalogue
  policy: WorkflowModelCatalog.Policy
  replacements: WorkflowModelCatalog.ActivationInput["replacements"]
}): { catalogue: WorkflowModelCatalog.Catalogue; policy: WorkflowModelCatalog.Policy } {
  const catalogue = normalizeCatalogue(input.catalogue, input.policy.scopeSha256)
  const policy = sealPolicy(input.policy)
  if (policy.sha256 !== input.policy.sha256 || catalogue.sha256 !== input.catalogue.sha256)
    throw error("snapshot_corrupt")
  const activation = Schema.decodeUnknownOption(WorkflowModelCatalog.ActivationInput)({
    expectedHeadSha256: "0".repeat(64),
    replacements: input.replacements,
  })
  if (Option.isNone(activation)) throw error()
  const choices = { ...policy.choices }
  const retired = new Set<string>()
  for (const replacement of activation.value.replacements) {
    const entry = catalogue.models.find((model) => key(model) === key(replacement))
    const roles = Object.entries(requirements)
      .filter(([, requirement]) => requirement.family === replacement.family)
      .map(([role]) => role as WorkflowRole.Role)
    if (!entry || !roles.every((role) => eligible(entry, role))) throw error("unverified_contract")
    const current = choices[replacement.family]
    if (entry.modelID !== current.modelID) {
      if (!descendsFrom(catalogue, entry, current.modelID)) throw error("unverified_contract")
      retired.add(key(current))
    }
    choices[replacement.family] = { providerID: entry.providerID, modelID: entry.modelID }
  }
  return {
    catalogue: normalizeCatalogue(
      {
        ...catalogue,
        models: catalogue.models.map((entry) =>
          retired.has(key(entry)) ? { ...entry, lifecycle: "superseded" } : entry,
        ),
      },
      catalogue.scopeSha256,
    ),
    policy: sealPolicy({ ...policy, choices }),
  }
}

function validProfile(entry: WorkflowModelCatalog.ModelEntry): boolean {
  const profile =
    entry.adapterProfileID === null ? undefined : WorkflowModelCatalog.adapterProfile(entry.adapterProfileID)
  const origins =
    entry.providerID === "kimi"
      ? ["api.moonshot.cn", "platform.kimi.com"]
      : ["api.deepseek.com", "api-docs.deepseek.com"]
  return (
    profile !== undefined &&
    entry.evidence.length > 0 &&
    entry.evidence.every((evidence) => origins.includes(URL.parse(evidence.url)?.hostname ?? "")) &&
    profile.providerID === entry.providerID &&
    profile.protocol === entry.protocol &&
    profile.wireContractSha256 === entry.adapterProfileSha256 &&
    entry.capabilities.every((capability) => profile.capabilities.includes(capability)) &&
    entry.effortLevels.every((effort) => profile.effortLevels.includes(effort))
  )
}

function descendsFrom(
  catalogue: WorkflowModelCatalog.Catalogue,
  entry: WorkflowModelCatalog.ModelEntry,
  ancestor: string,
): boolean {
  const seen = new Set<string>([entry.modelID])
  let predecessor = entry.predecessor
  while (predecessor !== null) {
    if (seen.has(predecessor)) return false
    seen.add(predecessor)
    const previous = catalogue.models.find(
      (model) =>
        model.providerID === entry.providerID && model.modelID === predecessor && model.family === entry.family,
    )
    if (!previous || previous.compatibility !== "supported" || !validProfile(previous)) return false
    if (previous.modelID === ancestor) return true
    predecessor = previous.predecessor
  }
  return false
}
