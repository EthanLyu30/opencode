export * as WorkflowCredentialScope from "./credential-scope"
import { Context, Effect, Layer } from "effect"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { asc, eq } from "drizzle-orm"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { Integration } from "../../integration"
import { Database } from "../../database/database"
import { Credential } from "../../credential"
import { CredentialTable } from "../../credential/sql"
import { WorkflowBusinessArtifact } from "../artifacts/business"
export interface Identity {
  referenceID: string
  revision: string
  origin: string
}
export interface Configuration {
  origin: string
  integrationID?: Integration.ID
  configurationRevision: string
  environment?: {
    referenceID: string
    file?: string
    reloadRevision?: string
    read: () => Effect.Effect<string, WorkflowModelCatalog.CatalogError>
  }
}
export class Runtime extends Context.Service<
  Runtime,
  { providers: Partial<Record<WorkflowModelCatalog.ProviderID, Configuration>> }
>()("WorkflowCredentialScope.Runtime") {}
export class Service extends Context.Service<
  Service,
  {
    resolve: (providerID: WorkflowModelCatalog.ProviderID) => Effect.Effect<Identity, WorkflowModelCatalog.CatalogError>
    credential: (
      providerID: WorkflowModelCatalog.ProviderID,
      identity: Identity,
    ) => Effect.Effect<string, WorkflowModelCatalog.CatalogError>
  }
>()("WorkflowCredentialScope.Service") {}
const error = (code: WorkflowModelCatalog.ErrorCode) => new WorkflowModelCatalog.CatalogError({ code })
export function validateOrigin(providerID: WorkflowModelCatalog.ProviderID, origin: string): void {
  if (origin !== (providerID === "kimi" ? "https://api.moonshot.cn" : "https://api.deepseek.com"))
    throw error("scope_mismatch")
}
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const database = yield* Database.Service
    const credentials = yield* Credential.Service
    const sessionRevision = randomUUID()
    const resolve = Effect.fn("WorkflowCredentialScope.resolve")(function* (
      providerID: WorkflowModelCatalog.ProviderID,
    ) {
      const config = runtime.providers[providerID]
      if (!config) return yield* Effect.fail(error("selection_required"))
      yield* Effect.try({ try: () => validateOrigin(providerID, config.origin), catch: () => error("scope_mismatch") })
      if (config.environment) {
        const environment = config.environment
        const metadata = environment.file
          ? yield* Effect.tryPromise({
              try: () => fs.stat(environment.file!),
              catch: () => error("selection_required"),
            })
          : null
        const revision = WorkflowBusinessArtifact.hash({
          configurationRevision: config.configurationRevision,
          reloadRevision: environment.reloadRevision ?? `ephemeral:${sessionRevision}`,
          metadata: metadata ? { size: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs } : null,
        })
        return {
          referenceID: environment.referenceID,
          revision: environment.reloadRevision ? revision : `ephemeral:${revision}`,
          origin: config.origin,
        }
      }
      if (!config.integrationID) return yield* Effect.fail(error("selection_required"))
      // Explicit projection: never materialize value, label or secret-key digests for the scope.
      const rows = yield* database.db
        .select({
          id: CredentialTable.id,
          integrationID: CredentialTable.integration_id,
          updatedAt: CredentialTable.time_updated,
        })
        .from(CredentialTable)
        .where(eq(CredentialTable.integration_id, config.integrationID))
        .orderBy(asc(CredentialTable.time_created), asc(CredentialTable.id))
        .all()
        .pipe(Effect.mapError(() => error("selection_required")))
      const row = rows.at(-1)
      if (!row) return yield* Effect.fail(error("selection_required"))
      return {
        referenceID: row.id,
        revision: WorkflowBusinessArtifact.hash({
          integrationID: row.integrationID,
          updatedAt: row.updatedAt,
          configurationRevision: config.configurationRevision,
        }),
        origin: config.origin,
      }
    })
    return Service.of({
      resolve,
      credential: Effect.fn("WorkflowCredentialScope.credential")(function* (providerID, identity) {
        const current = yield* resolve(providerID)
        if (hash([current]) !== hash([identity])) return yield* Effect.fail(error("scope_mismatch"))
        const config = runtime.providers[providerID]!
        if (config.environment)
          return yield* config.environment
            .read()
            .pipe(Effect.catchCause(() => Effect.fail(error("selection_required"))))
        const credential = yield* credentials
          .get(Credential.ID.make(identity.referenceID))
          .pipe(Effect.catchCause(() => Effect.fail(error("selection_required"))))
        if (!credential || credential.value.type !== "key") return yield* Effect.fail(error("selection_required"))
        return credential.value.key
      }),
    })
  }),
)
export function hash(identities: readonly Identity[]): string {
  identities.forEach((identity) => {
    if (!identity.referenceID || !identity.revision || !identity.origin) throw error("scope_mismatch")
  })
  return WorkflowBusinessArtifact.hash(
    [...identities].sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0)),
  )
}
