export * as WorkflowAdmission from "./admission"

import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { WorkflowVisualBuild } from "@opencode-ai/schema/workflow-visual-build"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { AgentV2 } from "../agent"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { Location } from "../location"
import { LocationServiceMap } from "../location-service-map"
import { ProjectV2 } from "../project"
import { ResponsesAdmission } from "../responses/admission"
import { ResponsesProjector } from "../responses/projector"
import { ResponsesStore } from "../responses/store"
import { SessionAdmission } from "../session/admission"
import { SessionProjector } from "../session/projector"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { WorkflowBusinessArtifact } from "./artifacts/business"
import { WorkflowExecution } from "./execution"
import { WorkflowGraph } from "./graph"
import { PreviewPlan } from "./preview-plan"
import { WorkflowProductionHostPlan } from "./production-host-plan"
import { WorkflowProjector } from "./projector"
import { WorkflowRouting } from "./routing"
import { WorkflowSecretGuard } from "./secret-guard"
import { WorkflowStore } from "./store"

const CLAIM_DOMAIN = "opencode.workflow.visual-build.admission-claim.v1"
const ID_DOMAIN = "opencode.workflow.visual-build.deterministic-id.v1"
const WORKFLOW_TYPE = "visual-build"
const RESPONSE_MODEL = "deepseek-v4-pro"

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("Workflow.ConflictError", {
  workflowID: Workflow.ID,
  operation: Schema.String,
}) {}

export class InvalidIdempotencyKey extends Schema.TaggedErrorClass<InvalidIdempotencyKey>()(
  "WorkflowAdmission.InvalidIdempotencyKey",
  { message: Schema.String },
) {}

export class InvalidAdmission extends Schema.TaggedErrorClass<InvalidAdmission>()(
  "WorkflowAdmission.InvalidAdmission",
  {
    reason: Schema.Literal("receipt_too_large"),
    message: Schema.String.check(Schema.isMaxLength(128)),
  },
) {}

export interface Admission {
  readonly workflow: Workflow.Info
  readonly response: Responses.Resource
}

