export * as ResponsesAdmission from "./admission"

import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Responses } from "@opencode-ai/schema/responses"
import { Session } from "@opencode-ai/schema/session"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { WorkflowVisualBuild } from "@opencode-ai/schema/workflow-visual-build"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/schema/schema"
import { DateTime, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { WorkflowBusinessArtifact } from "../workflow/artifacts/business"
import { WorkflowGraph } from "../workflow/graph"
import { PreviewPlan } from "../workflow/preview-plan"
import { WorkflowProductionHostPlan } from "../workflow/production-host-plan"
import { WorkflowRouting } from "../workflow/routing"

export const VISUAL_BUILD_RECEIPT_TYPE = "workflow.visual-build.admission-receipt.v1"
export const MAX_VISUAL_BUILD_RECEIPT_BYTES = 256 * 1024
const exact = { parseOptions: { onExcessProperty: "error" as const } }

const ReceiptStage = Schema.Struct({
  id: Workflow.StageID,
  type: WorkflowRole.Role,
  ordinal: NonNegativeInt,
  maxAttempts: PositiveInt,
  recoveryPolicy: Workflow.RecoveryPolicy,
  idempotencyKey: Schema.NonEmptyString,
  input: Schema.Record(Schema.String, Schema.Json),
}).annotate({ identifier: "ResponsesAdmission.ReceiptStage", ...exact })

const ReceiptRoute = Schema.Struct({
  providerID: Schema.Literals(["kimi", "deepseek"]),
  modelID: Schema.Literals(["kimi-k3", "deepseek-v4-flash", "deepseek-v4-pro"]),
  protocol: WorkflowRole.Protocol,
  reasoningEffort: WorkflowRole.ReasoningEffort,
  requiredCapabilities: Schema.Array(Schema.NonEmptyString),
}).annotate({ identifier: "ResponsesAdmission.ReceiptRoute", ...exact })

const RouteMatrix = Schema.Struct({
  design: ReceiptRoute,
  decompose: ReceiptRoute,
  implement: ReceiptRoute,
  repair: ReceiptRoute,
  test: ReceiptRoute,
  visual_review: ReceiptRoute,
  deliver: ReceiptRoute,
}).annotate({ identifier: "ResponsesAdmission.RouteMatrix", ...exact })

export const VisualBuildGraph = Schema.NonEmptyArray(ReceiptStage).annotate({
  identifier: "ResponsesAdmission.VisualBuildGraph",
})

export const VisualBuildReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal(VISUAL_BUILD_RECEIPT_TYPE),
  requestHash: Schema.NonEmptyString,
  request: WorkflowVisualBuild.CreateInput,
  location: Location.Ref,
  previewPlanSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  productionHostPlanSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  ids: Schema.Struct({
    workflowID: Workflow.ID,
    sessionID: Session.ID,
    responseID: Responses.ID,
    stageIDs: Schema.NonEmptyArray(Workflow.StageID),
  }).annotate({ identifier: "ResponsesAdmission.ReceiptIDs", ...exact }),
  profile: Schema.Struct({
    agent: Agent.ID,
    sessionVisibility: Schema.Literal("workflow"),
  }).annotate({ identifier: "ResponsesAdmission.ReceiptProfile", ...exact }),
  response: Schema.Struct({
    model: Schema.Literal("deepseek-v4-pro"),
    store: Schema.Literal(true),
    background: Schema.Boolean,
    delivery: Schema.Literals(["foreground", "background"]),
  }).annotate({ identifier: "ResponsesAdmission.ReceiptResponse", ...exact }),
  graph: VisualBuildGraph,
  routeMatrix: RouteMatrix,
}).annotate({ identifier: "ResponsesAdmission.VisualBuildReceipt", ...exact })
export interface VisualBuildReceipt extends Schema.Schema.Type<typeof VisualBuildReceipt> {}

export const VisualBuildReceiptPayload = Schema.Struct({
  type: Schema.Literal(VISUAL_BUILD_RECEIPT_TYPE),
  receipt: VisualBuildReceipt,
}).annotate({ identifier: "ResponsesAdmission.VisualBuildReceiptPayload", ...exact })
export interface VisualBuildReceiptPayload extends Schema.Schema.Type<typeof VisualBuildReceiptPayload> {}

export class InvalidCreate extends Error {}

export function receiptPayload(receipt: VisualBuildReceipt): VisualBuildReceiptPayload {
  const validated = validateVisualBuildReceipt(Schema.decodeUnknownSync(VisualBuildReceipt)(receipt))
  return bounded(
    Schema.decodeUnknownSync(VisualBuildReceiptPayload)({
      type: VISUAL_BUILD_RECEIPT_TYPE,
      receipt: validated,
    }),
  )
}

