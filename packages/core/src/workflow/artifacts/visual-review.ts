export * as WorkflowVisualReviewArtifact from "./visual-review"

import { Message } from "@opencode-ai/llm"
import { VisualReview } from "@opencode-ai/schema/visual-review"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { Hash } from "../../util/hash"
import { WorkflowSecretGuard } from "../secret-guard"
import { WorkflowDesignArtifact } from "./design"

export const REVIEW_KIND = "workflow.visual-review"
export const REVIEW_MIME = "application/vnd.opencode.visual-review+json"
export const REFERENCE_SCREENSHOT_KIND = "workflow.visual.reference-screenshot"
export const IMPLEMENTATION_SCREENSHOT_KIND = "workflow.visual.implementation-screenshot"

export interface CapturedImage extends VisualReview.EvidenceImage {
  readonly bytes: Uint8Array
}

export function capturedImage(input: {
  readonly workflowID: Workflow.ID
  readonly kind: "reference" | "implementation"
  readonly viewport: string
  readonly revision: number
  readonly bytes: Uint8Array
}): CapturedImage {
  if (input.bytes.byteLength === 0) throw new Error("Browser capture returned an empty PNG")
  const suffix = input.kind === "reference" ? "" : `-r${input.revision}`
  return {
    id: `${input.kind}-${input.viewport}${suffix}`,
    kind: input.kind,
    viewport: input.viewport,
    uri: `workflow://${input.workflowID}/${input.kind}-screenshot-${input.viewport}${suffix}.png`,
    mime: "image/png",
    sha256: Hash.sha256(Buffer.from(input.bytes)),
    size: input.bytes.byteLength,
    bytes: input.bytes,
  }
}

export function commitScreenshot(image: CapturedImage): Workflow.ArtifactCommit {
  const { bytes, ...metadata } = image
  WorkflowSecretGuard.assertSafe(metadata)
  return Workflow.ArtifactCommit.make({
    kind: image.kind === "reference" ? REFERENCE_SCREENSHOT_KIND : IMPLEMENTATION_SCREENSHOT_KIND,
    uri: image.uri,
    mime: image.mime,
    sha256: Hash.sha256(Buffer.from(bytes)),
    size: bytes.byteLength,
    metadata,
  })
}

export function reviewMessage(spec: unknown, images: ReadonlyArray<CapturedImage>): Message {
  const evidence = images.map(({ bytes: _, ...image }) => image)
  Schema.decodeUnknownSync(VisualReview.Artifact)(placeholderReview(evidence))
  return Message.user([
    {
      type: "text",
      text: `Compare the browser-rendered reference and implementation images against this design specification. Return only strict visual-review.json.\n${WorkflowDesignArtifact.encode(spec)}`,
    },
    ...images.map((image) => ({
      type: "media" as const,
      mediaType: "image/png",
      data: image.bytes,
      filename: `${image.id}.png`,
      metadata: { imageID: image.id, kind: image.kind, viewport: image.viewport },
    })),
  ])
}

export function commitReview(workflowID: Workflow.ID, input: unknown): Workflow.ArtifactCommit {
  WorkflowSecretGuard.assertSafe(input)
  const review = Schema.decodeUnknownSync(VisualReview.Artifact)(input)
  const body = WorkflowDesignArtifact.encode(review)
  const encoded = new TextEncoder().encode(body)
  return Workflow.ArtifactCommit.make({
    kind: REVIEW_KIND,
    uri: `workflow://${workflowID}/visual-review-r${review.revision}.json`,
    mime: REVIEW_MIME,
    sha256: Hash.sha256(Buffer.from(encoded)),
    size: encoded.byteLength,
    metadata: {
      schemaVersion: review.schemaVersion,
      revision: review.revision,
      verdict: review.verdict,
      score: review.score,
    },
  })
}

export function decodeReview(artifact: Workflow.ArtifactCommit, body: string): VisualReview.Artifact {
  WorkflowSecretGuard.assertSafe(artifact)
  const encoded = new TextEncoder().encode(body)
  if (
    artifact.kind !== REVIEW_KIND ||
    artifact.mime !== REVIEW_MIME ||
    artifact.sha256 !== Hash.sha256(Buffer.from(encoded)) ||
    artifact.size !== encoded.byteLength
  ) {
    throw new Error("Visual review body does not match its durable commit")
  }
  const value = JSON.parse(body)
  WorkflowSecretGuard.assertSafe(value)
  return Schema.decodeUnknownSync(VisualReview.Artifact)(value)
}

function placeholderReview(evidence: ReadonlyArray<VisualReview.EvidenceImage>): VisualReview.Artifact {
  const [first, ...rest] = evidence
  if (!first) throw new Error("Visual review requires screenshot evidence")
  return {
    schemaVersion: 1,
    revision: 0,
    verdict: "pass",
    score: 100,
    limits: { maxRevisions: 1, maxTokens: 1, maxTurns: 1, maxToolCalls: 1 },
    usage: { tokens: 0, turns: 0, toolCalls: 0 },
    evidence: [first, ...rest],
    findings: [],
  }
}
