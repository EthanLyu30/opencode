export * as WorkflowVisualHost from "./visual-host"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { makeGlobalNode } from "../effect/app-node"
import { WorkflowDesignArtifact } from "./artifacts/design"
import { WorkflowVisualReviewArtifact } from "./artifacts/visual-review"
import { PreviewPlan } from "./preview-plan"

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_WORKFLOW_EVIDENCE_BYTES = 128 * 1024 * 1024
export const MAX_VIEWPORT_DIMENSION = 8_192
export const MAX_VIEWPORT_PIXELS = 33_554_432

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
  /** The handle is valid only while this owning Effect scope remains open. */
  readonly scope: Scope.Scope
}

export interface CapturedImage {
  readonly bytes: Uint8Array
  readonly viewport: DesignArtifact.Viewport
  readonly width: number
  readonly height: number
  readonly sha256: string
  readonly evidenceBytes: number
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

export interface CaptureInput {
  readonly preview: PreparedPreview
  readonly viewport: DesignArtifact.Viewport
  readonly readySelector: string
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
  readonly recoverExpired: (input: RecoverExpiredInput) => Effect.Effect<void, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkflowVisualHost") {}

export interface FakeOptions {
  readonly captureBytes?: (input: CaptureInput) => Uint8Array
  readonly initialEvidenceBytes?: Readonly<Record<string, number>>
  readonly onRelease?: (hostID: HostID) => void
  readonly now?: () => number
}

interface FakeRecord {
  readonly workflowID: Workflow.ID
  readonly preview: PreparedPreview
  readonly createdAt: number
}

/** Deterministic, process-free host for Core orchestration and crash tests. */
export function fakeLayer(options: FakeOptions = {}): Layer.Layer<Service> {
  const active = new Map<HostID, FakeRecord>()
  const evidence = new Map<string, number>(Object.entries(options.initialEvidenceBytes ?? {}))
  const now = options.now ?? (() => Date.now())

  const acquire = Effect.fn("WorkflowVisualHost.fake.acquire")(function* (input: {
    readonly workflowID: Workflow.ID
    readonly revision: number
    readonly configSha256: string
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
    const hostID = HostID.make(hash(`${input.workflowID}\0${input.kind}\0${input.revision}\0${input.configSha256}`))
    const preview = preparedPreview({
      hostID,
      url: `http://127.0.0.1:4173/${hostID}/`,
      revision: input.revision,
      configSha256: input.configSha256,
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
        const configSha256 = yield* Effect.try({
          try: () => referenceHash(input.referenceApp),
          catch: () =>
            new Failure({
              operation: "materialize_reference",
              code: "invalid_reference_app",
              message: "Reference application failed host validation",
            }),
        })
        return yield* acquire({ workflowID: input.workflowID, revision: 0, configSha256, kind: "reference" })
      }),
    prepareImplementation: (input) =>
      Effect.gen(function* () {
        if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !PreviewPlan.isFrozen(input.plan)) {
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
        return yield* acquire({
          workflowID: input.workflowID,
          revision: input.revision,
          configSha256: input.plan.configSha256,
          kind: "implementation",
        })
      }),
    capture: (input) =>
      Effect.gen(function* () {
        const record = active.get(input.preview.hostID)
        if (record === undefined || record.preview !== input.preview) {
          return yield* failure(
            "capture",
            "invalid_preview_handle",
            "Capture requires an active host-minted preview handle",
          )
        }
        const viewport = yield* decodeViewport(input.viewport)
        if (typeof input.readySelector !== "string" || input.readySelector.length === 0) {
          return yield* failure("capture", "capture_failed", "Capture requires a non-empty ready selector")
        }
        const used = evidence.get(record.workflowID) ?? 0
        if (used >= MAX_WORKFLOW_EVIDENCE_BYTES) {
          return yield* failure(
            "capture",
            "workflow_evidence_limit_exceeded",
            "Workflow screenshot evidence exceeds 128 MiB",
          )
        }
        const bytes = yield* Effect.try({
          try: () => (options.captureBytes ?? ((value: CaptureInput) => deterministicPng(value.viewport)))(input),
          catch: () =>
            new Failure({ operation: "capture", code: "capture_failed", message: "Deterministic capture failed" }),
        })
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          return yield* failure("capture", "image_evidence_limit_exceeded", "Screenshot exceeds 8 MiB")
        }
        if (used + bytes.byteLength > MAX_WORKFLOW_EVIDENCE_BYTES) {
          return yield* failure(
            "capture",
            "workflow_evidence_limit_exceeded",
            "Workflow screenshot evidence exceeds 128 MiB",
          )
        }
        yield* validatePng(bytes, viewport)
        evidence.set(record.workflowID, used + bytes.byteLength)
        return Object.freeze({
          bytes,
          viewport: Object.freeze({ ...viewport }),
          width: viewport.width,
          height: viewport.height,
          sha256: hash(bytes),
          evidenceBytes: bytes.byteLength,
        })
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
    recoverExpired: () => unavailable("recover_expired"),
  }),
)

export const node = makeGlobalNode({ service: Service, layer: unavailableLayer, deps: [] })

/** Validate the only URL shape a PreparedPreview may expose. */
export function validateHandle(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.port !== "0" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/[a-f0-9]{64}\/$/.test(url.pathname)
    )
  } catch {
    return false
  }
}

/** Constructor for trusted runtime adapters; capture still verifies ownership. */
export function preparedPreview(input: {
  readonly hostID: HostID
  readonly url: string
  readonly revision: number
  readonly configSha256: string
  readonly scope: Scope.Scope
}): PreparedPreview {
  if (!validateHandle(input.url)) {
    throw new Failure({
      operation: "prepare_implementation",
      code: "invalid_preview_handle",
      message: "Prepared preview URL is not a loopback capability",
    })
  }
  const url = new URL(input.url)
  if (url.pathname !== `/${input.hostID}/` || !Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Failure({
      operation: "prepare_implementation",
      code: "invalid_preview_handle",
      message: "Prepared preview identity is not canonical",
    })
  }
  const configSha256 = Schema.decodeUnknownSync(DesignArtifact.Sha256)(input.configSha256)
  return Object.freeze({
    hostID: input.hostID,
    url: CapabilityURL.make(input.url),
    origin: url.origin,
    revision: input.revision,
    configSha256,
    scope: input.scope,
  })
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

function decodeViewport(viewport: DesignArtifact.Viewport): Effect.Effect<DesignArtifact.Viewport, Failure> {
  return Effect.try({
    try: () => {
      const decoded = Schema.decodeUnknownSync(DesignArtifact.Viewport)(viewport)
      validateViewportBounds(decoded)
      return decoded
    },
    catch: () => new Failure({ operation: "capture", code: "invalid_viewport", message: "Viewport is not bounded" }),
  })
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

function validatePng(bytes: Uint8Array, viewport: DesignArtifact.Viewport): Effect.Effect<void, Failure> {
  return Effect.try({
    try: () => {
      WorkflowVisualReviewArtifact.assertPng(bytes)
      const view = new DataView(bytes.buffer, bytes.byteOffset + 16, 8)
      if (view.getUint32(0) !== viewport.width || view.getUint32(4) !== viewport.height) {
        throw new TypeError("PNG dimensions differ from the requested viewport")
      }
    },
    catch: () => new Failure({ operation: "capture", code: "capture_failed", message: "Capture is not an exact PNG" }),
  })
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
