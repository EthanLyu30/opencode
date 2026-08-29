export * as WorkflowProductionEvidenceServer from "./production-evidence"

import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { WorkflowBusinessArtifact } from "@opencode-ai/core/workflow/artifacts/business"
import { WorkflowDecompositionArtifact } from "@opencode-ai/core/workflow/artifacts/decomposition"
import { WorkflowDesignArtifact } from "@opencode-ai/core/workflow/artifacts/design"
import { WorkflowImplementationArtifact } from "@opencode-ai/core/workflow/artifacts/implementation"
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
        materializeSnapshot: (location, snapshot, target) =>
          Effect.flatMap(Snapshot.Service, (service) => service.materialize({ snapshot, directory: target })).pipe(
            Effect.provide(locations.get(location)),
          ),
      }
      return WorkflowVisualHostServer.productionLayer({
        environment,
        resolveImplementationContract: makeImplementationResolver(dependencies),
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
      await fs.mkdir(configuredRoot, { recursive: true })
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
        const durable = JSON.parse(await fs.readFile(ownerFile, "utf8")) as unknown
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
        const temporary = path.join(configuredRoot, `.tmp-${identity}-${randomUUID()}`)
        assertDescendant(configuredRoot, temporary)
        try {
          await fs.mkdir(temporary)
          const temporaryTree = AbsolutePath.make(path.join(temporary, "tree"))
          await Effect.runPromise(dependencies.materializeSnapshot(input.location, input.snapshotRef, temporaryTree))
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
            await fs.rename(temporary, ownerRoot)
          } catch (cause) {
            if (!fileSystemCode(cause, "EEXIST")) throw cause
          }
        } finally {
          await fs.rm(temporary, { recursive: true, force: true })
        }
        await verify()
      }
      const lease = WorkflowWorkspaceMaterialization.make({ ...input, root: AbsolutePath.make(treeRoot) })
      const leaseDirectory = path.join(ownerRoot, "leases")
      await fs.mkdir(leaseDirectory, { recursive: true })
      const leaseFile = path.join(leaseDirectory, `${lease.leaseID}.json`)
      try {
        await fs.writeFile(leaseFile, JSON.stringify(lease), { encoding: "utf8", flag: "wx" })
      } catch (cause) {
        if (!fileSystemCode(cause, "EEXIST")) throw cause
        const durable = JSON.parse(await fs.readFile(leaseFile, "utf8")) as unknown
        if (WorkflowBusinessArtifact.encode(durable) !== WorkflowBusinessArtifact.encode(lease))
          throw new TypeError("Materialization lease identity drifted", { cause })
      }
      await verify()
      return lease
    },
    catch: () => new TypeError("Exact workspace materialization is unavailable or drifted"),
  })
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
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > Snapshot.MAX_FILE_BYTES)
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
