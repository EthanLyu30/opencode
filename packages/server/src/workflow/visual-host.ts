export * as WorkflowVisualHostServer from "./visual-host"

import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { WorkflowDesignArtifact } from "@opencode-ai/core/workflow/artifacts/design"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowSecretGuard } from "@opencode-ai/core/workflow/secret-guard"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"
import { Effect, Layer, Scope } from "effect"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { EvidenceLedger } from "./evidence-ledger"
import { Docker } from "./docker"
import { DockerConfig } from "./docker-config"
import { DockerProcessOwnership } from "./docker-process-ownership"
import { HostRootPolicy } from "./host-root-policy"
import { PlaywrightCapture } from "./playwright"
import { ProcessOwnership } from "./process-ownership"

const MAX_PROCESS_LOG_BYTES = 1024 * 1024
const MAX_STATIC_RESPONSE_BYTES = 32 * 1024 * 1024
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 50
const DEFAULT_FINALIZER_TIMEOUT_MS = 5_000
const manifestName = ".host.json"

interface HostRecord {
  readonly hostID: WorkflowVisualHost.HostID
  readonly workflowID: string
  readonly directory: string
  readonly workspace?: string
  materialization?: WorkflowWorkspaceMaterialization.Lease
  readonly createdAt: number
  readySelector?: string
  allowedOrigins: readonly string[]
  captureURL?: string
  processIdentity?: ProcessOwnership.Identity
  process?: ProcessOwnership.OwnedProcess
  logDrains?: readonly Promise<void>[]
  preview?: WorkflowVisualHost.PreparedPreview
  server?: ReturnType<typeof Bun.serve>
  released: boolean
}

export interface Options {
  readonly hostRoot: string
  readonly evidenceRoot?: string
  readonly browser: PlaywrightCapture.Runtime
  readonly evidenceLedger?: EvidenceLedger.Service
  readonly evidenceRootPolicy?: EvidenceLedger.OpenOptions["rootPolicy"]
  readonly hostRootPolicy?: (canonicalHostRoot: string) => void
  readonly workspacePolicy?: (canonicalWorkspace: string) => Promise<void>
  readonly processOwnership?: ProcessOwnership.Service
  readonly now?: () => number
  readonly startupTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly finalizerTimeoutMs?: number
  readonly maxProcessLogBytes?: number
  readonly onSpawnArgv?: (argv: readonly string[]) => void
  readonly onRecordCreated?: (directory: string, signal: AbortSignal) => Promise<void>
  readonly onStaticFileOpened?: (file: string) => Promise<void>
  readonly onStaticFileRead?: (file: string) => Promise<void>
  /**
   * Trusted host seam. Task23.7 supplies a resolver backed by exact durable
   * design + implementation/snapshot authority; absence fails closed.
   */
  readonly resolveImplementationContract?: WorkflowVisualHost.ResolveImplementationContract
  readonly requireImplementationMaterialization?: boolean
}

export function makeLayer(options: Options): Layer.Layer<WorkflowVisualHost.Service, WorkflowVisualHost.Failure> {
  return Layer.effect(
    WorkflowVisualHost.Service,
    Effect.gen(function* () {
      const state = yield* Effect.tryPromise({
        try: () => makeState(options),
        catch: () => failure("recover_expired", "visual_host_unavailable", "Workflow visual host root is unavailable"),
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await Promise.all([...state.active.values()].map((record) => release(state, record)))
          await settleWithin(state.browser.close(), state.finalizerTimeoutMs)
          await settleWithin(state.evidence.close(), state.finalizerTimeoutMs)
        }).pipe(Effect.ignore),
      )
      return WorkflowVisualHost.Service.of({
        materializeReference: (input) => materializeReference(state, input),
        prepareImplementation: (input) => prepareImplementation(state, input),
        capture: (input) => capture(state, input),
        lookupEvidence: (input) => lookupEvidence(state, input),
        commitEvidence: (input) => bindEvidence(state, "commit", input),
        releaseEvidence: (input) => bindEvidence(state, "release", input),
        abandonEvidence: (input) => abandonEvidence(state, input),
        reconcileEvidence: (input) => reconcileEvidence(state, input),
        recoverExpired: (input) => recoverExpired(state, input),
      })
    }),
  )
}

export interface ProductionLayerOptions {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly engine?: Docker.Engine
  readonly aclProbe?: HostRootPolicy.Probe
  readonly browser?: PlaywrightCapture.Runtime
  readonly resolveImplementationContract?: WorkflowVisualHost.ResolveImplementationContract
}

export function productionLayer(input: ProductionLayerOptions) {
  try {
    const configuredRoot = requiredEnvironment(input.environment, "OPENCODE_WORKFLOW_HOST_ROOT")
    const hostRoot = requiredEnvironment(input.environment, "OPENCODE_WORKFLOW_HOST_TEMP")
    const evidenceRoot = requiredEnvironment(input.environment, "OPENCODE_WORKFLOW_EVIDENCE_ROOT")
    const browserRoot = requiredEnvironment(input.environment, "PLAYWRIGHT_BROWSERS_PATH")
    const probe =
      input.aclProbe ??
      HostRootPolicy.productionProbe({
        tempRoot: hostRoot,
      })
    const policy = HostRootPolicy.make({
      hostRoot: configuredRoot,
      evidenceRoot,
      browserRoot,
      tempRoot: hostRoot,
      probe,
    })
    const config = DockerConfig.fromEnvironment(input.environment)
    const configured = makeLayer({
      hostRoot: policy.roots.tempRoot,
      evidenceRoot: policy.roots.evidenceRoot,
      browser:
        input.browser ??
        PlaywrightCapture.productionRuntime({
          browserRoot: policy.roots.browserRoot,
          tempRoot: path.join(policy.roots.browserRoot, "runtime-temp"),
        }),
      evidenceRootPolicy: policy.verifyEvidenceRoot,
      hostRootPolicy: policy.verifyTempRoot,
      workspacePolicy: async (workspace) => {
        const validated = await DockerConfig.validate(config)
        await DockerConfig.admitWorkspace(validated, workspace)
      },
      processOwnership: DockerProcessOwnership.make({
        engine: input.engine ?? Docker.production,
        config,
        hostRoot: policy.roots.tempRoot,
      }),
      resolveImplementationContract: input.resolveImplementationContract,
      requireImplementationMaterialization: true,
    })
    return configured.pipe(Layer.catch(() => WorkflowVisualHost.unavailableLayer))
  } catch {
    return WorkflowVisualHost.unavailableLayer
  }
}

