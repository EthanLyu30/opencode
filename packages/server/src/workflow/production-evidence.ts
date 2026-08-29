export * as WorkflowProductionEvidenceServer from "./production-evidence"

import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { WorkflowBusinessArtifact } from "@opencode-ai/core/workflow/artifacts/business"
import { WorkflowDecompositionArtifact } from "@opencode-ai/core/workflow/artifacts/decomposition"
import { WorkflowDesignArtifact } from "@opencode-ai/core/workflow/artifacts/design"
import { WorkflowImplementationArtifact } from "@opencode-ai/core/workflow/artifacts/implementation"
import { WorkflowTestArtifact } from "@opencode-ai/core/workflow/artifacts/test"
import { WorkflowTestLogArtifact } from "@opencode-ai/core/workflow/artifacts/test-log"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowProductionEvidence } from "@opencode-ai/core/workflow/execution/production-evidence"
import { WorkflowRoleExecution } from "@opencode-ai/core/workflow/execution/role"
import * as WorkflowRoleBinding from "@opencode-ai/core/workflow/execution/role-binding"
import { WorkflowProductionHostPlan } from "@opencode-ai/core/workflow/production-host-plan"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkflowVisualHostServer } from "./visual-host"
import { HostRootPolicy } from "./host-root-policy"

export interface ResolverDependencies {
  readonly getWorkflow: (workflowID: WorkflowRoleExecution.ResolverInput["workflow"]["id"]) => Effect.Effect<
    | {
        readonly run: WorkflowRoleExecution.ResolverInput["workflow"]
        readonly stages: readonly WorkflowRoleExecution.ResolverInput["stage"][]
        readonly artifacts: readonly WorkflowRoleExecution.PrepareInput["priorArtifacts"][number][]
      }
    | undefined,
    unknown
  >
  readonly captureSnapshot: (
    location: WorkflowRoleExecution.ResolverInput["location"],
  ) => Effect.Effect<Snapshot.ID | undefined, unknown>
  readonly snapshotEntries: (
    location: WorkflowRoleExecution.ResolverInput["location"],
    snapshot: Snapshot.ID,
  ) => Effect.Effect<readonly Snapshot.Entry[], unknown>
  readonly materializationRoot: () => string
  /** Repeated existing HostRootPolicy admission plus exact reparse/identity fence. */
  readonly verifyMaterializationRoot: (canonicalRoot: string) => Promise<void>
  readonly materializeSnapshot: (
    location: WorkflowRoleExecution.ResolverInput["location"],
    snapshot: Snapshot.ID,
    target: AbsolutePath,
  ) => Effect.Effect<void, unknown>
}

export function makeImplementationResolver(
  dependencies: ResolverDependencies,
): WorkflowVisualHost.ResolveImplementationContract {
  return (input) => Effect.runPromise(resolveImplementationContract(dependencies, input))
}

export function resolveImplementationContract(
  dependencies: ResolverDependencies,
  input: WorkflowVisualHost.PrepareImplementationInput,
) {
  return Effect.gen(function* () {
    const detail = yield* dependencies.getWorkflow(input.workflowID)
    if (detail === undefined || detail.run.type !== "visual-build" || detail.run.location === undefined)
      return yield* invalid("Persisted visual Workflow authority is unavailable")
    const stage = detail.stages.find((candidate) => candidate.id === detail.run.currentStageID)
    if (
      stage === undefined ||
      stage.workflowID !== detail.run.id ||
      stage.type !== "visual_review" ||
      (stage.status !== "leased" && stage.status !== "running") ||
      revisionOf(stage) !== input.revision
    )
      return yield* invalid("Persisted visual-review Stage authority is unavailable")
    const plan = yield* Effect.try({
      try: () => WorkflowProductionHostPlan.fromWorkflow(detail.run),
      catch: () => new TypeError("Persisted production host plan is invalid"),
    })
    if (WorkflowBusinessArtifact.encode(plan.preview) !== WorkflowBusinessArtifact.encode(input.plan))
      return yield* invalid("Prepared preview differs from admission authority")
    yield* Effect.try({
      try: () => WorkflowProductionHostPlan.verifyCurrentConfiguration(plan),
      catch: () => new TypeError("Admission-frozen host configuration changed"),
    })
    const prior = yield* Effect.try({
      try: () => WorkflowRoleBinding.decodePriorArtifacts(detail.run, detail.run.location!, detail.artifacts),
      catch: () => new TypeError("Durable visual artifact authority is invalid"),
    })
    const specArtifact = unique(prior, WorkflowDesignArtifact.SPEC_KIND)
    const referenceArtifact = unique(prior, WorkflowDesignArtifact.REFERENCE_APP_KIND)
    const decompositionArtifact = unique(prior, WorkflowDecompositionArtifact.KIND)
    const manifestArtifact = uniqueRevision(prior, WorkflowImplementationArtifact.KIND, input.revision)
    if (!specArtifact || !referenceArtifact || !decompositionArtifact || !manifestArtifact)
      return yield* invalid("Durable design, baseline, or implementation authority is missing")
    const spec = WorkflowDesignArtifact.decodeSpec(specArtifact.commit, detail.run.id)
    const reference = WorkflowDesignArtifact.decodeReferenceApp(referenceArtifact.commit, detail.run.id)
    const decomposition = WorkflowDecompositionArtifact.decode(
      decompositionArtifact.commit,
      detail.run.id,
      detail.run.location,
    )
    const manifest = WorkflowImplementationArtifact.decodeExact(
      manifestArtifact.commit,
      detail.run.id,
      detail.run.location,
    )
    if (
      reference.entrypoint !== spec.referenceApp.entrypoint ||
      reference.readySelector !== spec.referenceApp.readySelector ||
      manifest.snapshotRef !== decomposition.snapshotRef
    )
      return yield* invalid("Durable design or baseline lineage differs from the implementation")
    yield* dependencies.snapshotEntries(detail.run.location, Snapshot.ID.make(decomposition.snapshotRef))
    const current = yield* dependencies.captureSnapshot(detail.run.location)
    if (current === undefined) return yield* invalid("Current workspace Snapshot is unavailable")
    const entries = yield* dependencies.snapshotEntries(detail.run.location, current)
    if (Snapshot.workspaceSha256(entries) !== manifest.workspaceSha256)
      return yield* invalid("Current workspace differs from the implementation manifest")
    const manifestSha256 = WorkflowImplementationArtifact.hash(manifest)
    const materialization = yield* materializeExactWorkspace(dependencies, {
      workflowID: detail.run.id,
      stageID: stage.id,
      revision: input.revision,
      location: detail.run.location,
      snapshotRef: current,
      manifestSha256,
      workspaceSha256: manifest.workspaceSha256,
      entries,
    })
    return Object.freeze({
      implementationSha256: manifestSha256,
      readySelector: spec.referenceApp.readySelector,
      materialization,
    })
  })
}

