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

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const ScreenshotPayload = Schema.Struct({
  image: VisualReview.EvidenceImage,
  dataBase64: Schema.String,
}).annotate({ identifier: "WorkflowVisualReviewArtifact.ScreenshotPayload", ...exact })

const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface CapturedImage extends VisualReview.EvidenceImage {
  readonly bytes: Uint8Array
}

export function assertPng(bytes: Uint8Array): void {
  if (bytes.byteLength < pngSignature.byteLength) throw new Error("Browser capture is not a PNG")
  for (let index = 0; index < pngSignature.byteLength; index++) {
    if (bytes[index] !== pngSignature[index]) throw new Error("Browser capture is not a PNG")
  }
}

export function capturedImage(input: {
  readonly workflowID: Workflow.ID
  readonly kind: "reference" | "implementation"
  readonly viewport: string
  readonly revision: number
  readonly bytes: Uint8Array
}): CapturedImage {
  assertPng(input.bytes)
  if (input.kind === "reference" && input.revision !== 0)
    throw new Error("Reference screenshots must use revision zero")
  const viewport = Schema.decodeUnknownSync(VisualReview.EvidenceImage.fields.viewport)(input.viewport)
  const suffix = input.kind === "reference" ? "" : `-r${input.revision}`
  const metadata = Schema.decodeUnknownSync(VisualReview.EvidenceImage)({
    id: `${input.kind}-${viewport}${suffix}`,
    kind: input.kind,
    viewport,
    revision: input.revision,
    uri: `workflow://${input.workflowID}/${input.kind}-screenshot-${viewport}${suffix}.png`,
    mime: "image/png",
    sha256: Hash.sha256(Buffer.from(input.bytes)),
    size: input.bytes.byteLength,
  })
  return { ...metadata, bytes: input.bytes }
}

export function commitScreenshot(image: CapturedImage): Workflow.ArtifactCommit {
  assertPng(image.bytes)
  const { bytes, ...rawMetadata } = image
  WorkflowSecretGuard.assertSafe(rawMetadata)
  const metadata = Schema.decodeUnknownSync(VisualReview.EvidenceImage)(rawMetadata)
  const sha256 = Hash.sha256(Buffer.from(bytes))
  if (metadata.sha256 !== sha256 || metadata.size !== bytes.byteLength)
    throw new Error("Screenshot metadata does not match its PNG bytes")
  const payload = Schema.decodeUnknownSync(ScreenshotPayload)({
    image: metadata,
    dataBase64: Buffer.from(bytes).toString("base64"),
  })
  return Workflow.ArtifactCommit.make({
    kind: image.kind === "reference" ? REFERENCE_SCREENSHOT_KIND : IMPLEMENTATION_SCREENSHOT_KIND,
    uri: image.uri,
    mime: image.mime,
    sha256,
    size: bytes.byteLength,
    metadata: { payload },
  })
}

export function decodeScreenshot(artifact: Workflow.ArtifactCommit): CapturedImage {
  WorkflowSecretGuard.assertSafe(artifact)
  const payload = Schema.decodeUnknownSync(ScreenshotPayload)(metadataPayload(artifact))
  const bytes = Uint8Array.from(Buffer.from(payload.dataBase64, "base64"))
  if (Buffer.from(bytes).toString("base64") !== payload.dataBase64)
    throw new Error("Screenshot base64 is not canonical")
  assertPng(bytes)
  const expectedKind = payload.image.kind === "reference" ? REFERENCE_SCREENSHOT_KIND : IMPLEMENTATION_SCREENSHOT_KIND
  const sha256 = Hash.sha256(Buffer.from(bytes))
  if (
    artifact.kind !== expectedKind ||
    artifact.uri !== payload.image.uri ||
    artifact.mime !== "image/png" ||
    payload.image.mime !== "image/png" ||
    artifact.sha256 !== sha256 ||
    payload.image.sha256 !== sha256 ||
    artifact.size !== bytes.byteLength ||
    payload.image.size !== bytes.byteLength
  ) {
    throw new Error("Screenshot payload does not match its durable commit")
  }
  return { ...payload.image, bytes }
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
      metadata: { imageID: image.id, kind: image.kind, viewport: image.viewport, revision: image.revision },
    })),
  ])
}

export function commitReview(workflowID: Workflow.ID, input: unknown): Workflow.ArtifactCommit {
  WorkflowSecretGuard.assertSafe(input)
  const payload = Schema.decodeUnknownSync(VisualReview.Artifact)(input)
  const body = WorkflowDesignArtifact.encode(payload)
  const encoded = new TextEncoder().encode(body)
  return Workflow.ArtifactCommit.make({
    kind: REVIEW_KIND,
    uri: `workflow://${workflowID}/visual-review-r${payload.revision}.json`,
    mime: REVIEW_MIME,
    sha256: Hash.sha256(Buffer.from(encoded)),
    size: encoded.byteLength,
    metadata: { payload },
  })
}

export function decodeReview(artifact: Workflow.ArtifactCommit): VisualReview.Artifact {
  const payload = metadataPayload(artifact)
  WorkflowSecretGuard.assertSafe(payload)
  const review = Schema.decodeUnknownSync(VisualReview.Artifact)(payload)
  const encoded = new TextEncoder().encode(WorkflowDesignArtifact.encode(review))
  if (
    artifact.kind !== REVIEW_KIND ||
    artifact.mime !== REVIEW_MIME ||
    artifact.sha256 !== Hash.sha256(Buffer.from(encoded)) ||
    artifact.size !== encoded.byteLength
  ) {
    throw new Error("Visual review payload does not match its durable commit")
  }
  return review
}

function metadataPayload(artifact: Workflow.ArtifactCommit): unknown {
  WorkflowSecretGuard.assertSafe(artifact)
  if (Reflect.ownKeys(artifact.metadata).length !== 1 || !Object.hasOwn(artifact.metadata, "payload"))
    throw new Error("Durable artifact metadata must contain exactly one self-contained payload")
  return artifact.metadata.payload
}

function placeholderReview(evidence: ReadonlyArray<VisualReview.EvidenceImage>): VisualReview.Artifact {
  const [first, ...rest] = evidence
  if (!first) throw new Error("Visual review requires screenshot evidence")
  return {
    schemaVersion: 1,
    revision:
      first.kind === "implementation"
        ? first.revision
        : (rest.find((item) => item.kind === "implementation")?.revision ?? 0),
    verdict: "pass",
    score: 100,
    limits: { maxRevisions: VisualReview.MAX_VISUAL_REVISIONS, maxTokens: 1, maxTurns: 1, maxToolCalls: 1 },
    usage: { tokens: 0, turns: 0, toolCalls: 0 },
    evidence: [first, ...rest],
    findings: [],
  }
}