export const layer = Layer.unwrap(Effect.sync(() => productionLayer({ environment: process.env })))

export const node = makeGlobalNode({ service: WorkflowVisualHost.Service, layer, deps: [] })

interface State {
  readonly root: string
  readonly hostRootPolicy?: (canonicalHostRoot: string) => void
  readonly workspacePolicy?: (canonicalWorkspace: string) => Promise<void>
  readonly browser: PlaywrightCapture.Runtime
  readonly processOwnership: ProcessOwnership.Service
  readonly active: Map<WorkflowVisualHost.HostID, HostRecord>
  readonly evidence: EvidenceLedger.Service
  readonly captureTails: Map<string, Promise<void>>
  readonly now: () => number
  readonly startupTimeoutMs: number
  readonly pollIntervalMs: number
  readonly finalizerTimeoutMs: number
  readonly maxProcessLogBytes: number
  readonly onSpawnArgv?: (argv: readonly string[]) => void
  readonly onRecordCreated?: (directory: string, signal: AbortSignal) => Promise<void>
  readonly onStaticFileOpened?: (file: string) => Promise<void>
  readonly onStaticFileRead?: (file: string) => Promise<void>
  readonly resolveImplementationContract?: WorkflowVisualHost.ResolveImplementationContract
  readonly requireImplementationMaterialization: boolean
}

async function makeState(options: Options): Promise<State> {
  if (!path.isAbsolute(options.hostRoot)) throw new TypeError("Workflow host root must be absolute")
  await fs.mkdir(options.hostRoot, { recursive: true })
  const root = await fs.realpath(options.hostRoot)
  if (!(await fs.stat(root)).isDirectory()) throw new TypeError("Workflow host root must be a directory")
  options.hostRootPolicy?.(root)
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const finalizerTimeoutMs = options.finalizerTimeoutMs ?? DEFAULT_FINALIZER_TIMEOUT_MS
  const maxProcessLogBytes = options.maxProcessLogBytes ?? MAX_PROCESS_LOG_BYTES
  if (
    !Number.isSafeInteger(startupTimeoutMs) ||
    startupTimeoutMs <= 0 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs <= 0 ||
    !Number.isSafeInteger(finalizerTimeoutMs) ||
    finalizerTimeoutMs <= 0 ||
    !Number.isSafeInteger(maxProcessLogBytes) ||
    maxProcessLogBytes <= 0
  ) {
    throw new TypeError("Workflow host bounds must be positive safe integers")
  }
  return {
    root,
    hostRootPolicy: options.hostRootPolicy,
    workspacePolicy: options.workspacePolicy,
    browser: options.browser,
    processOwnership: options.processOwnership ?? ProcessOwnership.unavailable,
    active: new Map(),
    evidence:
      options.evidenceLedger ??
      EvidenceLedger.open(options.evidenceRoot ?? path.join(root, ".evidence"), {
        rootPolicy: options.evidenceRootPolicy,
      }),
    captureTails: new Map(),
    now: options.now ?? (() => Date.now()),
    startupTimeoutMs,
    pollIntervalMs,
    finalizerTimeoutMs,
    maxProcessLogBytes,
    onSpawnArgv: options.onSpawnArgv,
    onRecordCreated: options.onRecordCreated,
    onStaticFileOpened: options.onStaticFileOpened,
    onStaticFileRead: options.onStaticFileRead,
    resolveImplementationContract: options.resolveImplementationContract,
    requireImplementationMaterialization: options.requireImplementationMaterialization === true,
  }
}

function materializeReference(
  state: State,
  input: WorkflowVisualHost.MaterializeReferenceInput,
): Effect.Effect<WorkflowVisualHost.PreparedPreview, WorkflowVisualHost.Failure, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const reference = yield* Effect.try({
        try: () => validateReference(input.referenceApp),
        catch: () => failure("materialize_reference", "invalid_reference_app", "Reference application is invalid"),
      })
      const record = yield* Effect.tryPromise({
        try: () => createRecord(state, String(input.workflowID)),
        catch: () => failure("materialize_reference", "visual_host_unavailable", "Reference host could not start"),
      })
      state.active.set(record.hostID, record)
      yield* Effect.addFinalizer(() => Effect.promise(() => release(state, record)).pipe(Effect.ignore))
      const onRecordCreated = state.onRecordCreated
      if (onRecordCreated !== undefined) {
        yield* restore(
          Effect.tryPromise({
            try: (signal) => onRecordCreated(record.directory, signal),
            catch: () => failure("materialize_reference", "visual_host_unavailable", "Reference host could not start"),
          }),
        )
      }
      yield* Effect.tryPromise({
        try: async () => {
          for (const file of reference.files) await writeReferenceFile(state, record, file)
          await guardHostRoot(state, record.directory)
          await writeManifest(state, record)
          startStaticServer(
            record,
            record.directory,
            reference.entrypoint,
            record.directory,
            state.onStaticFileOpened,
            state.onStaticFileRead,
          )
          await guardHostRoot(state, record.directory)
        },
        catch: () => failure("materialize_reference", "visual_host_unavailable", "Reference host could not start"),
      })
      record.preview = WorkflowVisualHost.preparedPreview({
        hostID: record.hostID,
        url: capabilityURL(record),
        workflowID: input.workflowID,
        kind: "reference",
        revision: 0,
        configSha256: reference.configSha256,
        sourceSha256: reference.configSha256,
        readySelectorSha256: createHash("sha256").update(reference.readySelector).digest("hex"),
        scope,
      })
      record.readySelector = reference.readySelector
      return record.preview
    }),
  )
}

