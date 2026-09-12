export * as WorkflowVisualHostServer from "./visual-host"

import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { WorkflowDesignArtifact } from "@opencode-ai/core/workflow/artifacts/design"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowSecretGuard } from "@opencode-ai/core/workflow/secret-guard"
import { RelativePath } from "@opencode-ai/core/schema"
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
import { ProductionHostRuntime } from "./production-host-runtime"
import { VisualHostClaim } from "./visual-host-claim"

const MAX_PROCESS_LOG_BYTES = 1024 * 1024
const MAX_STATIC_RESPONSE_BYTES = 32 * 1024 * 1024
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 50
const DEFAULT_FINALIZER_TIMEOUT_MS = 5_000
const manifestName = ".host.json"
const MAX_AUTHORITY_FILE_BYTES = 16 * 1024

interface HostRecord {
  readonly hostID: WorkflowVisualHost.HostID
  readonly workflowID: string
  readonly directory: string
  readonly workspace?: string
  readonly createdAt: number
  readonly kind: "static" | "script"
  readonly lease: WorkflowVisualHost.PreviewLeaseAuthority
  claim: VisualHostClaim.Owned
  readonly identity: ProcessOwnership.Identity
  readySelector?: string
  allowedOrigins: readonly string[]
  captureURL?: string
  processIdentity?: ProcessOwnership.Identity
  process?: ProcessOwnership.OwnedProcess
  logDrains?: readonly Promise<void>[]
  preview?: WorkflowVisualHost.PreparedPreview
  server?: ReturnType<typeof Bun.serve>
  released: boolean
  releaseTask?: Promise<boolean>
}

export interface Options {
  readonly hostRoot: string
  readonly evidenceRoot?: string
  readonly browser: PlaywrightCapture.Runtime
  readonly evidenceLedger?: EvidenceLedger.Service
  readonly evidenceRootPolicy?: EvidenceLedger.OpenOptions["rootPolicy"]
  readonly hostRootPolicy?: (canonicalHostRoot: string) => void
  readonly cleanupPolicy?: Pick<HostRootPolicy.ProductionPolicy, "authorizeCleanupTarget" | "verifyCleanupTarget">
  readonly workspacePolicy?: (canonicalWorkspace: string) => Promise<void>
  readonly processOwnership?: ProcessOwnership.Service
  /** Trusted adapter seam for an already-authenticated owned loopback origin. */
  readonly probeOwnedOrigin?: (origin: string, signal: AbortSignal) => Promise<boolean>
  /** Trusted durable Stage resolver used by reference and implementation capabilities. */
  readonly resolvePreviewLease?: (
    workflowID: WorkflowVisualHost.PreviewLeaseAuthority["workflowID"],
  ) => Promise<WorkflowVisualHost.PreviewLeaseAuthority>
  /** Fresh WorkflowStore read; true only for the same live workflow/stage/attempt/owner tuple. */
  readonly isPreviewLeaseLive?: (lease: WorkflowVisualHost.PreviewLeaseAuthority) => Promise<boolean>
  readonly now?: () => number
  readonly startupTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly finalizerTimeoutMs?: number
  readonly maxProcessLogBytes?: number
  readonly onSpawnArgv?: (argv: readonly string[]) => void
  /** Trusted test seam after process ownership returns an authenticated live process. */
  readonly onProcessStarted?: (claim: VisualHostClaim.Owned) => Promise<void>
  /** Trusted test seam after the generation/nonce-bound private staging directory is created. */
  readonly onRecordStagingCreated?: (stagingDirectory: string) => Promise<void>
  /** Trusted test seam after the exact manifest is flushed in a private sibling staging directory. */
  readonly onRecordStaged?: (stagingDirectory: string, finalDirectory: string) => Promise<void>
  /** Trusted test seam after the manifest-bearing staging directory is atomically published. */
  readonly onRecordPublished?: (finalDirectory: string) => Promise<void>
  readonly onRecordCreated?: (directory: string, signal: AbortSignal) => Promise<void>
  readonly onStaticFileOpened?: (file: string) => Promise<void>
  readonly onStaticFileRead?: (file: string) => Promise<void>
  /** Trusted test seam immediately before the final live publication gate. */
  readonly onBeforePreviewPublish?: (claim: VisualHostClaim.Owned) => Promise<void>
  /** Trusted test seams around stale-owner destructive release boundaries. */
  readonly onAfterBeginRelease?: (claim: VisualHostClaim.Owned) => Promise<void>
  readonly onBeforeServerStop?: (claim: VisualHostClaim.Owned) => Promise<void>
  readonly onBeforeCapabilityRemove?: (claim: VisualHostClaim.Owned) => Promise<void>
  readonly onBeforeClaimDelete?: (claim: VisualHostClaim.Owned) => Promise<void>
  /** Trusted test seam after an orphan claim has durably entered releasing. */
  readonly onClaimReleasing?: (claim: VisualHostClaim.Owned) => Promise<void>
  /**
   * Trusted host seam. Task23.7 supplies a resolver backed by exact durable
   * design + implementation/snapshot authority; absence fails closed.
   */
  readonly resolveImplementationContract?: WorkflowVisualHost.ResolveImplementationContract
  readonly requireImplementationSealedSnapshot?: boolean
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
          await Promise.all(
            [...state.active.values()].map((record) => settleWithin(release(state, record), state.finalizerTimeoutMs)),
          )
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
  /** Trusted construction seam; production defaults to PlaywrightCapture.productionRuntime. */
  readonly browserRuntimeFactory?: typeof PlaywrightCapture.productionRuntime
  readonly resolveImplementationContract?: WorkflowVisualHost.ResolveImplementationContract
  readonly resolvePreviewLease?: Options["resolvePreviewLease"]
  readonly isPreviewLeaseLive?: Options["isPreviewLeaseLive"]
}

