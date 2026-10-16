export * as CodingAdmission from "./admission"

import { Responses } from "@opencode-ai/schema/responses"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { AgentV2 } from "../../agent"
import { EventV2 } from "../../event"
import { makeGlobalNode } from "../../effect/app-node"
import { Location } from "../../location"
import { LocationServiceMap } from "../../location-service-map"
import { ProjectV2 } from "../../project"
import { ResponsesAdmission } from "../../responses/admission"
import { ResponsesProjector } from "../../responses/projector"
import { ResponsesStore } from "../../responses/store"
import { SessionAdmission } from "../../session/admission"
import { SessionProjector } from "../../session/projector"
import { SessionStore } from "../../session/store"
import { WorkflowAdmission } from "../admission"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowBenchmarkTransport } from "../benchmark-transport"
import { WorkflowExecution } from "../execution"
import { ModelSelection } from "../model-selection"
import { WorkflowProjector } from "../projector"
import { WorkflowSecretGuard } from "../secret-guard"
import { WorkflowStore } from "../store"
import { CodingAuthority } from "./authority"
import { CodingGraph } from "./graph"
import { CodingHostPlan } from "./host-plan"
import { CodingModelSelection } from "./model-selection"
import { CodingAdmissionReceipt } from "./admission-receipt"

