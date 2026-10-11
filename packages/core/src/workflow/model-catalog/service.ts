export * as WorkflowModelCatalogService from "./service"
import { Clock, Context, Effect, Layer, Ref, Schedule, Schema, Semaphore } from "effect"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowModelCatalogStore } from "./store"
import { WorkflowModelCatalogPolicy } from "./policy"
import { WorkflowCredentialScope } from "./credential-scope"
import { WorkflowModelDiscovery } from "./discovery"
import { ModelSelection } from "../model-selection"
import { ModelAvailability } from "../model-availability"
export class Service extends Context.Service<
  Service,
  {
    view: () => Effect.Effect<WorkflowModelCatalog.View, WorkflowModelCatalog.CatalogError>
    refresh: (force?: boolean) => Effect.Effect<WorkflowModelCatalog.View, WorkflowModelCatalog.CatalogError>
    activate: (
      input: WorkflowModelCatalog.ActivationInput,
    ) => Effect.Effect<WorkflowModelCatalog.View, WorkflowModelCatalog.CatalogError>
    snapshot: () => Effect.Effect<WorkflowModelCatalog.AdmissionSnapshot, WorkflowModelCatalog.CatalogError>
    checkPinned: (selection: ModelSelection.FrozenSelection) => Effect.Effect<void, WorkflowModelCatalog.CatalogError>
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
      const ensureScope = Effect.fn("WorkflowModelCatalogService.ensureScope")(function* (scopeSha256: string) {
        if ((yield* identity).sha256 !== scopeSha256)
          return yield* Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "scope_mismatch" }))
      })
      const observe = Effect.fn("WorkflowModelCatalogService.observe")(function* (scopeSha256: string) {
        const kimi = yield* discovery.refresh("kimi", scopeSha256)
        const deepseek = yield* discovery.refresh("deepseek", scopeSha256)
        yield* ensureScope(scopeSha256)
        return yield* Effect.try({
          try: () =>
            WorkflowModelCatalogPolicy.normalizeCatalogue(
              {
                schemaVersion: 1,
                scopeSha256,
                observedAt: now(),
                models: [...kimi.models, ...deepseek.models],
                sha256: "0".repeat(64),
              },
              scopeSha256,
            ),
          catch: (cause) =>
            cause instanceof WorkflowModelCatalog.CatalogError
              ? cause
              : new WorkflowModelCatalog.CatalogError({ code: "invalid_metadata" }),
        })
      })
      const publish = (scopeSha256: string, data: Parameters<WorkflowModelCatalogStore.Interface["publish"]>[0]) =>
        Effect.tryPromise({
          try: (signal) =>
            WorkflowModelCatalogStore.open(input.root, scopeSha256, {
              signal,
              // Recheck trusted identity inside the existing Flock critical section, just before head replacement.
              onPublish: async (phase) => {
                if (phase === "before_head") await Effect.runPromise(ensureScope(scopeSha256), { signal })
              },
            }).then((writer) => writer.publish(data)),
          catch: (cause) =>
            cause instanceof WorkflowModelCatalog.CatalogError
              ? cause
              : new WorkflowModelCatalog.CatalogError({ code: "snapshot_corrupt" }),
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
          const observed = yield* observe(scopeSha256)
          const prepared = yield* Effect.try({
            try: () => {
              return {
                catalogue: WorkflowModelCatalogPolicy.mergeObservation(before.catalogue, observed, observed.observedAt),
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
          yield* publish(scopeSha256, { expectedHeadSha256: before.head?.sha256 ?? null, catalogue, policy })
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
      const checkPinned = Effect.fn("WorkflowModelCatalogService.checkPinned")(function* (
        selection: ModelSelection.FrozenSelection,
      ) {
        const pinned = yield* Effect.try({
          try: () => ModelSelection.validate(selection),
          catch: () => new WorkflowModelCatalog.CatalogError({ code: "snapshot_corrupt" }),
        })
        const current = yield* identity
        if (current.sha256 !== pinned.snapshot.scopeSha256)
          return yield* Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "scope_mismatch" }))
        const stored = yield* read(yield* open(current.sha256))
        if (!stored.catalogue)
          return yield* Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "selection_required" }))
        // Never mask fresh discovery failure or use the two-observation retirement merge for an existing pin.
        const catalogue =
          current.volatile || now() - stored.catalogue.observedAt >= 3_600_000
            ? yield* observe(current.sha256)
            : stored.catalogue
        yield* ModelAvailability.checkCatalogue(pinned, catalogue)
        yield* ensureScope(current.sha256)
      })
      const activateUnlocked = Effect.fn("WorkflowModelCatalogService.activate")(function* (
        request: WorkflowModelCatalog.ActivationInput,
      ) {
        const decoded = Schema.decodeUnknownOption(WorkflowModelCatalog.ActivationInput)(request)
        if (decoded._tag === "None")
          return yield* Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "invalid_metadata" }))
        const currentIdentity = yield* identity
        const store = yield* open(currentIdentity.sha256)
        const before = yield* read(store)
        if (!before.head || !before.catalogue || !before.policy)
          return yield* Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "selection_required" }))
        if (before.head.sha256 !== decoded.value.expectedHeadSha256)
          return yield* Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "selection_conflict" }))
        if (!currentIdentity.volatile && now() - before.catalogue.observedAt >= 3_600_000)
          return yield* Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "selection_required" }))
        const catalogue = currentIdentity.volatile
          ? yield* observe(currentIdentity.sha256).pipe(
              Effect.flatMap((observed) =>
                Effect.try({
                  try: () => {
                    const choices = { ...before.policy!.choices }
                    for (const replacement of decoded.value.replacements)
                      choices[replacement.family] = { providerID: replacement.providerID, modelID: replacement.modelID }
                    const pending = Object.values(choices)
                    for (const choice of pending) {
                      const original = before.catalogue!.models.find(
                        (entry) => entry.providerID === choice.providerID && entry.modelID === choice.modelID,
                      )
                      const fresh = observed.models.find(
                        (entry) => entry.providerID === choice.providerID && entry.modelID === choice.modelID,
                      )
                      if (!original || !fresh || fresh.availability !== "available")
                        throw new WorkflowModelCatalog.CatalogError({ code: "model_unavailable" })
                      const binding = (entry: WorkflowModelCatalog.ModelEntry) => {
                        const { lifecycle, missingObservation, evidence, ...facts } = entry
                        return { ...facts, evidence: evidence.map(({ observedAt, ...proof }) => proof) }
                      }
                      if (
                        WorkflowBusinessArtifact.hash(binding(original)) !==
                        WorkflowBusinessArtifact.hash(binding(fresh))
                      )
                        throw new WorkflowModelCatalog.CatalogError({ code: "selection_conflict" })
                    }
                    return WorkflowModelCatalogPolicy.mergeObservation(before.catalogue!, observed, observed.observedAt)
                  },
                  catch: (cause) =>
                    cause instanceof WorkflowModelCatalog.CatalogError
                      ? cause
                      : new WorkflowModelCatalog.CatalogError({ code: "invalid_metadata" }),
                }),
              ),
            )
          : before.catalogue
        const replacement = yield* Effect.try({
          try: () =>
            WorkflowModelCatalogPolicy.replacePolicy({
              catalogue,
              policy: before.policy!,
              replacements: decoded.value.replacements,
            }),
          catch: (cause) =>
            cause instanceof WorkflowModelCatalog.CatalogError
              ? cause
              : new WorkflowModelCatalog.CatalogError({ code: "invalid_metadata" }),
        })
        yield* publish(currentIdentity.sha256, { expectedHeadSha256: decoded.value.expectedHeadSha256, ...replacement })
        yield* ensureScope(currentIdentity.sha256)
        return yield* view()
      })
      const snapshotUnlocked = Effect.fn("WorkflowModelCatalogService.snapshot")(function* () {
        const currentIdentity = yield* identity
        const store = yield* open(currentIdentity.sha256)
        const before = yield* read(store)
        if (!before.head || !before.catalogue || !before.policy)
          return yield* Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "selection_required" }))
        const current =
          currentIdentity.volatile || now() - before.catalogue.observedAt >= 3_600_000
            ? yield* observe(currentIdentity.sha256).pipe(
                Effect.flatMap((observed) =>
                  Effect.gen(function* () {
                    // A volatile reference cannot reuse a model omitted by this account's fresh observation.
                    if (
                      currentIdentity.volatile &&
                      Object.values(before.policy!.choices).some(
                        (choice) =>
                          !observed.models.some(
                            (entry) =>
                              entry.providerID === choice.providerID &&
                              entry.modelID === choice.modelID &&
                              entry.availability === "available",
                          ),
                      )
                    )
                      return yield* Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "model_unavailable" }))
                    const catalogue = yield* Effect.try({
                      try: () =>
                        WorkflowModelCatalogPolicy.mergeObservation(before.catalogue!, observed, observed.observedAt),
                      catch: () => new WorkflowModelCatalog.CatalogError({ code: "invalid_metadata" }),
                    })
                    const head = yield* publish(currentIdentity.sha256, {
                      expectedHeadSha256: before.head!.sha256,
                      catalogue,
                      policy: before.policy!,
                    })
                    return { head, catalogue, policy: before.policy! }
                  }),
                ),
              )
            : { head: before.head, catalogue: before.catalogue, policy: before.policy }
        const snapshot = yield* Effect.try({
          try: () => {
            const route = (role: WorkflowRole.Role): WorkflowModelCatalog.RouteSelection => {
              const required = WorkflowModelCatalogPolicy.requirements[role]
              const choice = current.policy!.choices[required.family]
              const entry = current.catalogue!.models.find(
                (entry) => entry.providerID === choice.providerID && entry.modelID === choice.modelID,
              )
              if (!entry || entry.availability !== "available")
                throw new WorkflowModelCatalog.CatalogError({ code: "model_unavailable" })
              if (entry.lifecycle !== "current")
                throw new WorkflowModelCatalog.CatalogError({ code: "selection_required" })
              if (!WorkflowModelCatalogPolicy.eligible(entry, role))
                throw new WorkflowModelCatalog.CatalogError({ code: "unverified_contract" })
              return Schema.decodeUnknownSync(WorkflowModelCatalog.RouteSelection)({
                providerID: entry.providerID,
                modelID: entry.modelID,
                protocol: required.protocol,
                reasoningEffort: required.reasoningEffort,
                requiredCapabilities: [...required.capabilities],
                adapterProfileID: entry.adapterProfileID,
                adapterProfileSha256: entry.adapterProfileSha256,
                priceSha256: entry.priceSha256,
                advertisedRevision: entry.advertisedRevision,
              })
            }
            const content = {
              schemaVersion: 1 as const,
              catalogueSha256: current.catalogue!.sha256,
              policySha256: current.policy!.sha256,
              scopeSha256: currentIdentity.sha256,
              routes: {
                design: route("design"),
                decompose: route("decompose"),
                visual_review: route("visual_review"),
                implement: route("implement"),
                repair: route("repair"),
                deliver: route("deliver"),
                test: route("test"),
              },
            }
            return Schema.decodeUnknownSync(WorkflowModelCatalog.AdmissionSnapshot)({
              ...content,
              sha256: WorkflowBusinessArtifact.hash(content),
            })
          },
          catch: (cause) =>
            cause instanceof WorkflowModelCatalog.CatalogError
              ? cause
              : new WorkflowModelCatalog.CatalogError({ code: "invalid_metadata" }),
        })
        yield* ensureScope(currentIdentity.sha256)
        return snapshot
      })
      if (input.automatic !== false)
        yield* Effect.forkScoped(refresh().pipe(Effect.ignore, Effect.repeat(Schedule.spaced("60 minutes"))))
      return Service.of({
        view,
        refresh,
        activate: (request) => refreshLock.withPermits(1)(activateUnlocked(request)),
        snapshot: () => refreshLock.withPermits(1)(snapshotUnlocked()),
        checkPinned: (selection) => refreshLock.withPermits(1)(checkPinned(selection)),
      })
    }),
  )
}
