export * as WorkflowVisualEvidence from "./visual-evidence"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { createHash } from "node:crypto"

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_WORKFLOW_EVIDENCE_BYTES = 128 * 1024 * 1024
export const MAX_VIEWPORT_DIMENSION = 8_192
export const MAX_VIEWPORT_PIXELS = 33_554_432
export const REFERENCE_SCREENSHOT_KIND = "workflow.visual.reference-screenshot"
export const IMPLEMENTATION_SCREENSHOT_KIND = "workflow.visual.implementation-screenshot"

export const EvidenceID = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand("WorkflowVisualHost.EvidenceID"),
)
export type EvidenceID = typeof EvidenceID.Type

export type PreviewKind = "reference" | "implementation"

export interface EvidenceCoordinates {
  readonly schemaVersion: 1
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly kind: PreviewKind
  readonly revision: number
  readonly viewport: DesignArtifact.Viewport
  readonly configSha256: string
  readonly sourceSha256: string
  readonly readySelectorSha256: string
}

export interface EvidenceReceipt {
  readonly evidenceID: EvidenceID
  readonly coordinates: EvidenceCoordinates
  readonly pngSha256: string
  readonly width: number
  readonly height: number
  readonly evidenceBytes: number
}

export type EvidenceState = "capturing" | "staged" | "committed" | "released" | "abandoned"

export interface EvidenceArtifactBinding {
  readonly artifactID: Workflow.ArtifactID
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly kind: string
  readonly uri: string
  readonly mime: "image/png"
  readonly sha256: string
  readonly size: number
  readonly timeCreatedEpochMs: number
  readonly evidenceID: EvidenceID
  readonly pngSha256: string
  readonly receiptSha256: string
}

export interface EvidenceAbandonmentBinding {
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly status: "failed" | "cancelled"
  readonly authorityID: string
}

export interface EvidenceSummary {
  readonly evidenceID: EvidenceID
  readonly coordinates: EvidenceCoordinates
  /** Capturing intents have no PNG receipt until their owner completes the durable put. */
  readonly receipt?: EvidenceReceipt
  readonly state: EvidenceState
  readonly artifact?: EvidenceArtifactBinding
  readonly abandonment?: EvidenceAbandonmentBinding
  readonly createdAt: number
  readonly updatedAt: number
}

/** Derive the opaque ID from the one canonical, host-independent coordinate encoding. */
export function evidenceID(coordinatesInput: EvidenceCoordinates): EvidenceID {
  const coordinates = validateEvidenceCoordinates(coordinatesInput)
  return EvidenceID.make(
    hash(
      JSON.stringify([
        "opencode.workflow.evidence",
        coordinates.schemaVersion,
        coordinates.workflowID,
        coordinates.stageID,
        coordinates.kind,
        coordinates.revision,
        coordinates.viewport.name,
        coordinates.viewport.width,
        coordinates.viewport.height,
        coordinates.configSha256,
        coordinates.sourceSha256,
        coordinates.readySelectorSha256,
      ]),
    ),
  )
}

export function validateEvidenceCoordinates(input: unknown): EvidenceCoordinates {
  if (
    !hasExactDataKeys(input, [
      "schemaVersion",
      "workflowID",
      "stageID",
      "kind",
      "revision",
      "viewport",
      "configSha256",
      "sourceSha256",
      "readySelectorSha256",
    ])
  ) {
    throw new TypeError("Evidence coordinates shape is not exact")
  }
  if (input.schemaVersion !== 1 || (input.kind !== "reference" && input.kind !== "implementation")) {
    throw new TypeError("Evidence coordinates version or kind is invalid")
  }
  const workflowID = Schema.decodeUnknownSync(Workflow.ID)(input.workflowID)
  const stageID = Schema.decodeUnknownSync(Workflow.StageID)(input.stageID)
  const configSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(input.configSha256)
  const sourceSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(input.sourceSha256)
  const readySelectorSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(input.readySelectorSha256)
  const viewport = Schema.decodeUnknownSync(DesignArtifact.Viewport)(input.viewport)
  if (
    viewport.width > MAX_VIEWPORT_DIMENSION ||
    viewport.height > MAX_VIEWPORT_DIMENSION ||
    viewport.width * viewport.height > MAX_VIEWPORT_PIXELS
  ) {
    throw new TypeError("Evidence viewport exceeds host bounds")
  }
  if (
    typeof input.revision !== "number" ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    (input.kind === "reference" && input.revision !== 0)
  ) {
    throw new TypeError("Evidence revision is invalid")
  }
  return Object.freeze({
    schemaVersion: 1,
    workflowID,
    stageID,
    kind: input.kind,
    revision: input.revision,
    viewport: Object.freeze({ ...viewport }),
    configSha256,
    sourceSha256,
    readySelectorSha256,
  })
}

