export * as WorkflowTestLogArtifact from "./test-log"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowTestArtifact } from "@opencode-ai/schema/workflow-test-artifact"
import { Schema } from "effect"
import { Hash } from "../../util/hash"
import { WorkflowBusinessArtifact } from "./business"

export const KIND = "workflow.test.log"
export const MIME = "text/plain; charset=utf-8"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const PayloadV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: Schema.Number,
  encoding: Schema.Literal("utf8"),
  content: Schema.String.check(
    Schema.makeFilter<string>((content) =>
      Buffer.byteLength(content, "utf8") <= WorkflowTestArtifact.MAX_LOG_BYTES
        ? undefined
        : `Test log must not exceed ${WorkflowTestArtifact.MAX_LOG_BYTES} bytes`,
    ),
  ),
}).annotate({ identifier: "WorkflowTestLogArtifact.PayloadV1", ...exact })

const PayloadV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  workflowID: DesignArtifact.SafeWorkflowID,
  stageID: Workflow.StageID,
  revision: NonNegativeInt,
  encoding: Schema.Literal("utf8"),
  content: Schema.String.check(
    Schema.makeFilter<string>((content) =>
      Buffer.byteLength(content, "utf8") <= WorkflowTestArtifact.MAX_LOG_BYTES
        ? undefined
        : `Test log must not exceed ${WorkflowTestArtifact.MAX_LOG_BYTES} bytes`,
    ),
  ),
}).annotate({ identifier: "WorkflowTestLogArtifact.PayloadV2", ...exact })

const Payload = Schema.Union([PayloadV1, PayloadV2])

export function commit(workflowID: Workflow.ID, revision: number, content: string): Workflow.ArtifactCommit {
  const owner = WorkflowBusinessArtifact.safeWorkflowID(workflowID)
  const bytes = Buffer.from(content, "utf8")
  const sha256 = Hash.sha256(bytes)
  return Workflow.ArtifactCommit.make({
    kind: KIND,
    uri: `workflow://artifact/${owner}/test-log/${sha256}.txt`,
    mime: MIME,
    sha256,
    size: bytes.byteLength,
    metadata: {
      payload: Payload.make({ schemaVersion: 1, workflowID: owner, revision, encoding: "utf8", content }),
    },
  })
}

export function commitExact(
  workflowID: Workflow.ID,
  stageID: Workflow.StageID,
  revision: number,
  content: string,
): Workflow.ArtifactCommit {
  const owner = WorkflowBusinessArtifact.safeWorkflowID(workflowID)
  const bytes = Buffer.from(content, "utf8")
  const sha256 = Hash.sha256(bytes)
  return Workflow.ArtifactCommit.make({
    kind: KIND,
    uri: exactURI(owner, stageID, revision, sha256),
    mime: MIME,
    sha256,
    size: bytes.byteLength,
    metadata: {
      payload: PayloadV2.make({
        schemaVersion: 2,
        workflowID: owner,
        stageID,
        revision,
        encoding: "utf8",
        content,
      }),
    },
  })
}

export function decode(
  artifact: Workflow.Artifact | Workflow.ArtifactCommit,
  workflowID: Workflow.ID,
  revision?: number,
): string {
  if (artifact.kind !== KIND || artifact.mime !== MIME) throw new Error("Invalid test log kind")
  const keys = Reflect.ownKeys(artifact.metadata)
  if (keys.length !== 1 || !Object.hasOwn(artifact.metadata, "payload")) throw new Error("Invalid test log metadata")
  const payload = Schema.decodeUnknownSync(Payload)(artifact.metadata.payload)
  const owner = WorkflowBusinessArtifact.safeWorkflowID(workflowID)
  const bytes = Buffer.from(payload.content, "utf8")
  const sha256 = Hash.sha256(bytes)
  if (
    payload.workflowID !== owner ||
    (revision !== undefined && payload.revision !== revision) ||
    artifact.uri !==
      (payload.schemaVersion === 1
        ? `workflow://artifact/${owner}/test-log/${sha256}.txt`
        : exactURI(owner, payload.stageID, payload.revision, sha256)) ||
    artifact.sha256 !== sha256 ||
    artifact.size !== bytes.byteLength
  )
    throw new Error("Test log identity mismatch")
  return payload.content
}

export function decodeExact(
  artifact: Workflow.Artifact | Workflow.ArtifactCommit,
  workflowID: Workflow.ID,
  stageID: Workflow.StageID,
  revision: number,
): string {
  const content = decode(artifact, workflowID, revision)
  const payload = Schema.decodeUnknownSync(PayloadV2)(artifact.metadata.payload)
  if (payload.stageID !== stageID) throw new Error("Test log stage identity mismatch")
  return content
}

function exactURI(workflowID: string, stageID: string, revision: number, sha256: string): string {
  return `workflow://artifact/${workflowID}/stages/${stageID}/test-log/r${revision}/${sha256}.txt`
}
