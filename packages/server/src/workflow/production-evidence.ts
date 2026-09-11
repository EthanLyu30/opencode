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
import { DateTime, Effect, Layer } from "effect"
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
  readonly snapshotContents: (
    location: WorkflowRoleExecution.ResolverInput["location"],
    snapshot: Snapshot.ID,
  ) => Effect.Effect<readonly Snapshot.Content[], unknown>
}

export function makeImplementationResolver(
  dependencies: ResolverDependencies,
): WorkflowVisualHost.ResolveImplementationContract {
  return (input) => Effect.runPromise(resolveImplementationContract(dependencies, input))
}

export function makePreviewLeaseResolver(
  dependencies: Pick<ResolverDependencies, "getWorkflow">,
  now: () => number = Date.now,
): NonNullable<WorkflowVisualHostServer.Options["resolvePreviewLease"]> {
  return async (workflowID) => {
    const detail = await Effect.runPromise(dependencies.getWorkflow(workflowID))
    if (detail === undefined) throw new TypeError("Persisted visual Workflow authority is unavailable")
    const stage = detail.stages.find((candidate) => candidate.id === detail.run.currentStageID)
    if (
      detail.run.id !== workflowID ||
      detail.run.status !== "running" ||
      detail.run.cancelRequestedAt !== undefined ||
      stage === undefined ||
      stage.workflowID !== workflowID ||
      stage.type !== "visual_review" ||
      (stage.status !== "leased" && stage.status !== "running") ||
      stage.leaseOwner === undefined ||
      stage.leaseExpiresAt === undefined ||
      DateTime.toEpochMillis(stage.leaseExpiresAt) < now()
    ) {
      throw new TypeError("Persisted visual Stage lease is unavailable")
    }
    return WorkflowVisualHost.validatePreviewLeaseAuthority({
      workflowID,
      stageID: stage.id,
      attempt: stage.attempt,
      leaseOwner: stage.leaseOwner,
      leaseExpiresAt: DateTime.toEpochMillis(stage.leaseExpiresAt),
    })
  }
}

export function makePreviewLeaseLiveProbe(
  dependencies: Pick<ResolverDependencies, "getWorkflow">,
  now: () => number = Date.now,
): NonNullable<WorkflowVisualHostServer.Options["isPreviewLeaseLive"]> {
  return async (observed) => {
    const lease = WorkflowVisualHost.validatePreviewLeaseAuthority(observed)
    const detail = await Effect.runPromise(dependencies.getWorkflow(lease.workflowID))
    if (
      detail === undefined ||
      detail.run.id !== lease.workflowID ||
      detail.run.status !== "running" ||
      detail.run.cancelRequestedAt !== undefined
    )
      return false
    const stage = detail.stages.find((candidate) => candidate.id === detail.run.currentStageID)
    return (
      stage !== undefined &&
      stage.id === lease.stageID &&
      stage.workflowID === lease.workflowID &&
      stage.type === "visual_review" &&
      (stage.status === "leased" || stage.status === "running") &&
      stage.attempt === lease.attempt &&
      stage.leaseOwner === lease.leaseOwner &&
      stage.leaseExpiresAt !== undefined &&
      DateTime.toEpochMillis(stage.leaseExpiresAt) >= now()
    )
  }
}