export function validateEvidenceReceipt(input: unknown): EvidenceReceipt {
  if (!hasExactDataKeys(input, ["evidenceID", "coordinates", "pngSha256", "width", "height", "evidenceBytes"])) {
    throw new TypeError("Evidence receipt shape is not exact")
  }
  const coordinates = validateEvidenceCoordinates(input.coordinates)
  const expectedID = evidenceID(coordinates)
  const id = Schema.decodeUnknownSync(EvidenceID)(input.evidenceID)
  const pngSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(input.pngSha256)
  if (
    id !== expectedID ||
    input.width !== coordinates.viewport.width ||
    input.height !== coordinates.viewport.height ||
    typeof input.evidenceBytes !== "number" ||
    !Number.isSafeInteger(input.evidenceBytes) ||
    input.evidenceBytes <= 0 ||
    input.evidenceBytes > MAX_IMAGE_BYTES
  ) {
    throw new TypeError("Evidence receipt identity, dimensions, or bytes are invalid")
  }
  return Object.freeze({
    evidenceID: id,
    coordinates,
    pngSha256,
    width: coordinates.viewport.width,
    height: coordinates.viewport.height,
    evidenceBytes: input.evidenceBytes,
  })
}

export function validateEvidenceArtifactBinding(input: unknown, receiptInput?: unknown): EvidenceArtifactBinding {
  if (
    !hasExactDataKeys(input, [
      "artifactID",
      "workflowID",
      "stageID",
      "kind",
      "uri",
      "mime",
      "sha256",
      "size",
      "timeCreatedEpochMs",
      "evidenceID",
      "pngSha256",
      "receiptSha256",
    ])
  ) {
    throw new TypeError("Evidence artifact binding shape is not exact")
  }
  const artifactID = Schema.decodeUnknownSync(Workflow.ArtifactID)(input.artifactID)
  const workflowID = Schema.decodeUnknownSync(Workflow.ID)(input.workflowID)
  const stageID = Schema.decodeUnknownSync(Workflow.StageID)(input.stageID)
  const sha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(input.sha256)
  const id = Schema.decodeUnknownSync(EvidenceID)(input.evidenceID)
  const pngSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(input.pngSha256)
  const receiptSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(input.receiptSha256)
  if (
    typeof input.kind !== "string" ||
    input.kind.length === 0 ||
    typeof input.uri !== "string" ||
    input.uri.length === 0 ||
    input.mime !== "image/png" ||
    typeof input.size !== "number" ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    typeof input.timeCreatedEpochMs !== "number" ||
    !Number.isSafeInteger(input.timeCreatedEpochMs)
  ) {
    throw new TypeError("Evidence artifact binding fields are invalid")
  }
  if (receiptInput !== undefined) {
    const receipt = validateEvidenceReceipt(receiptInput)
    const expectedKind =
      receipt.coordinates.kind === "reference" ? REFERENCE_SCREENSHOT_KIND : IMPLEMENTATION_SCREENSHOT_KIND
    if (
      workflowID !== receipt.coordinates.workflowID ||
      stageID !== receipt.coordinates.stageID ||
      input.kind !== expectedKind ||
      id !== receipt.evidenceID ||
      pngSha256 !== receipt.pngSha256 ||
      receiptSha256 !== hash(JSON.stringify(receipt))
    ) {
      throw new TypeError("Evidence artifact binding differs from its receipt")
    }
  }
  return Object.freeze({
    artifactID,
    workflowID,
    stageID,
    kind: input.kind,
    uri: input.uri,
    mime: "image/png",
    sha256,
    size: input.size,
    timeCreatedEpochMs: input.timeCreatedEpochMs,
    evidenceID: id,
    pngSha256,
    receiptSha256,
  })
}

export function evidenceAbandonmentBinding(input: {
  readonly receipt: unknown
  readonly terminal: unknown
}): EvidenceAbandonmentBinding {
  const receipt = validateEvidenceReceipt(input.receipt)
  const terminal = input.terminal
  if (!hasExactDataKeys(terminal, ["workflowID", "stageID", "status", "authorityID"])) {
    throw new TypeError("Evidence terminal authority shape is not exact")
  }
  const workflowID = Schema.decodeUnknownSync(Workflow.ID)(terminal.workflowID)
  const stageID = Schema.decodeUnknownSync(Workflow.StageID)(terminal.stageID)
  if (
    workflowID !== receipt.coordinates.workflowID ||
    stageID !== receipt.coordinates.stageID ||
    (terminal.status !== "failed" && terminal.status !== "cancelled") ||
    typeof terminal.authorityID !== "string" ||
    terminal.authorityID.length === 0
  ) {
    throw new TypeError("Evidence terminal authority differs from its receipt")
  }
  return Object.freeze({ workflowID, stageID, status: terminal.status, authorityID: terminal.authorityID })
}

function hasExactDataKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return keys.every((key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key] ?? {}, "value"))
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