function prepareImplementation(
  state: State,
  input: WorkflowVisualHost.PrepareImplementationInput,
): Effect.Effect<WorkflowVisualHost.PreparedPreview, WorkflowVisualHost.Failure, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      yield* Effect.try({
        try: () => {
          if (
            !hasExactKeys(input, ["workflowID", "revision", "plan"]) ||
            !Number.isSafeInteger(input.revision) ||
            input.revision < 0 ||
            !PreviewPlan.isFrozen(input.plan)
          ) {
            throw new TypeError("invalid plan")
          }
          PreviewPlan.verifyConfiguration(input.plan)
          if (input.plan.kind === "script" && !state.processOwnership.available) {
            throw failure(
              "prepare_implementation",
              "visual_host_unavailable",
              "Authenticated preview process ownership is unavailable",
            )
          }
        },
        catch: (cause) =>
          cause instanceof WorkflowVisualHost.Failure
            ? cause
            : failure("prepare_implementation", "invalid_preview_plan", "Preview plan is not frozen"),
      })
      const resolveImplementationContract = state.resolveImplementationContract
      if (state.workspacePolicy !== undefined) {
        yield* Effect.tryPromise({
          try: () => state.workspacePolicy!(input.plan.locationRoot),
          catch: () =>
            failure(
              "prepare_implementation",
              "invalid_preview_plan",
              "Implementation Location overlaps protected host/runtime roots",
            ),
        })
      }
      if (resolveImplementationContract === undefined) {
        return yield* failure(
          "prepare_implementation",
          "visual_host_unavailable",
          "Trusted implementation capture authority is unavailable",
        )
      }
      const contract = yield* Effect.tryPromise({
        try: async () =>
          WorkflowVisualHost.validateImplementationCaptureContract(await resolveImplementationContract(input)),
        catch: (cause) =>
          cause instanceof WorkflowVisualHost.Failure
            ? cause
            : failure(
                "prepare_implementation",
                "invalid_preview_plan",
                "Implementation capture authority rejected the durable contract",
              ),
      })
      const materialization = contract.materialization
      if (state.requireImplementationMaterialization && materialization === undefined)
        return yield* failure(
          "prepare_implementation",
          "visual_host_unavailable",
          "Production implementation preview requires an exact Snapshot materialization",
        )
      if (materialization !== undefined) {
        yield* Effect.try({
          try: () => {
            const lease = WorkflowWorkspaceMaterialization.validate(materialization)
            if (
              lease.workflowID !== input.workflowID ||
              lease.revision !== input.revision ||
              lease.location.directory !== input.plan.locationRoot ||
              lease.manifestSha256 !== contract.implementationSha256
            )
              throw new TypeError("materialization authority mismatch")
          },
          catch: () =>
            failure(
              "prepare_implementation",
              "invalid_preview_plan",
              "Implementation materialization differs from the frozen preview authority",
            ),
        })
        yield* Effect.tryPromise({
          try: () => WorkflowWorkspaceMaterialization.verifyRoot(materialization),
          catch: () =>
            failure(
              "prepare_implementation",
              "invalid_preview_plan",
              "Implementation materialization is absent or mutated",
            ),
        })
      }
      const workspaceRoot = materialization?.root ?? input.plan.locationRoot
      const record = yield* Effect.tryPromise({
        try: () => createRecord(state, String(input.workflowID), workspaceRoot),
        catch: () =>
          failure("prepare_implementation", "visual_host_unavailable", "Implementation host could not start"),
      })
      state.active.set(record.hostID, record)
      record.materialization = materialization
      yield* Effect.addFinalizer(() => Effect.promise(() => release(state, record)).pipe(Effect.ignore))
      if (input.plan.kind === "script") {
        record.processIdentity = { hostID: record.hostID, nonce: randomBytes(32).toString("hex") }
      }
      yield* Effect.tryPromise({
        try: async () => {
          await guardHostRoot(state, record.directory)
          await writeManifest(state, record)
          await fs.mkdir(path.join(record.directory, ".tmp"))
          await guardHostRoot(state, record.directory)
        },
        catch: () =>
          failure("prepare_implementation", "visual_host_unavailable", "Implementation host could not start"),
      })
      if (input.plan.kind === "static") {
        record.allowedOrigins = input.plan.allowedOrigins
        const frozenEntrypoint = input.plan.entrypoint ?? ""
        const materializedEntrypoint =
          materialization === undefined
            ? frozenEntrypoint
            : path.join(workspaceRoot, path.relative(input.plan.locationRoot, frozenEntrypoint))
        yield* Effect.try({
          try: () =>
            startStaticServer(
              record,
              path.dirname(materializedEntrypoint),
              materializedEntrypoint,
              workspaceRoot,
              state.onStaticFileOpened,
              state.onStaticFileRead,
            ),
          catch: () =>
            failure("prepare_implementation", "visual_host_unavailable", "Static implementation host could not start"),
        })
      } else {
        const targetOrigin = yield* Effect.try({
          try: () => requireScriptOrigin(input.plan.allowedOrigins),
          catch: () =>
            failure(
              "prepare_implementation",
              "invalid_preview_plan",
              "Script preview requires one admission-frozen loopback origin",
            ),
        })
        yield* restore(
          Effect.tryPromise({
            try: (signal) =>
              spawnPreviewProcess(
                state,
                record,
                input.plan,
                workspaceRoot,
                signal,
                Date.now() + state.startupTimeoutMs,
              ),
            catch: () =>
              failure("prepare_implementation", "visual_host_unavailable", "Preview process could not start"),
          }),
        )
        yield* restore(
          Effect.tryPromise({
            try: (signal) => waitForOrigin(state, record, targetOrigin, signal),
            catch: () =>
              failure("prepare_implementation", "visual_host_unavailable", "Preview process did not become ready"),
          }),
        )
        yield* Effect.try({
          try: () => startProxyServer(record, targetOrigin),
          catch: () => failure("prepare_implementation", "visual_host_unavailable", "Preview proxy could not start"),
        })
        record.captureURL = targetOrigin
      }
      record.preview = WorkflowVisualHost.preparedPreview({
        hostID: record.hostID,
        url: capabilityURL(record),
        workflowID: input.workflowID,
        kind: "implementation",
        revision: input.revision,
        configSha256: input.plan.configSha256,
        sourceSha256: contract.implementationSha256,
        readySelectorSha256: createHash("sha256").update(contract.readySelector).digest("hex"),
        scope,
      })
      record.readySelector = contract.readySelector
      return record.preview
    }),
  )
}