export function productionLayer(input: ProductionLayerOptions) {
  try {
    const runtime = ProductionHostRuntime.load(input.environment, { probe: input.aclProbe })
    const contract = runtime.contract
    const browserRuntimeFactory = input.browserRuntimeFactory ?? PlaywrightCapture.productionRuntime
    const configured = makeLayer({
      hostRoot: contract.roots.previewCapabilityRoot,
      evidenceRoot: contract.roots.dataRoot,
      browser:
        input.browser ??
        browserRuntimeFactory({
          browserRoot: contract.roots.browserRuntimeRoot,
          tempRoot: contract.roots.browserCacheRoot,
          browserRuntimePolicy: contract.policy.verifyBrowserRuntimeRoot,
          browserCachePolicy: contract.policy.verifyBrowserCacheRoot,
        }),
      evidenceRootPolicy: contract.policy.verifyDataRoot,
      hostRootPolicy: contract.policy.verifyPreviewCapabilityRoot,
      cleanupPolicy: contract.policy,
      workspacePolicy: async (workspace) => {
        contract.policy.verifyDeploymentRoot(contract.roots.deploymentRoot)
        if (pathsOverlap(workspace, contract.roots.deploymentRoot)) {
          throw new TypeError("Workflow Location overlaps the production deployment tree")
        }
        const validated = await DockerConfig.validate(runtime.dockerConfig)
        await DockerConfig.admitWorkspace(validated, workspace)
      },
      processOwnership: DockerProcessOwnership.make({
        engine: input.engine ?? Docker.production,
        config: runtime.dockerConfig,
        hostRoot: contract.roots.previewCapabilityRoot,
        relayIngress: true,
      }),
      resolveImplementationContract: input.resolveImplementationContract,
      resolvePreviewLease: input.resolvePreviewLease,
      isPreviewLeaseLive: input.isPreviewLeaseLive,
      requireImplementationSealedSnapshot: true,
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
  readonly cleanupPolicy?: Options["cleanupPolicy"]
  readonly workspacePolicy?: (canonicalWorkspace: string) => Promise<void>
  readonly browser: PlaywrightCapture.Runtime
  readonly processOwnership: ProcessOwnership.Service
  readonly probeOwnedOrigin: NonNullable<Options["probeOwnedOrigin"]>
  readonly resolvePreviewLease?: Options["resolvePreviewLease"]
  readonly isPreviewLeaseLive?: Options["isPreviewLeaseLive"]
  readonly active: Map<WorkflowVisualHost.HostID, HostRecord>
  readonly evidence: EvidenceLedger.Service
  readonly captureTails: Map<string, Promise<void>>
  readonly now: () => number
  readonly startupTimeoutMs: number
  readonly pollIntervalMs: number
  readonly finalizerTimeoutMs: number
  readonly maxProcessLogBytes: number
  readonly onSpawnArgv?: (argv: readonly string[]) => void
  readonly onProcessStarted?: Options["onProcessStarted"]
  readonly onRecordStagingCreated?: Options["onRecordStagingCreated"]
  readonly onRecordStaged?: Options["onRecordStaged"]
  readonly onRecordPublished?: Options["onRecordPublished"]
  readonly onRecordCreated?: (directory: string, signal: AbortSignal) => Promise<void>
  readonly onStaticFileOpened?: (file: string) => Promise<void>
  readonly onStaticFileRead?: (file: string) => Promise<void>
  readonly onBeforePreviewPublish?: Options["onBeforePreviewPublish"]
  readonly onAfterBeginRelease?: Options["onAfterBeginRelease"]
  readonly onBeforeServerStop?: Options["onBeforeServerStop"]
  readonly onBeforeCapabilityRemove?: Options["onBeforeCapabilityRemove"]
  readonly onBeforeClaimDelete?: Options["onBeforeClaimDelete"]
  readonly onClaimReleasing?: Options["onClaimReleasing"]
  readonly resolveImplementationContract?: WorkflowVisualHost.ResolveImplementationContract
  readonly requireImplementationSealedSnapshot: boolean
}

async function makeState(options: Options): Promise<State> {
  if ((options.resolvePreviewLease === undefined) !== (options.isPreviewLeaseLive === undefined)) {
    throw new TypeError("Workflow preview lease authority is incomplete")
  }
  if (!path.isAbsolute(options.hostRoot)) throw new TypeError("Workflow host root must be absolute")
  if (options.hostRootPolicy === undefined) await fs.mkdir(options.hostRoot, { recursive: true })
  else options.hostRootPolicy(options.hostRoot)
  const lexicalRoot = path.resolve(options.hostRoot)
  const root = await fs.realpath(options.hostRoot)
  const rootStat = await fs.lstat(options.hostRoot)
  if (root !== lexicalRoot || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new TypeError("Workflow host root must be a canonical directory")
  }
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
  const state: State = {
    root,
    hostRootPolicy: options.hostRootPolicy,
    cleanupPolicy: options.cleanupPolicy,
    workspacePolicy: options.workspacePolicy,
    browser: options.browser,
    processOwnership: options.processOwnership ?? ProcessOwnership.unavailable,
    probeOwnedOrigin: options.probeOwnedOrigin ?? probeOwnedOrigin,
    resolvePreviewLease: options.resolvePreviewLease,
    isPreviewLeaseLive: options.isPreviewLeaseLive,
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
    onProcessStarted: options.onProcessStarted,
    onRecordStagingCreated: options.onRecordStagingCreated,
    onRecordStaged: options.onRecordStaged,
    onRecordPublished: options.onRecordPublished,
    onRecordCreated: options.onRecordCreated,
    onStaticFileOpened: options.onStaticFileOpened,
    onStaticFileRead: options.onStaticFileRead,
    onBeforePreviewPublish: options.onBeforePreviewPublish,
    onAfterBeginRelease: options.onAfterBeginRelease,
    onBeforeServerStop: options.onBeforeServerStop,
    onBeforeCapabilityRemove: options.onBeforeCapabilityRemove,
    onBeforeClaimDelete: options.onBeforeClaimDelete,
    onClaimReleasing: options.onClaimReleasing,
    resolveImplementationContract: options.resolveImplementationContract,
    requireImplementationSealedSnapshot: options.requireImplementationSealedSnapshot === true,
  }
  if (state.isPreviewLeaseLive !== undefined) {
    try {
      await recoverLeaseCapabilities(state)
    } catch (cause) {
      await settleWithin(state.evidence.close(), state.finalizerTimeoutMs)
      throw cause
    }
  }
  return state
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
      const lease = yield* Effect.tryPromise({
        try: () => resolvePreviewLease(state, input.workflowID),
        catch: () =>
          failure("materialize_reference", "visual_host_unavailable", "Reference lease authority is unavailable"),
      })
      const record = yield* Effect.tryPromise({
        try: () =>
          createRecord(state, {
            workflowID: String(input.workflowID),
            kind: "static",
            lease,
            purpose: "reference",
            revision: 0,
            configurationSha256: reference.configSha256,
            sourceSha256: reference.configSha256,
          }),
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
          await assertRecordLeaseLive(state, record)
          for (const file of reference.files) {
            await assertRecordLeaseLive(state, record)
            await writeReferenceFile(state, record, file)
            await assertRecordLeaseLive(state, record)
          }
          await guardHostRoot(state, record.directory)
          await assertRecordLeaseLive(state, record)
          startStaticServer(
            record,
            record.directory,
            reference.entrypoint,
            record.directory,
            state.onStaticFileOpened,
            state.onStaticFileRead,
          )
          await assertRecordLeaseLive(state, record)
          await guardHostRoot(state, record.directory)
          await assertRecordLeaseLive(state, record)
        },
        catch: () => failure("materialize_reference", "visual_host_unavailable", "Reference host could not start"),
      })
      return yield* Effect.tryPromise({
        try: () =>
          publishPreview(state, record, {
            workflowID: input.workflowID,
            kind: "reference",
            revision: 0,
            configSha256: reference.configSha256,
            sourceSha256: reference.configSha256,
            readySelectorSha256: createHash("sha256").update(reference.readySelector).digest("hex"),
            readySelector: reference.readySelector,
            scope,
          }),
        catch: () =>
          failure("materialize_reference", "visual_host_unavailable", "Reference lease changed before publication"),
      })
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
      const observedLease = yield* Effect.try({
        try: () => {
          const authority = WorkflowVisualHost.validatePreviewLeaseAuthority(contract.previewLease)
          if (authority.workflowID !== input.workflowID) throw new TypeError("preview lease workflow mismatch")
          return authority
        },
        catch: () =>
          failure(
            "prepare_implementation",
            "invalid_preview_plan",
            "Implementation capture authority has no exact live Stage lease",
          ),
      })
      const lease = yield* Effect.tryPromise({
        try: async () => {
          const current = await resolvePreviewLease(state, input.workflowID)
          if (!sameLeaseTuple(current, observedLease)) throw new TypeError("preview lease tuple changed")
          return current
        },
        catch: () =>
          failure(
            "prepare_implementation",
            "invalid_preview_plan",
            "Implementation capture authority Stage lease is not live",
          ),
      })
      const sealedSnapshot = contract.sealedSnapshot
      if (state.requireImplementationSealedSnapshot && sealedSnapshot === undefined)
        return yield* failure(
          "prepare_implementation",
          "visual_host_unavailable",
          "Production implementation preview requires exact sealed Snapshot bytes",
        )
      if (sealedSnapshot !== undefined) {
        yield* Effect.try({
          try: () => {
            const authority = WorkflowWorkspaceMaterialization.validate(sealedSnapshot)
            if (
              authority.workflowID !== input.workflowID ||
              authority.revision !== input.revision ||
              authority.location.directory !== input.plan.locationRoot ||
              authority.manifestSha256 !== contract.implementationSha256
            )
              throw new TypeError("sealed Snapshot authority mismatch")
          },
          catch: () =>
            failure(
              "prepare_implementation",
              "invalid_preview_plan",
              "Implementation sealed Snapshot differs from the frozen preview authority",
            ),
        })
      }
      const workspaceRoot = input.plan.locationRoot
      const record = yield* Effect.tryPromise({
        try: () =>
          createRecord(state, {
            workflowID: String(input.workflowID),
            kind: input.plan.kind,
            lease,
            purpose: "implementation",
            revision: input.revision,
            configurationSha256: input.plan.configSha256,
            sourceSha256: contract.implementationSha256,
            workspace: sealedSnapshot === undefined ? workspaceRoot : undefined,
          }),
        catch: () =>
          failure("prepare_implementation", "visual_host_unavailable", "Implementation host could not start"),
      })
      state.active.set(record.hostID, record)
      yield* Effect.addFinalizer(() => Effect.promise(() => release(state, record)).pipe(Effect.ignore))
      yield* Effect.tryPromise({
        try: async () => {
          await assertRecordLeaseLive(state, record)
          await guardHostRoot(state, record.directory)
          await fs.mkdir(path.join(record.directory, ".tmp"))
          await assertRecordLeaseLive(state, record)
          await guardHostRoot(state, record.directory)
        },
        catch: () =>
          failure("prepare_implementation", "visual_host_unavailable", "Implementation host could not start"),
      })
      if (input.plan.kind === "static") {
        record.allowedOrigins = input.plan.allowedOrigins
        const frozenEntrypoint = input.plan.entrypoint ?? ""
        yield* Effect.tryPromise({
          try: async () => {
            await assertRecordLeaseLive(state, record)
            startStaticServer(
              record,
              path.dirname(frozenEntrypoint),
              frozenEntrypoint,
              workspaceRoot,
              state.onStaticFileOpened,
              state.onStaticFileRead,
              sealedSnapshot?.archive,
            )
            await assertRecordLeaseLive(state, record)
          },
          catch: () =>
            failure("prepare_implementation", "visual_host_unavailable", "Static implementation host could not start"),
        })
      } else {
        record.allowedOrigins = input.plan.allowedOrigins
        yield* Effect.tryPromise({
          try: () => recoverLeaseCapabilities(state, lease, record.hostID),
          catch: () =>
            failure(
              "prepare_implementation",
              "visual_host_unavailable",
              "Prior preview owner recovery was unavailable",
            ),
        })
        yield* Effect.tryPromise({
          try: async () => {
            await assertRecordLeaseLive(state, record)
          },
          catch: () =>
            failure("prepare_implementation", "visual_host_unavailable", "Preview lease changed before process start"),
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
                sealedSnapshot?.archive,
              ),
            catch: () =>
              failure("prepare_implementation", "visual_host_unavailable", "Preview process could not start"),
          }),
        )
        yield* Effect.tryPromise({
          try: () => assertRecordLeaseLive(state, record),
          catch: () =>
            failure("prepare_implementation", "visual_host_unavailable", "Preview lease changed after process start"),
        })
        const targetOrigin = yield* Effect.try({
          try: () => requireOwnedOrigin(record.process?.origin),
          catch: () =>
            failure(
              "prepare_implementation",
              "visual_host_unavailable",
              "Preview process origin was not authenticated",
            ),
        })
        yield* restore(
          Effect.tryPromise({
            try: (signal) => waitForOrigin(state, record, targetOrigin, signal),
            catch: () =>
              failure("prepare_implementation", "visual_host_unavailable", "Preview process did not become ready"),
          }),
        )
        yield* Effect.tryPromise({
          try: () => assertRecordLeaseLive(state, record),
          catch: () =>
            failure("prepare_implementation", "visual_host_unavailable", "Preview lease changed after readiness"),
        })
        yield* Effect.try({
          try: () => startProxyServer(record, targetOrigin),
          catch: () => failure("prepare_implementation", "visual_host_unavailable", "Preview proxy could not start"),
        })
        yield* Effect.tryPromise({
          try: () => assertRecordLeaseLive(state, record),
          catch: () =>
            failure("prepare_implementation", "visual_host_unavailable", "Preview lease changed before publication"),
        })
        record.captureURL = targetOrigin
        record.allowedOrigins = Object.freeze([targetOrigin, ...input.plan.allowedOrigins])
      }
      return yield* Effect.tryPromise({
        try: () =>
          publishPreview(state, record, {
            workflowID: input.workflowID,
            kind: "implementation",
            revision: input.revision,
            configSha256: input.plan.configSha256,
            sourceSha256: contract.implementationSha256,
            readySelectorSha256: createHash("sha256").update(contract.readySelector).digest("hex"),
            readySelector: contract.readySelector,
            scope,
          }),
        catch: () =>
          failure("prepare_implementation", "visual_host_unavailable", "Preview lease changed before publication"),
      })
    }),
  )
}