export const KIND = CodingAdmissionReceipt.KIND
export const CLAIM_KEY = CodingAdmissionReceipt.CLAIM_KEY
// Share the existing explicit-key namespace so switching endpoint kinds cannot reuse a request identity.
const CLAIM_DOMAIN = "opencode.workflow.visual-build.admission-claim.v1"
type Receipt = CodingAdmissionReceipt.Receipt
const decodeReceipt = CodingAdmissionReceipt.decode
const identities = CodingAdmissionReceipt.identities
const workflowInput = CodingAdmissionReceipt.workflowInput
export class InvalidAdmission extends Schema.TaggedErrorClass<InvalidAdmission>()("CodingAdmission.Invalid", {
  code: Schema.Literal("coding_admission_invalid"),
  message: Schema.String,
}) {}
export type AdmissionError = InvalidAdmission | WorkflowAdmission.ConflictError
export interface Interface {
  readonly admit: (
    input: WorkflowCodingBuild.CreateInput,
    location: Location.Ref,
    key?: string,
  ) => Effect.Effect<WorkflowCodingBuild.Admission, AdmissionError>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/CodingAdmission") {}
const invalid = () =>
  new InvalidAdmission({
    code: "coding_admission_invalid",
    message: "Coding configuration, model selection or durable admission is invalid",
  })
const parse = <A>(f: () => A) => Effect.try({ try: f, catch: () => invalid() })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const workflows = yield* WorkflowStore.Service
    const responses = yield* ResponsesStore.Service
    const sessions = yield* SessionStore.Service
    const projects = yield* ProjectV2.Service
    const locations = yield* LocationServiceMap.Service
    const execution = yield* WorkflowExecution.Service
    const models = yield* ModelSelection.Service
    const benchmark = yield* WorkflowBenchmarkTransport.Service
    const existing = (receipt: Receipt) =>
      verify(receipt, workflows, responses, sessions).pipe(
        Effect.mapError(
          () => new WorkflowAdmission.ConflictError({ workflowID: receipt.workflowID, operation: "admitCodingBuild" }),
        ),
      )
    return Service.of({
      admit: Effect.fn("CodingAdmission.admit")(function* (input, locationInput, key) {
        const request = yield* parse(() => Schema.decodeUnknownSync(WorkflowCodingBuild.CreateInput)(input))
        const location = yield* parse(() => Schema.decodeUnknownSync(Location.Ref)(locationInput))
        yield* parse(() => WorkflowSecretGuard.assertSafe({ request, location }))
        const normalized = yield* parse(() => {
          if (key === undefined)
            return `derived:${WorkflowBusinessArtifact.hash({ schemaVersion: 1, type: "coding-build", request, location })}`
          if (!key || key.length > 256 || key.normalize("NFC") !== key || /[\u0000-\u001f\u007f]/.test(key))
            throw invalid()
          return key
        })
        const claim = `${CLAIM_DOMAIN}:${WorkflowBusinessArtifact.hash({ domain: CLAIM_DOMAIN, key: normalized })}`
        const ids = identities(claim)
        const conflict = () =>
          new WorkflowAdmission.ConflictError({ workflowID: ids.workflowID, operation: "admitCodingBuild" })
        const winner = yield* responses.request(claim)
        if (winner) {
          const items = yield* responses.items(winner.id, "context")
          const receipt = yield* Effect.try({
            try: () =>
              items.length === 1
                ? decodeReceipt(items[0]!.payload)
                : (() => {
                    throw invalid()
                  })(),
            catch: conflict,
          })
          if (
            !isDeepStrictEqual(receipt.request, request) ||
            !isDeepStrictEqual(receipt.location, location) ||
            !isDeepStrictEqual(receipt.benchmarkTransport, benchmark.binding)
          )
            return yield* conflict()
          yield* parse(() =>
            CodingHostPlan.verifyCurrentConfiguration(CodingHostPlan.decode(receipt.hostPlan, location)),
          )
          const admission = yield* existing(receipt)
          yield* execution.wake
          return admission
        }
        const snapshot = yield* models.snapshot().pipe(Effect.mapError(() => invalid()))
        if (!snapshot) return yield* invalid()
        const selection = yield* parse(() => CodingModelSelection.freeze(snapshot, location))
        const hostPlan = yield* parse(() =>
          CodingHostPlan.freeze({ authority: "admission", location, checks: request.checks }),
        )
        const transport = yield* parse(() =>
          benchmark.binding === undefined
            ? undefined
            : WorkflowBenchmarkTransport.decodeBinding(benchmark.binding, Date.now()),
        )
        const graph = CodingGraph.expand({
          maxRevisions: request.coding.maxRevisions,
          maxAttempts: 3,
          responseID: ids.responseID,
        }).map((stage) => ({
          ...stage,
          id: Workflow.StageID.make(
            `wfs_${WorkflowBusinessArtifact.hash({ claim, type: "coding-build", ordinal: stage.ordinal })}`,
          ),
        }))
        const project = yield* projects.resolve(location.directory)
        const selected = yield* Effect.gen(function* () {
          const agents = yield* AgentV2.Service
          return yield* agents.select()
        }).pipe(
          Effect.provide(locations.get(location)),
          Effect.mapError(() => invalid()),
        )
        const receipt = yield* parse(() =>
          decodeReceipt({
            type: KIND,
            receipt: {
              kind: KIND,
              requestHash: claim,
              request,
              location,
              selection,
              hostPlan,
              ...ids,
              agent: selected.id,
              graph,
              ...(transport === undefined ? {} : { benchmarkTransport: transport }),
            },
          }),
        )
        const timestamp = yield* DateTime.now
        const workflow = yield* parse(() =>
          WorkflowAdmission.prepare(
            {
              id: ids.workflowID,
              type: "coding-build",
              input: workflowInput(receipt),
              budget: request.budget,
              stages: receipt.graph,
            },
            {
              workflowID: ids.workflowID,
              timestamp,
              stages: graph as [(typeof graph)[number], ...(typeof graph)[number][]],
              admission: { location, sessionID: ids.sessionID, agent: selected.id },
              codingAdmission: { selection, hostPlan },
            },
          ),
        )
        const session = SessionAdmission.prepare({
          id: ids.sessionID,
          location,
          agent: selected.id,
          project,
          visibility: "workflow",
          timestamp: DateTime.toEpochMillis(timestamp),
        })
        const response = ResponsesAdmission.prepare(
          {
            id: ids.responseID,
            workflowID: ids.workflowID,
            model: selection.routes.deliver.modelID,
            background: request.delivery === "background",
            store: true,
            requestHash: claim,
            input: [{ type: "message", role: "user", content: request.prompt }],
          },
          {
            responseID: ids.responseID,
            timestamp,
            context: [Schema.decodeUnknownSync(Responses.ItemPayload)({ type: KIND, receipt })],
          },
        )
        if (yield* responses.request(claim)) return yield* existing(receipt)
        if ((yield* workflows.get(ids.workflowID)) || (yield* sessions.getWorkflow(ids.sessionID)))
          return yield* conflict()
        yield* events
          .publish(workflow.entry.definition, workflow.entry.data, {
            location,
            related: [session.entry, response.entry, ...workflow.queued],
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (!(yield* responses.request(claim))) return yield* Effect.failCause(cause)
                yield* existing(receipt)
              }),
            ),
          )
        const admitted = yield* existing(receipt)
        yield* execution.wake
        return admitted
      }),
    })
  }),
)