function capture(
  state: State,
  input: WorkflowVisualHost.CaptureInput,
): Effect.Effect<WorkflowVisualHost.CapturedImage, WorkflowVisualHost.Failure> {
  return Effect.tryPromise({
    try: async (signal) => {
      const record = state.active.get(input.preview.hostID)
      if (record === undefined || record.released || record.preview !== input.preview) {
        throw failure("capture", "invalid_preview_handle", "Capture requires an active preview handle")
      }
      const coordinates = WorkflowVisualHost.evidenceCoordinates(input)
      const evidenceID = WorkflowVisualHost.evidenceID(coordinates)
      return withCaptureLock(state, evidenceID, signal, async () => {
        if (record.released || state.active.get(record.hostID) !== record) {
          throw failure("capture", "invalid_preview_handle", "Capture requires an active preview handle")
        }
        const readySelector = record.readySelector
        if (readySelector === undefined) {
          throw failure("capture", "capture_failed", "Prepared preview has no host-minted ready selector")
        }
        const ownerNonce = randomBytes(32).toString("hex")
        const intent = await state.evidence.beginCapture({ coordinates, ownerNonce, now: state.now() })
        if (intent.status === "existing") return capturedFromLedgerItem(intent.item, "capture")
        if (intent.status === "terminal") {
          throw failure(
            "capture",
            intent.item.state === "released" ? "evidence_released" : "evidence_abandoned",
            "Screenshot evidence is already owned by durable terminal authority",
          )
        }
        if (intent.status === "ambiguous") {
          throw failure(
            "capture",
            "evidence_capture_ambiguous",
            "A durable capture intent belongs to another or crashed owner",
          )
        }
        let completed = false
        try {
          if ((await state.evidence.used(record.workflowID)) >= WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES) {
            throw failure("capture", "workflow_evidence_limit_exceeded", "Workflow evidence exceeds 128 MiB")
          }
          const viewport = validateViewport(input.viewport)
          if (record.materialization !== undefined) {
            await WorkflowWorkspaceMaterialization.verifyRoot(record.materialization).catch(() => {
              throw failure(
                "capture",
                "invalid_preview_handle",
                "Implementation materialization changed before capture",
              )
            })
          }
          const bytes = await state.browser.capture({
            url: record.captureURL ?? input.preview.url,
            viewport,
            readySelector,
            allowedOrigins: record.allowedOrigins,
            signal,
          })
          const image = WorkflowVisualHost.capturedImage(coordinates, bytes)
          const item = await state.evidence.completeCapture({
            receipt: image.receipt,
            bytes: image.bytes,
            ownerNonce,
            now: state.now(),
            limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
          })
          completed = true
          return capturedFromLedgerItem(item, "capture")
        } catch (cause) {
          if (!completed) {
            try {
              await state.evidence.clearCapture({ coordinates, ownerNonce })
            } catch {
              throw new Error("Capture failed and its exact durable intent could not be cleared", { cause })
            }
          }
          throw cause
        }
      })
    },
    catch: (cause) =>
      cause instanceof WorkflowVisualHost.Failure
        ? cause
        : failure("capture", "capture_failed", "Browser capture failed"),
  })
}

function lookupEvidence(
  state: State,
  input: WorkflowVisualHost.LookupEvidenceInput,
): Effect.Effect<WorkflowVisualHost.CapturedImage | undefined, WorkflowVisualHost.Failure> {
  return Effect.tryPromise({
    try: async () => {
      const item = await state.evidence.get(input.coordinates)
      return item === undefined ? undefined : capturedFromLedgerItem(item, "lookup_evidence")
    },
    catch: (cause) => evidenceFailure("lookup_evidence", cause),
  })
}

function bindEvidence(
  state: State,
  operation: "commit" | "release",
  input: WorkflowVisualHost.BindEvidenceInput,
): Effect.Effect<WorkflowVisualHost.EvidenceSummary, WorkflowVisualHost.Failure> {
  return Effect.tryPromise({
    try: async () =>
      evidenceSummary(
        operation === "commit"
          ? await state.evidence.commit(input, state.now())
          : await state.evidence.release(input, state.now()),
      ),
    catch: (cause) => evidenceFailure(operation === "commit" ? "commit_evidence" : "release_evidence", cause),
  })
}

function abandonEvidence(
  state: State,
  input: WorkflowVisualHost.AbandonEvidenceInput,
): Effect.Effect<WorkflowVisualHost.EvidenceSummary, WorkflowVisualHost.Failure> {
  return Effect.tryPromise({
    try: async () => evidenceSummary(await state.evidence.abandon(input, state.now())),
    catch: (cause) => evidenceFailure("abandon_evidence", cause),
  })
}

