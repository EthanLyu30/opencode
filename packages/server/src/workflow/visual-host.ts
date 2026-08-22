export * as WorkflowVisualHostServer from "./visual-host"

import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { WorkflowDesignArtifact } from "@opencode-ai/core/workflow/artifacts/design"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowSecretGuard } from "@opencode-ai/core/workflow/secret-guard"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { Effect, Layer, Scope } from "effect"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { EvidenceLedger } from "./evidence-ledger"
import { PlaywrightCapture } from "./playwright"
import { ProcessOwnership } from "./process-ownership"

const MAX_PROCESS_LOG_BYTES = 1024 * 1024
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 50
const DEFAULT_FINALIZER_TIMEOUT_MS = 5_000
const manifestName = ".host.json"

interface HostRecord {
  readonly hostID: WorkflowVisualHost.HostID
  readonly workflowID: string
  readonly directory: string
  readonly workspace?: string
  readonly createdAt: number
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
  readonly browser: PlaywrightCapture.Runtime
  readonly evidenceLedger?: EvidenceLedger.Service
  readonly processOwnership?: ProcessOwnership.Service
  readonly now?: () => number
  readonly startupTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly finalizerTimeoutMs?: number
  readonly maxProcessLogBytes?: number
  readonly onSpawnArgv?: (argv: readonly string[]) => void
  readonly onRecordCreated?: (directory: string, signal: AbortSignal) => Promise<void>
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
        recoverExpired: (input) => recoverExpired(state, input),
      })
    }),
  )
}

export const layer = Layer.unwrap(
  Effect.sync(() => {
    const hostRoot = process.env.OPENCODE_WORKFLOW_HOST_TEMP
    if (hostRoot === undefined) throw new TypeError("OPENCODE_WORKFLOW_HOST_TEMP is required")
    return makeLayer({
      hostRoot,
      browser: PlaywrightCapture.productionRuntime({ tempRoot: path.join(hostRoot, "browser") }),
    })
  }),
)

export const node = makeGlobalNode({ service: WorkflowVisualHost.Service, layer, deps: [] })

interface State {
  readonly root: string
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
}

async function makeState(options: Options): Promise<State> {
  if (!path.isAbsolute(options.hostRoot)) throw new TypeError("Workflow host root must be absolute")
  await fs.mkdir(options.hostRoot, { recursive: true })
  const root = await fs.realpath(options.hostRoot)
  if (!(await fs.stat(root)).isDirectory()) throw new TypeError("Workflow host root must be a directory")
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
    browser: options.browser,
    processOwnership: options.processOwnership ?? ProcessOwnership.unavailable,
    active: new Map(),
    evidence: options.evidenceLedger ?? EvidenceLedger.open(path.join(root, ".evidence")),
    captureTails: new Map(),
    now: options.now ?? (() => Date.now()),
    startupTimeoutMs,
    pollIntervalMs,
    finalizerTimeoutMs,
    maxProcessLogBytes,
    onSpawnArgv: options.onSpawnArgv,
    onRecordCreated: options.onRecordCreated,
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
          await Promise.all(
            reference.files.map(async (file) => {
              const target = materializedPath(record.directory, file.path)
              await fs.mkdir(path.dirname(target), { recursive: true })
              await fs.writeFile(target, file.content, { encoding: "utf8", flag: "wx" })
            }),
          )
          await writeManifest(record)
          startStaticServer(record, record.directory, reference.entrypoint, record.directory)
        },
        catch: () => failure("materialize_reference", "visual_host_unavailable", "Reference host could not start"),
      })
      record.preview = WorkflowVisualHost.preparedPreview({
        hostID: record.hostID,
        url: capabilityURL(record),
        revision: 0,
        configSha256: reference.configSha256,
        scope,
      })
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
          if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !PreviewPlan.isFrozen(input.plan)) {
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
      const record = yield* Effect.tryPromise({
        try: () => createRecord(state, String(input.workflowID), input.plan.locationRoot),
        catch: () =>
          failure("prepare_implementation", "visual_host_unavailable", "Implementation host could not start"),
      })
      state.active.set(record.hostID, record)
      yield* Effect.addFinalizer(() => Effect.promise(() => release(state, record)).pipe(Effect.ignore))
      if (input.plan.kind === "script") {
        record.processIdentity = { hostID: record.hostID, nonce: randomBytes(32).toString("hex") }
      }
      yield* Effect.tryPromise({
        try: async () => {
          await writeManifest(record)
          await fs.mkdir(path.join(record.directory, ".tmp"))
        },
        catch: () =>
          failure("prepare_implementation", "visual_host_unavailable", "Implementation host could not start"),
      })
      if (input.plan.kind === "static") {
        record.allowedOrigins = input.plan.allowedOrigins
        yield* Effect.try({
          try: () =>
            startStaticServer(
              record,
              path.dirname(input.plan.entrypoint ?? ""),
              input.plan.entrypoint ?? "",
              input.plan.locationRoot,
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
        yield* Effect.tryPromise({
          try: () => spawnPreviewProcess(state, record, input.plan),
          catch: () => failure("prepare_implementation", "visual_host_unavailable", "Preview process could not start"),
        })
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
        revision: input.revision,
        configSha256: input.plan.configSha256,
        scope,
      })
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
      return withCaptureLock(state, record.workflowID, signal, async () => {
        if (record.released || state.active.get(record.hostID) !== record) {
          throw failure("capture", "invalid_preview_handle", "Capture requires an active preview handle")
        }
        const viewport = validateViewport(input.viewport)
        if (typeof input.readySelector !== "string" || input.readySelector.length === 0) {
          throw failure("capture", "capture_failed", "Capture requires a ready selector")
        }
        const used = await state.evidence.used(record.workflowID)
        if (used >= WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES) {
          throw failure("capture", "workflow_evidence_limit_exceeded", "Workflow evidence exceeds 128 MiB")
        }
        const bytes = await state.browser.capture({
          url: record.captureURL ?? input.preview.url,
          viewport,
          readySelector: input.readySelector,
          allowedOrigins: record.allowedOrigins,
          signal,
        })
        if (bytes.byteLength > WorkflowVisualHost.MAX_IMAGE_BYTES) {
          throw failure("capture", "image_evidence_limit_exceeded", "Screenshot exceeds 8 MiB")
        }
        validatePng(bytes, viewport)
        if (
          !(await state.evidence.reserve(
            record.workflowID,
            bytes.byteLength,
            WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
          ))
        ) {
          throw failure("capture", "workflow_evidence_limit_exceeded", "Workflow evidence exceeds 128 MiB")
        }
        return Object.freeze({
          bytes,
          viewport: Object.freeze({ ...input.viewport }),
          width: viewport.width,
          height: viewport.height,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          evidenceBytes: bytes.byteLength,
        })
      })
    },
    catch: (cause) =>
      cause instanceof WorkflowVisualHost.Failure
        ? cause
        : failure("capture", "capture_failed", "Browser capture failed"),
  })
}