export function resolveImplementationContract(
  dependencies: ResolverDependencies,
  input: WorkflowVisualHost.PrepareImplementationInput,
) {
  return Effect.gen(function* () {
    const detail = yield* dependencies.getWorkflow(input.workflowID)
    if (
      detail === undefined ||
      detail.run.type !== "visual-build" ||
      detail.run.status !== "running" ||
      detail.run.cancelRequestedAt !== undefined ||
      detail.run.location === undefined
    )
      return yield* invalid("Persisted visual Workflow authority is unavailable")
    const stage = detail.stages.find((candidate) => candidate.id === detail.run.currentStageID)
    if (
      stage === undefined ||
      stage.workflowID !== detail.run.id ||
      stage.type !== "visual_review" ||
      (stage.status !== "leased" && stage.status !== "running") ||
      revisionOf(stage) !== input.revision ||
      stage.leaseOwner === undefined ||
      stage.leaseExpiresAt === undefined
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
    const contents = yield* dependencies.snapshotContents(detail.run.location, current)
    const entries = entriesOf(contents)
    if (Snapshot.workspaceSha256(entries) !== manifest.workspaceSha256)
      return yield* invalid("Current workspace differs from the implementation manifest")
    const manifestSha256 = WorkflowImplementationArtifact.hash(manifest)
    const sealedSnapshot = yield* sealExactSnapshot({
      workflowID: detail.run.id,
      stageID: stage.id,
      revision: input.revision,
      location: detail.run.location,
      snapshotRef: current,
      manifestSha256,
      workspaceSha256: manifest.workspaceSha256,
      entries,
      contents,
    })
    return Object.freeze({
      implementationSha256: manifestSha256,
      readySelector: spec.referenceApp.readySelector,
      sealedSnapshot,
      previewLease: WorkflowVisualHost.validatePreviewLeaseAuthority({
        workflowID: detail.run.id,
        stageID: stage.id,
        attempt: stage.attempt,
        leaseOwner: stage.leaseOwner,
        leaseExpiresAt: DateTime.toEpochMillis(stage.leaseExpiresAt),
      }),
    })
  })
}

export function productionRoleLayer(): Layer.Layer<
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
      const snapshotContents: ResolverDependencies["snapshotContents"] = (location, snapshot) =>
        Effect.flatMap(Snapshot.Service, (service) => service.contents({ snapshot })).pipe(
          Effect.provide(locations.get(location)),
        )
      const resolverDependencies: ResolverDependencies = {
        getWorkflow: workflows.get,
        captureSnapshot,
        snapshotEntries,
        snapshotContents,
      }
      return WorkflowRoleExecution.Service.of(
        WorkflowProductionEvidence.make({
          captureSnapshot,
          snapshotEntries,
          sealWorkspace: (request) => sealFunctionalWorkspace(resolverDependencies, request),
          runFunctionalTest: (request) =>
            Effect.flatMap(WorkflowCommandSandbox.Service, (command) => {
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
                sealedSnapshot: request.sealedSnapshot,
              })
            })
              .pipe(Effect.provide(locations.get(request.location)))
              .pipe(Effect.map((result) => ({ exitCode: result.exit, log: result.output }))),
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
        snapshotContents: (location, snapshot) =>
          Effect.flatMap(Snapshot.Service, (service) => service.contents({ snapshot })).pipe(
            Effect.provide(locations.get(location)),
          ),
      }
      return WorkflowVisualHostServer.productionLayer({
        environment,
        resolveImplementationContract: makeImplementationResolver(dependencies),
        resolvePreviewLease: makePreviewLeaseResolver(dependencies),
        isPreviewLeaseLive: makePreviewLeaseLiveProbe(dependencies),
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

function sealFunctionalWorkspace(
  dependencies: ResolverDependencies,
  input: Parameters<WorkflowProductionEvidence.Dependencies["sealWorkspace"]>[0],
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
      return yield* invalid("Functional-test sealed Snapshot lineage differs from the implementation")
    yield* dependencies.snapshotEntries(detail.run.location, Snapshot.ID.make(decomposition.snapshotRef))
    const current = yield* dependencies.captureSnapshot(detail.run.location)
    if (current === undefined) return yield* invalid("Current functional-test Snapshot is unavailable")
    const contents = yield* dependencies.snapshotContents(detail.run.location, current)
    const entries = entriesOf(contents)
    if (Snapshot.workspaceSha256(entries) !== manifest.workspaceSha256)
      return yield* invalid("Current functional-test workspace differs from the implementation manifest")
    return yield* sealExactSnapshot({ ...input, snapshotRef: current, entries, contents })
  })
}

function sealExactSnapshot(
  input: Omit<WorkflowWorkspaceMaterialization.BindInput, "archive"> & {
    readonly entries: readonly Snapshot.Entry[]
    readonly contents: readonly Snapshot.Content[]
  },
) {
  return Effect.tryPromise({
    try: async () => {
      if (WorkflowBusinessArtifact.encode(entriesOf(input.contents)) !== WorkflowBusinessArtifact.encode(input.entries))
        throw new TypeError("Snapshot contents differ from their canonical entries")
      const byPath = new Map(input.contents.map((content) => [content.path, content.bytes] as const))
      if (byPath.size !== input.entries.length) throw new TypeError("Snapshot contents are missing or duplicated")
      const archive = await WorkflowWorkspaceMaterialization.seal(input.entries, async (relative) => {
        const content = byPath.get(relative)
        if (content === undefined) throw new TypeError("Snapshot content is missing")
        return Uint8Array.from(content)
      })
      return WorkflowWorkspaceMaterialization.bind({
        workflowID: input.workflowID,
        stageID: input.stageID,
        revision: input.revision,
        location: input.location,
        snapshotRef: input.snapshotRef,
        manifestSha256: input.manifestSha256,
        workspaceSha256: input.workspaceSha256,
        archive,
      })
    },
    catch: () => new TypeError("Exact sealed Snapshot is unavailable or drifted"),
  })
}

function entriesOf(contents: readonly Snapshot.Content[]): readonly Snapshot.Entry[] {
  return Snapshot.canonicalEntries(contents.map(({ bytes: _, ...entry }) => entry))
}