export interface Interface {
  readonly admitVisualBuild: (
    input: WorkflowVisualBuild.CreateInput,
    location: Location.Ref,
    idempotencyKey?: string,
  ) => Effect.Effect<
    Admission,
    | ConflictError
    | InvalidAdmission
    | InvalidIdempotencyKey
    | WorkflowSecretGuard.UnsafePersistenceError
    | AgentV2.ReservedSelectionError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkflowAdmission") {}

type AdmittedStage = Omit<Workflow.StageInput, "id"> & { readonly id: Workflow.StageID }

export function prepare(
  input: Workflow.CreateInput,
  options: {
    readonly workflowID: Workflow.ID
    readonly stages: readonly [AdmittedStage, ...AdmittedStage[]]
    readonly timestamp: DateTime.Utc
    readonly admission?: Pick<Workflow.AdmissionInput, "location" | "sessionID" | "agent">
  },
) {
  const ordinals = new Set<number>()
  const keys = new Set<string>()
  for (const stage of options.stages) {
    if (ordinals.has(stage.ordinal) || keys.has(stage.idempotencyKey)) {
      throw new ConflictError({ workflowID: options.workflowID, operation: "create" })
    }
    ordinals.add(stage.ordinal)
    keys.add(stage.idempotencyKey)
  }
  const info = Workflow.Info.make({
    id: options.workflowID,
    type: input.type,
    status: "queued",
    input: input.input,
    budget: input.budget,
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
    location: options.admission?.location,
    sessionID: options.admission?.sessionID,
    agent: options.admission?.agent,
    version: 0,
    time: { created: options.timestamp, updated: options.timestamp },
  })
  const stages = options.stages.map((stage) =>
    Workflow.Stage.make({
      ...stage,
      workflowID: options.workflowID,
      status: "pending",
      attempt: 0,
      time: { created: options.timestamp, updated: options.timestamp },
    }),
  )
  const entry = Object.freeze({
    definition: WorkflowEvent.Created,
    data: Object.freeze({
      workflowID: options.workflowID,
      timestamp: options.timestamp,
      type: input.type,
      input: input.input,
      budget: input.budget,
      stages: options.stages,
      location: options.admission?.location,
      sessionID: options.admission?.sessionID,
      agent: options.admission?.agent,
    }),
  })
  const queued = Object.freeze(
    options.stages.map((stage) =>
      Object.freeze({
        definition: WorkflowEvent.Stage.Queued,
        data: Object.freeze({ workflowID: options.workflowID, stageID: stage.id, timestamp: options.timestamp }),
      }),
    ),
  )
  return Object.freeze({ info, stages: Object.freeze(stages), entry, queued })
}

export function matchesCreateInput(existing: Workflow.Detail, input: Workflow.CreateInput) {
  if (existing.run.type !== input.type) return false
  if (!isDeepStrictEqual(existing.run.input, input.input)) return false
  if (!isDeepStrictEqual(existing.run.budget, input.budget)) return false
  if (existing.stages.length !== input.stages.length) return false
  return input.stages
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .every((stage, index) => {
      const projected = existing.stages[index]
      return (
        projected !== undefined &&
        (stage.id === undefined || stage.id === projected.id) &&
        stage.type === projected.type &&
        stage.ordinal === projected.ordinal &&
        stage.maxAttempts === projected.maxAttempts &&
        stage.recoveryPolicy === projected.recoveryPolicy &&
        stage.idempotencyKey === projected.idempotencyKey &&
        isDeepStrictEqual(stage.input, projected.input)
      )
    })
}

export function matchesAdmissionInput(existing: Workflow.Detail, input: Workflow.AdmissionInput) {
  return (
    matchesCreateInput(existing, input) &&
    existing.run.location?.directory === input.location.directory &&
    existing.run.location.workspaceID === input.location.workspaceID &&
    existing.run.sessionID === input.sessionID &&
    existing.run.agent === input.agent
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const workflows = yield* WorkflowStore.Service
    const responses = yield* ResponsesStore.Service
    const sessions = yield* SessionStore.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* WorkflowExecution.Service
    const locations = yield* LocationServiceMap.Service

    const reconcile = Effect.fn("WorkflowAdmission.reconcile")(function* (expected: PreparedVisualBuild) {
      const winner = yield* responses.request(expected.response.resource.requestHash)
      if (!winner || winner.deletedAt) {
        return yield* new ConflictError({ workflowID: expected.workflow.info.id, operation: "admitVisualBuild" })
      }
      const receiptItems = yield* responses.items(winner.id, "context")
      const detail = yield* workflows.get(expected.workflow.info.id)
      const session = yield* sessions.getWorkflow(expected.session.info.id)
      let receipt: ResponsesAdmission.VisualBuildReceipt | undefined
      try {
        receipt =
          receiptItems.length === 1 ? ResponsesAdmission.decodeVisualBuildReceipt(receiptItems[0].payload) : undefined
      } catch {
        receipt = undefined
      }
      const immutableResponse =
        winner.id === expected.response.resource.id &&
        winner.workflowID === expected.response.resource.workflowID &&
        winner.model === expected.response.resource.model &&
        winner.background === expected.response.resource.background &&
        winner.store &&
        winner.previousResponseID === undefined &&
        winner.conversationID === undefined &&
        winner.requestHash === expected.response.resource.requestHash
      const immutableSession =
        session !== undefined &&
        session.id === expected.session.info.id &&
        session.visibility === "workflow" &&
        session.projectID === expected.session.info.projectID &&
        session.agent === expected.session.info.agent &&
        session.location.directory === expected.session.info.location.directory &&
        session.location.workspaceID === expected.session.info.location.workspaceID
      const immutableWorkflow =
        detail !== undefined &&
        detail.run.type === expected.workflow.info.type &&
        isDeepStrictEqual(detail.run.input, expected.workflow.info.input) &&
        isDeepStrictEqual(detail.run.budget, expected.workflow.info.budget) &&
        isDeepStrictEqual(detail.run.location, expected.workflow.info.location) &&
        detail.run.sessionID === expected.workflow.info.sessionID &&
        detail.run.agent === expected.workflow.info.agent &&
        detail.stages.length === expected.workflow.stages.length &&
        expected.workflow.stages.every((stage, index) => {
          const current = detail.stages[index]
          return (
            current !== undefined &&
            current.id === stage.id &&
            current.workflowID === stage.workflowID &&
            current.type === stage.type &&
            current.ordinal === stage.ordinal &&
            current.maxAttempts === stage.maxAttempts &&
            current.recoveryPolicy === stage.recoveryPolicy &&
            current.idempotencyKey === stage.idempotencyKey &&
            isDeepStrictEqual(current.input, stage.input)
          )
        })
      if (
        !immutableResponse ||
        !immutableSession ||
        !immutableWorkflow ||
        receipt === undefined ||
        !isDeepStrictEqual(receipt, expected.receipt)
      ) {
        return yield* new ConflictError({ workflowID: expected.workflow.info.id, operation: "admitVisualBuild" })
      }
      return { workflow: detail.run, response: winner }
    })

    return Service.of({
      admitVisualBuild: Effect.fn("WorkflowAdmission.admitVisualBuild")(function* (input, locationInput, keyInput) {
        const request = yield* Schema.decodeUnknownEffect(WorkflowVisualBuild.CreateInput)(input).pipe(Effect.orDie)
        const location = yield* Schema.decodeUnknownEffect(Location.Ref)(locationInput).pipe(Effect.orDie)
        yield* guardSafe(request)
        const key = yield* Effect.try({
          try: () => normalizeKey(keyInput, request, location),
          catch: (error) =>
            error instanceof InvalidIdempotencyKey
              ? error
              : new InvalidIdempotencyKey({ message: "Idempotency key could not be normalized" }),
        })
        const claim = `${CLAIM_DOMAIN}:${WorkflowBusinessArtifact.hash({ domain: CLAIM_DOMAIN, key })}`
        const ids = deterministicIDs(claim, request.visual.maxRevisions)
        const preview = PreviewPlan.freeze({ authority: "admission", location, preview: request.preview })
        const productionHostPlan = WorkflowProductionHostPlan.freeze({ authority: "admission", location, preview })
        const project = yield* projects.resolve(location.directory)
        const selected = yield* Effect.gen(function* () {
          const agents = yield* AgentV2.Service
          return yield* agents.select()
        }).pipe(Effect.provide(locations.get(location)))
        const timestamp = yield* DateTime.now
        const routeMatrix = buildRouteMatrix(request.budget)
        const graph = Schema.decodeUnknownSync(ResponsesAdmission.VisualBuildGraph)(
          WorkflowGraph.expandVisualBuild({
            maxRevisions: request.visual.maxRevisions,
            maxAttempts: request.budget.maxAttempts ?? 1,
            responseID: ids.responseID,
          }).map((stage, index) => ({ ...stage, id: ids.stageIDs[index] })),
        )
        const workflowInput = WorkflowProductionHostPlan.withPlan(
          {
            schemaVersion: 1,
            prompt: request.prompt,
            visual: request.visual,
            ...(request.preview === undefined ? {} : { preview: request.preview }),
            delivery: request.delivery,
          },
          productionHostPlan,
        )
        const workflowCreate: Workflow.CreateInput = {
          id: ids.workflowID,
          type: WORKFLOW_TYPE,
          input: workflowInput,
          budget: request.budget,
          stages: graph,
        }
        const workflow = prepare(workflowCreate, {
          workflowID: ids.workflowID,
          stages: graph,
          timestamp,
          admission: { location, sessionID: ids.sessionID, agent: selected.id },
        })
        const session = SessionAdmission.prepare({
          id: ids.sessionID,
          agent: selected.id,
          location,
          project,
          visibility: "workflow",
          timestamp: DateTime.toEpochMillis(timestamp),
        })
        const receipt = ResponsesAdmission.VisualBuildReceipt.make({
          schemaVersion: 1,
          kind: ResponsesAdmission.VISUAL_BUILD_RECEIPT_TYPE,
          requestHash: claim,
          request,
          location,
          previewPlanSha256: preview.configSha256,
          productionHostPlanSha256: WorkflowBusinessArtifact.hash(productionHostPlan),
          ids: {
            workflowID: ids.workflowID,
            sessionID: ids.sessionID,
            responseID: ids.responseID,
            stageIDs: ids.stageIDs,
          },
          profile: { agent: selected.id, sessionVisibility: "workflow" },
          response: {
            model: RESPONSE_MODEL,
            store: true,
            background: request.delivery === "background",
            delivery: request.delivery,
          },
          graph,
          routeMatrix,
        })
        const responseInput: Responses.CreateInput = {
          id: ids.responseID,
          workflowID: ids.workflowID,
          model: RESPONSE_MODEL,
          background: request.delivery === "background",
          store: true,
          requestHash: claim,
          input: [{ type: "message", role: "user", content: request.prompt }],
        }
        const response = yield* Effect.try({
          try: () =>
            ResponsesAdmission.prepareVisualBuild(responseInput, {
              responseID: ids.responseID,
              timestamp,
              receipt,
            }),
          catch: (error) => {
            if (!(error instanceof ResponsesAdmission.InvalidCreate) || error.reason !== "receipt_too_large")
              throw error
            return new InvalidAdmission({
              reason: "receipt_too_large",
              message: "Visual-build admission exceeds the durable receipt bound",
            })
          },
        })
        const expected: PreparedVisualBuild = { workflow, session, response, receipt }
        if (yield* responses.request(claim)) return yield* reconcile(expected)
        if ((yield* workflows.get(ids.workflowID)) || (yield* sessions.get(ids.sessionID))) {
          return yield* new ConflictError({ workflowID: ids.workflowID, operation: "admitVisualBuild" })
        }

        const published = yield* events
          .publish(workflow.entry.definition, workflow.entry.data, {
            location,
            related: [session.entry, response.entry, ...workflow.queued],
          })
          .pipe(
            Effect.as({ created: true as const }),
            Effect.catchCause((cause) =>
              responses
                .request(claim)
                .pipe(
                  Effect.flatMap((winner) =>
                    winner
                      ? reconcile(expected).pipe(Effect.map((admission) => ({ created: false as const, admission })))
                      : Effect.failCause(cause),
                  ),
                ),
            ),
          )
        if (!published.created) return published.admission
        yield* execution.wake
        return yield* reconcile(expected)
      }),
    })
  }),
)