export function productionRoleLayer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Layer.Layer<
  WorkflowRoleExecution.Service,
  never,
  LocationServiceMap.Service | WorkflowVisualHost.Service | WorkflowStore.Service
> {
  return Layer.effect(
    WorkflowRoleExecution.Service,
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      const visualHost = yield* WorkflowVisualHost.Service
      const workflows = yield* WorkflowStore.Service
      const captureSnapshot: WorkflowProductionEvidence.Dependencies["captureSnapshot"] = (location) =>
        Effect.flatMap(Snapshot.Service, (snapshot) => snapshot.capture()).pipe(Effect.provide(locations.get(location)))
      const snapshotEntries: WorkflowProductionEvidence.Dependencies["snapshotEntries"] = (location, snapshot) =>
        Effect.flatMap(Snapshot.Service, (service) => service.entries({ snapshot })).pipe(
          Effect.provide(locations.get(location)),
        )
      const resolverDependencies: ResolverDependencies = {
        getWorkflow: workflows.get,
        captureSnapshot,
        snapshotEntries,
        materializationRoot: () =>
          path.join(requiredEnvironment(environment, "OPENCODE_WORKFLOW_HOST_TEMP"), "materializations"),
        verifyMaterializationRoot: productionMaterializationRootVerifier(environment),
        materializeSnapshot: (location, snapshot, target) =>
          Effect.flatMap(Snapshot.Service, (service) => service.materialize({ snapshot, directory: target })).pipe(
            Effect.provide(locations.get(location)),
          ),
      }
      return WorkflowRoleExecution.Service.of(
        WorkflowProductionEvidence.make({
          captureSnapshot,
          snapshotEntries,
          materializeWorkspace: (request) => materializeFunctionalWorkspace(resolverDependencies, request),
          runFunctionalTest: (request) => {
            return Effect.flatMap(WorkflowCommandSandbox.Service, (command) => {
              if (command.runFrozenTest === undefined)
                return Effect.fail(
                  new WorkflowCommandSandbox.Unavailable({ message: "Frozen test runner is unavailable" }),
                )
              return command.runFrozenTest({
                workflowID: request.workflowID,
                stageID: request.stageID,
                revision: request.revision,
                argv: request.argv,
                cwd: request.cwd,
                policySha256: request.policySha256,
                configSha256: request.configSha256,
                materialization: request.materialization,
              })
            })
              .pipe(Effect.provide(locations.get(request.location)))
              .pipe(Effect.map((result) => ({ exitCode: result.exit, log: result.output })))
          },
          visualHost,
        }),
      )
    }),
  )
}

