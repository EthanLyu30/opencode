import {
  fixtureCatalogue,
  fixturePolicy,
  fixtureAdmissionSnapshot,
} from "../../../core/test/fixtures/workflow-model-catalog"
import { WorkflowBusinessArtifact } from "@opencode-ai/core/workflow/artifacts/business"

export function benchmarkModelPacket() {
  const catalogue = fixtureCatalogue()
  const policy = fixturePolicy(catalogue)
  const { sha256: _, ...before } = fixtureAdmissionSnapshot()
  const content = { ...before, policySha256: policy.sha256 }
  return {
    kind: "task24.zero-cost-models.v1" as const,
    catalogue,
    policy,
    snapshot: { ...content, sha256: WorkflowBusinessArtifact.hash(content) },
  }
}
