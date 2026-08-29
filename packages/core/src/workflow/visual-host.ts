export * as WorkflowVisualHost from "./visual-host"
export * from "./visual-evidence"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Context, DateTime, Effect, Layer, Schema, Scope } from "effect"
import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { makeGlobalNode } from "../effect/app-node"
import { WorkflowDesignArtifact } from "./artifacts/design"
import { WorkflowVisualReviewArtifact } from "./artifacts/visual-review"
import { PreviewPlan } from "./preview-plan"
import { WorkflowWorkspaceMaterialization } from "./workspace-materialization"
import {
  EvidenceID,
  IMPLEMENTATION_SCREENSHOT_KIND,
  MAX_IMAGE_BYTES,
  MAX_VIEWPORT_DIMENSION,
  MAX_VIEWPORT_PIXELS,
  MAX_WORKFLOW_EVIDENCE_BYTES,
  REFERENCE_SCREENSHOT_KIND,
  evidenceAbandonmentBinding,
  evidenceID,
  validateEvidenceArtifactBinding,
  validateEvidenceCoordinates,
  validateEvidenceReceipt,
} from "./visual-evidence"
import type {
  EvidenceAbandonmentBinding,
  EvidenceArtifactBinding,
  EvidenceCoordinates,
  EvidenceReceipt,
  EvidenceState,
  EvidenceSummary,
  PreviewKind,
} from "./visual-evidence"

export const HostID = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand("WorkflowVisualHost.HostID"),
)
export type HostID = typeof HostID.Type

export const CapabilityURL = Schema.String.check(
  Schema.makeFilter<string>((value) => (validateHandle(value) ? undefined : "Expected a loopback capability URL")),
).pipe(Schema.brand("WorkflowVisualHost.CapabilityURL"))
export type CapabilityURL = typeof CapabilityURL.Type

export interface PreparedPreview {
  readonly hostID: HostID
  readonly url: CapabilityURL
  readonly origin: string
  readonly revision: number
  readonly configSha256: string
  /** Host-minted evidence identity. Capture callers cannot override these fields. */
  readonly identity: PreviewIdentity
  /** The handle is valid only while this owning Effect scope remains open. */
  readonly scope: Scope.Scope
}

export interface PreviewIdentity {
  readonly workflowID: Workflow.ID
  readonly kind: PreviewKind
  readonly revision: number
  readonly configSha256: string
  /** Reference-app hash or host-owned implementation snapshot/manifest hash. */
  readonly sourceSha256: string
  readonly readySelectorSha256: string
}

export function referenceIdentity(
  workflowID: Workflow.ID,
  referenceApp: WorkflowDesignArtifact.ReferenceApp,
): PreviewIdentity {
  const configSha256 = referenceHash(referenceApp)
  return Object.freeze({
    workflowID,
    kind: "reference",
    revision: 0,
    configSha256,
    sourceSha256: configSha256,
    readySelectorSha256: hash(referenceApp.readySelector),
  })
}

export interface CapturedImage {
  readonly bytes: Uint8Array
  readonly viewport: DesignArtifact.Viewport
  readonly width: number
  readonly height: number
  readonly sha256: string
  readonly evidenceBytes: number
  readonly evidenceID: EvidenceID
  readonly receipt: EvidenceReceipt
}

export interface MaterializeReferenceInput {
  readonly workflowID: Workflow.ID
  readonly referenceApp: WorkflowDesignArtifact.ReferenceApp
}

export interface PrepareImplementationInput {
  readonly workflowID: Workflow.ID
  readonly revision: number
  readonly plan: PreviewPlan.PreviewPlan
}

/**
 * Trusted host output derived from durable implementation/snapshot plus design
 * authority. It is deliberately not part of PrepareImplementationInput.
 */
export interface ImplementationCaptureContract {
  readonly implementationSha256: string
  readonly readySelector: string
  readonly sealedSnapshot?: WorkflowWorkspaceMaterialization.Sealed
}

export type ResolveImplementationContract = (
  input: PrepareImplementationInput,
) => ImplementationCaptureContract | Promise<ImplementationCaptureContract>

export interface CaptureInput {
  readonly preview: PreparedPreview
  readonly stageID: Workflow.StageID
  readonly viewport: DesignArtifact.Viewport
}

export interface LookupEvidenceInput {
  readonly coordinates: EvidenceCoordinates
}

export interface BindEvidenceInput {
  readonly receipt: EvidenceReceipt
  readonly artifact: Workflow.Artifact
}

export interface AbandonEvidenceInput {
  readonly receipt: EvidenceReceipt
  readonly terminal: {
    readonly workflowID: Workflow.ID
    readonly stageID: Workflow.StageID
    readonly status: "failed" | "cancelled"
    readonly authorityID: string
  }
}

export interface ReconcileEvidenceInput {
  readonly workflowID: Workflow.ID
  readonly active: readonly EvidenceCoordinates[]
  readonly abandoned: readonly AbandonEvidenceInput[]
  readonly committed: readonly (BindEvidenceInput & { readonly release: boolean })[]
}

export interface ReconcileEvidenceResult {
  readonly active: readonly EvidenceSummary[]
  readonly committed: readonly EvidenceSummary[]
  readonly released: readonly EvidenceSummary[]
  readonly abandoned: readonly EvidenceSummary[]
  readonly ambiguous: readonly EvidenceSummary[]
}