export function productionVisualHostLayer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Layer.Layer<WorkflowVisualHost.Service, never, WorkflowStore.Service | LocationServiceMap.Service> {
  return Layer.unwrap(
    Effect.gen(function* () {
      const workflows = yield* WorkflowStore.Service
      const locations = yield* LocationServiceMap.Service
      const verifyMaterializationRoot = productionMaterializationRootVerifier(environment)
      const dependencies: ResolverDependencies = {
        getWorkflow: workflows.get,
        captureSnapshot: (location) =>
          Effect.flatMap(Snapshot.Service, (snapshot) => snapshot.capture()).pipe(
            Effect.provide(locations.get(location)),
          ),
        snapshotEntries: (location, snapshot) =>
          Effect.flatMap(Snapshot.Service, (service) => service.entries({ snapshot })).pipe(
            Effect.provide(locations.get(location)),
          ),
        materializationRoot: () =>
          path.join(requiredEnvironment(environment, "OPENCODE_WORKFLOW_HOST_TEMP"), "materializations"),
        verifyMaterializationRoot,
        materializeSnapshot: (location, snapshot, target) =>
          Effect.flatMap(Snapshot.Service, (service) => service.materialize({ snapshot, directory: target })).pipe(
            Effect.provide(locations.get(location)),
          ),
      }
      const materializations = makeMaterializationLeaseManager({
        root: dependencies.materializationRoot,
        verifyRoot: verifyMaterializationRoot,
        getWorkflow: workflows.get,
      })
      if (
        [
          "OPENCODE_WORKFLOW_HOST_ROOT",
          "OPENCODE_WORKFLOW_HOST_TEMP",
          "OPENCODE_WORKFLOW_EVIDENCE_ROOT",
          "PLAYWRIGHT_BROWSERS_PATH",
        ].every((key) => {
          const value = environment[key]
          return typeof value === "string" && value.trim() !== ""
        })
      )
        yield* Effect.promise(() => materializations.gcTick()).pipe(Effect.orDie)
      return WorkflowVisualHostServer.productionLayer({
        environment,
        resolveImplementationContract: makeImplementationResolver(dependencies),
        onEvidenceReleased: async ({ receipt }) => {
          if (receipt.coordinates.kind !== "implementation") return
          if (!(await materializations.release(receipt.coordinates)))
            throw new TypeError("Released implementation evidence has no exact materialization lease")
        },
        onEvidenceReconciled: async () => {
          await materializations.gcTick()
        },
      })
    }),
  )
}

export const visualHostNode = makeGlobalNode({
  service: WorkflowVisualHost.Service,
  layer: productionVisualHostLayer(),
  deps: [WorkflowStore.node, LocationServiceMap.node],
})

export const roleEvidenceNode = makeGlobalNode({
  service: WorkflowRoleExecution.Service,
  layer: productionRoleLayer(),
  deps: [LocationServiceMap.node, WorkflowVisualHost.node, WorkflowStore.node],
})

export function compositionNodes() {
  return Object.freeze({ visualHost: visualHostNode, roleEvidence: roleEvidenceNode })
}

function unique(artifacts: readonly WorkflowRoleExecution.DecodedPriorArtifact[], kind: string) {
  const matches = artifacts.filter((artifact) => artifact.kind === kind)
  return matches.length === 1 ? matches[0] : undefined
}

function uniqueRevision(
  artifacts: readonly WorkflowRoleExecution.DecodedPriorArtifact[],
  kind: string,
  revision: number,
) {
  const matches = artifacts.filter(
    (artifact) =>
      artifact.kind === kind &&
      artifact.value !== null &&
      typeof artifact.value === "object" &&
      Reflect.get(artifact.value, "revision") === revision,
  )
  return matches.length === 1 ? matches[0] : undefined
}

function revisionOf(stage: WorkflowRoleExecution.ResolverInput["stage"]): number {
  const revision = stage.input.revision ?? 0
  if (!Number.isSafeInteger(revision) || typeof revision !== "number" || revision < 0) throw new TypeError("revision")
  return revision
}

function invalid(message: string): Effect.Effect<never, TypeError> {
  return Effect.fail(new TypeError(message))
}

function requiredEnvironment(environment: Readonly<Record<string, string | undefined>>, key: string) {
  const value = environment[key]
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`Missing required ${key}`)
  return value
}