async function publishPreview(
  state: State,
  record: HostRecord,
  input: Omit<Parameters<typeof WorkflowVisualHost.preparedPreview>[0], "hostID" | "url"> & {
    readonly readySelector: string
  },
): Promise<WorkflowVisualHost.PreparedPreview> {
  await state.onBeforePreviewPublish?.(record.claim)
  await assertRecordLeaseLive(state, record)
  const preview = WorkflowVisualHost.preparedPreview({
    hostID: record.hostID,
    url: capabilityURL(record),
    workflowID: input.workflowID,
    kind: input.kind,
    revision: input.revision,
    configSha256: input.configSha256,
    sourceSha256: input.sourceSha256,
    readySelectorSha256: input.readySelectorSha256,
    scope: input.scope,
  })
  record.readySelector = input.readySelector
  record.preview = preview
  return preview
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
        await assertRecordLeaseLive(state, record)
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
        let staged: EvidenceLedger.Item | undefined
        try {
          await assertRecordLeaseLive(state, record)
          if ((await state.evidence.used(record.workflowID)) >= WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES) {
            throw failure("capture", "workflow_evidence_limit_exceeded", "Workflow evidence exceeds 128 MiB")
          }
          const viewport = validateViewport(input.viewport)
          await assertRecordLeaseLive(state, record)
          const bytes = await state.browser.capture({
            url: record.captureURL ?? input.preview.url,
            viewport,
            readySelector,
            allowedOrigins: record.allowedOrigins,
            signal,
          })
          await assertRecordLeaseLive(state, record)
          const image = WorkflowVisualHost.capturedImage(coordinates, bytes)
          await assertRecordLeaseLive(state, record)
          staged = await state.evidence.completeCapture({
            receipt: image.receipt,
            bytes: image.bytes,
            ownerNonce,
            now: state.now(),
            limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
          })
          await assertRecordLeaseLive(state, record)
          return capturedFromLedgerItem(staged, "capture")
        } catch (cause) {
          if (staged !== undefined) {
            try {
              if (
                staged.receipt === undefined ||
                !(await state.evidence.rollbackStagedCapture({ receipt: staged.receipt }))
              ) {
                throw new Error("Exact staged evidence was not present", { cause })
              }
            } catch (rollbackCause) {
              // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains both the primary and rollback failures.
              throw new AggregateError(
                [cause, rollbackCause],
                "Capture failed and its exact staged evidence could not be rolled back",
                { cause: rollbackCause },
              )
            }
          } else {
            try {
              await state.evidence.clearCapture({ coordinates, ownerNonce })
            } catch (cleanupCause) {
              // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains both the primary and cleanup failures.
              throw new AggregateError(
                [cause, cleanupCause],
                "Capture failed and its exact durable intent could not be cleared",
                { cause: cleanupCause },
              )
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
    try: () =>
      recoverLeaseCapabilities(state, undefined, undefined, (manifest) => {
        return !input.activeHostIDs.has(manifest.body.hostID) && manifest.body.createdAt < input.expiredBefore
      }),
    catch: () => failure("recover_expired", "cleanup_target_rejected", "Expired host cleanup was rejected"),
  })
}

async function resolvePreviewLease(state: State, workflowID: WorkflowVisualHost.PreviewLeaseAuthority["workflowID"]) {
  if (state.resolvePreviewLease === undefined || state.isPreviewLeaseLive === undefined) {
    throw new TypeError("Workflow preview lease authority is unavailable")
  }
  const lease = WorkflowVisualHost.validatePreviewLeaseAuthority(await state.resolvePreviewLease(workflowID))
  if (lease.workflowID !== workflowID || !(await state.isPreviewLeaseLive(lease))) {
    throw new TypeError("Workflow preview lease is not live")
  }
  return lease
}

function sameLeaseTuple(
  left: WorkflowVisualHost.PreviewLeaseAuthority,
  right: WorkflowVisualHost.PreviewLeaseAuthority,
) {
  return (
    left.workflowID === right.workflowID &&
    left.stageID === right.stageID &&
    left.attempt === right.attempt &&
    left.leaseOwner === right.leaseOwner
  )
}

async function assertLeaseLive(
  state: State,
  observed: WorkflowVisualHost.PreviewLeaseAuthority,
): Promise<WorkflowVisualHost.PreviewLeaseAuthority> {
  const current = await resolvePreviewLease(state, observed.workflowID)
  if (!sameLeaseTuple(current, observed)) throw new TypeError("Workflow preview lease tuple changed")
  return current
}

async function assertRecordLeaseLive(state: State, record: HostRecord): Promise<void> {
  if (record.released || state.active.get(record.hostID) !== record) {
    throw new TypeError("Workflow preview owner is no longer active")
  }
  record.claim = await VisualHostClaim.assertActive(state.root, record.claim)
  await assertLeaseLive(state, record.lease)
}

async function recoverLeaseCapabilities(
  state: State,
  replacementLease?: WorkflowVisualHost.PreviewLeaseAuthority,
  excludeHostID?: WorkflowVisualHost.HostID,
  include: (claim: VisualHostClaim.Owned) => boolean = () => true,
) {
  const isLive = state.isPreviewLeaseLive
  if (isLive === undefined) {
    if (replacementLease !== undefined) throw new TypeError("Workflow preview lease authority is unavailable")
    return
  }
  await guardHostRoot(state)
  const claims = await VisualHostClaim.list(state.root)
  const claimedHostIDs = new Set(claims.map((claim) => String(claim.body.hostID)))
  const claimedStagingNames = new Set(
    claims.map((claim) => `.host.${claim.body.hostID}.${claim.body.generation}.${claim.body.nonce}.pending`),
  )
  for (const entry of await fs.readdir(state.root, { withFileTypes: true })) {
    if (!entry.name.startsWith(".host.") || !entry.name.endsWith(".pending")) continue
    if (!claimedStagingNames.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new TypeError("Workflow record staging directory has no exact durable claim authority")
    }
  }
  for (const claim of claims) {
    const hostID = claim.body.hostID
    if (hostID === excludeHostID) continue
    if (!include(claim)) continue
    if (
      replacementLease !== undefined &&
      (claim.body.workflowID !== replacementLease.workflowID || claim.body.stageID !== replacementLease.stageID)
    ) {
      continue
    }
    const active = state.active.get(hostID)
    if (active !== undefined) {
      if (await isLive(active.lease)) continue
      const staleGate = async () => !(await isLive(active.lease))
      if (!(await release(state, active, staleGate))) {
        throw new Error("Stale active preview shutdown was not confirmed")
      }
      continue
    }
    if (await isLive(leaseFromClaim(claim.body))) continue
    await recoverClaim(state, claim)
  }
  const unclaimed = (await fs.readdir(state.root, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name) && !claimedHostIDs.has(entry.name),
  )
  if (unclaimed.length > 0) {
    throw new TypeError("Workflow capability has no durable claim authority")
  }
}

async function recoverClaim(state: State, claim: VisualHostClaim.Owned): Promise<void> {
  const isLive = state.isPreviewLeaseLive
  if (isLive === undefined) throw new TypeError("Workflow preview lease authority is unavailable")
  const lease = leaseFromClaim(claim.body)
  const finalGate = async () => !(await isLive(lease))
  if (!(await finalGate())) return
  const directory = path.join(state.root, claim.body.hostID)
  if (claim.state === "pending") {
    await VisualHostClaim.rollbackPending(
      state.root,
      claim,
      async () => {
        const staging = path.join(
          state.root,
          `.host.${claim.body.hostID}.${claim.body.generation}.${claim.body.nonce}.pending`,
        )
        if ((await lexicalEntryExists(directory)) || (await lexicalEntryExists(staging))) {
          throw new TypeError("Pending visual host claim has unauthorized side effects")
        }
        if (!(await finalGate())) throw new Error("Preview lease became live before pending claim rollback")
      },
      finalGate,
    )
    return
  }
  const record = await authenticatedRecoveryRecord(state, claim)
  if (claim.state !== "releasing" && !(await finalGate())) return
  const releasing =
    claim.state === "releasing" ? claim : await VisualHostClaim.beginRelease(state.root, claim, finalGate)
  if (releasing === undefined) return
  await state.onClaimReleasing?.(releasing)
  await VisualHostClaim.finishRelease(
    state.root,
    releasing,
    async () => {
      if (record?.kind === "final") {
        await guardHostRoot(state, directory)
        const manifest = await readManifest(directory)
        if (!manifestMatchesClaim(manifest, claim)) {
          throw new TypeError("Workflow capability manifest differs from its durable claim")
        }
        if (claim.body.kind === "script") {
          const recovered = await settleWithin(
            state.processOwnership.recover({ identity: identityFromClaim(claim.body), finalGate }),
            state.finalizerTimeoutMs,
          )
          if (!recovered) throw new Error("Orphan process recovery was not confirmed")
        }
        await state.onBeforeCapabilityRemove?.(releasing)
        if (!(await finalGate())) throw new Error("Preview lease became live before orphan cleanup")
        await removeCapability(state.root, directory, undefined, state.hostRootPolicy, state.cleanupPolicy)
      } else if (record?.kind === "staging") {
        if (!(await finalGate())) throw new Error("Preview lease became live before record staging cleanup")
        await removeExactUnpublishedRecord(state, record.directory, claim, record.identity)
      }
      if (!(await finalGate())) throw new Error("Preview lease became live before claim release")
    },
    {
      beforeAuthorityDelete: async () => state.onBeforeClaimDelete?.(releasing),
      finalGate,
    },
  )
}

async function authenticatedRecoveryRecord(
  state: State,
  claim: VisualHostClaim.Owned,
): Promise<
  | { readonly kind: "final"; readonly directory: string }
  | { readonly kind: "staging"; readonly directory: string; readonly identity: Awaited<ReturnType<typeof fs.lstat>> }
  | undefined
> {
  const finalDirectory = path.join(state.root, claim.body.hostID)
  const prefix = `.host.${claim.body.hostID}.${claim.body.generation}.`
  const stagingEntries = (await fs.readdir(state.root, { withFileTypes: true })).filter(
    (entry) => entry.name.startsWith(prefix) && entry.name.endsWith(".pending"),
  )
  const expectedName = `${prefix}${claim.body.nonce}.pending`
  if (stagingEntries.some((entry) => entry.name !== expectedName)) {
    throw new TypeError("Workflow record staging authority is not bound to the claim nonce")
  }
  if (stagingEntries.length > 1) throw new TypeError("Multiple workflow record staging authorities are ambiguous")
  if (await lexicalEntryExists(finalDirectory)) {
    if (stagingEntries.length !== 0) throw new TypeError("Final workflow record conflicts with a staging authority")
    await guardHostRoot(state, finalDirectory)
    const manifestFile = path.join(finalDirectory, manifestName)
    if (!(await lexicalEntryExists(manifestFile))) {
      throw new TypeError("Final workflow capability has no complete exact manifest")
    }
    const manifest = await readManifest(finalDirectory)
    if (!manifestMatchesClaim(manifest, claim)) {
      throw new TypeError("Workflow capability manifest differs from its durable claim")
    }
    return { kind: "final", directory: finalDirectory }
  }
  const entry = stagingEntries[0]
  if (entry === undefined) return undefined
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new TypeError("Workflow record staging authority is not a directory")
  }
  const directory = path.join(state.root, entry.name)
  await guardHostRoot(state, directory)
  const contents = await fs.readdir(directory, { withFileTypes: true })
  if (contents.length > 1 || (contents.length === 1 && contents[0]?.name !== manifestName)) {
    throw new TypeError("Unexpected workflow record staging state")
  }
  const manifestEntry = contents[0]
  if (manifestEntry !== undefined) {
    if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink()) {
      throw new TypeError("Workflow record staging manifest has unknown identity")
    }
    const manifestFile = path.join(directory, manifestName)
    const canonical = await fs.realpath(manifestFile)
    const stat = await fs.lstat(manifestFile)
    if (canonical !== manifestFile || !isSingleOwnerRegularFile(stat) || stat.size > MAX_AUTHORITY_FILE_BYTES) {
      throw new TypeError("Workflow record staging manifest has unknown identity")
    }
    if (stat.size > 0) {
      try {
        const manifest = await readManifest(directory, claim.body.hostID)
        if (!manifestMatchesClaim(manifest, claim)) {
          throw new TypeError("Workflow record staging manifest differs from its durable claim")
        }
      } catch (cause) {
        if (cause instanceof TypeError && cause.message.includes("differs from")) throw cause
        const text = await fs.readFile(manifestFile, "utf8")
        try {
          JSON.parse(text)
        } catch {
          // A bounded, singly-owned syntactically partial manifest is a recognized pre-publication crash.
          return { kind: "staging", directory, identity: await fs.lstat(directory) }
        }
        throw cause
      }
    }
  }
  return { kind: "staging", directory, identity: await fs.lstat(directory) }
}

