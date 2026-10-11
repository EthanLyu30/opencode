export * as WorkflowModelDiscovery from "./discovery"
import { Clock, Context, Effect, Layer, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowCredentialScope } from "./credential-scope"
import { WorkflowModelSources } from "./sources"
import { WorkflowModelCatalogPolicy } from "./policy"
const error = (code: WorkflowModelCatalog.ErrorCode) => new WorkflowModelCatalog.CatalogError({ code })
const positive = Schema.Int.check(Schema.isGreaterThan(0))
const common = { id: WorkflowModelCatalog.ModelID, object: Schema.Literal("model"), owned_by: Schema.NonEmptyString }
const kimi = Schema.Struct({
  ...common,
  created: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  context_length: positive,
  supports_image_in: Schema.Boolean,
  supports_video_in: Schema.Boolean,
  supports_reasoning: Schema.Boolean,
})
const deepseek = Schema.Struct({
  ...common,
  name: Schema.optional(Schema.NonEmptyString),
  context_window: Schema.optional(positive),
  max_output_tokens: Schema.optional(positive),
  input_modalities: Schema.optional(Schema.Array(Schema.Literals(["text", "image"]))),
  output_modalities: Schema.optional(Schema.Array(Schema.Literal("text"))),
  effort: Schema.optional(
    Schema.Struct({
      supported_levels: Schema.Array(Schema.NonEmptyString),
      default_level: Schema.optional(Schema.NonEmptyString),
    }),
  ),
  api_capabilities: Schema.optional(
    Schema.Struct({
      anthropic_messages: Schema.optional(
        Schema.Struct({ system_prompt_update: Schema.Literals(["leading-only", "in-history"]) }),
      ),
    }),
  ),
})
const kimiList = Schema.Struct({
  object: Schema.Literal("list"),
  data: Schema.Array(kimi).check(Schema.isMaxLength(256)),
})
const deepseekList = Schema.Struct({
  object: Schema.Literal("list"),
  data: Schema.Array(deepseek).check(Schema.isMaxLength(256)),
})

export function parse(
  providerID: WorkflowModelCatalog.ProviderID,
  input: unknown,
  observedAt: number,
  scopeSha256: string,
): WorkflowModelCatalog.Catalogue {
  const value =
    providerID === "kimi"
      ? Schema.decodeUnknownOption(kimiList)(input)
      : Schema.decodeUnknownOption(deepseekList)(input)
  if (value._tag === "None") throw error("invalid_metadata")
  const evidence = WorkflowModelSources.metadataEvidence(providerID, observedAt)
  const models = value.value.data.map((item): WorkflowModelCatalog.ModelEntry => {
    const isKimi = "context_length" in item
    const capabilities = isKimi
      ? item.supports_image_in
        ? ["vision_input"]
        : []
      : "input_modalities" in item && item.input_modalities?.includes("image")
        ? ["vision_input"]
        : []
    const efforts = "effort" in item ? (item.effort?.supported_levels ?? []) : []
    if ("effort" in item && item.effort?.default_level && !efforts.includes(item.effort.default_level))
      throw error("invalid_metadata")
    return WorkflowModelSources.verify(
      {
        providerID,
        modelID: item.id,
        displayName: "name" in item ? (item.name ?? item.id) : item.id,
        family: "unknown",
        predecessor: null,
        advertisedRevision: null,
        contextWindow: isKimi ? item.context_length : "context_window" in item ? (item.context_window ?? null) : null,
        maxOutputTokens: "max_output_tokens" in item ? (item.max_output_tokens ?? null) : null,
        capabilities,
        effortLevels: efforts,
        protocol: null,
        adapterProfileID: null,
        adapterProfileSha256: null,
        priceSha256: null,
        evidence: [evidence],
        availability: "available",
        compatibility: "unverified",
        lifecycle: "current",
        missingObservation: null,
      },
      [evidence],
    )
  })
  return WorkflowModelCatalogPolicy.normalizeCatalogue(
    { schemaVersion: 1, scopeSha256, observedAt, models, sha256: "0".repeat(64) },
    scopeSha256,
  )
}
export class Service extends Context.Service<
  Service,
  {
    refresh: (
      providerID: WorkflowModelCatalog.ProviderID,
      scopeSha256: string,
    ) => Effect.Effect<WorkflowModelCatalog.Catalogue, WorkflowModelCatalog.CatalogError>
  }
>()("WorkflowModelDiscovery.Service") {}
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* WorkflowCredentialScope.Service
    const http = yield* HttpClient.HttpClient
    return Service.of({
      refresh: Effect.fn("WorkflowModelDiscovery.refresh")(function* (providerID, scopeSha256) {
        const identity = yield* scope.resolve(providerID)
        yield* Effect.try({
          try: () => WorkflowCredentialScope.validateOrigin(providerID, identity.origin),
          catch: () => error("scope_mismatch"),
        })
        const key = yield* scope.credential(providerID, identity)
        const body = yield* Effect.gen(function* () {
          const response = yield* http.execute(
            HttpClientRequest.get(WorkflowModelSources.contracts[providerID].endpoint).pipe(
              HttpClientRequest.setHeader("Authorization", `Bearer ${key}`),
            ),
          )
          if (response.status !== 200) return yield* Effect.fail(error("discovery_failed"))
          const length = response.headers["content-length"]
          if (length && (!/^\d+$/.test(length) || Number(length) > 2 * 1024 * 1024))
            return yield* Effect.fail(error("invalid_metadata"))
          return yield* Stream.runFoldEffect(
            response.stream,
            () => Buffer.alloc(0),
            (acc, chunk) =>
              acc.length + chunk.length > 2 * 1024 * 1024
                ? Effect.fail(error("invalid_metadata"))
                : Effect.succeed(Buffer.concat([acc, chunk])),
          )
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.catch((cause) =>
            Effect.fail(cause instanceof WorkflowModelCatalog.CatalogError ? cause : error("discovery_failed")),
          ),
        )
        const current = yield* scope.resolve(providerID)
        if (WorkflowCredentialScope.hash([identity]) !== WorkflowCredentialScope.hash([current]))
          return yield* Effect.fail(error("scope_mismatch"))
        const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body.toString("utf8"))
        if (json._tag === "None") return yield* Effect.fail(error("invalid_metadata"))
        const observedAt = yield* Clock.currentTimeMillis
        return yield* Effect.try({
          try: () => parse(providerID, json.value, observedAt, scopeSha256),
          catch: () => error("invalid_metadata"),
        })
      }),
    })
  }),
).pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }))),
  ),
)
