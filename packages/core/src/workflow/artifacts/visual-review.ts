export * as WorkflowVisualReviewArtifact from "./visual-review"

import { Message } from "@opencode-ai/llm"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { VisualReview } from "@opencode-ai/schema/visual-review"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { Hash } from "../../util/hash"
import { WorkflowSecretGuard } from "../secret-guard"
import { IMPLEMENTATION_SCREENSHOT_KIND, REFERENCE_SCREENSHOT_KIND, validateEvidenceReceipt } from "../visual-evidence"
import type { EvidenceReceipt } from "../visual-evidence"
import { WorkflowDesignArtifact } from "./design"

export { IMPLEMENTATION_SCREENSHOT_KIND, REFERENCE_SCREENSHOT_KIND } from "../visual-evidence"

export const REVIEW_KIND = "workflow.visual-review"
export const REVIEW_MIME = "application/vnd.opencode.visual-review+json"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const ScreenshotPayload = Schema.Struct({
  image: VisualReview.EvidenceImage,
  dataBase64: Schema.String,
  /** New production captures embed the exact logical host receipt for crash reconciliation. */
  evidenceReceipt: Schema.optional(Schema.Unknown),
}).annotate({ identifier: "WorkflowVisualReviewArtifact.ScreenshotPayload", ...exact })
const ReviewPayload = Schema.Struct({
  workflowID: DesignArtifact.SafeWorkflowID,
  artifactKind: Schema.Literal(REVIEW_KIND),
  revision: NonNegativeInt,
  review: VisualReview.Artifact,
}).annotate({ identifier: "WorkflowVisualReviewArtifact.ReviewPayload", ...exact })

const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface CapturedImage extends VisualReview.EvidenceImage {
  readonly bytes: Uint8Array
  readonly evidenceReceipt?: EvidenceReceipt
}

export function assertPng(bytes: Uint8Array): { readonly width: number; readonly height: number } {
  if (bytes.byteLength < pngSignature.byteLength + 12) throw new Error("Browser capture is not a complete PNG")
  for (let index = 0; index < pngSignature.byteLength; index++) {
    if (bytes[index] !== pngSignature[index]) throw new Error("Browser capture is not a PNG")
  }
  let offset = pngSignature.byteLength
  let chunkIndex = 0
  let hasIDAT = false
  let hasIEND = false
  let pngWidth: number | undefined
  let pngHeight: number | undefined
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) throw new Error("PNG chunk is truncated")
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset)
    const length = view.getUint32(0)
    const end = offset + 12 + length
    if (end > bytes.byteLength || end < offset) throw new Error("PNG chunk length exceeds the capture")
    const typeBytes = bytes.slice(offset + 4, offset + 8)
    const type = String.fromCharCode(...typeBytes)
    const data = bytes.slice(offset + 8, offset + 8 + length)
    const expectedCrc = new DataView(bytes.buffer, bytes.byteOffset + offset + 8 + length, 4).getUint32(0)
    if (crc32(typeBytes, data) !== expectedCrc) throw new Error(`PNG ${type} chunk CRC is invalid`)
    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) throw new Error("PNG must start with a 13-byte IHDR chunk")
      const dimensions = new DataView(data.buffer, data.byteOffset, data.byteLength)
      const width = dimensions.getUint32(0)
      const height = dimensions.getUint32(4)
      if (width === 0 || width > 0x7fffffff || height === 0 || height > 0x7fffffff)
        throw new Error("PNG dimensions must be between 1 and 2^31 - 1")
      const bitDepth = data[8]
      const colorType = data[9]
      const validBitDepths: Readonly<Record<number, ReadonlyArray<number>>> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      }
      if (!validBitDepths[colorType]?.includes(bitDepth))
        throw new Error("PNG IHDR color type and bit depth are invalid")
      if (data[10] !== 0) throw new Error("PNG IHDR compression method is invalid")
      if (data[11] !== 0) throw new Error("PNG IHDR filter method is invalid")
      if (data[12] !== 0 && data[12] !== 1) throw new Error("PNG IHDR interlace method is invalid")
      pngWidth = width
      pngHeight = height
    } else if (type === "IHDR") {
      throw new Error("PNG must contain exactly one leading IHDR chunk")
    }
    if (type === "IDAT") hasIDAT = true
    if (type === "IEND") {
      if (length !== 0) throw new Error("PNG IEND chunk must be empty")
      hasIEND = true
      if (end !== bytes.byteLength) throw new Error("PNG must not contain data after IEND")
    }
    offset = end
    chunkIndex++
  }
  if (!hasIDAT) throw new Error("PNG must contain an IDAT chunk")
  if (!hasIEND) throw new Error("PNG must end with an IEND chunk")
  if (pngWidth === undefined || pngHeight === undefined) throw new Error("PNG dimensions are missing")
  return Object.freeze({ width: pngWidth, height: pngHeight })
}

