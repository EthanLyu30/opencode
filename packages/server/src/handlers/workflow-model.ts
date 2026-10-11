import { WorkflowModelCatalogService } from "@opencode-ai/core/workflow/model-catalog/service"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { InvalidRequestError, UnauthorizedError } from "@opencode-ai/protocol/errors"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ServerAuth } from "../auth"

export const controller = Effect.gen(function* () {
  const catalogue = yield* WorkflowModelCatalogService.Service
  const auth = yield* ServerAuth.Config
  const authorized = ServerAuth.required(auth)
    ? Effect.void
    : Effect.fail(new UnauthorizedError({ message: "Catalogue administration requires configured authentication" }))
  const run = <A>(effect: Effect.Effect<A, WorkflowModelCatalog.CatalogError>) =>
    authorized.pipe(
      Effect.andThen(effect),
      Effect.catchTag(
        "WorkflowModelCatalog.CatalogError",
        (error) => new InvalidRequestError({ message: error.message, kind: error.code }),
      ),
    )
  const validated = <A>(schema: Schema.Codec<A>, input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError(() => new WorkflowModelCatalog.CatalogError({ code: "invalid_metadata" })),
    )
  const output = (effect: Effect.Effect<WorkflowModelCatalog.View, WorkflowModelCatalog.CatalogError>) =>
    effect.pipe(Effect.flatMap((view) => validated(WorkflowModelCatalog.View, view)))
  return {
    list: () => run(output(catalogue.view())),
    refresh: (input: WorkflowModelCatalog.RefreshInput) =>
      run(
        validated(WorkflowModelCatalog.RefreshInput, input).pipe(
          Effect.flatMap((request) => output(catalogue.refresh(request.force))),
        ),
      ),
    activate: (input: WorkflowModelCatalog.ActivationInput) =>
      run(
        validated(WorkflowModelCatalog.ActivationInput, input).pipe(
          Effect.flatMap((request) => output(catalogue.activate(request))),
        ),
      ),
  }
})
export const WorkflowModelHandler = HttpApiBuilder.group(Api, "server.workflowModels", (handlers) =>
  Effect.gen(function* () {
    const catalogue = yield* controller
    return handlers
      .handle("workflowModels.list", () => catalogue.list().pipe(Effect.map((data) => ({ data }))))
      .handle("workflowModels.refresh", (ctx) => catalogue.refresh(ctx.payload).pipe(Effect.map((data) => ({ data }))))
      .handle("workflowModels.activate", (ctx) =>
        catalogue.activate(ctx.payload).pipe(Effect.map((data) => ({ data }))),
      )
  }),
)