const authorityLayer = Layer.effect(
  CodingAuthority.Service,
  Effect.gen(function* () {
    const workflows = yield* WorkflowStore.Service
    const responses = yield* ResponsesStore.Service
    const sessions = yield* SessionStore.Service
    return CodingAuthority.Service.of({
      require: Effect.fn("CodingAdmission.require")(function* (workflow) {
        const claim = workflow.input[CLAIM_KEY]
        if (workflow.type !== "coding-build" || typeof claim !== "string")
          return yield* new CodingAuthority.Invalid({ message: "Trusted coding admission is missing" })
        const response = yield* responses.request(claim)
        const items = response ? yield* responses.items(response.id, "context") : []
        const receipt = yield* Effect.try({
          try: () =>
            items.length === 1
              ? decodeReceipt(items[0]!.payload)
              : (() => {
                  throw invalid()
                })(),
          catch: () => new CodingAuthority.Invalid({ message: "Trusted coding receipt is invalid" }),
        })
        const admitted = yield* verify(receipt, workflows, responses, sessions).pipe(
          Effect.mapError(() => new CodingAuthority.Invalid({ message: "Trusted coding resources do not match" })),
        )
        if (
          workflow.id !== admitted.workflow.id ||
          workflow.type !== admitted.workflow.type ||
          !isDeepStrictEqual(workflow.input, admitted.workflow.input) ||
          !isDeepStrictEqual(workflow.location, admitted.workflow.location) ||
          workflow.sessionID !== admitted.workflow.sessionID ||
          workflow.agent !== admitted.workflow.agent
        )
          return yield* new CodingAuthority.Invalid({ message: "Coding authority differs from durable admission" })
      }),
    })
  }),
)

const verify = Effect.fn("CodingAdmission.verify")(function* (
  receipt: Receipt,
  workflows: WorkflowStore.Interface,
  responses: ResponsesStore.Interface,
  sessions: SessionStore.Interface,
) {
  const detail = yield* workflows.get(receipt.workflowID)
  const response = yield* responses.request(receipt.requestHash)
  const session = yield* sessions.getWorkflow(receipt.sessionID)
  const contexts = response ? yield* responses.items(response.id, "context") : []
  if (
    !detail ||
    !response ||
    !session ||
    contexts.length !== 1 ||
    !isDeepStrictEqual(decodeReceipt(contexts[0]!.payload), receipt) ||
    detail.run.type !== "coding-build" ||
    !isDeepStrictEqual(detail.run.input, workflowInput(receipt)) ||
    !isDeepStrictEqual(detail.run.location, receipt.location) ||
    detail.run.sessionID !== receipt.sessionID ||
    detail.run.agent !== receipt.agent ||
    session.visibility !== "workflow" ||
    session.agent !== receipt.agent ||
    session.location.directory !== receipt.location.directory ||
    session.location.workspaceID !== receipt.location.workspaceID ||
    response.id !== receipt.responseID ||
    response.workflowID !== receipt.workflowID ||
    !response.store ||
    response.deletedAt !== undefined ||
    response.model !== receipt.selection.routes.deliver.modelID ||
    response.background !== (receipt.request.delivery === "background") ||
    response.previousResponseID !== undefined ||
    response.conversationID !== undefined ||
    detail.stages.length !== receipt.graph.length ||
    receipt.graph.some((stage, index) => {
      const current = detail.stages[index]
      return (
        !current ||
        current.id !== stage.id ||
        current.workflowID !== receipt.workflowID ||
        current.type !== stage.type ||
        current.ordinal !== stage.ordinal ||
        current.maxAttempts !== stage.maxAttempts ||
        current.recoveryPolicy !== stage.recoveryPolicy ||
        current.idempotencyKey !== stage.idempotencyKey ||
        !isDeepStrictEqual(current.input, stage.input)
      )
    })
  )
    return yield* invalid()
  return { workflow: detail.run, response }
})

export const authorityNode = makeGlobalNode({
  service: CodingAuthority.Service,
  layer: authorityLayer,
  deps: [WorkflowStore.node, ResponsesStore.node, SessionStore.node],
})
export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    WorkflowProjector.node,
    SessionProjector.node,
    ResponsesProjector.node,
    WorkflowStore.node,
    SessionStore.node,
    ResponsesStore.node,
    ProjectV2.node,
    LocationServiceMap.node,
    WorkflowExecution.node,
    ModelSelection.node,
    WorkflowBenchmarkTransport.node,
  ],
})