export function capturedImage(input: {
  readonly workflowID: Workflow.ID
  readonly kind: "reference" | "implementation"
  readonly viewport: string
  readonly revision: number
  readonly bytes: Uint8Array
  readonly evidenceReceipt?: unknown
}): CapturedImage {
  const workflowID = safeWorkflowID(input.workflowID)
  const dimensions = assertPng(input.bytes)
  if (input.kind === "reference" && input.revision !== 0)
    throw new Error("Reference screenshots must use revision zero")
  const viewport = Schema.decodeUnknownSync(VisualReview.EvidenceImage.fields.viewport)(input.viewport)
  const metadata = Schema.decodeUnknownSync(VisualReview.EvidenceImage)({
    id: imageID(workflowID, input.kind, viewport, input.revision),
    workflowID,
    kind: input.kind,
    viewport,
    revision: input.revision,
    uri: imageURI(workflowID, input.kind, viewport, input.revision),
    mime: "image/png",
    sha256: Hash.sha256(Buffer.from(input.bytes)),
    size: input.bytes.byteLength,
  })
  const evidenceReceipt =
    input.evidenceReceipt === undefined ? undefined : receiptForImage(input.evidenceReceipt, metadata, dimensions)
  return {
    ...metadata,
    bytes: input.bytes,
    ...(evidenceReceipt === undefined ? {} : { evidenceReceipt }),
  }
}

export function commitScreenshot(image: CapturedImage): Workflow.ArtifactCommit {
  const dimensions = assertPng(image.bytes)
  const { bytes, evidenceReceipt, ...rawMetadata } = image
  WorkflowSecretGuard.assertSafe(rawMetadata)
  const metadata = Schema.decodeUnknownSync(VisualReview.EvidenceImage)(rawMetadata)
  validateImageIdentity(metadata)
  const sha256 = Hash.sha256(Buffer.from(bytes))
  if (metadata.sha256 !== sha256 || metadata.size !== bytes.byteLength)
    throw new Error("Screenshot metadata does not match its PNG bytes")
  const normalizedReceipt =
    evidenceReceipt === undefined ? undefined : receiptForImage(evidenceReceipt, metadata, dimensions)
  const payload = Schema.decodeUnknownSync(ScreenshotPayload)({
    image: metadata,
    dataBase64: Buffer.from(bytes).toString("base64"),
    ...(normalizedReceipt === undefined ? {} : { evidenceReceipt: normalizedReceipt }),
  })
  const body = WorkflowDesignArtifact.encode(payload)
  const encoded = new TextEncoder().encode(body)
  return Workflow.ArtifactCommit.make({
    kind: image.kind === "reference" ? REFERENCE_SCREENSHOT_KIND : IMPLEMENTATION_SCREENSHOT_KIND,
    uri: image.uri,
    mime: image.mime,
    sha256: Hash.sha256(Buffer.from(encoded)),
    size: encoded.byteLength,
    metadata: { payload },
  })
}

export function decodeScreenshot(artifact: Workflow.ArtifactCommit, expectedWorkflowID: Workflow.ID): CapturedImage {
  const owner = safeWorkflowID(expectedWorkflowID)
  WorkflowSecretGuard.assertSafe(artifact)
  const payload = Schema.decodeUnknownSync(ScreenshotPayload)(metadataPayload(artifact))
  validateImageIdentity(payload.image)
  if (payload.image.workflowID !== owner) throw new Error("Screenshot belongs to a different workflow")
  const bytes = Uint8Array.from(Buffer.from(payload.dataBase64, "base64"))
  if (Buffer.from(bytes).toString("base64") !== payload.dataBase64)
    throw new Error("Screenshot base64 is not canonical")
  const dimensions = assertPng(bytes)
  const expectedKind = payload.image.kind === "reference" ? REFERENCE_SCREENSHOT_KIND : IMPLEMENTATION_SCREENSHOT_KIND
  const sha256 = Hash.sha256(Buffer.from(bytes))
  const encoded = new TextEncoder().encode(WorkflowDesignArtifact.encode(payload))
  if (
    artifact.kind !== expectedKind ||
    artifact.uri !== payload.image.uri ||
    artifact.mime !== "image/png" ||
    payload.image.mime !== "image/png" ||
    artifact.sha256 !== Hash.sha256(Buffer.from(encoded)) ||
    payload.image.sha256 !== sha256 ||
    artifact.size !== encoded.byteLength ||
    payload.image.size !== bytes.byteLength
  ) {
    throw new Error("Screenshot payload does not match its durable commit")
  }
  const evidenceReceipt =
    payload.evidenceReceipt === undefined
      ? undefined
      : receiptForImage(payload.evidenceReceipt, payload.image, dimensions)
  return {
    ...payload.image,
    bytes,
    ...(evidenceReceipt === undefined ? {} : { evidenceReceipt }),
  }
}