export interface RecoverExpiredInput {
  readonly activeHostIDs: ReadonlySet<HostID>
  readonly expiredBefore: number
}

export class Failure extends Schema.TaggedErrorClass<Failure>()("WorkflowVisualHost.Failure", {
  operation: Schema.Literals([
    "materialize_reference",
    "prepare_implementation",
    "capture",
    "lookup_evidence",
    "commit_evidence",
    "release_evidence",
    "abandon_evidence",
    "reconcile_evidence",
    "recover_expired",
    "cleanup",
  ]),
  code: Schema.Literals([
    "visual_host_unavailable",
    "invalid_reference_app",
    "invalid_preview_plan",
    "invalid_preview_handle",
    "invalid_viewport",
    "capture_failed",
    "image_evidence_limit_exceeded",
    "workflow_evidence_limit_exceeded",
    "invalid_evidence_receipt",
    "evidence_conflict",
    "evidence_released",
    "evidence_abandoned",
    "evidence_capture_ambiguous",
    "cleanup_target_rejected",
  ]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly materializeReference: (
    input: MaterializeReferenceInput,
  ) => Effect.Effect<PreparedPreview, Failure, Scope.Scope>
  readonly prepareImplementation: (
    input: PrepareImplementationInput,
  ) => Effect.Effect<PreparedPreview, Failure, Scope.Scope>
  readonly capture: (input: CaptureInput) => Effect.Effect<CapturedImage, Failure, Scope.Scope>
  readonly lookupEvidence: (input: LookupEvidenceInput) => Effect.Effect<CapturedImage | undefined, Failure>
  readonly commitEvidence: (input: BindEvidenceInput) => Effect.Effect<EvidenceSummary, Failure>
  readonly releaseEvidence: (input: BindEvidenceInput) => Effect.Effect<EvidenceSummary, Failure>
  readonly abandonEvidence: (input: AbandonEvidenceInput) => Effect.Effect<EvidenceSummary, Failure>
  readonly reconcileEvidence: (input: ReconcileEvidenceInput) => Effect.Effect<ReconcileEvidenceResult, Failure>
  readonly recoverExpired: (input: RecoverExpiredInput) => Effect.Effect<void, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkflowVisualHost") {}

export interface FakeOptions {
  readonly captureBytes?: (input: CaptureInput) => Uint8Array
  readonly initialEvidenceBytes?: Readonly<Record<string, number>>
  readonly evidenceStore?: FakeEvidenceStore
  readonly hostIDSalt?: () => string
  readonly onRelease?: (hostID: HostID) => void
  readonly now?: () => number
  /** Deterministic trusted-authority seam; absent means implementation preview is unavailable. */
  readonly resolveImplementationContract?: ResolveImplementationContract
}

export interface FakeEvidenceRecord {
  readonly evidenceID: EvidenceID
  readonly coordinates: EvidenceCoordinates
  readonly receipt: EvidenceReceipt
  state: EvidenceState
  artifact?: EvidenceArtifactBinding
  abandonment?: EvidenceAbandonmentBinding
  readonly createdAt: number
  updatedAt: number
  bytes?: Uint8Array
}

/** Durable-in-memory state explicitly reusable across deterministic fake layer restarts. */
export interface FakeEvidenceStore {
  readonly items: Map<EvidenceID, FakeEvidenceRecord>
  readonly totals: Map<string, number>
}

export function makeFakeEvidenceStore(initialEvidenceBytes: Readonly<Record<string, number>> = {}): FakeEvidenceStore {
  return {
    items: new Map(),
    totals: new Map(Object.entries(initialEvidenceBytes)),
  }
}

export function inspectFakeEvidenceStore(store: FakeEvidenceStore): {
  readonly totalBytesByWorkflow: Readonly<Record<string, number>>
  readonly items: readonly (EvidenceSummary & { readonly hasBytes: boolean })[]
} {
  return {
    totalBytesByWorkflow: Object.fromEntries(store.totals),
    items: [...store.items.values()]
      .map(({ bytes, ...item }) => ({ ...item, hasBytes: bytes !== undefined }))
      .sort((left, right) => left.evidenceID.localeCompare(right.evidenceID)),
  }
}

interface FakeRecord {
  readonly workflowID: Workflow.ID
  readonly preview: PreparedPreview
  readonly createdAt: number
}

/** Deterministic, process-free host for Core orchestration and crash tests. */
export function fakeLayer(options: FakeOptions = {}): Layer.Layer<Service> {
  const active = new Map<HostID, FakeRecord>()
  const evidence = options.evidenceStore ?? makeFakeEvidenceStore(options.initialEvidenceBytes)
  const captureFlights = new Map<EvidenceID, Promise<CapturedImage>>()
  const now = options.now ?? (() => Date.now())

  const acquire = Effect.fn("WorkflowVisualHost.fake.acquire")(function* (input: {
    readonly workflowID: Workflow.ID
    readonly revision: number
    readonly configSha256: string
    readonly sourceSha256: string
    readonly readySelectorSha256: string
    readonly kind: "reference" | "implementation"
  }) {
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !/^[a-f0-9]{64}$/.test(input.configSha256)) {
      return yield* failure(
        input.kind === "reference" ? "materialize_reference" : "prepare_implementation",
        input.kind === "reference" ? "invalid_reference_app" : "invalid_preview_plan",
        "Visual preview identity is not canonical",
      )
    }
    const scope = yield* Scope.Scope
    const hostID = HostID.make(
      hash(
        `${input.workflowID}\0${input.kind}\0${input.revision}\0${input.configSha256}\0${input.sourceSha256}\0${input.readySelectorSha256}\0${options.hostIDSalt?.() ?? ""}`,
      ),
    )
    const preview = preparedPreview({
      hostID,
      url: `http://127.0.0.1:4173/${hostID}/`,
      workflowID: input.workflowID,
      kind: input.kind,
      revision: input.revision,
      configSha256: input.configSha256,
      sourceSha256: input.sourceSha256,
      readySelectorSha256: input.readySelectorSha256,
      scope,
    })
    const record = { workflowID: input.workflowID, preview, createdAt: now() }
    active.set(hostID, record)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (active.get(hostID) === record) {
          active.delete(hostID)
          options.onRelease?.(hostID)
        }
      }),
    )
    return preview
  })

  const service = Service.of({
    materializeReference: (input) =>
      Effect.gen(function* () {
        const identity = yield* Effect.try({
          try: () => referenceIdentity(input.workflowID, input.referenceApp),
          catch: () =>
            new Failure({
              operation: "materialize_reference",
              code: "invalid_reference_app",
              message: "Reference application failed host validation",
            }),
        })
        return yield* acquire({
          workflowID: input.workflowID,
          revision: 0,
          configSha256: identity.configSha256,
          sourceSha256: identity.sourceSha256,
          readySelectorSha256: identity.readySelectorSha256,
          kind: "reference",
        })
      }),
    prepareImplementation: (input) =>
      Effect.gen(function* () {
        if (
          !hasExactDataKeys(input, ["workflowID", "revision", "plan"]) ||
          !Number.isSafeInteger(input.revision) ||
          input.revision < 0 ||
          !PreviewPlan.isFrozen(input.plan)
        ) {
          return yield* failure(
            "prepare_implementation",
            "invalid_preview_plan",
            "Implementation preview requires an admission-frozen plan",
          )
        }
        yield* Effect.try({
          try: () => PreviewPlan.verifyConfiguration(input.plan),
          catch: () =>
            new Failure({
              operation: "prepare_implementation",
              code: "invalid_preview_plan",
              message: "Implementation preview configuration no longer matches admission",
            }),
        })
        if (options.resolveImplementationContract === undefined) {
          return yield* failure(
            "prepare_implementation",
            "visual_host_unavailable",
            "Trusted implementation capture authority is unavailable",
          )
        }
        const contract = yield* Effect.tryPromise({
          try: async () => validateImplementationCaptureContract(await options.resolveImplementationContract!(input)),
          catch: (cause) =>
            cause instanceof Failure
              ? cause
              : new Failure({
                  operation: "prepare_implementation",
                  code: "invalid_preview_plan",
                  message: "Implementation capture authority rejected the durable contract",
                }),
        })
        return yield* acquire({
          workflowID: input.workflowID,
          revision: input.revision,
          configSha256: input.plan.configSha256,
          sourceSha256: contract.implementationSha256,
          readySelectorSha256: hash(contract.readySelector),
          kind: "implementation",
        })
      }),
    capture: (input) =>
      Effect.tryPromise({
        try: async () => {
          const record = active.get(input.preview.hostID)
          if (record === undefined || record.preview !== input.preview) {
            throw new Failure({
              operation: "capture",
              code: "invalid_preview_handle",
              message: "Capture requires an active host-minted preview handle",
            })
          }
          const coordinates = evidenceCoordinates(input)
          const id = evidenceID(coordinates)
          const existing = evidence.items.get(id)
          if (existing !== undefined) return capturedFromFakeRecord(coordinates, existing)
          if ((evidence.totals.get(record.workflowID) ?? 0) >= MAX_WORKFLOW_EVIDENCE_BYTES) {
            throw new Failure({
              operation: "capture",
              code: "workflow_evidence_limit_exceeded",
              message: "Workflow screenshot evidence exceeds 128 MiB",
            })
          }
          const prior = captureFlights.get(id)
          if (prior !== undefined) return prior
          const pending = Promise.resolve().then(() => {
            const winner = evidence.items.get(id)
            if (winner !== undefined) return capturedFromFakeRecord(coordinates, winner)
            let bytes: Uint8Array
            try {
              bytes = (options.captureBytes ?? ((value: CaptureInput) => deterministicPng(value.viewport)))(input)
            } catch {
              throw new Failure({
                operation: "capture",
                code: "capture_failed",
                message: "Deterministic capture failed",
              })
            }
            const image = capturedImage(coordinates, bytes)
            const used = evidence.totals.get(record.workflowID) ?? 0
            if (used + image.evidenceBytes > MAX_WORKFLOW_EVIDENCE_BYTES) {
              throw new Failure({
                operation: "capture",
                code: "workflow_evidence_limit_exceeded",
                message: "Workflow screenshot evidence exceeds 128 MiB",
              })
            }
            const timestamp = now()
            evidence.items.set(id, {
              evidenceID: id,
              coordinates,
              receipt: image.receipt,
              state: "staged",
              createdAt: timestamp,
              updatedAt: timestamp,
              bytes: Uint8Array.from(image.bytes),
            })
            evidence.totals.set(record.workflowID, used + image.evidenceBytes)
            return cloneCapturedImage(image)
          })
          captureFlights.set(id, pending)
          try {
            return await pending
          } finally {
            if (captureFlights.get(id) === pending) captureFlights.delete(id)
          }
        },
        catch: (cause) =>
          cause instanceof Failure
            ? cause
            : new Failure({ operation: "capture", code: "capture_failed", message: "Deterministic capture failed" }),
      }),
    lookupEvidence: (input) =>
      Effect.try({
        try: () => {
          const coordinates = validateEvidenceCoordinates(input.coordinates)
          const record = evidence.items.get(evidenceID(coordinates))
          return record === undefined ? undefined : capturedFromFakeRecord(coordinates, record)
        },
        catch: (cause) => evidenceFailure("lookup_evidence", cause),
      }),
    commitEvidence: (input) =>
      Effect.try({
        try: () => bindFakeEvidence(evidence, "commit", input, now),
        catch: (cause) => evidenceFailure("commit_evidence", cause),
      }),
    releaseEvidence: (input) =>
      Effect.try({
        try: () => bindFakeEvidence(evidence, "release", input, now),
        catch: (cause) => evidenceFailure("release_evidence", cause),
      }),
    abandonEvidence: (input) =>
      Effect.try({
        try: () => abandonFakeEvidence(evidence, input, now),
        catch: (cause) => evidenceFailure("abandon_evidence", cause),
      }),
    reconcileEvidence: (input) =>
      Effect.try({
        try: () => reconcileFakeEvidence(evidence, input, now),
        catch: (cause) => evidenceFailure("reconcile_evidence", cause),
      }),
    recoverExpired: (input) =>
      Effect.sync(() => {
        for (const [hostID, record] of active) {
          if (record.createdAt >= input.expiredBefore || input.activeHostIDs.has(hostID)) continue
          active.delete(hostID)
          options.onRelease?.(hostID)
        }
      }),
  })
  return Layer.succeed(Service, service)
}