type PreparedVisualBuild = {
  readonly workflow: ReturnType<typeof prepare>
  readonly session: ReturnType<typeof SessionAdmission.prepare>
  readonly response: ReturnType<typeof ResponsesAdmission.prepareVisualBuild>
  readonly receipt: ResponsesAdmission.VisualBuildReceipt
}

function normalizeKey(
  input: string | undefined,
  request: WorkflowVisualBuild.CreateInput,
  location: Location.Ref,
): string {
  if (input === undefined) {
    return `derived:${WorkflowBusinessArtifact.hash({ schemaVersion: 1, request, location })}`
  }
  if (
    input.length < 1 ||
    input.length > 256 ||
    input.normalize("NFC") !== input ||
    /[\u0000-\u001f\u007f]/.test(input)
  ) {
    throw new InvalidIdempotencyKey({ message: "Idempotency key is not normalized" })
  }
  return input
}

function guardSafe(value: unknown) {
  return Effect.try({
    try: () => WorkflowSecretGuard.assertSafe(value),
    catch: (error) =>
      error instanceof WorkflowSecretGuard.UnsafePersistenceError
        ? error
        : new WorkflowSecretGuard.UnsafePersistenceError({
            path: "$",
            message: "Persistence value could not be inspected safely",
          }),
  })
}