function materializeFunctionalWorkspace(
  dependencies: ResolverDependencies,
  input: Parameters<WorkflowProductionEvidence.Dependencies["materializeWorkspace"]>[0],
) {
  return Effect.gen(function* () {
    const detail = yield* dependencies.getWorkflow(input.workflowID)
    if (
      detail === undefined ||
      detail.run.type !== "visual-build" ||
      detail.run.location === undefined ||
      detail.run.location.directory !== input.location.directory ||
      detail.run.location.workspaceID !== input.location.workspaceID
    )
      return yield* invalid("Persisted functional-test Workflow authority is unavailable")
    const stage = detail.stages.find((candidate) => candidate.id === input.stageID)
    if (
      stage === undefined ||
      stage.id !== detail.run.currentStageID ||
      stage.type !== "test" ||
      (stage.status !== "leased" && stage.status !== "running") ||
      revisionOf(stage) !== input.revision
    )
      return yield* invalid("Persisted functional-test Stage authority is unavailable")
    const prior = yield* Effect.try({
      try: () => WorkflowRoleBinding.decodePriorArtifacts(detail.run, detail.run.location!, detail.artifacts),
      catch: () => new TypeError("Durable functional-test artifact authority is invalid"),
    })
    const decompositionArtifact = unique(prior, WorkflowDecompositionArtifact.KIND)
    const manifestArtifact = uniqueRevision(prior, WorkflowImplementationArtifact.KIND, input.revision)
    if (!decompositionArtifact || !manifestArtifact)
      return yield* invalid("Durable baseline or implementation authority is missing")
    const decomposition = WorkflowDecompositionArtifact.decode(
      decompositionArtifact.commit,
      detail.run.id,
      detail.run.location,
    )
    const manifest = WorkflowImplementationArtifact.decodeExact(
      manifestArtifact.commit,
      detail.run.id,
      detail.run.location,
    )
    const manifestSha256 = WorkflowImplementationArtifact.hash(manifest)
    if (
      manifest.snapshotRef !== decomposition.snapshotRef ||
      manifestSha256 !== input.manifestSha256 ||
      manifest.workspaceSha256 !== input.workspaceSha256
    )
      return yield* invalid("Functional-test materialization lineage differs from the implementation")
    yield* dependencies.snapshotEntries(detail.run.location, Snapshot.ID.make(decomposition.snapshotRef))
    const current = yield* dependencies.captureSnapshot(detail.run.location)
    if (current === undefined) return yield* invalid("Current functional-test Snapshot is unavailable")
    const entries = yield* dependencies.snapshotEntries(detail.run.location, current)
    if (Snapshot.workspaceSha256(entries) !== manifest.workspaceSha256)
      return yield* invalid("Current functional-test workspace differs from the implementation manifest")
    return yield* materializeExactWorkspace(dependencies, {
      ...input,
      snapshotRef: current,
      entries,
    })
  })
}

function materializeExactWorkspace(
  dependencies: ResolverDependencies,
  input: {
    readonly workflowID: WorkflowRoleExecution.ResolverInput["workflow"]["id"]
    readonly stageID: WorkflowRoleExecution.ResolverInput["stage"]["id"]
    readonly revision: number
    readonly location: WorkflowRoleExecution.ResolverInput["location"]
    readonly snapshotRef: Snapshot.ID
    readonly manifestSha256: string
    readonly workspaceSha256: string
    readonly entries: readonly Snapshot.Entry[]
  },
) {
  return Effect.tryPromise({
    try: async () => {
      const configuredRoot = path.resolve(dependencies.materializationRoot())
      if (!/^D:[\\/]/i.test(configuredRoot) || configuredRoot === path.parse(configuredRoot).root)
        throw new TypeError("Workspace materialization root must be a bounded D-drive directory")
      await dependencies.verifyMaterializationRoot(configuredRoot)
      await fs.mkdir(configuredRoot, { recursive: true })
      await dependencies.verifyMaterializationRoot(configuredRoot)
      const rootIdentity = await directoryIdentity(configuredRoot)
      const fenceRoot = async () => {
        await dependencies.verifyMaterializationRoot(configuredRoot)
        if ((await directoryIdentity(configuredRoot)) !== rootIdentity)
          throw new TypeError("Workspace materialization root identity changed")
      }
      const identity = WorkflowWorkspaceMaterialization.materializationID(input)
      const ownerRoot = path.join(configuredRoot, identity)
      const treeRoot = path.join(ownerRoot, "tree")
      const ownerFile = path.join(ownerRoot, "owner.json")
      const owner = {
        schemaVersion: 1,
        materializationID: identity,
        workflowID: input.workflowID,
        revision: input.revision,
        location: input.location,
        snapshotRef: input.snapshotRef,
        manifestSha256: input.manifestSha256,
        workspaceSha256: input.workspaceSha256,
      } as const
      const verify = async () => {
        await fenceRoot()
        await safeDirectory(ownerRoot, configuredRoot)
        await safeDirectory(treeRoot, ownerRoot)
        await safeFile(ownerFile, ownerRoot)
        const durable = JSON.parse(await fs.readFile(ownerFile, "utf8")) as unknown
        await safeFile(ownerFile, ownerRoot)
        if (WorkflowBusinessArtifact.encode(durable) !== WorkflowBusinessArtifact.encode(owner))
          throw new TypeError("Materialized workspace owner identity drifted")
        const exact = await materializedEntries(treeRoot)
        if (
          Snapshot.workspaceSha256(exact) !== input.workspaceSha256 ||
          WorkflowBusinessArtifact.encode(exact) !== WorkflowBusinessArtifact.encode(input.entries)
        )
          throw new TypeError("Materialized workspace bytes differ from the exact Snapshot tree")
      }
      try {
        await verify()
      } catch {
        await fenceRoot()
        const temporary = path.join(configuredRoot, `.tmp-${identity}-${randomUUID()}`)
        assertDescendant(configuredRoot, temporary)
        try {
          await fs.mkdir(temporary)
          await safeDirectory(temporary, configuredRoot)
          const temporaryTree = AbsolutePath.make(path.join(temporary, "tree"))
          await Effect.runPromise(dependencies.materializeSnapshot(input.location, input.snapshotRef, temporaryTree))
          await fenceRoot()
          await safeDirectory(temporary, configuredRoot)
          await safeDirectory(temporaryTree, temporary)
          const exact = await materializedEntries(temporaryTree)
          if (
            Snapshot.workspaceSha256(exact) !== input.workspaceSha256 ||
            WorkflowBusinessArtifact.encode(exact) !== WorkflowBusinessArtifact.encode(input.entries)
          )
            throw new TypeError("Snapshot materialization did not reproduce the exact tree")
          await fs.writeFile(path.join(temporary, "owner.json"), JSON.stringify(owner), {
            encoding: "utf8",
            flag: "wx",
          })
          try {
            await fenceRoot()
            await fs.rename(temporary, ownerRoot)
          } catch (cause) {
            if (!fileSystemCode(cause, "EEXIST")) throw cause
          }
        } finally {
          await removeLeafFirst(temporary, configuredRoot)
        }
        await verify()
      }
      const archive = await WorkflowWorkspaceMaterialization.seal(input.entries, async (relative) => {
        const target = path.resolve(treeRoot, ...relative.split("/"))
        assertDescendant(treeRoot, target)
        await safeFile(target, treeRoot)
        const bytes = await fs.readFile(target)
        await safeFile(target, treeRoot)
        return bytes
      })
      const lease = WorkflowWorkspaceMaterialization.make({
        ...input,
        root: AbsolutePath.make(treeRoot),
        archive,
      })
      const leaseDirectory = path.join(ownerRoot, "leases")
      await fs.mkdir(leaseDirectory, { recursive: true })
      await safeDirectory(leaseDirectory, ownerRoot)
      const leaseFile = path.join(leaseDirectory, `${lease.leaseID}.json`)
      const leaseRecord = {
        schemaVersion: 1,
        state: "active",
        lease,
        acquiredAt: Date.now(),
      } as const
      try {
        await fs.writeFile(leaseFile, JSON.stringify(leaseRecord), { encoding: "utf8", flag: "wx" })
        await safeFile(leaseFile, leaseDirectory)
      } catch (cause) {
        if (!fileSystemCode(cause, "EEXIST")) throw cause
        await safeFile(leaseFile, leaseDirectory)
        const durable = decodeLeaseRecord(JSON.parse(await fs.readFile(leaseFile, "utf8")))
        await safeFile(leaseFile, leaseDirectory)
        if (
          durable.state !== "active" ||
          WorkflowBusinessArtifact.encode(durable.lease) !== WorkflowBusinessArtifact.encode(lease)
        )
          throw new TypeError("Materialization lease identity drifted", { cause })
      }
      await verify()
      await fenceRoot()
      return lease
    },
    catch: () => new TypeError("Exact workspace materialization is unavailable or drifted"),
  })
}