export const unavailableLayer = Layer.succeed(
  Service,
  Service.of({
    materializeReference: () => unavailable("materialize_reference"),
    prepareImplementation: () => unavailable("prepare_implementation"),
    capture: () => unavailable("capture"),
    lookupEvidence: () => unavailable("lookup_evidence"),
    commitEvidence: () => unavailable("commit_evidence"),
    releaseEvidence: () => unavailable("release_evidence"),
    abandonEvidence: () => unavailable("abandon_evidence"),
    reconcileEvidence: () => unavailable("reconcile_evidence"),
    recoverExpired: () => unavailable("recover_expired"),
  }),
)

export const node = makeGlobalNode({ service: Service, layer: unavailableLayer, deps: [] })

/** Build the only logical capture key. Host ID, URL, paths, providers, and secrets are deliberately absent. */
export function evidenceCoordinates(input: CaptureInput): EvidenceCoordinates {
  const identity = validatePreviewIdentity(input.preview)
  const stageID = Schema.decodeUnknownSync(Workflow.StageID)(input.stageID)
  const viewport = Schema.decodeUnknownSync(DesignArtifact.Viewport)(input.viewport)
  validateViewportBounds(viewport)
  return Object.freeze({
    schemaVersion: 1,
    workflowID: identity.workflowID,
    stageID,
    kind: identity.kind,
    revision: identity.revision,
    viewport: Object.freeze({ ...viewport }),
    configSha256: identity.configSha256,
    sourceSha256: identity.sourceSha256,
    readySelectorSha256: identity.readySelectorSha256,
  })
}