function leaseFromClaim(body: VisualHostClaim.Body): WorkflowVisualHost.PreviewLeaseAuthority {
  return WorkflowVisualHost.validatePreviewLeaseAuthority({
    workflowID: body.workflowID,
    stageID: body.stageID,
    attempt: body.attempt,
    leaseOwner: body.leaseOwner,
    leaseExpiresAt: body.leaseExpiresAt,
  })
}

function identityFromClaim(body: VisualHostClaim.Body): ProcessOwnership.Identity {
  return { ...leaseFromClaim(body), hostID: body.hostID, nonce: body.nonce }
}

function sameProcessIdentity(left: ProcessOwnership.Identity, right: ProcessOwnership.Identity): boolean {
  return (
    sameLeaseTuple(left, right) &&
    left.leaseExpiresAt === right.leaseExpiresAt &&
    left.hostID === right.hostID &&
    left.nonce === right.nonce
  )
}

async function createRecord(
  state: State,
  input: {
    readonly workflowID: string
    readonly kind: "static" | "script"
    readonly lease: WorkflowVisualHost.PreviewLeaseAuthority
    readonly purpose: VisualHostClaim.Purpose
    readonly revision: number
    readonly configurationSha256: string
    readonly sourceSha256: string
    readonly workspace?: string
  },
): Promise<HostRecord> {
  if (input.workspace !== undefined && pathsOverlap(state.root, input.workspace)) {
    throw new TypeError("Workflow host root overlaps the admitted workspace")
  }
  await guardHostRoot(state)
  await assertLeaseLive(state, input.lease)
  for (let attempt = 0; attempt < 3; attempt++) {
    const hostID = WorkflowVisualHost.HostID.make(randomBytes(32).toString("hex"))
    const nonce = randomBytes(32).toString("hex")
    const createdAt = state.now()
    const body = VisualHostClaim.make({
      purpose: input.purpose,
      kind: input.kind,
      ...input.lease,
      hostID,
      nonce,
      createdAt,
      revision: input.revision,
      configurationSha256: input.configurationSha256,
      sourceSha256: input.sourceSha256,
    })
    const claimed = await VisualHostClaim.acquire(state.root, body)
    if (claimed.status === "contended") {
      const isLive = state.isPreviewLeaseLive
      if (isLive === undefined || (await isLive(leaseFromClaim(claimed.claim.body)))) {
        throw new TypeError("Visual Stage purpose already has a live host owner")
      }
      const active = state.active.get(claimed.claim.body.hostID)
      if (active !== undefined) {
        if (active.claim.key !== claimed.claim.key || active.claim.body.generation !== claimed.claim.body.generation) {
          throw new TypeError("Active visual host differs from its durable claim")
        }
        const staleGate = async () => !(await isLive(active.lease))
        if (!(await release(state, active, staleGate))) {
          throw new TypeError("Stale active preview shutdown was not confirmed")
        }
        continue
      }
      await recoverClaim(state, claimed.claim)
      continue
    }
    const activeClaim = await VisualHostClaim.assertActive(state.root, claimed.claim)
    const directory = path.join(state.root, hostID)
    const staging = path.join(
      state.root,
      `.host.${hostID}.${activeClaim.body.generation}.${activeClaim.body.nonce}.pending`,
    )
    const identity = identityFromClaim(body)
    let created: Awaited<ReturnType<typeof fs.lstat>> | undefined
    let published = false
    try {
      await assertLeaseLive(state, input.lease)
      await fs.mkdir(staging)
      created = await fs.lstat(staging)
      await guardHostRoot(state, staging)
      await state.onRecordStagingCreated?.(staging)
      const staged: HostRecord = {
        hostID,
        workflowID: input.workflowID,
        directory: staging,
        workspace: input.workspace,
        createdAt,
        kind: input.kind,
        lease: input.lease,
        claim: activeClaim,
        identity,
        allowedOrigins: [],
        processIdentity: input.kind === "script" ? identity : undefined,
        released: false,
      }
      await writeManifest(state, staged)
      await assertLeaseLive(state, input.lease)
      await state.onRecordStaged?.(staging, directory)
      await assertLeaseLive(state, input.lease)
      await fs.rename(staging, directory)
      published = true
      await state.onRecordPublished?.(directory)
      await guardHostRoot(state, directory)
      const manifest = await readManifest(directory)
      if (!manifestMatchesClaim(manifest, activeClaim)) {
        throw new TypeError("Published workflow capability manifest differs from its durable claim")
      }
      return { ...staged, directory }
    } catch (cause) {
      const releasing = await VisualHostClaim.beginRelease(state.root, activeClaim)
      await VisualHostClaim.finishRelease(state.root, releasing, async () => {
        if (created !== undefined) {
          const ownedDirectory = published ? directory : staging
          if (await fs.exists(ownedDirectory)) {
            await removeExactUnpublishedRecord(state, ownedDirectory, activeClaim, created)
          }
        }
      })
      throw cause
    }
  }
  throw new TypeError("Visual Stage purpose claim could not be reconciled")
}