function reconcileEvidence(
  state: State,
  input: WorkflowVisualHost.ReconcileEvidenceInput,
): Effect.Effect<WorkflowVisualHost.ReconcileEvidenceResult, WorkflowVisualHost.Failure> {
  return Effect.tryPromise({
    try: () => state.evidence.reconcile(input, state.now()),
    catch: (cause) => evidenceFailure("reconcile_evidence", cause),
  })
}

function capturedFromLedgerItem(
  item: EvidenceLedger.Item,
  operation: "capture" | "lookup_evidence",
): WorkflowVisualHost.CapturedImage {
  if (item.state === "released") {
    throw failure(operation, "evidence_released", "Released evidence is owned by its durable artifact")
  }
  if (item.state === "abandoned") {
    throw failure(operation, "evidence_abandoned", "Abandoned evidence is a terminal accounting tombstone")
  }
  if (item.state === "capturing") {
    throw failure(operation, "evidence_capture_ambiguous", "Capture intent has no durable PNG result")
  }
  if (item.receipt === undefined || item.bytes === undefined) {
    throw new TypeError("Active evidence has no exact durable receipt and BLOB")
  }
  return WorkflowVisualHost.restoreCapturedImage({ receipt: item.receipt, bytes: item.bytes })
}

function evidenceSummary(item: EvidenceLedger.Item): WorkflowVisualHost.EvidenceSummary {
  return Object.freeze({
    evidenceID: item.evidenceID,
    coordinates: item.coordinates,
    ...(item.receipt === undefined ? {} : { receipt: item.receipt }),
    state: item.state,
    ...(item.artifact === undefined ? {} : { artifact: item.artifact }),
    ...(item.abandonment === undefined ? {} : { abandonment: item.abandonment }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  })
}

function evidenceFailure(
  operation: WorkflowVisualHost.Failure["operation"],
  cause: unknown,
): WorkflowVisualHost.Failure {
  if (cause instanceof WorkflowVisualHost.Failure) {
    return new WorkflowVisualHost.Failure({ operation, code: cause.code, message: cause.message })
  }
  return failure(operation, "invalid_evidence_receipt", "Durable screenshot evidence is invalid or conflicting")
}

async function withCaptureLock<A>(
  state: State,
  evidenceID: string,
  signal: AbortSignal,
  run: () => Promise<A>,
): Promise<A> {
  const previous = state.captureTails.get(evidenceID) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  state.captureTails.set(evidenceID, tail)
  try {
    await waitForSignal(previous, signal)
    return await run()
  } finally {
    release()
    if (state.captureTails.get(evidenceID) === tail) state.captureTails.delete(evidenceID)
  }
}

function waitForSignal(work: PromiseLike<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const finish = (callback: () => void) => {
      signal.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(signal.reason))
    signal.addEventListener("abort", onAbort, { once: true })
    void Promise.resolve(work).then(
      () => finish(resolve),
      (cause) => finish(() => reject(cause)),
    )
  })
}

function recoverExpired(
  state: State,
  input: WorkflowVisualHost.RecoverExpiredInput,
): Effect.Effect<void, WorkflowVisualHost.Failure> {
  return Effect.tryPromise({
    try: async () => {
      const entries = await fs.readdir(state.root, { withFileTypes: true })
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
          .map(async (entry) => {
            const hostID = WorkflowVisualHost.HostID.make(entry.name)
            if (input.activeHostIDs.has(hostID)) return
            const directory = path.join(state.root, entry.name)
            const manifest = await readManifest(directory)
            if (manifest.createdAt >= input.expiredBefore) return
            const record = state.active.get(hostID)
            if (record !== undefined) {
              if (!(await release(state, record))) throw new Error("Active host shutdown was not confirmed")
              return
            }
            if (manifest.processNonce !== undefined) {
              const recovered = await settleWithin(
                state.processOwnership.recover({ hostID, nonce: manifest.processNonce }),
                state.finalizerTimeoutMs,
              )
              if (!recovered) throw new Error("Orphan process recovery was not confirmed")
            }
            await removeCapability(state.root, directory, undefined, state.hostRootPolicy)
          }),
      )
    },
    catch: () => failure("recover_expired", "cleanup_target_rejected", "Expired host cleanup was rejected"),
  })
}

async function createRecord(state: State, workflowID: string, workspace?: string): Promise<HostRecord> {
  const hostID = WorkflowVisualHost.HostID.make(randomBytes(32).toString("hex"))
  const directory = path.join(state.root, hostID)
  if (workspace !== undefined && pathsOverlap(state.root, workspace)) {
    throw new TypeError("Workflow host root overlaps the admitted workspace")
  }
  await guardHostRoot(state)
  await fs.mkdir(directory)
  await guardHostRoot(state, directory)
  return {
    hostID,
    workflowID,
    directory,
    workspace,
    createdAt: state.now(),
    allowedOrigins: [],
    released: false,
  }
}

function startStaticServer(
  record: HostRecord,
  root: string,
  entrypoint: string,
  containmentRoot: string,
  onStaticFileOpened?: (file: string) => Promise<void>,
  onStaticFileRead?: (file: string) => Promise<void>,
): void {
  record.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const relative = capabilityPath(request.url, record.hostID)
      if (relative === undefined) return new Response("Not found", { status: 404 })
      const target =
        relative === ""
          ? path.isAbsolute(entrypoint)
            ? entrypoint
            : path.join(root, ...entrypoint.split("/"))
          : path.join(root, ...relative.split("/"))
      const file = await readStaticFile(target, containmentRoot, onStaticFileOpened, onStaticFileRead)
      if (file === undefined) return new Response("Not found", { status: 404 })
      if (file.status === "too-large") return new Response("Static response exceeds host limit", { status: 413 })
      return new Response(Uint8Array.from(file.bytes).buffer, { headers: { "content-type": file.contentType } })
    },
  })
}