function deterministicIDs(claim: string, maxRevisions: number) {
  const stageCount = 6 + maxRevisions * 3
  const digest = (kind: string, ordinal?: number) =>
    WorkflowBusinessArtifact.hash({ domain: ID_DOMAIN, claim, kind, ...(ordinal === undefined ? {} : { ordinal }) })
  const firstStageID = Workflow.StageID.make(`wfs_${digest("stage", 0)}`)
  const remainingStageIDs = Array.from({ length: stageCount - 1 }, (_, index) =>
    Workflow.StageID.make(`wfs_${digest("stage", index + 1)}`),
  )
  return Object.freeze({
    workflowID: Workflow.ID.make(`wfl_${digest("workflow")}`),
    sessionID: SessionSchema.ID.make(`ses_${digest("session")}`),
    responseID: Responses.ID.make(`resp_${digest("response")}`),
    stageIDs: Object.freeze([firstStageID, ...remainingStageIDs] as const),
  })
}

function buildRouteMatrix(budget: Workflow.Budget): ResponsesAdmission.VisualBuildReceipt["routeMatrix"] {
  const route = (role: WorkflowRole.Role) => {
    const resolved = WorkflowRouting.resolve({ role, budget })
    return {
      providerID: resolved.providerID,
      modelID: resolved.modelID,
      protocol: resolved.protocol,
      reasoningEffort: resolved.reasoningEffort,
      requiredCapabilities: [...resolved.requiredCapabilities],
    }
  }
  return {
    design: route("design"),
    decompose: route("decompose"),
    implement: route("implement"),
    repair: route("repair"),
    test: route("test"),
    visual_review: route("visual_review"),
    deliver: route("deliver"),
  }
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    SessionProjector.node,
    ResponsesProjector.node,
    WorkflowProjector.node,
    SessionStore.node,
    ResponsesStore.node,
    WorkflowStore.node,
    ProjectV2.node,
    LocationServiceMap.node,
    WorkflowExecution.node,
  ],
})