function productionMaterializationRootVerifier(
  environment: Readonly<Record<string, string | undefined>>,
): (canonicalRoot: string) => Promise<void> {
  let admitted: { readonly policy: HostRootPolicy.Policy; readonly expected: string } | undefined
  return async (root) => {
    if (admitted === undefined) {
      const hostRoot = requiredEnvironment(environment, "OPENCODE_WORKFLOW_HOST_ROOT")
      const tempRoot = requiredEnvironment(environment, "OPENCODE_WORKFLOW_HOST_TEMP")
      const policy = HostRootPolicy.make({
        hostRoot,
        evidenceRoot: requiredEnvironment(environment, "OPENCODE_WORKFLOW_EVIDENCE_ROOT"),
        browserRoot: requiredEnvironment(environment, "PLAYWRIGHT_BROWSERS_PATH"),
        tempRoot,
        probe: HostRootPolicy.productionProbe({ tempRoot }),
      })
      admitted = { policy, expected: path.resolve(policy.roots.tempRoot, "materializations") }
    }
    const { policy, expected } = admitted
    policy.verifyTempRoot(policy.roots.tempRoot)
    if (path.resolve(root) !== expected) throw new TypeError("Workspace materialization root differs from host policy")
    try {
      await safeDirectory(expected, policy.roots.tempRoot)
    } catch (cause) {
      if (!fileSystemCode(cause, "ENOENT")) throw cause
    }
  }
}

interface LeaseRecord {
  readonly schemaVersion: 1
  readonly state: "active" | "released"
  readonly lease: WorkflowWorkspaceMaterialization.Lease
  readonly acquiredAt: number
  readonly releasedAt?: number
}

function decodeLeaseRecord(input: unknown): LeaseRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid lease state")
  const keys = Object.keys(input).sort()
  const state = Reflect.get(input, "state")
  const acquiredAt = safeInteger(Reflect.get(input, "acquiredAt"))
  const releasedAt = state === "released" ? safeInteger(Reflect.get(input, "releasedAt")) : undefined
  const expected =
    state === "released"
      ? ["acquiredAt", "lease", "releasedAt", "schemaVersion", "state"]
      : ["acquiredAt", "lease", "schemaVersion", "state"]
  if (
    WorkflowBusinessArtifact.encode(keys) !== WorkflowBusinessArtifact.encode(expected) ||
    Reflect.get(input, "schemaVersion") !== 1 ||
    (state !== "active" && state !== "released") ||
    acquiredAt < 0 ||
    (state === "released" && releasedAt === undefined)
  )
    throw new TypeError("Invalid lease state")
  return Object.freeze({
    schemaVersion: 1,
    state,
    lease: WorkflowWorkspaceMaterialization.validate(Reflect.get(input, "lease")),
    acquiredAt,
    ...(state === "released" ? { releasedAt } : {}),
  })
}

