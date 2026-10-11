export * as WorkflowModelCatalogService from "./service"
import { Clock, Context, Effect, Layer, Ref, Schedule, Semaphore } from "effect"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowModelCatalogStore } from "./store"
import { WorkflowModelCatalogPolicy } from "./policy"
import { WorkflowCredentialScope } from "./credential-scope"
import { WorkflowModelDiscovery } from "./discovery"
export class Service extends Context.Service<
  Service,
  {
    view: () => Effect.Effect<WorkflowModelCatalog.View, WorkflowModelCatalog.CatalogError>
    refresh: (force?: boolean) => Effect.Effect<WorkflowModelCatalog.View, WorkflowModelCatalog.CatalogError>
  }
>()("WorkflowModelCatalogService.Service") {}
export function layer(input: {
  root: string
  automatic?: boolean
  now?: () => number
  initialPolicy?: (scopeSha256: string) => WorkflowModelCatalog.Policy
}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const scope = yield* WorkflowCredentialScope.Service
      const discovery = yield* WorkflowModelDiscovery.Service
      const clock = yield* Clock.Clock
      const now = input.now ?? (() => clock.currentTimeMillisUnsafe())
      const refreshLock = yield* Semaphore.make(1)
      const status = yield* Ref.make<{
        scopeSha256: string
        refreshStatus: WorkflowModelCatalog.View["refreshStatus"]
        failureCode: string | null
      }>({ scopeSha256: "", refreshStatus: "idle", failureCode: null })
      const identity = Effect.gen(function* () {
        const kimi = yield* scope.resolve("kimi")
        const deepseek = yield* scope.resolve("deepseek")
        return {
          sha256: WorkflowCredentialScope.hash([kimi, deepseek]),
          volatile: kimi.revision.startsWith("ephemeral:") || deepseek.revision.startsWith("ephemeral:"),
        }
      })
      const open = (scopeSha256: string) =>
        Effect.tryPromise({
          try: () => WorkflowModelCatalogStore.open(input.root, scopeSha256),
          catch: () => new WorkflowModelCatalog.CatalogError({ code: "snapshot_corrupt" }),
        })
      const read = (store: WorkflowModelCatalogStore.Interface) =>
        Effect.tryPromise({
          try: () => store.read(),
          catch: () => new WorkflowModelCatalog.CatalogError({ code: "snapshot_corrupt" }),
        })
      const view = Effect.fn("WorkflowModelCatalogService.view")(function* () {
        const currentIdentity = yield* identity
        const scopeSha256 = currentIdentity.sha256
        const store = yield* open(scopeSha256)
        const value = yield* read(store)
        const current = yield* Ref.get(status)
        return {
          ...value,
          stale:
            currentIdentity.volatile || value.catalogue === null || now() - value.catalogue.observedAt >= 3_600_000,
          ...(current.scopeSha256 === scopeSha256
            ? { refreshStatus: current.refreshStatus, failureCode: current.failureCode }
            : {}),
        }
      })
      const refreshUnlocked = Effect.fn("WorkflowModelCatalogService.refresh")(function* (force = false) {
        const currentIdentity = yield* identity
        const scopeSha256 = currentIdentity.sha256
        const store = yield* open(scopeSha256)
        const before = yield* read(store)
        if (!force && !currentIdentity.volatile && before.catalogue && now() - before.catalogue.observedAt < 3_600_000)
          return yield* view()
        yield* Ref.set(status, { scopeSha256, refreshStatus: "refreshing", failureCode: null })
        const result = yield* Effect.gen(function* () {
          const kimi = yield* discovery.refresh("kimi", scopeSha256)
          const deepseek = yield* discovery.refresh("deepseek", scopeSha256)
          if ((yield* identity).sha256 !== scopeSha256)
            return yield* Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "scope_mismatch" }))
          const observedAt = now()
          const prepared = yield* Effect.try({
            try: () => {
              const observed = WorkflowModelCatalogPolicy.normalizeCatalogue(
                {
                  schemaVersion: 1,
                  scopeSha256,
                  observedAt,
                  models: [...kimi.models, ...deepseek.models],
                  sha256: "0".repeat(64),
                },
                scopeSha256,
              )
              return {
                catalogue: WorkflowModelCatalogPolicy.mergeObservation(before.catalogue, observed, observedAt),
                policy: before.policy ?? input.initialPolicy?.(scopeSha256),
              }
            },
            catch: (cause) =>
              cause instanceof WorkflowModelCatalog.CatalogError
                ? cause
                : new WorkflowModelCatalog.CatalogError({ code: "invalid_metadata" }),
          })
          const { catalogue, policy } = prepared
          if (!policy) return yield* Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "selection_required" }))
          yield* Effect.tryPromise({
            try: (signal) =>
              WorkflowModelCatalogStore.open(input.root, scopeSha256, { signal }).then((writer) =>
                writer.publish({ expectedHeadSha256: before.head?.sha256 ?? null, catalogue, policy }),
              ),
            catch: (cause) =>
              cause instanceof WorkflowModelCatalog.CatalogError
                ? cause
                : new WorkflowModelCatalog.CatalogError({ code: "snapshot_corrupt" }),
          })
        }).pipe(
          Effect.catch((cause) => Effect.succeed(cause)),
          Effect.onInterrupt(() =>
            Ref.set(status, { scopeSha256, refreshStatus: "failed", failureCode: "discovery_failed" }),
          ),
        )
        yield* Ref.set(status, {
          scopeSha256,
          refreshStatus: result instanceof WorkflowModelCatalog.CatalogError ? "failed" : "idle",
          failureCode: result instanceof WorkflowModelCatalog.CatalogError ? result.code : null,
        })
        return yield* view()
      })
      const refresh = (force = false) => refreshLock.withPermits(1)(refreshUnlocked(force))
      if (input.automatic !== false)
        yield* Effect.forkScoped(refresh().pipe(Effect.ignore, Effect.repeat(Schedule.spaced("60 minutes"))))
      return Service.of({ view, refresh })
    }),
  )
}