/** Validate and reconstruct a durable capture from exact receipt metadata and PNG bytes. */
export function capturedImage(coordinatesInput: EvidenceCoordinates, bytesInput: Uint8Array): CapturedImage {
  const coordinates = validateEvidenceCoordinates(coordinatesInput)
  const id = evidenceID(coordinates)
  if (!(bytesInput instanceof Uint8Array)) {
    throw new Failure({ operation: "capture", code: "capture_failed", message: "Capture bytes are invalid" })
  }
  if (bytesInput.byteLength > MAX_IMAGE_BYTES) {
    throw new Failure({
      operation: "capture",
      code: "image_evidence_limit_exceeded",
      message: "Screenshot exceeds 8 MiB",
    })
  }
  const bytes = Uint8Array.from(bytesInput)
  try {
    validatePngSync(bytes, coordinates.viewport)
  } catch {
    throw new Failure({ operation: "capture", code: "capture_failed", message: "Capture is not an exact PNG" })
  }
  const pngSha256 = hash(bytes)
  const receipt = Object.freeze({
    evidenceID: id,
    coordinates,
    pngSha256,
    width: coordinates.viewport.width,
    height: coordinates.viewport.height,
    evidenceBytes: bytes.byteLength,
  })
  return Object.freeze({
    bytes,
    viewport: Object.freeze({ ...coordinates.viewport }),
    width: coordinates.viewport.width,
    height: coordinates.viewport.height,
    sha256: pngSha256,
    evidenceBytes: bytes.byteLength,
    evidenceID: id,
    receipt,
  })
}

export function restoreCapturedImage(input: {
  readonly receipt: EvidenceReceipt
  readonly bytes: Uint8Array
}): CapturedImage {
  const receipt = validateEvidenceReceipt(input.receipt)
  const image = capturedImage(receipt.coordinates, input.bytes)
  if (!sameReceipt(image.receipt, receipt)) {
    throw new Failure({
      operation: "lookup_evidence",
      code: "invalid_evidence_receipt",
      message: "Evidence PNG does not match its durable receipt",
    })
  }
  return image
}