function startProxyServer(record: HostRecord, targetOrigin: string): void {
  record.allowedOrigins = Object.freeze([targetOrigin])
  record.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const relative = proxyCapabilityPath(request.url, record.hostID)
      if (relative === undefined) return new Response("Not found", { status: 404 })
      const source = new URL(request.url)
      const target = new URL(targetOrigin)
      target.pathname = `/${relative}`
      target.search = source.search
      const headers = new Headers(request.headers)
      for (const name of ["authorization", "cookie", "host", "proxy-authorization"]) headers.delete(name)
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
        redirect: "manual",
      })
      const responseHeaders = new Headers(response.headers)
      responseHeaders.delete("set-cookie")
      return new Response(response.body, { status: response.status, headers: responseHeaders })
    },
  })
}

async function spawnPreviewProcess(
  state: State,
  record: HostRecord,
  plan: PreviewPlan.PreviewPlan,
  workspaceRoot: string,
  signal: AbortSignal,
  deadline: number,
): Promise<void> {
  if (plan.argv === undefined || record.processIdentity === undefined)
    throw new TypeError("Script plan has no identity")
  state.onSpawnArgv?.(plan.argv)
  const runtimeTemp = path.join(record.directory, ".tmp")
  const owned = await state.processOwnership.start({
    identity: record.processIdentity,
    plan,
    workspaceRoot,
    tempRoot: runtimeTemp,
    signal,
    deadline,
  })
  record.process = owned
  record.logDrains = [
    drainBounded(owned.stdout, state.maxProcessLogBytes).catch(() => undefined),
    drainBounded(owned.stderr, state.maxProcessLogBytes).catch(() => undefined),
  ]
}

async function waitForOrigin(state: State, record: HostRecord, origin: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + state.startupTimeoutMs
  let exited = false
  void record.process?.exited.then(
    () => {
      exited = true
    },
    () => {
      exited = true
    },
  )
  while (Date.now() < deadline && !signal.aborted) {
    if (exited) throw new Error("preview process exited")
    const ready = await fetch(origin, { redirect: "manual", signal: AbortSignal.timeout(500) }).then(
      (response) => {
        void response.body?.cancel()
        return response.status < 500
      },
      () => false,
    )
    if (ready) return
    await abortableDelay(state.pollIntervalMs, signal)
  }
  throw new Error("preview process startup timed out")
}

async function release(state: State, record: HostRecord): Promise<boolean> {
  if (record.released) return false
  record.released = true
  if (state.active.get(record.hostID) === record) state.active.delete(record.hostID)
  const serverStopped = await settleWithin(record.server?.stop(true), state.finalizerTimeoutMs)
  let processStopped = true
  if (record.process !== undefined && record.processIdentity !== undefined) {
    processStopped = await settleWithin(
      state.processOwnership.stop({ identity: record.processIdentity, process: record.process }),
      state.finalizerTimeoutMs,
    )
  }
  await settleWithin(Promise.all(record.logDrains ?? []), state.finalizerTimeoutMs)
  if (!serverStopped || !processStopped) return false
  await removeCapability(state.root, record.directory, record.workspace, state.hostRootPolicy)
  return true
}

async function removeCapability(
  root: string,
  directory: string,
  workspace?: string,
  rootPolicy?: (canonicalHostRoot: string) => void,
): Promise<void> {
  if (!(await fs.exists(directory))) return
  rootPolicy?.(root)
  const target = WorkflowVisualHost.cleanupTarget({ hostRoots: [root], target: directory, workspace })
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  } finally {
    rootPolicy?.(root)
  }
}

async function drainBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<void> {
  const reader = stream.getReader()
  let retained = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return
    retained += Math.min(chunk.value.byteLength, Math.max(0, limit - retained))
  }
}

async function settleWithin(work: PromiseLike<unknown> | undefined, timeoutMs: number): Promise<boolean> {
  if (work === undefined) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void Promise.resolve(work).then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(false)
      },
    )
  })
}

function validateReference(reference: WorkflowDesignArtifact.ReferenceApp): {
  readonly entrypoint: string
  readonly readySelector: string
  readonly files: readonly { readonly path: string; readonly content: string }[]
  readonly configSha256: string
} {
  if (!hasExactKeys(reference, ["entrypoint", "readySelector", "projectStack", "files"])) {
    throw new TypeError("reference shape")
  }
  if (
    !validSourcePath(reference.entrypoint) ||
    typeof reference.readySelector !== "string" ||
    reference.readySelector.length === 0 ||
    !Array.isArray(reference.projectStack) ||
    reference.projectStack.length === 0 ||
    reference.projectStack.some((value) => typeof value !== "string" || value.length === 0) ||
    !Array.isArray(reference.files) ||
    reference.files.length === 0
  ) {
    throw new TypeError("reference fields")
  }
  const files = reference.files.map((file) => {
    if (
      !hasExactKeys(file, ["path", "content"]) ||
      !validSourcePath(file.path) ||
      typeof file.content !== "string" ||
      new TextEncoder().encode(file.content).byteLength === 0
    ) {
      throw new TypeError("reference file")
    }
    WorkflowSecretGuard.assertSafe(file.content)
    return { path: file.path, content: file.content }
  })
  if (!files.some((file) => file.path === reference.entrypoint) || topologyError(files.map((file) => file.path))) {
    throw new TypeError("reference topology")
  }
  WorkflowSecretGuard.assertSafe(reference)
  return {
    entrypoint: reference.entrypoint,
    readySelector: reference.readySelector,
    files,
    configSha256: createHash("sha256")
      .update(
        WorkflowDesignArtifact.encode({
          entrypoint: reference.entrypoint,
          readySelector: reference.readySelector,
          projectStack: reference.projectStack,
          files,
        }),
      )
      .digest("hex"),
  }
}

