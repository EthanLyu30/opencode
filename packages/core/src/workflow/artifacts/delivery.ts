export * as WorkflowDeliveryArtifact from "./delivery"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { VisualReview } from "@opencode-ai/schema/visual-review"
import { Delivery } from "@opencode-ai/schema/workflow-delivery-artifact"
import { Manifest } from "@opencode-ai/schema/workflow-implementation-artifact"
import { Result } from "@opencode-ai/schema/workflow-test-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { WorkflowBusinessArtifact } from "./business"

export const KIND = "workflow.delivery"
export const MIME = "application/vnd.opencode.workflow-delivery+json"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const Payload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  locationSha256: DesignArtifact.Sha256,
  artifactKind: Schema.Literal(KIND),
  delivery: Delivery,
}).annotate({ identifier: "WorkflowDeliveryArtifact.Payload", ...exact })

export function hashVisualReview(input: unknown): string {
  return WorkflowBusinessArtifact.hash(Schema.decodeUnknownSync(VisualReview.Artifact)(input))
}

export function commit(workflowID: Workflow.ID, location: Location.Ref, input: unknown): Workflow.ArtifactCommit {
  const owner = WorkflowBusinessArtifact.safeWorkflowID(workflowID)
  const delivery = Schema.decodeUnknownSync(Delivery)(input)
  if (delivery.workflowID !== owner) throw new Error("Delivery belongs to a different workflow")
  const workspace = WorkflowBusinessArtifact.locationSha256(location)
  const payload = Schema.decodeUnknownSync(Payload)({
    schemaVersion: 1,
    workflowID: owner,
    revision: delivery.revision,
    locationSha256: workspace,
    artifactKind: KIND,
    delivery,
  })
  return WorkflowBusinessArtifact.commit({
    kind: KIND,
    mime: MIME,
    uri: uri(owner, workspace, delivery.revision),
    payload,
  })
}

export function decode(
  input: Workflow.ArtifactCommit,
  expectedWorkflowID: Workflow.ID,
  location: Location.Ref,
): Delivery {
  const artifact = WorkflowBusinessArtifact.requireCommit(input)
  const payload = Schema.decodeUnknownSync(Payload)(WorkflowBusinessArtifact.metadataPayload(artifact))
  const owner = WorkflowBusinessArtifact.safeWorkflowID(expectedWorkflowID)
  const workspace = WorkflowBusinessArtifact.locationSha256(location)
  if (payload.workflowID !== owner || payload.delivery.workflowID !== owner)
    throw new Error("Delivery belongs to a different workflow")
  if (payload.locationSha256 !== workspace) throw new Error("Delivery belongs to a different workspace")
  if (payload.revision !== payload.delivery.revision) throw new Error("Delivery revision is not canonical")
  WorkflowBusinessArtifact.validateCommit(artifact, payload, KIND, MIME, uri(owner, workspace, payload.revision))
  return payload.delivery
}

export function validateDelivery(input: {
  readonly delivery: Delivery
  readonly manifest: Manifest
  readonly test: Result
  readonly review: VisualReview.Artifact
}): void {
  const delivery = Schema.decodeUnknownSync(Delivery)(input.delivery)
  const manifest = Schema.decodeUnknownSync(Manifest)(input.manifest)
  const test = Schema.decodeUnknownSync(Result)(input.test)
  const review = Schema.decodeUnknownSync(VisualReview.Artifact)(input.review)
  if (
    manifest.workflowID !== delivery.workflowID ||
    test.workflowID !== delivery.workflowID ||
    review.evidence.some((image) => image.workflowID !== delivery.workflowID)
  )
    throw new Error("Delivery artifacts must belong to the same workflow")
  if (
    manifest.revision !== delivery.revision ||
    test.revision !== delivery.revision ||
    review.revision !== delivery.revision
  )
    throw new Error("Delivery artifacts must use the latest revision")
  const implementationSha256 = WorkflowBusinessArtifact.hash(manifest)
  if (delivery.implementationSha256 !== implementationSha256 || test.implementationSha256 !== implementationSha256)
    throw new Error("Delivery does not reference the exact implementation manifest")
  if (delivery.testSha256 !== WorkflowBusinessArtifact.hash(test))
    throw new Error("Delivery does not reference the exact test result")
  if (delivery.visualReviewSha256 !== WorkflowBusinessArtifact.hash(review))
    throw new Error("Delivery does not reference the exact visual review")
  if (test.verdict !== "pass" || test.tests.some((record) => record.exitCode !== 0))
    throw new Error("Delivery requires passing functional tests")
  if (review.verdict !== "pass" || review.findings.length !== 0)
    throw new Error("Delivery requires a passing visual review")
}

function uri(workflowID: string, workspace: string, revision: number): string {
  return `workflow://artifact/${workflowID}/workspace-${workspace}/delivery-r${revision}.json`
}