export function evidenceArtifactBinding(input: BindEvidenceInput): EvidenceArtifactBinding {
  const receipt = validateEvidenceReceipt(input.receipt)
  const artifact = input.artifact
  if (
    !hasExactDataKeys(artifact, [
      "id",
      "workflowID",
      "stageID",
      "kind",
      "uri",
      "mime",
      "sha256",
      "size",
      "metadata",
      "timeCreated",
    ])
  ) {
    throw new TypeError("Screenshot artifact shape is not exact")
  }
  // Artifact contains a decoded DateTime value. Encode + decode validates the
  // complete runtime object and produces one canonical representation.
  const durable = Schema.decodeUnknownSync(Workflow.Artifact)(Schema.encodeSync(Workflow.Artifact)(artifact))
  const artifactSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(durable.sha256)
  if (durable.workflowID !== receipt.coordinates.workflowID || durable.stageID !== receipt.coordinates.stageID) {
    throw new TypeError("Screenshot artifact owner differs from its evidence receipt")
  }
  const expectedKind =
    receipt.coordinates.kind === "reference" ? REFERENCE_SCREENSHOT_KIND : IMPLEMENTATION_SCREENSHOT_KIND
  if (durable.kind !== expectedKind || durable.mime !== "image/png") {
    throw new TypeError("Screenshot artifact kind or MIME differs from its evidence receipt")
  }
  const image = WorkflowVisualReviewArtifact.decodeScreenshot(
    {
      kind: durable.kind,
      uri: durable.uri,
      mime: durable.mime,
      sha256: durable.sha256,
      size: durable.size,
      metadata: durable.metadata,
    },
    receipt.coordinates.workflowID,
  )
  if (
    image.kind !== receipt.coordinates.kind ||
    image.viewport !== receipt.coordinates.viewport.name ||
    image.revision !== receipt.coordinates.revision ||
    image.sha256 !== receipt.pngSha256 ||
    image.size !== receipt.evidenceBytes ||
    image.evidenceReceipt === undefined ||
    !sameReceipt(validateEvidenceReceipt(image.evidenceReceipt), receipt)
  ) {
    throw new TypeError("Screenshot artifact payload differs from its exact evidence receipt")
  }
  return validateEvidenceArtifactBinding(
    {
      artifactID: durable.id,
      workflowID: durable.workflowID,
      stageID: durable.stageID,
      kind: durable.kind,
      uri: durable.uri,
      mime: "image/png",
      sha256: artifactSha256,
      size: durable.size,
      timeCreatedEpochMs: DateTime.toEpochMillis(durable.timeCreated),
      evidenceID: receipt.evidenceID,
      pngSha256: receipt.pngSha256,
      receiptSha256: hash(JSON.stringify(receipt)),
    },
    receipt,
  )
}

export function validateImplementationCaptureContract(input: unknown): ImplementationCaptureContract {
  if (
    !hasExactDataKeys(input, ["implementationSha256", "readySelector"]) &&
    !hasExactDataKeys(input, ["implementationSha256", "readySelector", "sealedSnapshot"])
  ) {
    throw new TypeError("Implementation capture contract shape is not exact")
  }
  const implementationSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(input.implementationSha256)
  if (typeof input.readySelector !== "string" || input.readySelector.length === 0) {
    throw new TypeError("Implementation capture selector is invalid")
  }
  const sealedSnapshot =
    "sealedSnapshot" in input ? WorkflowWorkspaceMaterialization.validate(input.sealedSnapshot) : undefined
  return Object.freeze({
    implementationSha256,
    readySelector: input.readySelector,
    ...(sealedSnapshot === undefined ? {} : { sealedSnapshot }),
  })
}

function validatePreviewIdentity(preview: PreparedPreview): PreviewIdentity {
  if (
    !hasExactDataKeys(preview.identity, [
      "workflowID",
      "kind",
      "revision",
      "configSha256",
      "sourceSha256",
      "readySelectorSha256",
    ])
  ) {
    throw new TypeError("Prepared preview identity is not exact")
  }
  const workflowID = Schema.decodeUnknownSync(Workflow.ID)(preview.identity.workflowID)
  const configSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(preview.identity.configSha256)
  const sourceSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(preview.identity.sourceSha256)
  const readySelectorSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(preview.identity.readySelectorSha256)
  if (
    (preview.identity.kind !== "reference" && preview.identity.kind !== "implementation") ||
    !Number.isSafeInteger(preview.identity.revision) ||
    preview.identity.revision < 0 ||
    (preview.identity.kind === "reference" && preview.identity.revision !== 0) ||
    preview.revision !== preview.identity.revision ||
    preview.configSha256 !== configSha256
  ) {
    throw new TypeError("Prepared preview identity changed")
  }
  return Object.freeze({
    workflowID,
    kind: preview.identity.kind,
    revision: preview.identity.revision,
    configSha256,
    sourceSha256,
    readySelectorSha256,
  })
}