async function withCaptureLock<A>(
  state: State,
  workflowID: string,
  signal: AbortSignal,
  run: () => Promise<A>,
): Promise<A> {
  const previous = state.captureTails.get(workflowID) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  state.captureTails.set(workflowID, tail)
  try {
    await waitForSignal(previous, signal)
    return await run()
  } finally {
    release()
    if (state.captureTails.get(workflowID) === tail) state.captureTails.delete(workflowID)
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
            await removeCapability(state.root, directory)
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
  await fs.mkdir(directory)
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

function startStaticServer(record: HostRecord, root: string, entrypoint: string, containmentRoot: string): void {
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
      const canonical = await canonicalFile(target, containmentRoot)
      if (canonical === undefined) return new Response("Not found", { status: 404 })
      return new Response(Bun.file(canonical))
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

async function spawnPreviewProcess(state: State, record: HostRecord, plan: PreviewPlan.PreviewPlan): Promise<void> {
  if (plan.argv === undefined || record.processIdentity === undefined)
    throw new TypeError("Script plan has no identity")
  state.onSpawnArgv?.(plan.argv)
  const runtimeTemp = path.join(record.directory, ".tmp")
  const owned = await state.processOwnership.start({
    identity: record.processIdentity,
    plan,
    tempRoot: runtimeTemp,
  })
  record.process = owned
  record.logDrains = [
    drainBounded(owned.stdout, state.maxProcessLogBytes),
    drainBounded(owned.stderr, state.maxProcessLogBytes),
  ]
}

async function waitForOrigin(state: State, record: HostRecord, origin: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + state.startupTimeoutMs
  let exited = false
  void record.process?.exited.then(() => {
    exited = true
  })
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
  await removeCapability(state.root, record.directory, record.workspace)
  return true
}

async function removeCapability(root: string, directory: string, workspace?: string): Promise<void> {
  if (!(await fs.exists(directory))) return
  const target = WorkflowVisualHost.cleanupTarget({ hostRoots: [root], target: directory, workspace })
  await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
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

function validatePng(bytes: Uint8Array, viewport: { readonly width: number; readonly height: number }): void {
  WorkflowVisualReviewArtifact.assertPng(bytes)
  const dimensions = new DataView(bytes.buffer, bytes.byteOffset + 16, 8)
  if (dimensions.getUint32(0) !== viewport.width || dimensions.getUint32(4) !== viewport.height) {
    throw new TypeError("PNG dimensions differ from viewport")
  }
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

async function canonicalFile(target: string, root: string): Promise<string | undefined> {
  try {
    const lexical = path.resolve(target)
    const canonical = await fs.realpath(lexical)
    if (comparisonKey(lexical) !== comparisonKey(canonical) || !strictlyContains(root, canonical)) return undefined
    return (await fs.stat(canonical)).isFile() ? canonical : undefined
  } catch {
    return undefined
  }
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

async function writeManifest(record: HostRecord): Promise<void> {
  await fs.writeFile(
    path.join(record.directory, manifestName),
    JSON.stringify({
      hostID: record.hostID,
      createdAt: record.createdAt,
      ...(record.processIdentity === undefined ? {} : { processNonce: record.processIdentity.nonce }),
    }),
    { encoding: "utf8", flag: "wx" },
  )
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
