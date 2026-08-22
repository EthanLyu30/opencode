export * as WorkflowTestArtifact from "./test"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Result } from "@opencode-ai/schema/workflow-test-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { WorkflowBusinessArtifact } from "./business"

export const KIND = "workflow.test.result"
export const MIME = "application/vnd.opencode.workflow-test+json"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const Payload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  locationSha256: DesignArtifact.Sha256,
  artifactKind: Schema.Literal(KIND),
  result: Result,
}).annotate({ identifier: "WorkflowTestArtifact.Payload", ...exact })

export function hash(input: unknown): string {
  return WorkflowBusinessArtifact.hash(Schema.decodeUnknownSync(Result)(input))
}

export function commit(workflowID: Workflow.ID, location: Location.Ref, input: unknown): Workflow.ArtifactCommit {
  const owner = WorkflowBusinessArtifact.safeWorkflowID(workflowID)
  const result = Schema.decodeUnknownSync(Result)(input)
  if (result.workflowID !== owner) throw new Error("Test result belongs to a different workflow")
  const workspace = WorkflowBusinessArtifact.locationSha256(location)
  const payload = Schema.decodeUnknownSync(Payload)({
    schemaVersion: 1,
    workflowID: owner,
    revision: result.revision,
    locationSha256: workspace,
    artifactKind: KIND,
    result,
  })
  return WorkflowBusinessArtifact.commit({
    kind: KIND,
    mime: MIME,
    uri: uri(owner, workspace, result.revision),
    payload,
  })
}

export function decode(
  input: Workflow.ArtifactCommit,
  expectedWorkflowID: Workflow.ID,
  location: Location.Ref,
): Result {
  const artifact = WorkflowBusinessArtifact.requireCommit(input)
  const payload = Schema.decodeUnknownSync(Payload)(WorkflowBusinessArtifact.metadataPayload(artifact))
  const owner = WorkflowBusinessArtifact.safeWorkflowID(expectedWorkflowID)
  const workspace = WorkflowBusinessArtifact.locationSha256(location)
  if (payload.workflowID !== owner || payload.result.workflowID !== owner)
    throw new Error("Test result belongs to a different workflow")
  if (payload.locationSha256 !== workspace) throw new Error("Test result belongs to a different workspace")
  if (payload.revision !== payload.result.revision) throw new Error("Test result revision is not canonical")
  WorkflowBusinessArtifact.validateCommit(artifact, payload, KIND, MIME, uri(owner, workspace, payload.revision))
  return payload.result
}

function uri(workflowID: string, workspace: string, revision: number): string {
  return `workflow://artifact/${workflowID}/workspace-${workspace}/test-r${revision}.json`
}