function startStaticServer(
  record: HostRecord,
  root: string,
  entrypoint: string,
  containmentRoot: string,
  onStaticFileOpened?: (file: string) => Promise<void>,
  onStaticFileRead?: (file: string) => Promise<void>,
  archive?: WorkflowWorkspaceMaterialization.Archive,
): void {
  const frozen = archive === undefined ? undefined : WorkflowWorkspaceMaterialization.bytes(archive)
  const frozenEntrypoint = path.relative(containmentRoot, entrypoint).replaceAll("\\", "/")
  const frozenRoot = path.relative(containmentRoot, root).replaceAll("\\", "/")
  record.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const relative = capabilityPath(request.url, record.hostID)
      if (relative === undefined) return new Response("Not found", { status: 404 })
      if (frozen !== undefined) {
        const sourcePath =
          relative === "" ? frozenEntrypoint : frozenRoot === "" ? relative : `${frozenRoot}/${relative}`
        if (!validSourcePath(sourcePath)) return new Response("Not found", { status: 404 })
        const bytes = frozen.get(RelativePath.make(sourcePath))
        if (bytes === undefined) return new Response("Not found", { status: 404 })
        if (bytes.byteLength > MAX_STATIC_RESPONSE_BYTES)
          return new Response("Static response exceeds host limit", { status: 413 })
        return new Response(Uint8Array.from(bytes).buffer, {
          headers: { "content-type": Bun.file(sourcePath).type || "application/octet-stream" },
        })
      }
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
  archive?: WorkflowWorkspaceMaterialization.Archive,
): Promise<void> {
  if (plan.argv === undefined || record.processIdentity === undefined)
    throw new TypeError("Script plan has no identity")
  state.onSpawnArgv?.(plan.argv)
  const runtimeTemp = path.join(record.directory, ".tmp")
  const owned = await state.processOwnership.start({
    identity: record.processIdentity,
    plan,
    workspaceRoot,
    archive,
    tempRoot: runtimeTemp,
    signal,
    deadline,
  })
  record.process = owned
  await state.onProcessStarted?.(record.claim)
  record.logDrains = [
    drainBounded(owned.stdout, state.maxProcessLogBytes).catch(() => undefined),
    drainBounded(owned.stderr, state.maxProcessLogBytes).catch(() => undefined),
  ]
}

