export * as BenchmarkModelCatalog from "./benchmark-model-catalog"

import { Effect, Schema } from "effect"
import { WorkflowBenchmarkModels } from "@opencode-ai/schema/workflow-benchmark-models"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { WorkflowModelCatalogPolicy } from "@opencode-ai/core/workflow/model-catalog/policy"
import { WorkflowBusinessArtifact } from "@opencode-ai/core/workflow/artifacts/business"
import { ModelAvailability } from "@opencode-ai/core/workflow/model-availability"
import { ModelSelection } from "@opencode-ai/core/workflow/model-selection"
import { BenchmarkAclAuthority } from "./benchmark-acl-authority"
import { ProductionHostRuntime } from "./production-host-runtime"
import { existsSync } from "node:fs"
import path from "node:path"

const selected = {
  "kimi-flagship": "kimi-k3",
  "deepseek-pro": "deepseek-v4-pro",
  "deepseek-flash": "deepseek-v4-flash",
} as const
const invalid = () => new WorkflowModelCatalog.CatalogError({ code: "snapshot_corrupt" })

export function validate(input: unknown): WorkflowBenchmarkModels.Packet {
  try {
    const packet = Schema.decodeUnknownSync(WorkflowBenchmarkModels.Packet)(input, { onExcessProperty: "error" })
    const { catalogue, policy, snapshot } = packet
    if (
      catalogue.models.length !== 3 ||
      WorkflowModelCatalogPolicy.normalizeCatalogue(catalogue, catalogue.scopeSha256).sha256 !== catalogue.sha256 ||
      WorkflowModelCatalogPolicy.sealPolicy(policy).sha256 !== policy.sha256 ||
      policy.scopeSha256 !== catalogue.scopeSha256 ||
      snapshot.catalogueSha256 !== catalogue.sha256 ||
      snapshot.policySha256 !== policy.sha256 ||
      snapshot.scopeSha256 !== catalogue.scopeSha256
    )
      throw invalid()
    const { sha256, ...content } = snapshot
    if (WorkflowBusinessArtifact.hash(content) !== sha256) throw invalid()
    for (const role of WorkflowRole.Role.literals) {
      const required = WorkflowModelCatalogPolicy.requirements[role]
      const choice = policy.choices[required.family]
      const entry = catalogue.models.find((m) => m.providerID === choice.providerID && m.modelID === choice.modelID)
      if (!entry || entry.modelID !== selected[required.family] || !WorkflowModelCatalogPolicy.eligible(entry, role))
        throw invalid()
      const expected = {
        providerID: entry.providerID,
        modelID: entry.modelID,
        protocol: required.protocol,
        reasoningEffort: required.reasoningEffort,
        requiredCapabilities: [...required.capabilities],
        adapterProfileID: entry.adapterProfileID,
        adapterProfileSha256: entry.adapterProfileSha256,
        priceSha256: entry.priceSha256,
        advertisedRevision: entry.advertisedRevision,
      }
      if (WorkflowBusinessArtifact.encode(expected) !== WorkflowBusinessArtifact.encode(snapshot.routes[role]))
        throw invalid()
    }
    return packet
  } catch {
    throw invalid()
  }
}

/** Trusted composition only; the production loader below always uses actual native authority. */
export function fromAuthority(authority: Pick<ReturnType<typeof BenchmarkAclAuthority.make>, "modelSnapshot">) {
  const read = () => Effect.try({ try: () => validate(authority.modelSnapshot()), catch: invalid })
  return Object.freeze({
    snapshot: () => read().pipe(Effect.map((packet) => packet.snapshot)),
    check: (selection: ModelSelection.FrozenSelection) =>
      read().pipe(
        Effect.flatMap((packet) =>
          Effect.gen(function* () {
            const pinned = yield* Effect.try({ try: () => ModelSelection.validate(selection), catch: invalid })
            if (pinned.snapshot.sha256 !== packet.snapshot.sha256) return yield* Effect.fail(invalid())
            yield* ModelAvailability.checkCatalogue(pinned, packet.catalogue)
          }),
        ),
      ),
  })
}

/** Missing optional proof preserves legacy behavior; invalid present proof never falls back. */
export function load(environment: Readonly<Record<string, string | undefined>>) {
  if (environment.OPENCODE_BENCHMARK_HOST_FILE === undefined) return undefined
  if (!existsSync(path.join(path.dirname(process.execPath), "benchmark-acl-authority.json"))) return undefined
  const binding = ProductionHostRuntime.loadBenchmarkTransport(environment)
  const tempRoot = environment.OPENCODE_WORKFLOW_HOST_TEMP
  const runDataRoot = environment.OPENCODE_BENCHMARK_RUN_DATA_ROOT
  if (
    !binding ||
    binding.evidenceMode !== "production" ||
    !tempRoot ||
    !runDataRoot ||
    environment.OPENCODE_BENCHMARK_HOST_FILE !== path.join(runDataRoot, "benchmark-host.json") ||
    path.resolve(tempRoot) !== tempRoot ||
    !tempRoot.startsWith(runDataRoot + path.sep)
  )
    throw invalid()
  const authority = BenchmarkAclAuthority.make({
    binding,
    tempRoot,
    guard() {
      if (ProductionHostRuntime.loadBenchmarkTransport(environment)?.bindingSha256 !== binding.bindingSha256)
        throw invalid()
    },
  })
  if (authority.modelSnapshot() === undefined) return undefined
  return fromAuthority(authority)
}