function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TypeError("Invalid lease timestamp")
  return value
}

export interface MaterializationLeaseManager {
  readonly release: (coordinates: {
    readonly workflowID: WorkflowVisualHost.EvidenceCoordinates["workflowID"]
    readonly stageID: WorkflowVisualHost.EvidenceCoordinates["stageID"]
    readonly revision: number
  }) => Promise<boolean>
  readonly gcTick: () => Promise<number>
}

export function makeMaterializationLeaseManager(input: {
  readonly root: () => string
  readonly verifyRoot: (canonicalRoot: string) => Promise<void>
  readonly getWorkflow: ResolverDependencies["getWorkflow"]
  readonly batchSize?: number
  readonly now?: () => number
}): MaterializationLeaseManager {
  const batchSize = Math.min(128, Math.max(1, input.batchSize ?? 32))
  const now = input.now ?? Date.now
  let cursor: string | undefined

  const owners = async () => {
    const root = path.resolve(input.root())
    await input.verifyRoot(root)
    await fs.mkdir(root, { recursive: true })
    await input.verifyRoot(root)
    const records = await fs.readdir(root, { withFileTypes: true })
    const names = records
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "en"))
    return { root, names }
  }

  const readOwnerLeases = async (root: string, name: string) => {
    const ownerRoot = path.join(root, name)
    await safeDirectory(ownerRoot, root)
    const ownerRecords = (await fs.readdir(ownerRoot, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    )
    if (
      ownerRecords.length !== 3 ||
      ownerRecords[0]?.name !== "leases" ||
      !ownerRecords[0].isDirectory() ||
      ownerRecords[1]?.name !== "owner.json" ||
      !ownerRecords[1].isFile() ||
      ownerRecords[2]?.name !== "tree" ||
      !ownerRecords[2].isDirectory()
    )
      throw new TypeError("Materialization owner topology is foreign")
    const ownerFile = path.join(ownerRoot, "owner.json")
    await safeFile(ownerFile, ownerRoot)
    const owner: unknown = JSON.parse(await fs.readFile(ownerFile, "utf8"))
    await safeFile(ownerFile, ownerRoot)
    const leaseRoot = path.join(ownerRoot, "leases")
    await safeDirectory(leaseRoot, ownerRoot)
    const leaseRecords = await fs.readdir(leaseRoot, { withFileTypes: true })
    if (leaseRecords.some((entry) => !entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)))
      throw new TypeError("Materialization lease topology is foreign")
    const files = leaseRecords.sort((left, right) => left.name.localeCompare(right.name, "en"))
    if (files.length === 0 || files.length > 64) throw new TypeError("Materialization lease set is ambiguous")
    const leases = await Promise.all(
      files.map(async (file) => {
        const leaseFile = path.join(leaseRoot, file.name)
        await safeFile(leaseFile, leaseRoot)
        const record = decodeLeaseRecord(JSON.parse(await fs.readFile(leaseFile, "utf8")))
        await safeFile(leaseFile, leaseRoot)
        return { file: leaseFile, record }
      }),
    )
    if (leases.some(({ record, file }) => `${record.lease.leaseID}.json` !== path.basename(file)))
      throw new TypeError("Materialization lease filename is foreign")
    const treeRoot = path.join(ownerRoot, "tree")
    await safeDirectory(treeRoot, ownerRoot)
    for (const { record } of leases) {
      const lease = record.lease
      const expectedOwner = {
        schemaVersion: 1,
        materializationID: lease.materializationID,
        workflowID: lease.workflowID,
        revision: lease.revision,
        location: lease.location,
        snapshotRef: lease.snapshotRef,
        manifestSha256: lease.manifestSha256,
        workspaceSha256: lease.workspaceSha256,
      }
      if (
        lease.materializationID !== name ||
        path.resolve(lease.root) !== treeRoot ||
        lease.archive === undefined ||
        WorkflowBusinessArtifact.encode(owner) !== WorkflowBusinessArtifact.encode(expectedOwner)
      )
        throw new TypeError("Materialization owner authority is foreign")
    }
    const firstArchive = leases[0]?.record.lease.archive
    if (
      firstArchive === undefined ||
      leases.some(({ record }) => record.lease.archive?.archiveSha256 !== firstArchive.archiveSha256)
    )
      throw new TypeError("Materialization archive authority is ambiguous")
    const cacheEntries = await materializedEntries(treeRoot)
    const archiveEntries = firstArchive.entries.map(({ contentBase64: _, ...entry }) => entry)
    if (WorkflowBusinessArtifact.encode(cacheEntries) !== WorkflowBusinessArtifact.encode(archiveEntries))
      throw new TypeError("Materialization cleanup cache is foreign")
    return { ownerRoot, owner, leases }
  }

  const releaseMatches = async (
    root: string,
    name: string,
    coordinates: Parameters<MaterializationLeaseManager["release"]>[0],
  ) => {
    const item = await readOwnerLeases(root, name)
    const matches = item.leases.filter(
      ({ record }) =>
        record.lease.workflowID === coordinates.workflowID &&
        record.lease.stageID === coordinates.stageID &&
        record.lease.revision === coordinates.revision,
    )
    if (matches.length === 0) return false
    if (matches.length !== 1) throw new TypeError("Materialization cleanup authority is ambiguous")
    const match = matches[0]
    if (match.record.state === "active") {
      const released = { ...match.record, state: "released" as const, releasedAt: now() }
      await safeFile(match.file, path.dirname(match.file))
      await fs.writeFile(match.file, JSON.stringify(released), { encoding: "utf8", flag: "w" })
      await safeFile(match.file, path.dirname(match.file))
    }
    const settled = await readOwnerLeases(root, name)
    if (settled.leases.every(({ record }) => record.state === "released"))
      await removeLeafFirst(settled.ownerRoot, root)
    return true
  }

  const release = async (coordinates: Parameters<MaterializationLeaseManager["release"]>[0]) => {
    const { root, names } = await owners()
    const matched: string[] = []
    for (const name of names) {
      try {
        const item = await readOwnerLeases(root, name)
        if (
          item.leases.some(
            ({ record }) =>
              record.lease.workflowID === coordinates.workflowID &&
              record.lease.stageID === coordinates.stageID &&
              record.lease.revision === coordinates.revision,
          )
        )
          matched.push(name)
      } catch {
        // Unrelated foreign owners are retained and cannot grant cleanup authority.
      }
    }
    if (matched.length === 0) return false
    if (matched.length !== 1) throw new TypeError("Materialization cleanup authority is duplicated")
    return releaseMatches(root, matched[0], coordinates)
  }

  const gcTick = async () => {
    const { root, names } = await owners()
    if (names.length === 0) {
      cursor = undefined
      return 0
    }
    const start =
      cursor === undefined
        ? 0
        : Math.max(
            0,
            names.findIndex((name) => name > cursor!),
          )
    const selected = names.slice(start, start + batchSize)
    let released = 0
    for (const name of selected) {
      try {
        const item = await readOwnerLeases(root, name)
        for (const { record } of item.leases) {
          if (record.state === "released") continue
          const detail = await Effect.runPromise(input.getWorkflow(record.lease.workflowID))
          if (detail === undefined) continue
          const stages = detail.stages.filter((candidate) => candidate.id === record.lease.stageID)
          if (stages.length !== 1) continue
          const stage = stages[0]
          if (revisionOf(stage) !== record.lease.revision) continue
          const terminal = stage.status === "failed" || stage.status === "cancelled"
          if (!terminal && (stage.status !== "succeeded" || !durableMaterializationEvidence(stage, detail))) continue
          if (await releaseMatches(root, name, record.lease)) released++
        }
      } catch {
        // Foreign, ambiguous, or reparse-drifted owners are intentionally retained.
      }
    }
    const last = selected.at(-1)
    cursor = last === undefined || last === names.at(-1) ? undefined : last
    return released
  }

  return Object.freeze({ release, gcTick })
}