function validateViewport(viewport: WorkflowVisualHost.CaptureInput["viewport"]): {
  readonly width: number
  readonly height: number
} {
  if (
    !hasExactKeys(viewport, ["name", "width", "height"]) ||
    typeof viewport.name !== "string" ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(viewport.name) ||
    !Number.isSafeInteger(viewport.width) ||
    viewport.width <= 0 ||
    !Number.isSafeInteger(viewport.height) ||
    viewport.height <= 0 ||
    viewport.width > WorkflowVisualHost.MAX_VIEWPORT_DIMENSION ||
    viewport.height > WorkflowVisualHost.MAX_VIEWPORT_DIMENSION ||
    viewport.width * viewport.height > WorkflowVisualHost.MAX_VIEWPORT_PIXELS
  ) {
    throw failure("capture", "invalid_viewport", "Viewport is not bounded")
  }
  return { width: viewport.width, height: viewport.height }
}

function validSourcePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("%") ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false
  }
  return value.split("/").every((segment) => {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      !/^[A-Za-z0-9_][A-Za-z0-9._@+()[\]-]*$/.test(segment) ||
      /[. ]$/.test(segment)
    ) {
      return false
    }
    return !/^(?:CON|PRN|AUX|NUL|COM(?:[1-9]|¹|²|³)|LPT(?:[1-9]|¹|²|³))$/i.test(segment.split(".")[0] ?? "")
  })
}

function topologyError(paths: readonly string[]): boolean {
  const files = new Set<string>()
  const directories = new Set<string>()
  const spellings = new Map<string, string>()
  for (const value of paths) {
    const key = value.toLowerCase()
    if (files.has(key)) return true
    files.add(key)
    const segments = value.split("/")
    for (let index = 1; index < segments.length; index++) {
      const directory = segments.slice(0, index).join("/")
      const directoryKey = directory.toLowerCase()
      const previous = spellings.get(directoryKey)
      if (previous !== undefined && previous !== directory) return true
      spellings.set(directoryKey, directory)
      directories.add(directoryKey)
    }
  }
  return [...directories].some((directory) => files.has(directory))
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  if (Object.getPrototypeOf(value) !== Object.prototype || actual.length !== keys.length) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return keys.every((key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key] ?? {}, "value"))
}

function materializedPath(root: string, value: string): string {
  if (!validSourcePath(value)) throw new TypeError("invalid source path")
  const target = path.resolve(root, ...value.split("/"))
  if (!strictlyContains(root, target)) throw new TypeError("source path escaped capability")
  return target
}

async function readStaticFile(
  target: string,
  root: string,
  onOpened?: (file: string) => Promise<void>,
  onRead?: (file: string) => Promise<void>,
): Promise<
  | { readonly status: "ok"; readonly bytes: Uint8Array; readonly contentType: string }
  | { readonly status: "too-large" }
  | undefined
> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    const lexical = path.resolve(target)
    const canonical = await fs.realpath(lexical)
    if (comparisonKey(lexical) !== comparisonKey(canonical) || !strictlyContains(root, canonical)) return undefined
    const admitted = await fs.lstat(lexical, { bigint: true })
    if (!safeStaticFile(admitted)) return undefined
    handle = await fs.open(lexical, "r")
    const opened = await handle.stat({ bigint: true })
    if (!safeStaticFile(opened) || !sameFileIdentity(admitted, opened)) return undefined
    if (opened.size > BigInt(MAX_STATIC_RESPONSE_BYTES)) return { status: "too-large" }
    await onOpened?.(lexical)
    const bytes = new Uint8Array(Number(opened.size))
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (result.bytesRead === 0) return undefined
      offset += result.bytesRead
    }
    const settled = await handle.stat({ bigint: true })
    await onRead?.(lexical)
    const pathSettled = await fs.lstat(lexical, { bigint: true })
    const canonicalSettled = await fs.realpath(lexical)
    if (
      !safeStaticFile(settled) ||
      !safeStaticFile(pathSettled) ||
      !sameFileIdentity(opened, settled) ||
      !sameFileIdentity(opened, pathSettled) ||
      comparisonKey(canonicalSettled) !== comparisonKey(canonical)
    ) {
      return undefined
    }
    if (
      settled.size !== opened.size ||
      pathSettled.size !== opened.size ||
      settled.size !== pathSettled.size ||
      settled.size > BigInt(MAX_STATIC_RESPONSE_BYTES) ||
      pathSettled.size > BigInt(MAX_STATIC_RESPONSE_BYTES)
    )
      return { status: "too-large" }
    return { status: "ok", bytes, contentType: Bun.file(lexical).type || "application/octet-stream" }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function safeStaticFile(stat: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
}

function sameFileIdentity(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>,
) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs
}

function capabilityPath(url: string, hostID: WorkflowVisualHost.HostID): string | undefined {
  const parsed = new URL(url)
  const prefix = `/${hostID}/`
  if (!parsed.pathname.startsWith(prefix)) return undefined
  const value = parsed.pathname.slice(prefix.length)
  if (value === "") return ""
  try {
    const decoded = decodeURIComponent(value)
    return validSourcePath(decoded) ? decoded : undefined
  } catch {
    return undefined
  }
}

function proxyCapabilityPath(url: string, hostID: WorkflowVisualHost.HostID): string | undefined {
  const parsed = new URL(url)
  const prefix = `/${hostID}/`
  if (!parsed.pathname.startsWith(prefix)) return undefined
  const value = parsed.pathname.slice(prefix.length)
  try {
    const decoded = decodeURIComponent(value)
    if (decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) return undefined
    return decoded.split("/").some((segment) => segment === "." || segment === "..") ? undefined : decoded
  } catch {
    return undefined
  }
}

function capabilityURL(record: HostRecord): string {
  if (record.server === undefined) throw new TypeError("Capability server is unavailable")
  return `http://127.0.0.1:${record.server.port}/${record.hostID}/`
}

