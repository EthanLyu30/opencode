export * as WorkflowDecompositionArtifact from "./decomposition"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Plan } from "@opencode-ai/schema/workflow-decomposition-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { WorkflowBusinessArtifact } from "./business"

export const KIND = "workflow.decomposition.plan"
export const MIME = "application/vnd.opencode.workflow-decomposition+json"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const Payload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  locationSha256: DesignArtifact.Sha256,
  artifactKind: Schema.Literal(KIND),
  plan: Plan,
}).annotate({ identifier: "WorkflowDecompositionArtifact.Payload", ...exact })

export function commit(workflowID: Workflow.ID, location: Location.Ref, input: unknown): Workflow.ArtifactCommit {
  const owner = WorkflowBusinessArtifact.safeWorkflowID(workflowID)
  const plan = Schema.decodeUnknownSync(Plan)(input)
  if (plan.workflowID !== owner) throw new Error("Decomposition plan belongs to a different workflow")
  const workspace = WorkflowBusinessArtifact.locationSha256(location)
  const payload = Schema.decodeUnknownSync(Payload)({
    schemaVersion: 1,
    workflowID: owner,
    revision: plan.revision,
    locationSha256: workspace,
    artifactKind: KIND,
    plan,
  })
  return WorkflowBusinessArtifact.commit({ kind: KIND, mime: MIME, uri: uri(owner, workspace, plan.revision), payload })
}

export function decode(input: Workflow.ArtifactCommit, expectedWorkflowID: Workflow.ID, location: Location.Ref): Plan {
  const artifact = WorkflowBusinessArtifact.requireCommit(input)
  const payload = Schema.decodeUnknownSync(Payload)(WorkflowBusinessArtifact.metadataPayload(artifact))
  const owner = WorkflowBusinessArtifact.safeWorkflowID(expectedWorkflowID)
  const workspace = WorkflowBusinessArtifact.locationSha256(location)
  if (payload.workflowID !== owner || payload.plan.workflowID !== owner)
    throw new Error("Decomposition plan belongs to a different workflow")
  if (payload.locationSha256 !== workspace) throw new Error("Decomposition plan belongs to a different workspace")
  if (payload.revision !== payload.plan.revision) throw new Error("Decomposition plan revision is not canonical")
  WorkflowBusinessArtifact.validateCommit(artifact, payload, KIND, MIME, uri(owner, workspace, payload.revision))
  return payload.plan
}

function uri(workflowID: string, workspace: string, revision: number): string {
  return `workflow://artifact/${workflowID}/workspace-${workspace}/decomposition-r${revision}.json`
}