function durableMaterializationEvidence(
  stage: WorkflowRoleExecution.ResolverInput["stage"],
  detail: NonNullable<Effect.Success<ReturnType<ResolverDependencies["getWorkflow"]>>>,
) {
  try {
    const owned = detail.artifacts.filter((artifact) => artifact.stageID === stage.id)
    if (stage.type === "test") {
      if (detail.run.location === undefined) return false
      const results = owned.filter((artifact) => artifact.kind === WorkflowTestArtifact.KIND)
      const logs = owned.filter((artifact) => artifact.kind === WorkflowTestLogArtifact.KIND)
      if (results.length !== 1 || logs.length !== 1) return false
      const resultArtifact = results[0]
      const logArtifact = logs[0]
      const result = WorkflowTestArtifact.decodeExact(
        toCommit(resultArtifact),
        detail.run.id,
        stage.id,
        detail.run.location,
      )
      WorkflowTestLogArtifact.decodeExact(logArtifact, detail.run.id, stage.id, revisionOf(stage))
      if (result.tests.length !== 1) return false
      const test = result.tests[0]
      return (
        result.revision === revisionOf(stage) &&
        test.log.uri === logArtifact.uri &&
        test.log.sha256 === logArtifact.sha256 &&
        test.log.size === logArtifact.size
      )
    }
    if (stage.type === "visual_review") {
      const screenshots = owned.filter(
        (artifact) => artifact.kind === WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND,
      )
      const reviews = owned.filter((artifact) => artifact.kind === WorkflowVisualReviewArtifact.REVIEW_KIND)
      if (screenshots.length === 0 || reviews.length !== 1) return false
      const reviewArtifact = reviews[0]
      const decoded = screenshots.map((artifact) =>
        WorkflowVisualReviewArtifact.decodeScreenshot(toCommit(artifact), detail.run.id),
      )
      const review = WorkflowVisualReviewArtifact.decodeReview(toCommit(reviewArtifact), detail.run.id)
      return (
        decoded.every((image) => image.kind === "implementation" && image.revision === revisionOf(stage)) &&
        review.revision === revisionOf(stage) &&
        decoded.every((image) =>
          review.evidence.some(
            (candidate) =>
              candidate.kind === image.kind &&
              candidate.viewport === image.viewport &&
              candidate.revision === image.revision &&
              candidate.sha256 === image.sha256,
          ),
        )
      )
    }
    return false
  } catch {
    return false
  }
}