function receiptForImage(
  input: unknown,
  image: VisualReview.EvidenceImage,
  dimensions: { readonly width: number; readonly height: number },
): EvidenceReceipt {
  const receipt = validateEvidenceReceipt(input)
  if (
    receipt.coordinates.workflowID !== image.workflowID ||
    receipt.coordinates.kind !== image.kind ||
    receipt.coordinates.viewport.name !== image.viewport ||
    receipt.coordinates.revision !== image.revision ||
    receipt.pngSha256 !== image.sha256 ||
    receipt.evidenceBytes !== image.size ||
    receipt.width !== dimensions.width ||
    receipt.height !== dimensions.height
  ) {
    throw new Error("Screenshot evidence receipt does not match its image")
  }
  return receipt
}

function validateImageIdentity(image: VisualReview.EvidenceImage): void {
  if (image.kind === "reference" && image.revision !== 0)
    throw new Error("Reference screenshots must use revision zero")
  const id = imageID(image.workflowID, image.kind, image.viewport, image.revision)
  const uri = imageURI(image.workflowID, image.kind, image.viewport, image.revision)
  if (image.id !== id || image.uri !== uri) throw new Error("Screenshot identity is not canonical")
}

function imageID(
  workflowID: DesignArtifact.SafeWorkflowID,
  kind: "reference" | "implementation",
  viewport: string,
  revision: number,
): string {
  const suffix = kind === "reference" ? "" : `-r${revision}`
  const ownerDigest = Hash.sha256(Buffer.from(workflowID, "utf8"))
  return `screenshot-${ownerDigest}-${kind}-${viewport}${suffix}`
}

function imageURI(
  workflowID: DesignArtifact.SafeWorkflowID,
  kind: "reference" | "implementation",
  viewport: string,
  revision: number,
): string {
  const suffix = kind === "reference" ? "" : `-r${revision}`
  return `workflow://artifact/${workflowID}/${kind}-screenshot-${viewport}${suffix}.png`
}

function crc32(type: Uint8Array, data: Uint8Array): number {
  let crc = 0xffffffff
  for (const bytes of [type, data]) {
    for (const value of bytes) {
      crc ^= value
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function reviewMessage(spec: unknown, images: ReadonlyArray<CapturedImage>): Message {
  const evidence = images.map(({ bytes: _, evidenceReceipt: __, ...image }) => image)
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
  const owner = safeWorkflowID(workflowID)
  WorkflowSecretGuard.assertSafe(input)
  const review = Schema.decodeUnknownSync(VisualReview.Artifact)(input)
  for (const image of review.evidence) validateImageIdentity(image)
  if (review.evidence.some((image) => image.workflowID !== owner))
    throw new Error("Visual review evidence belongs to a different workflow")
  const payload = Schema.decodeUnknownSync(ReviewPayload)({
    workflowID: owner,
    artifactKind: REVIEW_KIND,
    revision: review.revision,
    review,
  })
  const body = WorkflowDesignArtifact.encode(payload)
  const encoded = new TextEncoder().encode(body)
  return Workflow.ArtifactCommit.make({
    kind: REVIEW_KIND,
    uri: reviewURI(owner, review.revision),
    mime: REVIEW_MIME,
    sha256: Hash.sha256(Buffer.from(encoded)),
    size: encoded.byteLength,
    metadata: { payload },
  })
}

export function decodeReview(
  artifact: Workflow.ArtifactCommit,
  expectedWorkflowID: Workflow.ID,
): VisualReview.Artifact {
  const owner = safeWorkflowID(expectedWorkflowID)
  const payload = Schema.decodeUnknownSync(ReviewPayload)(metadataPayload(artifact))
  WorkflowSecretGuard.assertSafe(payload)
  if (payload.workflowID !== owner) throw new Error("Visual review belongs to a different workflow")
  if (payload.revision !== payload.review.revision) throw new Error("Visual review revision is not canonical")
  for (const image of payload.review.evidence) validateImageIdentity(image)
  if (payload.review.evidence.some((image) => image.workflowID !== payload.workflowID))
    throw new Error("Visual review evidence belongs to a different workflow")
  const encoded = new TextEncoder().encode(WorkflowDesignArtifact.encode(payload))
  if (
    artifact.kind !== REVIEW_KIND ||
    artifact.mime !== REVIEW_MIME ||
    artifact.uri !== reviewURI(payload.workflowID, payload.revision) ||
    artifact.sha256 !== Hash.sha256(Buffer.from(encoded)) ||
    artifact.size !== encoded.byteLength
  ) {
    throw new Error("Visual review payload does not match its durable commit")
  }
  return payload.review
}

function safeWorkflowID(input: unknown): DesignArtifact.SafeWorkflowID {
  return Schema.decodeUnknownSync(DesignArtifact.SafeWorkflowID)(input)
}

function reviewURI(workflowID: DesignArtifact.SafeWorkflowID, revision: number): string {
  return `workflow://artifact/${workflowID}/visual-review-r${revision}.json`
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
