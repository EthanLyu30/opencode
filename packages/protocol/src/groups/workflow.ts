import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  InvalidRequestError,
  WorkflowConflictError,
  WorkflowNotFoundError,
  WorkflowStageNotFoundError,
} from "../errors"

const WorkflowHistoryLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100))
const WorkflowListLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100))

export const WorkflowHistoryQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(WorkflowHistoryLimit), Schema.optional),
  after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
})

const WorkflowListQuery = Schema.Struct({
  status: Workflow.RunStatus.pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(WorkflowListLimit), Schema.optional),
})

export const WorkflowGroup = HttpApiGroup.make("server.workflow")
  .add(
    HttpApiEndpoint.post("workflow.create", "/api/workflow", {
      payload: Workflow.CreateInput,
      success: Schema.Struct({ data: Workflow.Info }),
      error: [InvalidRequestError, WorkflowConflictError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.create",
        summary: "Create workflow",
        description: "Durably create one workflow and its ordered stage definitions.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workflow.list", "/api/workflow", {
      query: WorkflowListQuery,
      success: Schema.Struct({ data: Schema.Array(Workflow.Info) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.list",
        summary: "List workflows",
        description: "List durable workflows in descending creation order.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workflow.get", "/api/workflow/:workflowID", {
      params: { workflowID: Workflow.ID },
      success: Schema.Struct({ data: Workflow.Detail }),
      error: WorkflowNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.workflow.get", summary: "Get workflow" })),
  )
  .add(
    HttpApiEndpoint.get("workflow.history", "/api/workflow/:workflowID/history", {
      params: { workflowID: Workflow.ID },
      query: WorkflowHistoryQuery,
      success: Schema.Struct({
        data: Schema.Array(WorkflowEvent.Durable),
        hasMore: Schema.Boolean,
      }).annotate({ identifier: "WorkflowHistory" }),
      error: WorkflowNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.history",
        summary: "Get workflow history",
        description: "Read durable workflow events after an exclusive aggregate sequence.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workflow.events", "/api/workflow/:workflowID/event", {
      params: { workflowID: Workflow.ID },
      query: { after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional) },
      success: HttpApiSchema.StreamSse({ data: WorkflowEvent.Durable }),
      error: WorkflowNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workflow.events",
        summary: "Subscribe to workflow events",
        description: "Replay durable workflow events after an aggregate sequence, then continue with new events.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workflow.artifacts", "/api/workflow/:workflowID/artifact", {
      params: { workflowID: Workflow.ID },
      success: Schema.Struct({ data: Schema.Array(Workflow.Artifact) }),
      error: WorkflowNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.workflow.artifacts", summary: "List workflow artifacts" })),
  )
  .add(
    HttpApiEndpoint.post("workflow.cancel", "/api/workflow/:workflowID/cancel", {
      params: { workflowID: Workflow.ID },
      success: HttpApiSchema.NoContent,
      error: [WorkflowNotFoundError, WorkflowConflictError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.workflow.cancel", summary: "Cancel workflow" })),
  )
  .add(
    HttpApiEndpoint.post("workflow.updateBudget", "/api/workflow/:workflowID/budget", {
      params: { workflowID: Workflow.ID },
      payload: Schema.Struct({ budget: Workflow.Budget }),
      success: Schema.Struct({ data: Workflow.Info }),
      error: [WorkflowNotFoundError, WorkflowConflictError, InvalidRequestError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.workflow.updateBudget", summary: "Update workflow budget" })),
  )
  .add(
    HttpApiEndpoint.post("workflow.resolveRecovery", "/api/workflow/:workflowID/stage/:stageID/recovery", {
      params: { workflowID: Workflow.ID, stageID: Workflow.StageID },
      payload: Schema.Struct({ action: Workflow.RecoveryAction }),
      success: HttpApiSchema.NoContent,
      error: [WorkflowNotFoundError, WorkflowStageNotFoundError, WorkflowConflictError],
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.workflow.resolveRecovery", summary: "Resolve workflow recovery" }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "workflows", description: "Durable workflow routes." }))