function toCommit(artifact: WorkflowRoleExecution.PrepareInput["priorArtifacts"][number]) {
  return {
    kind: artifact.kind,
    uri: artifact.uri,
    mime: artifact.mime,
    sha256: artifact.sha256,
    size: artifact.size,
    metadata: artifact.metadata,
  }
}

async function directoryIdentity(target: string): Promise<string> {
  const canonical = await fs.realpath(target)
  const stat = await fs.lstat(target, { bigint: true })
  if (canonical !== path.resolve(target) || !stat.isDirectory() || stat.isSymbolicLink())
    throw new TypeError("Workspace materialization directory is not exact")
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
}

async function safeDirectory(target: string, parent: string): Promise<void> {
  assertDescendant(parent, target)
  await directoryIdentity(target)
}

async function safeFile(target: string, parent: string): Promise<void> {
  assertDescendant(parent, target)
  const canonical = await fs.realpath(target)
  const stat = await fs.lstat(target)
  if (canonical !== path.resolve(target) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new TypeError("Workspace materialization file is not exact")
}

/** Never follow a reparse point and never delegate recursive deletion to the platform. */
async function removeLeafFirst(target: string, parent: string): Promise<void> {
  assertDescendant(parent, target)
  let root: Awaited<ReturnType<typeof fs.lstat>>
  try {
    root = await fs.lstat(target)
  } catch (cause) {
    if (fileSystemCode(cause, "ENOENT")) return
    throw cause
  }
  if (!root.isDirectory() || root.isSymbolicLink() || (await fs.realpath(target)) !== path.resolve(target))
    throw new TypeError("Workspace materialization cleanup target is unsafe")
  let count = 0
  const visit = async (directory: string): Promise<void> => {
    const records = await fs.readdir(directory, { withFileTypes: true })
    records.sort((left, right) => left.name.localeCompare(right.name, "en"))
    for (const record of records) {
      if (++count > Snapshot.MAX_ENTRIES + 16)
        throw new TypeError("Workspace materialization cleanup target is excessive")
      const child = path.join(directory, record.name)
      assertDescendant(target, child)
      if (record.isSymbolicLink()) throw new TypeError("Workspace materialization cleanup refuses links")
      if (record.isDirectory()) {
        await safeDirectory(child, target)
        await visit(child)
        await fs.rmdir(child)
        continue
      }
      const stat = await fs.lstat(child)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new TypeError("Workspace materialization cleanup refuses foreign leaves")
      await fs.unlink(child)
    }
  }
  await visit(target)
  await fs.rmdir(target)
}

async function materializedEntries(root: string): Promise<readonly Snapshot.Entry[]> {
  const result: Snapshot.Entry[] = []
  let total = 0
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const records = await fs.readdir(directory, { withFileTypes: true })
    records.sort((left, right) => left.name.localeCompare(right.name, "en"))
    for (const record of records) {
      const target = path.join(directory, record.name)
      const relative = prefix ? `${prefix}/${record.name}` : record.name
      if (record.isSymbolicLink()) throw new TypeError("Materialized workspace contains a link")
      if (record.isDirectory()) {
        await visit(target, relative)
        continue
      }
      if (!record.isFile()) throw new TypeError("Materialized workspace contains an unsupported entry")
      if (result.length >= Snapshot.MAX_ENTRIES) throw new TypeError("Materialized workspace has too many entries")
      const stat = await fs.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > Snapshot.MAX_FILE_BYTES)
        throw new TypeError("Materialized workspace entry is unsafe or oversized")
      total += stat.size
      if (total > Snapshot.MAX_TREE_BYTES) throw new TypeError("Materialized workspace is oversized")
      const bytes = await fs.readFile(target)
      if (bytes.byteLength !== stat.size) throw new TypeError("Materialized workspace entry changed while reading")
      const settled = await fs.lstat(target)
      if (settled.size !== stat.size || settled.mtimeMs !== stat.mtimeMs)
        throw new TypeError("Materialized workspace entry changed while hashing")
      result.push({
        path: RelativePath.make(relative.replaceAll("\\", "/")),
        type: (stat.mode & 0o111) === 0 ? "file" : "executable",
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      })
    }
  }
  await visit(root, "")
  return Snapshot.canonicalEntries(result)
}

function assertDescendant(root: string, target: string) {
  const relative = path.relative(root, target)
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new TypeError("Materialization target escaped its configured root")
}

function fileSystemCode(cause: unknown, code: string) {
  return cause !== null && typeof cause === "object" && Reflect.get(cause, "code") === code
}