function capturedFromFakeRecord(coordinatesInput: EvidenceCoordinates, record: FakeEvidenceRecord): CapturedImage {
  const coordinates = validateEvidenceCoordinates(coordinatesInput)
  const id = evidenceID(coordinates)
  const receipt = validateEvidenceReceipt(record.receipt)
  if (receipt.evidenceID !== id || !sameCoordinates(receipt.coordinates, coordinates)) {
    throw new Failure({
      operation: "lookup_evidence",
      code: "evidence_conflict",
      message: "Evidence ID is bound to conflicting logical metadata",
    })
  }
  if (record.state === "released") {
    throw new Failure({
      operation: "lookup_evidence",
      code: "evidence_released",
      message: "Released evidence is owned by its durable artifact",
    })
  }
  if (record.state === "abandoned") {
    throw new Failure({
      operation: "lookup_evidence",
      code: "evidence_abandoned",
      message: "Abandoned evidence is a terminal accounting tombstone",
    })
  }
  if (record.state === "capturing") {
    throw new Failure({
      operation: "lookup_evidence",
      code: "evidence_capture_ambiguous",
      message: "Evidence capture intent has no durable PNG result",
    })
  }
  if (record.state !== "staged" && record.state !== "committed") throw new TypeError("Evidence state is invalid")
  if (record.bytes === undefined) throw new TypeError("Active evidence has no PNG bytes")
  return restoreCapturedImage({ receipt: record.receipt, bytes: record.bytes })
}

function bindFakeEvidence(
  store: FakeEvidenceStore,
  operation: "commit" | "release",
  input: BindEvidenceInput,
  now: () => number,
): EvidenceSummary {
  const receipt = validateEvidenceReceipt(input.receipt)
  const artifact = evidenceArtifactBinding(input)
  const record = store.items.get(receipt.evidenceID)
  if (record === undefined || !sameReceipt(record.receipt, receipt)) throw new TypeError("Evidence receipt is unknown")
  if (record.state !== "released" && record.state !== "abandoned") {
    if (record.bytes === undefined) throw new TypeError("Active evidence has no PNG bytes")
    restoreCapturedImage({ receipt: record.receipt, bytes: record.bytes })
  }
  if (operation === "commit") {
    if (record.state === "staged") {
      record.state = "committed"
      record.artifact = artifact
      record.updatedAt = now()
    } else if (
      record.state === "abandoned" ||
      record.state === "capturing" ||
      !sameArtifact(record.artifact, artifact)
    ) {
      throw evidenceConflict("commit_evidence", "Evidence is bound to a different artifact")
    }
  } else {
    if (record.state === "staged") {
      throw evidenceConflict("release_evidence", "Evidence must be committed before release")
    }
    if (record.state === "abandoned" || record.state === "capturing" || !sameArtifact(record.artifact, artifact)) {
      throw evidenceConflict("release_evidence", "Evidence artifact binding differs")
    }
    if (record.state === "committed") {
      record.state = "released"
      record.bytes = undefined
      record.updatedAt = now()
    }
  }
  return cloneSummary(record)
}

function abandonFakeEvidence(
  store: FakeEvidenceStore,
  input: AbandonEvidenceInput,
  now: () => number,
): EvidenceSummary {
  const receipt = validateEvidenceReceipt(input.receipt)
  const terminal = evidenceAbandonmentBinding({ receipt, terminal: input.terminal })
  const record = store.items.get(receipt.evidenceID)
  if (record === undefined || !sameReceipt(record.receipt, receipt)) throw new TypeError("Evidence receipt is unknown")
  if (record.state === "committed" || record.state === "released") {
    throw new TypeError("Artifact-bound evidence cannot be abandoned")
  }
  if (record.state === "abandoned") {
    if (!sameAbandonment(record.abandonment, terminal)) throw new TypeError("Evidence has another terminal authority")
    return cloneSummary(record)
  }
  record.state = "abandoned"
  record.bytes = undefined
  record.abandonment = terminal
  record.updatedAt = now()
  return cloneSummary(record)
}