async function waitForOrigin(state: State, record: HostRecord, origin: string, signal: AbortSignal): Promise<void> {
  requireOwnedOrigin(origin)
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
    await assertRecordLeaseLive(state, record)
    const ready = await state.probeOwnedOrigin(origin, signal).catch(() => false)
    await assertRecordLeaseLive(state, record)
    if (ready) return
    await abortableDelay(state.pollIntervalMs, signal)
  }
  throw new Error("preview process startup timed out")
}

async function probeOwnedOrigin(origin: string, signal: AbortSignal): Promise<boolean> {
  requireOwnedOrigin(origin)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 500)
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  try {
    const response = await fetch(origin, { redirect: "manual", signal: controller.signal })
    void response.body?.cancel()
    return response.status < 500
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}

async function release(state: State, record: HostRecord, finalGate?: () => Promise<boolean>): Promise<boolean> {
  if (record.released) return false
  if (record.releaseTask !== undefined) {
    try {
      await record.releaseTask
    } catch {
      // The waiting caller revalidates and retries its own release authority below.
    }
    return record.released ? false : release(state, record, finalGate)
  }
  const task = releaseOnce(state, record, finalGate)
  record.releaseTask = task
  try {
    return await task
  } finally {
    if (record.releaseTask === task) record.releaseTask = undefined
  }
}

