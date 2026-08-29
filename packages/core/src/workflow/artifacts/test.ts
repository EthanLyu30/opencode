export * as WorkflowTestArtifact from "./test"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Result, ResultV2 } from "@opencode-ai/schema/workflow-test-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { WorkflowBusinessArtifact } from "./business"

export const KIND = "workflow.test.result"
export const MIME = "application/vnd.opencode.workflow-test+json"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const PayloadV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  locationSha256: DesignArtifact.Sha256,
  artifactKind: Schema.Literal(KIND),
  result: Result,
}).annotate({ identifier: "WorkflowTestArtifact.PayloadV1", ...exact })
const PayloadV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  workflowID: DesignArtifact.SafeWorkflowID,
  stageID: Workflow.StageID,
  revision: NonNegativeInt,
  locationSha256: DesignArtifact.Sha256,
  artifactKind: Schema.Literal(KIND),
  result: ResultV2,
}).annotate({ identifier: "WorkflowTestArtifact.PayloadV2", ...exact })
const Payload = Schema.Union([PayloadV1, PayloadV2])

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

export function commitExact(
  workflowID: Workflow.ID,
  stageID: Workflow.StageID,
  location: Location.Ref,
  input: unknown,
): Workflow.ArtifactCommit {
  const owner = WorkflowBusinessArtifact.safeWorkflowID(workflowID)
  const result = Schema.decodeUnknownSync(ResultV2)(input)
  if (result.workflowID !== owner || result.stageID !== stageID)
    throw new Error("Test result belongs to a different workflow or stage")
  const workspace = WorkflowBusinessArtifact.locationSha256(location)
  const payload = Schema.decodeUnknownSync(PayloadV2)({
    schemaVersion: 2,
    workflowID: owner,
    stageID,
    revision: result.revision,
    locationSha256: workspace,
    artifactKind: KIND,
    result,
  })
  return WorkflowBusinessArtifact.commit({
    kind: KIND,
    mime: MIME,
    uri: exactURI(owner, stageID, workspace, result.revision),
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
  WorkflowBusinessArtifact.validateCommit(
    artifact,
    payload,
    KIND,
    MIME,
    payload.schemaVersion === 1
      ? uri(owner, workspace, payload.revision)
      : exactURI(owner, payload.stageID, workspace, payload.revision),
  )
  return payload.result
}

export function decodeExact(
  input: Workflow.ArtifactCommit,
  expectedWorkflowID: Workflow.ID,
  stageID: Workflow.StageID,
  location: Location.Ref,
): typeof ResultV2.Type {
  const result = Schema.decodeUnknownSync(ResultV2)(decode(input, expectedWorkflowID, location))
  if (result.stageID !== stageID) throw new Error("Test result belongs to a different stage")
  return result
}

function uri(workflowID: string, workspace: string, revision: number): string {
  return `workflow://artifact/${workflowID}/workspace-${workspace}/test-r${revision}.json`
}

function exactURI(workflowID: string, stageID: string, workspace: string, revision: number): string {
  return `workflow://artifact/${workflowID}/stages/${stageID}/workspace-${workspace}/test-r${revision}.json`
}
