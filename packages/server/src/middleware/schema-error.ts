import { Effect } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"
import { HttpServerRequest } from "effect/unstable/http"
export { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"

const REASON_LIMIT = 1024

function truncateReason(reason: string) {
  if (reason.length <= REASON_LIMIT) return reason
  return reason.slice(0, REASON_LIMIT) + `... (${reason.length - REASON_LIMIT} more chars)`
}

export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrorMiddleware, (error) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const pathname = new URL(request.url, "http://localhost").pathname
    if (["/api/workflow-models", "/api/workflow-models/refresh", "/api/workflow-models/activate"].includes(pathname))
      return yield* new InvalidRequestError({ message: "Invalid workflow model request", kind: error.kind })
    const reason = truncateReason(error.cause.message)
    return yield* Effect.logWarning("schema rejection").pipe(
      Effect.annotateLogs({ kind: error.kind, reason }),
      Effect.andThen(Effect.fail(new InvalidRequestError({ message: reason, kind: error.kind }))),
    )
  }),
)
