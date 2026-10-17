export * as CodingChecksServer from "./coding-checks"

import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { CodingArtifacts } from "@opencode-ai/core/workflow/coding/artifacts"
import { CodingAuthority } from "@opencode-ai/core/workflow/coding/authority"
import { CodingChecks } from "@opencode-ai/core/workflow/coding/checks"
import { CodingHostPlan } from "@opencode-ai/core/workflow/coding/host-plan"
import { WorkflowBusinessArtifact } from "@opencode-ai/core/workflow/artifacts/business"
import { WorkflowDecompositionArtifact } from "@opencode-ai/core/workflow/artifacts/decomposition"
import { WorkflowImplementationArtifact } from "@opencode-ai/core/workflow/artifacts/implementation"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowSecretGuard } from "@opencode-ai/core/workflow/secret-guard"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Hash } from "@opencode-ai/core/util/hash"
import { CodingJUnit } from "./coding-junit"

const failure = (code = "coding_checks_unavailable") =>
  new CodingChecks.CheckFailure({ code, message: "Trusted coding check or exact Snapshot authority is unavailable" })

export function reusableRecord(input: CodingChecks.Request): CodingArtifacts.CheckRecord | undefined {
  const record = CodingArtifacts.checkpointChecks(input.stage)
  if (!record) {
    if (input.stage.checkpoint?.kind === "workflow.model.continuation") throw failure("coding_check_record_lost")
    return undefined
  }
  const sealed = WorkflowWorkspaceMaterialization.validate(input.sealedSnapshot)
  if (
    record.workflowID !== input.workflow.id ||
    record.stageID !== input.stage.id ||
    record.revision !== input.revision ||
    record.locationSha256 !== WorkflowBusinessArtifact.locationSha256(input.workflow.location!) ||
    record.planSha256 !== input.plan.sha256 ||
    record.configSha256 !== input.plan.configSha256 ||
    record.implementationSha256 !== sealed.manifestSha256 ||
    record.workspaceSha256 !== sealed.workspaceSha256 ||
    record.snapshotRef !== sealed.snapshotRef ||
    record.sealedAuthoritySha256 !== sealed.authoritySha256
  )
    throw failure("coding_cached_check_mismatch")
  CodingArtifacts.validateChecks(record.checks, input.plan)
  return record
}

export function measuredChecks(
  plan: CodingHostPlan.Plan,
  measured: readonly {
    readonly id: "test" | "build" | "typecheck"
    readonly result: WorkflowCommandSandbox.FrozenCodingResult
  }[],
): readonly CodingArtifacts.Check[] {
  if (
    measured.length !== plan.commands.length ||
    new Set(measured.map((item) => item.id)).size !== measured.length ||
    measured.some((item) => !plan.commands.some((command) => command.id === item.id))
  )
    throw failure()
  return (["test", "build", "typecheck"] as const).map((id): CodingArtifacts.Check => {
    const command = plan.commands.find((command) => command.id === id)
    if (!command) return { id, status: "not-applicable" }
    const result = measured.find((item) => item.id === id)!.result
    const report = (() => {
      if (id !== "test" || result.report === undefined) return undefined
      try {
        return CodingJUnit.parse(result.report)
      } catch {
        return undefined
      }
    })()
    const log = WorkflowSecretGuard.sanitizeText(result.log).slice(0, 65536)
    return {
      id: command.id,
      status: "executed",
      argv: command.argv,
      cwd: plan.cwd,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      observedTests: report?.observedTests ?? 0,
      failedTests: report?.failedTests ?? (id === "test" ? 1 : 0),
      ...(result.report === undefined ? {} : { reportSha256: Hash.sha256(result.report) }),
      log,
      logSha256: WorkflowBusinessArtifact.hash(log),
      ownerSha256: result.ownerSha256,
    }
  })
}