function reconcileFakeEvidence(
  store: FakeEvidenceStore,
  input: ReconcileEvidenceInput,
  now: () => number,
): ReconcileEvidenceResult {
  const workflowID = Schema.decodeUnknownSync(Workflow.ID)(input.workflowID)
  const active = new Map<EvidenceID, EvidenceCoordinates>()
  for (const candidate of input.active) {
    const coordinates = validateEvidenceCoordinates(candidate)
    if (coordinates.workflowID !== workflowID) throw new TypeError("Active evidence belongs to another workflow")
    const id = evidenceID(coordinates)
    const prior = active.get(id)
    if (prior !== undefined && !sameCoordinates(prior, coordinates))
      throw new TypeError("Active evidence authority conflicts")
    active.set(id, coordinates)
  }
  const abandoned = new Map<EvidenceID, AbandonEvidenceInput>()
  for (const candidate of input.abandoned) {
    const receipt = validateEvidenceReceipt(candidate.receipt)
    evidenceAbandonmentBinding({ receipt, terminal: candidate.terminal })
    if (receipt.coordinates.workflowID !== workflowID || active.has(receipt.evidenceID)) {
      throw new TypeError("Abandoned evidence authority conflicts")
    }
    const prior = abandoned.get(receipt.evidenceID)
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(candidate)) {
      throw new TypeError("Abandoned evidence authority conflicts")
    }
    abandoned.set(receipt.evidenceID, candidate)
  }
  const committed = new Map<EvidenceID, BindEvidenceInput & { readonly release: boolean }>()
  for (const binding of input.committed) {
    const receipt = validateEvidenceReceipt(binding.receipt)
    evidenceArtifactBinding(binding)
    if (
      receipt.coordinates.workflowID !== workflowID ||
      active.has(receipt.evidenceID) ||
      abandoned.has(receipt.evidenceID)
    ) {
      throw new TypeError("Committed evidence authority conflicts")
    }
    const prior = committed.get(receipt.evidenceID)
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(binding)) {
      throw new TypeError("Committed evidence authority conflicts")
    }
    committed.set(receipt.evidenceID, binding)
  }
  for (const [id, coordinates] of active) {
    const record = store.items.get(id)
    if (
      record === undefined ||
      record.receipt.evidenceID !== id ||
      !sameCoordinates(validateEvidenceReceipt(record.receipt).coordinates, coordinates)
    ) {
      throw new TypeError("Active evidence receipt is unknown")
    }
  }
  for (const binding of abandoned.values()) abandonFakeEvidence(store, binding, now)
  for (const binding of committed.values()) {
    bindFakeEvidence(store, "commit", binding, now)
    if (binding.release) bindFakeEvidence(store, "release", binding, now)
  }
  const result: { [K in keyof ReconcileEvidenceResult]: EvidenceSummary[] } = {
    active: [],
    committed: [],
    released: [],
    abandoned: [],
    ambiguous: [],
  }
  for (const record of [...store.items.values()].sort((left, right) =>
    left.evidenceID.localeCompare(right.evidenceID),
  )) {
    if (record.receipt.coordinates.workflowID !== workflowID) continue
    if (record.state === "staged" || record.state === "committed") {
      capturedFromFakeRecord(record.receipt.coordinates, record)
    }
    const summary = cloneSummary(record)
    if (record.state === "released") result.released.push(summary)
    else if (active.has(record.evidenceID)) result.active.push(summary)
    else if (record.state === "abandoned" || abandoned.has(record.evidenceID)) result.abandoned.push(summary)
    else if (record.state === "committed") result.committed.push(summary)
    else result.ambiguous.push(summary)
  }
  return Object.freeze({
    active: Object.freeze(result.active),
    committed: Object.freeze(result.committed),
    released: Object.freeze(result.released),
    abandoned: Object.freeze(result.abandoned),
    ambiguous: Object.freeze(result.ambiguous),
  })
}

function cloneSummary(record: FakeEvidenceRecord): EvidenceSummary {
  return Object.freeze({
    evidenceID: record.evidenceID,
    coordinates: validateEvidenceCoordinates(record.coordinates),
    receipt: validateEvidenceReceipt(record.receipt),
    state: record.state,
    ...(record.artifact === undefined ? {} : { artifact: record.artifact }),
    ...(record.abandonment === undefined ? {} : { abandonment: record.abandonment }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  })
}

function cloneCapturedImage(image: CapturedImage): CapturedImage {
  return Object.freeze({ ...image, bytes: Uint8Array.from(image.bytes) })
}

function evidenceFailure(operation: Failure["operation"], cause: unknown): Failure {
  if (cause instanceof Failure) {
    return new Failure({ operation, code: cause.code, message: cause.message })
  }
  return new Failure({
    operation,
    code: "invalid_evidence_receipt",
    message: "Evidence authority or durable state is invalid",
  })
}

function evidenceConflict(operation: "commit_evidence" | "release_evidence", message: string): Failure {
  return new Failure({ operation, code: "evidence_conflict", message })
}

function sameCoordinates(left: EvidenceCoordinates, right: EvidenceCoordinates): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameReceipt(left: EvidenceReceipt, right: EvidenceReceipt): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameArtifact(left: EvidenceArtifactBinding | undefined, right: EvidenceArtifactBinding): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

function sameAbandonment(left: EvidenceAbandonmentBinding | undefined, right: EvidenceAbandonmentBinding): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

function hasExactDataKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return keys.every((key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key] ?? {}, "value"))
}

/** Validate the only URL shape a PreparedPreview may expose. */
export function validateHandle(value: string): boolean {
  return canonicalHandle(value) !== undefined
}

/** Constructor for trusted runtime adapters; capture still verifies ownership. */
export function preparedPreview(input: {
  readonly hostID: HostID
  readonly url: string
  readonly workflowID: Workflow.ID
  readonly kind: PreviewKind
  readonly revision: number
  readonly configSha256: string
  readonly sourceSha256: string
  readonly readySelectorSha256: string
  readonly scope: Scope.Scope
}): PreparedPreview {
  const handle = canonicalHandle(input.url)
  if (handle === undefined) {
    throw new Failure({
      operation: "prepare_implementation",
      code: "invalid_preview_handle",
      message: "Prepared preview URL is not a loopback capability",
    })
  }
  if (
    handle.hostID !== input.hostID ||
    (input.kind !== "reference" && input.kind !== "implementation") ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    (input.kind === "reference" && input.revision !== 0)
  ) {
    throw new Failure({
      operation: "prepare_implementation",
      code: "invalid_preview_handle",
      message: "Prepared preview identity is not canonical",
    })
  }
  const workflowID = Schema.decodeUnknownSync(Workflow.ID)(input.workflowID)
  const configSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(input.configSha256)
  const sourceSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(input.sourceSha256)
  const readySelectorSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(input.readySelectorSha256)
  const identity = Object.freeze({
    workflowID,
    kind: input.kind,
    revision: input.revision,
    configSha256,
    sourceSha256,
    readySelectorSha256,
  })
  return Object.freeze({
    hostID: input.hostID,
    url: CapabilityURL.make(handle.url),
    origin: handle.origin,
    revision: input.revision,
    configSha256,
    identity,
    scope: input.scope,
  })
}