async function releaseOnce(state: State, record: HostRecord, finalGate?: () => Promise<boolean>): Promise<boolean> {
  if (record.released) return false
  if (finalGate !== undefined && !(await finalGate())) throw new Error("Preview lease became live before shutdown")
  const releasing =
    finalGate === undefined
      ? await VisualHostClaim.beginRelease(state.root, record.claim)
      : await VisualHostClaim.beginRelease(state.root, record.claim, finalGate)
  if (releasing === undefined) return false
  record.claim = releasing
  if (finalGate !== undefined) {
    await state.onAfterBeginRelease?.(record.claim)
    if (!(await finalGate())) return false
  }
  let destructive = false
  const finished = await VisualHostClaim.finishRelease(
    state.root,
    record.claim,
    async () => {
      await state.onBeforeServerStop?.(record.claim)
      if (finalGate !== undefined && !(await finalGate())) return false
      destructive = record.server !== undefined
      const serverStopped = await settleWithin(record.server?.stop(true), state.finalizerTimeoutMs)
      let processStopped = true
      if (record.process !== undefined && record.processIdentity !== undefined) {
        destructive = true
        processStopped = await settleWithin(
          state.processOwnership.stop({ identity: record.processIdentity, process: record.process, finalGate }),
          state.finalizerTimeoutMs,
        )
      }
      const logsDrained = await settleWithin(Promise.all(record.logDrains ?? []), state.finalizerTimeoutMs)
      if (!serverStopped || !processStopped || !logsDrained) {
        return false
      }
      await state.onBeforeCapabilityRemove?.(record.claim)
      if (finalGate !== undefined && !(await finalGate())) return false
      destructive = true
      await removeCapability(state.root, record.directory, record.workspace, state.hostRootPolicy, state.cleanupPolicy)
      if (finalGate !== undefined && !(await finalGate())) {
        throw new Error("Preview lease became live before claim cleanup")
      }
      return true
    },
    {
      beforeAuthorityDelete: async () => state.onBeforeClaimDelete?.(record.claim),
      finalGate,
    },
  )
  if (!finished && !destructive && finalGate !== undefined && !(await finalGate())) {
    return false
  }
  if (finished) {
    record.released = true
    if (state.active.get(record.hostID) === record) state.active.delete(record.hostID)
  }
  return finished
}

async function removeCapability(
  root: string,
  directory: string,
  workspace?: string,
  rootPolicy?: (canonicalHostRoot: string) => void,
  cleanupPolicy?: Options["cleanupPolicy"],
): Promise<void> {
  if (!(await fs.exists(directory))) return
  rootPolicy?.(root)
  const admitted = WorkflowVisualHost.cleanupTarget({ hostRoots: [root], target: directory, workspace })
  const target =
    cleanupPolicy === undefined
      ? admitted
      : cleanupPolicy.verifyCleanupTarget(cleanupPolicy.authorizeCleanupTarget({ target: admitted, workspace }))
  if (comparisonKey(target) !== comparisonKey(admitted)) {
    throw new TypeError("Workflow cleanup authority changed its exact target")
  }
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

function requireOwnedOrigin(origin: string | undefined): string {
  if (origin === undefined || PreviewPlan.normalizeLocalOrigin(origin) !== origin) {
    throw new TypeError("invalid owned origin")
  }
  const parsed = new URL(origin)
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.port === ""
  ) {
    throw new TypeError("invalid owned origin")
  }
  return origin
}

async function writeManifest(state: State, record: HostRecord): Promise<void> {
  await guardHostRoot(state, record.directory)
  const body = {
    hostID: record.hostID,
    createdAt: record.createdAt,
    kind: record.kind,
    purpose: record.claim.body.purpose,
    revision: record.claim.body.revision,
    configurationSha256: record.claim.body.configurationSha256,
    sourceSha256: record.claim.body.sourceSha256,
    claimKey: record.claim.key,
    claimGeneration: record.claim.body.generation,
    claimSha256: record.claim.sha256,
    workflowID: record.lease.workflowID,
    stageID: record.lease.stageID,
    attempt: record.lease.attempt,
    leaseOwner: record.lease.leaseOwner,
    leaseExpiresAt: record.lease.leaseExpiresAt,
    nonce: record.identity.nonce,
  }
  const encoded = JSON.stringify(body)
  if (Buffer.byteLength(encoded) > MAX_AUTHORITY_FILE_BYTES) throw new TypeError("host manifest is oversized")
  const file = path.join(record.directory, manifestName)
  const handle = await fs.open(file, "wx", 0o600)
  try {
    await handle.writeFile(encoded, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await guardHostRoot(state, record.directory)
  const persisted = await readManifest(record.directory, record.hostID)
  if (!manifestMatchesClaim(persisted, record.claim)) {
    throw new TypeError("Persisted workflow capability manifest differs from its durable claim")
  }
}

async function removeExactUnpublishedRecord(
  state: State,
  directory: string,
  claim: VisualHostClaim.Owned,
  created: Awaited<ReturnType<typeof fs.lstat>>,
): Promise<void> {
  const lexical = path.resolve(directory)
  const finalName = String(claim.body.hostID)
  const stagingName = `.host.${claim.body.hostID}.${claim.body.generation}.${claim.body.nonce}.pending`
  const name = path.basename(lexical)
  if (path.dirname(lexical) !== state.root || (name !== finalName && name !== stagingName)) {
    throw new TypeError("Invalid workflow record staging path")
  }
  const canonical = await fs.realpath(lexical)
  const stat = await fs.lstat(lexical)
  if (
    canonical !== lexical ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== created.dev ||
    stat.ino !== created.ino ||
    stat.birthtimeMs !== created.birthtimeMs
  ) {
    throw new TypeError("Workflow record staging identity changed")
  }
  const entries = await fs.readdir(lexical, { withFileTypes: true })
  if (entries.length > 1 || (entries.length === 1 && entries[0]?.name !== manifestName)) {
    throw new TypeError("Unexpected workflow record staging state")
  }
  const entry = entries[0]
  if (entry !== undefined) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new TypeError("Workflow record staging manifest has unknown identity")
    }
    const manifestFile = path.join(lexical, manifestName)
    const canonicalManifest = await fs.realpath(manifestFile)
    const manifestStat = await fs.lstat(manifestFile)
    if (canonicalManifest !== manifestFile || !isSingleOwnerRegularFile(manifestStat)) {
      throw new TypeError("Workflow record staging manifest has unknown identity")
    }
    if (name === finalName) {
      const manifest = await readManifest(lexical)
      if (!manifestMatchesClaim(manifest, claim)) {
        throw new TypeError("Workflow record staging manifest differs from its durable claim")
      }
    }
    await fs.unlink(manifestFile)
  }
  await fs.rmdir(lexical)
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

async function lexicalEntryExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file)
    return true
  } catch (cause) {
    if (isFileSystemError(cause, "ENOENT")) return false
    throw cause
  }
}

