export * as WorkflowImplementationArtifact from "./implementation"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Manifest } from "@opencode-ai/schema/workflow-implementation-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { WorkflowBusinessArtifact } from "./business"

export const encode = WorkflowBusinessArtifact.encode

export const KIND = "workflow.implementation-manifest"
export const MIME = "application/vnd.opencode.workflow-implementation+json"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const Payload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  locationSha256: DesignArtifact.Sha256,
  artifactKind: Schema.Literal(KIND),
  manifest: Manifest,
}).annotate({ identifier: "WorkflowImplementationArtifact.Payload", ...exact })

export function hash(input: unknown): string {
  return WorkflowBusinessArtifact.hash(Schema.decodeUnknownSync(Manifest)(input))
}

export function commit(workflowID: Workflow.ID, location: Location.Ref, input: unknown): Workflow.ArtifactCommit {
  const owner = WorkflowBusinessArtifact.safeWorkflowID(workflowID)
  const manifest = Schema.decodeUnknownSync(Manifest)(input)
  if (manifest.workflowID !== owner) throw new Error("Implementation manifest belongs to a different workflow")
  const workspace = WorkflowBusinessArtifact.locationSha256(location)
  const payload = Schema.decodeUnknownSync(Payload)({
    schemaVersion: 1,
    workflowID: owner,
    revision: manifest.revision,
    locationSha256: workspace,
    artifactKind: KIND,
    manifest,
  })
  return WorkflowBusinessArtifact.commit({
    kind: KIND,
    mime: MIME,
    uri: uri(owner, workspace, manifest.revision),
    payload,
  })
}

export function decode(
  input: Workflow.ArtifactCommit,
  expectedWorkflowID: Workflow.ID,
  location: Location.Ref,
): Manifest {
  const artifact = WorkflowBusinessArtifact.requireCommit(input)
  const payload = Schema.decodeUnknownSync(Payload)(WorkflowBusinessArtifact.metadataPayload(artifact))
  const owner = WorkflowBusinessArtifact.safeWorkflowID(expectedWorkflowID)
  const workspace = WorkflowBusinessArtifact.locationSha256(location)
  if (payload.workflowID !== owner || payload.manifest.workflowID !== owner)
    throw new Error("Implementation manifest belongs to a different workflow")
  if (payload.locationSha256 !== workspace) throw new Error("Implementation manifest belongs to a different workspace")
  if (payload.revision !== payload.manifest.revision)
    throw new Error("Implementation manifest revision is not canonical")
  WorkflowBusinessArtifact.validateCommit(artifact, payload, KIND, MIME, uri(owner, workspace, payload.revision))
  return payload.manifest
}

function uri(workflowID: string, workspace: string, revision: number): string {
  return `workflow://artifact/${workflowID}/workspace-${workspace}/implementation-r${revision}.json`
}