export function decodeVisualBuildReceipt(input: unknown): VisualBuildReceipt {
  return validateVisualBuildReceipt(bounded(Schema.decodeUnknownSync(VisualBuildReceiptPayload)(input)).receipt)
}

export function tryDecodeVisualBuildReceipt(input: unknown): VisualBuildReceipt | undefined {
  try {
    return decodeVisualBuildReceipt(input)
  } catch {
    return undefined
  }
}

export function prepare(input: Responses.CreateInput, options: {
  readonly responseID: Responses.ID
  readonly timestamp: DateTime.Utc
  readonly context: ReadonlyArray<Responses.ItemPayload>
}) {
  if ((input.previousResponseID && input.conversationID) || (!input.store && (input.conversationID || input.background))) {
    throw new InvalidCreate("Invalid Response persistence relationship")
  }
  const resource = Responses.Resource.make({
    id: options.responseID,
    workflowID: input.workflowID,
    model: input.model,
    status: "queued",
    background: input.background,
    store: input.store,
    previousResponseID: input.previousResponseID,
    conversationID: input.conversationID,
    requestHash: input.requestHash,
    output: [],
    createdAt: options.timestamp,
  })
  const persistedInput = input.store
    ? ([input.input[0], ...input.input.slice(1)] as const)
    : ([{ type: "redacted" }] as const)
  return Object.freeze({
    resource,
    entry: Object.freeze({
      definition: ResponseEvent.Created,
      data: Object.freeze({
        responseID: options.responseID,
        workflowID: input.workflowID,
        timestamp: options.timestamp,
        model: input.model,
        background: input.background,
        store: input.store,
        previousResponseID: input.previousResponseID,
        conversationID: input.conversationID,
        requestHash: input.requestHash,
        context: [...options.context],
        input: persistedInput,
      }),
    }),
  })
}

export function prepareVisualBuild(input: Responses.CreateInput, options: {
  readonly responseID: Responses.ID
  readonly timestamp: DateTime.Utc
  readonly receipt: VisualBuildReceipt
}) {
  const receipt = validateVisualBuildReceipt(Schema.decodeUnknownSync(VisualBuildReceipt)(options.receipt))
  if (
    !input.store ||
    input.previousResponseID !== undefined ||
    input.conversationID !== undefined ||
    input.workflowID !== receipt.ids.workflowID ||
    options.responseID !== receipt.ids.responseID ||
    input.requestHash !== receipt.requestHash ||
    input.model !== receipt.response.model ||
    input.background !== receipt.response.background ||
    receipt.response.store !== true ||
    receipt.response.background !== (receipt.response.delivery === "background")
  ) {
    throw new InvalidCreate("Visual builds require one stored, same-workflow Response")
  }
  return prepare(input, {
    responseID: options.responseID,
    timestamp: options.timestamp,
    context: [receiptPayload(receipt)],
  })
}

function validateVisualBuildReceipt(receipt: VisualBuildReceipt): VisualBuildReceipt {
  const expectedGraph = WorkflowGraph.expandVisualBuild({
    maxRevisions: receipt.request.visual.maxRevisions,
    maxAttempts: receipt.request.budget.maxAttempts ?? 1,
    responseID: receipt.ids.responseID,
  }).map((stage, index) => ({ ...stage, id: receipt.ids.stageIDs[index] }))
  const expectedRouteMatrix = Object.fromEntries(
    WorkflowRole.Role.literals.map((role) => {
      const route = WorkflowRouting.resolve({ role, budget: receipt.request.budget })
      return [
        role,
        {
          providerID: route.providerID,
          modelID: route.modelID,
          protocol: route.protocol,
          reasoningEffort: route.reasoningEffort,
          requiredCapabilities: [...route.requiredCapabilities],
        },
      ]
    }),
  )
  const preview = PreviewPlan.freeze({
    authority: "admission",
    location: receipt.location,
    preview: receipt.request.preview,
  })
  const productionHostPlan = WorkflowProductionHostPlan.freeze({
    authority: "admission",
    location: receipt.location,
    preview,
  })
  if (
    receipt.response.delivery !== receipt.request.delivery ||
    receipt.response.background !== (receipt.request.delivery === "background") ||
    !isDeepStrictEqual(receipt.graph, expectedGraph) ||
    !isDeepStrictEqual(receipt.routeMatrix, expectedRouteMatrix) ||
    receipt.previewPlanSha256 !== preview.configSha256 ||
    receipt.productionHostPlanSha256 !== WorkflowBusinessArtifact.hash(productionHostPlan)
  ) {
    throw new InvalidCreate("Visual-build admission receipt is internally inconsistent")
  }
  return receipt
}

function bounded<A extends VisualBuildReceiptPayload>(value: A): A {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_VISUAL_BUILD_RECEIPT_BYTES) {
    throw new InvalidCreate("Visual-build admission receipt exceeds its durable bound")
  }
  return value
}