function isFileSystemError(cause: unknown, code: string): cause is Error & { readonly code: string } {
  return cause instanceof Error && Reflect.get(cause, "code") === code
}

async function guardHostRoot(state: State, directory?: string): Promise<void> {
  const canonicalRoot = await fs.realpath(state.root)
  const rootStat = await fs.lstat(state.root)
  if (canonicalRoot !== state.root || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
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

async function readManifest(
  directory: string,
  expectedHostID?: WorkflowVisualHost.HostID,
): Promise<{
  readonly hostID: WorkflowVisualHost.HostID
  readonly createdAt: number
  readonly kind: "static" | "script"
  readonly purpose: VisualHostClaim.Purpose
  readonly revision: number
  readonly configurationSha256: string
  readonly sourceSha256: string
  readonly claimKey: string
  readonly claimGeneration: string
  readonly claimSha256: string
  readonly identity: ProcessOwnership.Identity
}> {
  const manifest = path.resolve(directory, manifestName)
  const canonicalBefore = await fs.realpath(manifest)
  const before = await fs.lstat(manifest)
  if (
    canonicalBefore !== manifest ||
    !isSingleOwnerRegularFile(before) ||
    before.size <= 0 ||
    before.size > MAX_AUTHORITY_FILE_BYTES
  ) {
    throw new TypeError("invalid host manifest identity")
  }
  const handle = await fs.open(manifest, "r")
  let text: string
  try {
    const opened = await handle.stat()
    if (!isSingleOwnerRegularFile(opened) || !sameAuthorityFileIdentity(before, opened)) {
      throw new TypeError("host manifest identity changed before read")
    }
    const bytes = Buffer.alloc(opened.size)
    const read = await handle.read(bytes, 0, bytes.length, 0)
    const overflow = Buffer.alloc(1)
    const extra = await handle.read(overflow, 0, 1, bytes.length)
    const afterHandle = await handle.stat()
    const afterPath = await fs.lstat(manifest)
    const canonicalAfter = await fs.realpath(manifest)
    if (
      read.bytesRead !== bytes.length ||
      extra.bytesRead !== 0 ||
      canonicalAfter !== manifest ||
      !isSingleOwnerRegularFile(afterHandle) ||
      !isSingleOwnerRegularFile(afterPath) ||
      !sameAuthorityFileIdentity(opened, afterHandle) ||
      !sameAuthorityFileIdentity(opened, afterPath)
    ) {
      throw new TypeError("host manifest identity changed during read")
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } finally {
    await handle.close()
  }
  const value: unknown = JSON.parse(text)
  if (JSON.stringify(value) !== text) throw new TypeError("host manifest is not canonical JSON")
  if (
    value === null ||
    typeof value !== "object" ||
    !hasExactKeys(value, [
      "hostID",
      "createdAt",
      "kind",
      "purpose",
      "revision",
      "configurationSha256",
      "sourceSha256",
      "claimKey",
      "claimGeneration",
      "claimSha256",
      "workflowID",
      "stageID",
      "attempt",
      "leaseOwner",
      "leaseExpiresAt",
      "nonce",
    ]) ||
    typeof Reflect.get(value, "hostID") !== "string" ||
    String(expectedHostID ?? path.basename(directory)) !== Reflect.get(value, "hostID") ||
    !Number.isSafeInteger(Reflect.get(value, "createdAt")) ||
    Number(Reflect.get(value, "createdAt")) < 0 ||
    (Reflect.get(value, "kind") !== "static" && Reflect.get(value, "kind") !== "script") ||
    (Reflect.get(value, "purpose") !== "reference" && Reflect.get(value, "purpose") !== "implementation") ||
    !Number.isSafeInteger(Reflect.get(value, "revision")) ||
    Number(Reflect.get(value, "revision")) < 0 ||
    !/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "configurationSha256"))) ||
    !/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "sourceSha256"))) ||
    !/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "claimKey"))) ||
    !/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "claimGeneration"))) ||
    !/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "claimSha256"))) ||
    !/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "nonce")))
  ) {
    throw new TypeError("invalid host manifest")
  }
  const hostID = WorkflowVisualHost.HostID.make(String(Reflect.get(value, "hostID")))
  const lease = WorkflowVisualHost.validatePreviewLeaseAuthority({
    workflowID: Reflect.get(value, "workflowID"),
    stageID: Reflect.get(value, "stageID"),
    attempt: Reflect.get(value, "attempt"),
    leaseOwner: Reflect.get(value, "leaseOwner"),
    leaseExpiresAt: Reflect.get(value, "leaseExpiresAt"),
  })
  return {
    hostID,
    createdAt: Reflect.get(value, "createdAt"),
    kind: Reflect.get(value, "kind") as "static" | "script",
    purpose: Reflect.get(value, "purpose") as VisualHostClaim.Purpose,
    revision: Number(Reflect.get(value, "revision")),
    configurationSha256: String(Reflect.get(value, "configurationSha256")),
    sourceSha256: String(Reflect.get(value, "sourceSha256")),
    claimKey: String(Reflect.get(value, "claimKey")),
    claimGeneration: String(Reflect.get(value, "claimGeneration")),
    claimSha256: String(Reflect.get(value, "claimSha256")),
    identity: { ...lease, hostID, nonce: String(Reflect.get(value, "nonce")) },
  }
}

function manifestMatchesClaim(
  manifest: Awaited<ReturnType<typeof readManifest>>,
  claim: VisualHostClaim.Owned,
): boolean {
  return (
    manifest.hostID === claim.body.hostID &&
    manifest.createdAt === claim.body.createdAt &&
    manifest.kind === claim.body.kind &&
    manifest.claimKey === claim.key &&
    manifest.claimGeneration === claim.body.generation &&
    manifest.claimSha256 === claim.sha256 &&
    manifest.purpose === claim.body.purpose &&
    manifest.revision === claim.body.revision &&
    manifest.configurationSha256 === claim.body.configurationSha256 &&
    manifest.sourceSha256 === claim.body.sourceSha256 &&
    sameProcessIdentity(manifest.identity, identityFromClaim(claim.body))
  )
}

function isSingleOwnerRegularFile(value: {
  readonly nlink: number
  isFile(): boolean
  isSymbolicLink(): boolean
}): boolean {
  return value.isFile() && !value.isSymbolicLink() && value.nlink === 1
}

function sameAuthorityFileIdentity(
  left: {
    readonly dev: number
    readonly ino: number
    readonly mode: number
    readonly nlink: number
    readonly size: number
    readonly mtimeMs: number
    readonly ctimeMs: number
    readonly birthtimeMs: number
  },
  right: {
    readonly dev: number
    readonly ino: number
    readonly mode: number
    readonly nlink: number
    readonly size: number
    readonly mtimeMs: number
    readonly ctimeMs: number
    readonly birthtimeMs: number
  },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs
  )
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