function canonicalHandle(
  value: string,
): { readonly url: string; readonly origin: string; readonly hostID: string } | undefined {
  if (typeof value !== "string") return undefined
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/([a-f0-9]{64})\/$/.exec(value)
  if (match === null) return undefined
  const port = Number(match[1])
  if (!Number.isSafeInteger(port) || port > 65_535) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.href !== value || parsed.port !== match[1]) return undefined
    return { url: parsed.href, origin: parsed.origin, hostID: match[2] ?? "" }
  } catch {
    return undefined
  }
}

/**
 * Resolve a cleanup target through the filesystem and require it to be a
 * strict descendant of a configured host root with no workspace overlap.
 */
export function cleanupTarget(input: {
  readonly hostRoots: readonly string[]
  readonly target: string
  readonly workspace?: string
}): string {
  try {
    if (input.hostRoots.length === 0) throw new TypeError("no host roots")
    const lexicalTarget = path.resolve(input.target)
    const target = canonical(input.target)
    if (comparisonKey(lexicalTarget) !== comparisonKey(target)) throw new TypeError("cleanup aliases are forbidden")
    const roots = input.hostRoots.map(canonical)
    if (!roots.some((root) => strictlyContains(root, target))) throw new TypeError("outside host roots")
    if (input.workspace !== undefined) {
      const workspace = canonical(input.workspace)
      if (contains(workspace, target) || contains(target, workspace)) throw new TypeError("workspace overlap")
    }
    return target
  } catch (cause) {
    if (cause instanceof Failure) throw cause
    throw new Failure({
      operation: "cleanup",
      code: "cleanup_target_rejected",
      message: "Cleanup target is not a verified host-owned descendant",
    })
  }
}

/** A small valid RGBA PNG whose bytes are stable for an exact viewport. */
export function deterministicPng(viewport: DesignArtifact.Viewport): Uint8Array {
  const decoded = Schema.decodeUnknownSync(DesignArtifact.Viewport)(viewport)
  validateViewportBounds(decoded)
  const stride = decoded.width * 4 + 1
  const raw = Buffer.alloc(stride * decoded.height)
  const compressed = deflateSync(raw, { level: 9 })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(decoded.width, 0)
  ihdr.writeUInt32BE(decoded.height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", compressed),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  )
}

function referenceHash(referenceApp: WorkflowDesignArtifact.ReferenceApp): string {
  if (referenceApp.files.length === 0) throw new TypeError("empty reference")
  const paths = referenceApp.files.map((file) => Schema.decodeUnknownSync(DesignArtifact.SourcePath)(file.path))
  const topology = DesignArtifact.sourceTopologyError(paths)
  if (topology !== undefined || !paths.includes(referenceApp.entrypoint)) throw new TypeError("invalid topology")
  if (typeof referenceApp.readySelector !== "string" || referenceApp.readySelector.length === 0) {
    throw new TypeError("missing ready selector")
  }
  const files = referenceApp.files.map((file, index) => ({ path: paths[index], content: file.content }))
  return hash(
    WorkflowDesignArtifact.encode({
      entrypoint: referenceApp.entrypoint,
      readySelector: referenceApp.readySelector,
      projectStack: referenceApp.projectStack,
      files,
    }),
  )
}

function validateViewportBounds(viewport: DesignArtifact.Viewport): void {
  if (
    viewport.width > MAX_VIEWPORT_DIMENSION ||
    viewport.height > MAX_VIEWPORT_DIMENSION ||
    viewport.width * viewport.height > MAX_VIEWPORT_PIXELS
  ) {
    throw new TypeError("viewport exceeds host bounds")
  }
}

function validatePngSync(bytes: Uint8Array, viewport: DesignArtifact.Viewport): void {
  WorkflowVisualReviewArtifact.assertPng(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset + 16, 8)
  if (view.getUint32(0) !== viewport.width || view.getUint32(4) !== viewport.height) {
    throw new TypeError("PNG dimensions differ from the requested viewport")
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii")
  const chunk = Buffer.alloc(12 + data.byteLength)
  chunk.writeUInt32BE(data.byteLength, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(typeBytes, data), 8 + data.byteLength)
  return chunk
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

function canonical(value: string): string {
  if (!path.isAbsolute(value)) throw new TypeError("path is not absolute")
  assertNoDeviceSegments(value)
  const result = realpathSync.native(value)
  if (!statSync(result).isDirectory()) throw new TypeError("path is not a directory")
  return result
}

function assertNoDeviceSegments(value: string): void {
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    const basename = segment.split(".")[0].toUpperCase()
    if (/^(?:CON|PRN|AUX|NUL|COM(?:[1-9]|¹|²|³)|LPT(?:[1-9]|¹|²|³))$/.test(basename)) {
      throw new TypeError("Windows device path")
    }
  }
}

function strictlyContains(parent: string, child: string): boolean {
  return comparisonKey(parent) !== comparisonKey(child) && contains(parent, child)
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(comparisonKey(parent), comparisonKey(child))
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function comparisonKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value
}

function unavailable(operation: Failure["operation"]): Effect.Effect<never, Failure> {
  return failure(operation, "visual_host_unavailable", "Workflow visual host runtime is not installed")
}

function failure(
  operation: Failure["operation"],
  code: Failure["code"],
  message: string,
): Effect.Effect<never, Failure> {
  return Effect.fail(new Failure({ operation, code, message }))
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