export const layer = Layer.effect(
  CodingChecks.Service,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const workflows = yield* WorkflowStore.Service
    const authority = yield* CodingAuthority.Service
    const captureSnapshot: CodingChecks.Interface["captureSnapshot"] = (location) =>
      Effect.gen(function* () {
        const service = yield* Snapshot.Service
        const captured = yield* service.capture()
        if (!captured) return yield* failure("coding_snapshot_unavailable")
        return captured
      }).pipe(Effect.provide(locations.get(location)))
    const snapshotEntries: CodingChecks.Interface["snapshotEntries"] = (location, snapshot) =>
      Effect.flatMap(Snapshot.Service, (service) => service.entries({ snapshot })).pipe(
        Effect.provide(locations.get(location)),
        Effect.mapError(() => failure("coding_snapshot_unavailable")),
      )
    const snapshotContents = (
      location: Parameters<CodingChecks.Interface["snapshotEntries"]>[0],
      snapshot: Snapshot.ID,
    ) =>
      Effect.flatMap(Snapshot.Service, (service) => service.contents({ snapshot })).pipe(
        Effect.provide(locations.get(location)),
        Effect.mapError(() => failure("coding_snapshot_unavailable")),
      )
    return CodingChecks.Service.of({
      captureSnapshot,
      snapshotEntries,
      sealWorkspace: (input) =>
        Effect.gen(function* () {
          const detail = yield* workflows.get(input.workflowID)
          if (
            !detail ||
            !detail.run.location ||
            detail.run.type !== "coding-build" ||
            WorkflowBusinessArtifact.locationSha256(detail.run.location) !==
              WorkflowBusinessArtifact.locationSha256(input.location)
          )
            return yield* failure("coding_snapshot_unavailable")
          yield* authority.require(detail.run).pipe(Effect.mapError(() => failure("coding_admission_required")))
          const stage = detail.stages.find((stage) => stage.id === input.stageID)
          if (
            !stage ||
            stage.type !== "test" ||
            stage.id !== detail.run.currentStageID ||
            stage.input.revision !== input.revision ||
            (stage.status !== "running" && stage.status !== "leased")
          )
            return yield* failure("coding_snapshot_unavailable")
          const manifest = yield* Effect.try({
            try: () => {
              const values = detail.artifacts
                .filter((artifact) => artifact.kind === WorkflowImplementationArtifact.KIND)
                .map((artifact) =>
                  WorkflowImplementationArtifact.decodeExact(
                    CodingArtifacts.toCommit(artifact),
                    input.workflowID,
                    input.location,
                  ),
                )
                .filter((value) => value.revision === input.revision)
              const baselines = detail.artifacts.filter(
                (artifact) => artifact.kind === WorkflowDecompositionArtifact.KIND,
              )
              if (values.length !== 1 || baselines.length !== 1) throw failure()
              const baseline = WorkflowDecompositionArtifact.decode(
                CodingArtifacts.toCommit(baselines[0]!),
                input.workflowID,
                input.location,
              )
              if (
                values[0]!.snapshotRef !== baseline.snapshotRef ||
                WorkflowImplementationArtifact.hash(values[0]) !== input.manifestSha256 ||
                values[0]!.workspaceSha256 !== input.workspaceSha256
              )
                throw failure()
              return values[0]!
            },
            catch: () => failure("coding_snapshot_unavailable"),
          })
          yield* snapshotEntries(input.location, Snapshot.ID.make(manifest.snapshotRef))
          const snapshotRef = yield* captureSnapshot(input.location)
          const contents = yield* snapshotContents(input.location, snapshotRef)
          const entries = Snapshot.canonicalEntries(
            contents.map((content) => ({
              path: content.path,
              type: content.type,
              sha256: content.sha256,
              size: content.size,
            })),
          )
          if (Snapshot.workspaceSha256(entries) !== input.workspaceSha256) return yield* failure("coding_source_drift")
          return yield* Effect.tryPromise({
            try: async () => {
              const bytes = new Map(contents.map((content) => [content.path, content.bytes]))
              const archive = await WorkflowWorkspaceMaterialization.seal(entries, async (relative) => {
                const content = bytes.get(relative)
                if (!content) throw failure()
                return content
              })
              const plan = CodingHostPlan.decode(detail.run.input[CodingHostPlan.RESERVED_INPUT_KEY], input.location)
              CodingHostPlan.verifySealedConfiguration(plan, archive.entries)
              return WorkflowWorkspaceMaterialization.bind({ ...input, snapshotRef, archive })
            },
            catch: () => failure("coding_snapshot_unavailable"),
          })
        }),
      run: (input) =>
        Effect.gen(function* () {
          yield* authority.require(input.workflow).pipe(Effect.mapError(() => failure("coding_admission_required")))
          const current = yield* workflows.stage(input.stage.id)
          if (
            !current ||
            current.workflowID !== input.workflow.id ||
            current.attempt !== input.stage.attempt ||
            current.leaseOwner !== input.stage.leaseOwner ||
            !current.leaseOwner ||
            !current.leaseExpiresAt ||
            DateTime.toEpochMillis(current.leaseExpiresAt) < Date.now() ||
            (current.status !== "running" && current.status !== "leased")
          )
            return yield* failure("coding_lease_changed")
          yield* Effect.try({
            try: () => {
              CodingHostPlan.verifyCurrentConfiguration(input.plan)
              WorkflowWorkspaceMaterialization.assertAuthority(input.sealedSnapshot, {
                workflowID: input.workflow.id,
                stageID: input.stage.id,
                revision: input.revision,
                location: input.workflow.location!,
                manifestSha256: input.sealedSnapshot.manifestSha256,
                workspaceSha256: input.sealedSnapshot.workspaceSha256,
              })
              CodingHostPlan.verifySealedConfiguration(input.plan, input.sealedSnapshot.archive.entries)
            },
            catch: () => failure("coding_source_drift"),
          })
          const cached = yield* Effect.try({
            try: () => reusableRecord({ ...input, stage: current }),
            catch: () => failure("coding_cached_check_mismatch"),
          })
          if (cached) return cached
          const measured = yield* Effect.forEach(
            input.plan.commands,
            (command) =>
              Effect.gen(function* () {
                const result = yield* Effect.flatMap(WorkflowCommandSandbox.Service, (sandbox) =>
                  sandbox.runFrozenCoding === undefined
                    ? Effect.fail(failure())
                    : sandbox
                        .runFrozenCoding({
                          workflowID: input.workflow.id,
                          stageID: input.stage.id,
                          revision: input.revision,
                          commandID: command.id,
                          planSha256: input.plan.sha256,
                          configSha256: input.plan.configSha256,
                          sealedSnapshot: input.sealedSnapshot,
                        })
                        .pipe(Effect.mapError(() => failure())),
                ).pipe(Effect.provide(locations.get(input.workflow.location!)))
                return { id: command.id, result }
              }),
            { concurrency: 1 },
          )
          return yield* Effect.try({
            try: () =>
              Schema.decodeUnknownSync(CodingArtifacts.CheckRecord)({
                schemaVersion: 1,
                workflowID: input.workflow.id,
                stageID: input.stage.id,
                attempt: current.attempt,
                leaseOwner: current.leaseOwner,
                revision: input.revision,
                locationSha256: WorkflowBusinessArtifact.locationSha256(input.workflow.location!),
                planSha256: input.plan.sha256,
                configSha256: input.plan.configSha256,
                implementationSha256: input.sealedSnapshot.manifestSha256,
                workspaceSha256: input.sealedSnapshot.workspaceSha256,
                snapshotRef: input.sealedSnapshot.snapshotRef,
                sealedAuthoritySha256: input.sealedSnapshot.authoritySha256,
                checks: measuredChecks(input.plan, measured),
              }),
            catch: () => failure(),
          })
        }),
    })
  }),
)
export const node = makeGlobalNode({
  service: CodingChecks.Service,
  layer,
  deps: [LocationServiceMap.node, WorkflowStore.node, CodingAuthority.node],
})