function requireScriptOrigin(origins: readonly string[]): string {
  if (origins.length !== 1 || PreviewPlan.normalizeLocalOrigin(origins[0] ?? "") !== origins[0]) {
    throw new TypeError("ambiguous script origin")
  }
  return origins[0]
}

async function writeManifest(state: State, record: HostRecord): Promise<void> {
  await guardHostRoot(state, record.directory)
  await fs.writeFile(
    path.join(record.directory, manifestName),
    JSON.stringify({
      hostID: record.hostID,
      createdAt: record.createdAt,
      ...(record.processIdentity === undefined ? {} : { processNonce: record.processIdentity.nonce }),
    }),
    { encoding: "utf8", flag: "wx" },
  )
  await guardHostRoot(state, record.directory)
}

async function writeReferenceFile(
  state: State,
  record: HostRecord,
  file: { readonly path: string; readonly content: string },
): Promise<void> {
  const target = materializedPath(record.directory, file.path)
  await ensureMaterializedParent(state, record.directory, target)
  await guardMaterializedParent(state, record.directory, target)
  await guardHostRoot(state, record.directory)
  await fs.writeFile(target, file.content, { encoding: "utf8", flag: "wx" })
  await guardMaterializedParent(state, record.directory, target)
  const canonical = await fs.realpath(target)
  const stat = await fs.lstat(target)
  if (canonical !== path.resolve(target) || !stat.isFile() || stat.isSymbolicLink()) {
    throw new TypeError("Workflow reference file identity changed")
  }
  await guardHostRoot(state, record.directory)
}

async function ensureMaterializedParent(state: State, capabilityRoot: string, target: string): Promise<void> {
  const relative = path.relative(capabilityRoot, path.dirname(target))
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    if (relative === "") {
      await guardHostRoot(state, capabilityRoot)
      return
    }
    throw new TypeError("Workflow reference parent escaped capability")
  }
  let current = capabilityRoot
  for (const segment of relative.split(path.sep)) {
    if (comparisonKey(current) === comparisonKey(capabilityRoot)) await guardHostRoot(state, capabilityRoot)
    else await guardMaterializedDirectory(state, capabilityRoot, current)
    const next = path.join(current, segment)
    try {
      await fs.mkdir(next)
    } catch (cause) {
      if (!isFileSystemError(cause, "EEXIST")) throw cause
    }
    await guardMaterializedDirectory(state, capabilityRoot, next)
    current = next
  }
}

async function guardMaterializedParent(state: State, capabilityRoot: string, target: string): Promise<void> {
  await guardHostRoot(state, capabilityRoot)
  let current = path.dirname(target)
  while (comparisonKey(current) !== comparisonKey(capabilityRoot)) {
    await guardMaterializedDirectory(state, capabilityRoot, current)
    current = path.dirname(current)
  }
}

async function guardMaterializedDirectory(state: State, capabilityRoot: string, directory: string): Promise<void> {
  await guardHostRoot(state, capabilityRoot)
  const canonical = await fs.realpath(directory)
  const stat = await fs.lstat(directory)
  if (
    canonical !== path.resolve(directory) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !strictlyContains(capabilityRoot, canonical)
  ) {
    throw new TypeError("Workflow reference parent identity changed")
  }
}

function isFileSystemError(cause: unknown, code: string): cause is Error & { readonly code: string } {
  return cause instanceof Error && Reflect.get(cause, "code") === code
}

async function guardHostRoot(state: State, directory?: string): Promise<void> {
  const canonicalRoot = await fs.realpath(state.root)
  if (canonicalRoot !== state.root || !(await fs.lstat(state.root)).isDirectory()) {
    throw new TypeError("Workflow host root identity changed")
  }
  state.hostRootPolicy?.(canonicalRoot)
  if (directory === undefined) return
  const canonicalDirectory = await fs.realpath(directory)
  const stat = await fs.lstat(directory)
  if (
    canonicalDirectory !== path.resolve(directory) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !strictlyContains(canonicalRoot, canonicalDirectory)
  ) {
    throw new TypeError("Workflow capability directory identity changed")
  }
}

function requiredEnvironment(environment: Readonly<Record<string, string | undefined>>, name: string) {
  const value = environment[name]
  if (value === undefined || value === "") throw new TypeError(`${name} is required`)
  return value
}

async function readManifest(directory: string): Promise<{
  readonly createdAt: number
  readonly processNonce?: string
}> {
  const value: unknown = await Bun.file(path.join(directory, manifestName)).json()
  const hasProcessNonce = value !== null && typeof value === "object" && Object.hasOwn(value, "processNonce")
  if (
    value === null ||
    typeof value !== "object" ||
    !hasExactKeys(value, hasProcessNonce ? ["hostID", "createdAt", "processNonce"] : ["hostID", "createdAt"]) ||
    typeof Reflect.get(value, "hostID") !== "string" ||
    path.basename(directory) !== Reflect.get(value, "hostID") ||
    typeof Reflect.get(value, "createdAt") !== "number" ||
    (hasProcessNonce && !/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "processNonce"))))
  ) {
    throw new TypeError("invalid host manifest")
  }
  return {
    createdAt: Reflect.get(value, "createdAt"),
    ...(hasProcessNonce ? { processNonce: String(Reflect.get(value, "processNonce")) } : {}),
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left)
}

function strictlyContains(parent: string, child: string): boolean {
  return comparisonKey(parent) !== comparisonKey(child) && contains(parent, child)
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(comparisonKey(parent), comparisonKey(child))
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function comparisonKey(value: string): string {
  return process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function failure(
  operation: WorkflowVisualHost.Failure["operation"],
  code: WorkflowVisualHost.Failure["code"],
  message: string,
): WorkflowVisualHost.Failure {
  return new WorkflowVisualHost.Failure({ operation, code, message })
}
