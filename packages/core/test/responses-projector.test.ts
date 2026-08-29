import { describe, expect } from "bun:test"
import path from "node:path"
import { DateTime, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ResponsesProjector } from "@opencode-ai/core/responses/projector"
import { ResponsesAdmission } from "@opencode-ai/core/responses/admission"
import { ConversationItemTable, ResponseItemTable, ResponseTable } from "@opencode-ai/core/responses/sql"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { WorkflowRunTable, WorkflowStageTable } from "@opencode-ai/core/workflow/sql"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Responses } from "@opencode-ai/schema/responses"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { WorkflowVisualBuild } from "@opencode-ai/schema/workflow-visual-build"
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Session } from "@opencode-ai/schema/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkflowGraph } from "@opencode-ai/core/workflow/graph"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowProductionHostPlan } from "@opencode-ai/core/workflow/production-host-plan"
import { WorkflowBusinessArtifact } from "@opencode-ai/core/workflow/artifacts/business"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, WorkflowProjector.node, ResponsesProjector.node])),
)

const workflowID = Workflow.ID.make("wfl_responses_projector")
const stageID = Workflow.StageID.make("wfs_responses_projector")

function createWorkflow(events: EventV2.Interface) {
  return events.publish(WorkflowEvent.Created, {
    workflowID,
    timestamp: DateTime.makeUnsafe(1_000),
    type: "responses",
    input: {},
    budget: {},
    stages: [
      {
        id: stageID,
        type: "deliver",
        ordinal: 0,
        maxAttempts: 1,
        recoveryPolicy: "restart_safe",
        idempotencyKey: "responses/projector",
        input: { responseBinding: "workflow" },
      },
    ],
  })
}

function created(responseID: Responses.ID, overrides?: Partial<(typeof ResponseEvent.Created.Type)["data"]>) {
  const value: (typeof ResponseEvent.Created.Type)["data"] = {
    responseID,
    workflowID,
    timestamp: DateTime.makeUnsafe(2_000),
    model: "deepseek-v4-flash",
    background: false,
    store: true,
    requestHash: `hash:${responseID}`,
    context: [],
    input: [{ type: "message", role: "user", content: "hello" }],
    ...overrides,
  }
  return value
}

function visualReceipt(responseID: Responses.ID) {
  const request = WorkflowVisualBuild.CreateInput.make({
    prompt: "Build the receipt fixture",
    budget: { maxAttempts: 1 },
    visual: { maxRevisions: 0, maxTokens: 1_000, maxTurns: 10, maxToolCalls: 10 },
    preview: { kind: "static", entrypoint: "package.json" },
    delivery: "background",
  })
  const stageIDs = WorkflowGraph.expandVisualBuild({ maxRevisions: 0, maxAttempts: 1, responseID }).map(
    (_, ordinal) => Workflow.StageID.make(`wfs_receipt_${ordinal}`),
  ) as [Workflow.StageID, ...Workflow.StageID[]]
  const graph = ResponsesAdmission.VisualBuildGraph.make(
    WorkflowGraph.expandVisualBuild({ maxRevisions: 0, maxAttempts: 1, responseID }).map((stage, ordinal) => ({
      ...stage,
      id: stageIDs[ordinal]!,
    })) as [ResponsesAdmission.VisualBuildReceipt["graph"][number], ...ResponsesAdmission.VisualBuildReceipt["graph"]],
  )
  const routeMatrix = Object.fromEntries(
    WorkflowRole.Role.literals.map((role) => {
      const route = WorkflowRouting.resolve({ role, budget: request.budget })
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
  ) as unknown as ResponsesAdmission.VisualBuildReceipt["routeMatrix"]
  const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
  const preview = PreviewPlan.freeze({ authority: "admission", location, preview: request.preview })
  const productionHostPlan = WorkflowProductionHostPlan.freeze({ authority: "admission", location, preview })
  return ResponsesAdmission.VisualBuildReceipt.make({
    schemaVersion: 1,
    kind: ResponsesAdmission.VISUAL_BUILD_RECEIPT_TYPE,
    requestHash: `visual-claim:${responseID}`,
    request,
    location,
    previewPlanSha256: preview.configSha256,
    productionHostPlanSha256: WorkflowBusinessArtifact.hash(productionHostPlan),
    ids: {
      workflowID,
      sessionID: Session.ID.make("ses_response_receipt"),
      responseID,
      stageIDs,
    },
    profile: { agent: Agent.ID.make("build"), sessionVisibility: "workflow" },
    response: { model: "deepseek-v4-pro", store: true, background: true, delivery: "background" },
    graph,
    routeMatrix,
  })
}

describe("ResponsesProjector", () => {
  it.effect("rejects a visual-build receipt owned by another Response before projection", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_receipt_target")
      const otherID = Responses.ID.make("resp_receipt_other")
      const receipt = visualReceipt(otherID)
      yield* createWorkflow(events)

      const rejected = yield* events
        .publish(
          ResponseEvent.Created,
          created(responseID, {
            model: "deepseek-v4-pro",
            background: true,
            requestHash: receipt.requestHash,
            context: [ResponsesAdmission.receiptPayload(receipt)],
          }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(rejected)).toBe(true)
      expect(
        yield* database.db
          .select()
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(-1)
    }),
  )

  it.effect("rejects non-stored and cross-workflow visual Responses before event construction", () =>
    Effect.sync(() => {
      const responseID = Responses.ID.make("resp_receipt_prepare")
      const receipt = visualReceipt(responseID)
      const base: Responses.CreateInput = {
        id: responseID,
        workflowID,
        model: "deepseek-v4-pro",
        background: true,
        store: true,
        requestHash: receipt.requestHash,
        input: [{ type: "message", role: "user", content: "fixture" }],
      }
      const options = { responseID, timestamp: DateTime.makeUnsafe(2_000), receipt }

      expect(() => ResponsesAdmission.prepareVisualBuild({ ...base, store: false }, options)).toThrow()
      expect(() =>
        ResponsesAdmission.prepareVisualBuild(
          { ...base, workflowID: Workflow.ID.make("wfl_receipt_cross_workflow") },
          options,
        ),
      ).toThrow()
      const payload = ResponsesAdmission.receiptPayload(receipt)
      expect(() => ResponsesAdmission.decodeVisualBuildReceipt({ ...payload, unexpected: true })).toThrow()
      expect(() =>
        ResponsesAdmission.receiptPayload({
          ...receipt,
          request: { ...receipt.request, prompt: "x".repeat(ResponsesAdmission.MAX_VISUAL_BUILD_RECEIPT_BYTES) },
        }),
      ).toThrow()
      expect(() =>
        ResponsesAdmission.receiptPayload({
          ...receipt,
          response: { ...receipt.response, background: false, delivery: "foreground" },
        }),
      ).toThrow()
      expect(() =>
        ResponsesAdmission.receiptPayload({
          ...receipt,
          ids: {
            ...receipt.ids,
            stageIDs: [Workflow.StageID.make("wfs_receipt_mismatched"), ...receipt.ids.stageIDs.slice(1)],
          },
        }),
      ).toThrow()
      expect(() =>
        ResponsesAdmission.receiptPayload({
          ...receipt,
          routeMatrix: {
            ...receipt.routeMatrix,
            design: receipt.routeMatrix.implement,
          },
        }),
      ).toThrow()
    }),
  )

  it.effect("projects lifecycle state and ordered input/output items", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_projected")
      yield* createWorkflow(events)
      yield* events.publish(ResponseEvent.Created, created(responseID))
      yield* events.publish(ResponseEvent.InProgress, {
        responseID,
        timestamp: DateTime.makeUnsafe(3_000),
      })
      yield* events.publish(ResponseEvent.Completed, {
        responseID,
        timestamp: DateTime.makeUnsafe(4_000),
        output: [
          { type: "reasoning", summary: "plan" },
          { type: "message", role: "assistant", content: "done" },
        ],
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      })

      expect(
        yield* database.db
          .select({
            status: ResponseTable.status,
            output: ResponseTable.output,
            completedAt: ResponseTable.completed_at,
          })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        status: "completed",
        output: [
          { type: "reasoning", summary: "plan" },
          { type: "message", role: "assistant", content: "done" },
        ],
        completedAt: 4_000,
      })
      expect(
        yield* database.db
          .select({ ordinal: ResponseItemTable.ordinal, kind: ResponseItemTable.kind })
          .from(ResponseItemTable)
          .where(eq(ResponseItemTable.response_id, responseID))
          .orderBy(ResponseItemTable.ordinal)
          .all()
          .pipe(Effect.orDie),
      ).toEqual([
        { ordinal: 0, kind: "input" },
        { ordinal: 1, kind: "output" },
        { ordinal: 2, kind: "output" },
      ])
    }),
  )

  it.effect("projects incomplete, failed, cancelled, and deleted terminals", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      yield* createWorkflow(events)
      const cases = [
        {
          id: Responses.ID.make("resp_incomplete"),
          definition: ResponseEvent.Incomplete,
          terminal: {
            output: [{ type: "message", content: "partial" }],
            error: { code: "max_output_tokens", message: "limit reached" },
          },
          status: "incomplete",
        },
        {
          id: Responses.ID.make("resp_failed"),
          definition: ResponseEvent.Failed,
          terminal: { error: { code: "provider_error", message: "upstream failed" } },
          status: "failed",
        },
        {
          id: Responses.ID.make("resp_cancelled"),
          definition: ResponseEvent.Cancelled,
          terminal: { error: { code: "cancelled", message: "cancelled by user" } },
          status: "cancelled",
        },
      ] as const

      for (const item of cases) {
        yield* events.publish(ResponseEvent.Created, created(item.id))
        yield* events.publish(item.definition, {
          responseID: item.id,
          timestamp: DateTime.makeUnsafe(5_000),
          ...item.terminal,
        })
      }
      yield* events.publish(ResponseEvent.Deleted, {
        responseID: cases[0].id,
        timestamp: DateTime.makeUnsafe(6_000),
      })

      expect(
        yield* database.db
          .select({ id: ResponseTable.id, status: ResponseTable.status, deletedAt: ResponseTable.deleted_at })
          .from(ResponseTable)
          .orderBy(ResponseTable.id)
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map((row) => ({ ...row, id: String(row.id) }))),
          ),
      ).toEqual([
        { id: "resp_cancelled", status: "cancelled", deletedAt: null },
        { id: "resp_failed", status: "failed", deletedAt: null },
        { id: "resp_incomplete", status: "incomplete", deletedAt: 6_000 },
      ])
    }),
  )

  it.effect("rolls back both the response projection and durable event when workflow linkage fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_missing_workflow")
      const failed = yield* events
        .publish(ResponseEvent.Created, created(responseID, { workflowID: Workflow.ID.make("wfl_missing_workflow") }))
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(-1)
      expect(
        yield* database.db
          .select({ id: ResponseTable.id })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()

      const backgroundID = Responses.ID.make("resp_transient_background_projector")
      expect(
        Exit.isFailure(
          yield* events
            .publish(ResponseEvent.Created, created(backgroundID, { store: false, background: true }))
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, backgroundID)).toBe(-1)
    }),
  )

  it.effect("rolls back a response when an atomically related conversation event fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_related_rollback")
      const conversationID = Responses.ConversationID.make("conv_related_missing")
      yield* createWorkflow(events)

      const failed = yield* events
        .publish(ResponseEvent.Created, created(responseID), {
          related: [
            {
              definition: ResponseEvent.Conversation.ItemAdded,
              data: {
                conversationID,
                timestamp: DateTime.makeUnsafe(2_000),
                responseID,
                payload: { type: "message", content: "must roll back" },
              },
            },
          ],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(-1)
      expect(yield* EventV2.latestSequence(database.db, conversationID)).toBe(-1)
      expect(
        yield* database.db
          .select({ id: ResponseTable.id })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.effect("requires matching related conversation events for live response input and output", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const conversationID = Responses.ConversationID.make("conv_related_contract")
      const rejectedID = Responses.ID.make("resp_related_input_missing")
      const responseID = Responses.ID.make("resp_related_contract")
      yield* createWorkflow(events)
      yield* events.publish(ResponseEvent.Conversation.Created, {
        conversationID,
        timestamp: DateTime.makeUnsafe(2_000),
        metadata: {},
      })

      expect(
        Exit.isFailure(
          yield* events.publish(ResponseEvent.Created, created(rejectedID, { conversationID })).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, rejectedID)).toBe(-1)

      const input = created(responseID, { conversationID })
      yield* events.publish(ResponseEvent.Created, input, {
        related: input.input.map((payload) => ({
          definition: ResponseEvent.Conversation.ItemAdded,
          data: {
            conversationID,
            timestamp: input.timestamp,
            responseID,
            payload,
          },
        })),
      })
      expect(
        Exit.isFailure(
          yield* events
            .publish(ResponseEvent.Completed, {
              responseID,
              timestamp: DateTime.makeUnsafe(3_000),
              output: [{ type: "message", content: "missing related output" }],
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(0)
      expect(
        yield* database.db
          .select({ payload: ConversationItemTable.payload })
          .from(ConversationItemTable)
          .where(eq(ConversationItemTable.conversation_id, conversationID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ payload: { type: "message", role: "user", content: "hello" } }])
    }),
  )

  it.effect("settles a conversation response atomically from a workflow-related event batch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const conversationID = Responses.ConversationID.make("conv_workflow_atomic")
      const responseID = Responses.ID.make("resp_workflow_atomic")
      const output = { type: "message" as const, role: "assistant" as const, content: "done" }
      yield* createWorkflow(events)
      yield* events.publish(ResponseEvent.Conversation.Created, {
        conversationID,
        timestamp: DateTime.makeUnsafe(2_000),
        metadata: {},
      })
      const input = created(responseID, { conversationID })
      yield* events.publish(ResponseEvent.Created, input, {
        related: input.input.map((payload) => ({
          definition: ResponseEvent.Conversation.ItemAdded,
          data: { conversationID, timestamp: input.timestamp, responseID, payload },
        })),
      })

      yield* events.publish(
        WorkflowEvent.CancelRequested,
        { workflowID, timestamp: DateTime.makeUnsafe(3_000) },
        {
          related: [
            {
              definition: ResponseEvent.Completed,
              data: { responseID, timestamp: DateTime.makeUnsafe(3_000), output: [output] },
            },
            {
              definition: ResponseEvent.Conversation.ItemAdded,
              data: { conversationID, timestamp: DateTime.makeUnsafe(3_000), responseID, payload: output },
            },
          ],
        },
      )

      expect(
        yield* database.db
          .select({ status: ResponseTable.status, output: ResponseTable.output })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "completed", output: [output] })
      expect(
        yield* database.db
          .select({ payload: ConversationItemTable.payload })
          .from(ConversationItemTable)
          .where(eq(ConversationItemTable.conversation_id, conversationID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ payload: { type: "message", role: "user", content: "hello" } }, { payload: output }])
    }),
  )

  it.effect("rolls back workflow and response settlement when a later related projector fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const conversationID = Responses.ConversationID.make("conv_workflow_atomic_rollback")
      const responseID = Responses.ID.make("resp_workflow_atomic_rollback")
      const missingResponseID = Responses.ID.make("resp_workflow_atomic_missing")
      const output = { type: "message" as const, role: "assistant" as const, content: "must roll back" }
      yield* createWorkflow(events)
      yield* events.publish(ResponseEvent.Conversation.Created, {
        conversationID,
        timestamp: DateTime.makeUnsafe(2_000),
        metadata: {},
      })
      const input = created(responseID, { conversationID })
      yield* events.publish(ResponseEvent.Created, input, {
        related: input.input.map((payload) => ({
          definition: ResponseEvent.Conversation.ItemAdded,
          data: { conversationID, timestamp: input.timestamp, responseID, payload },
        })),
      })

      const failed = yield* events
        .publish(
          WorkflowEvent.CancelRequested,
          { workflowID, timestamp: DateTime.makeUnsafe(3_000) },
          {
            related: [
              {
                definition: ResponseEvent.Completed,
                data: { responseID, timestamp: DateTime.makeUnsafe(3_000), output: [output] },
              },
              {
                definition: ResponseEvent.Conversation.ItemAdded,
                data: { conversationID, timestamp: DateTime.makeUnsafe(3_000), responseID, payload: output },
              },
              {
                definition: ResponseEvent.Completed,
                data: { responseID: missingResponseID, timestamp: DateTime.makeUnsafe(3_000), output: [] },
              },
            ],
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(
        yield* database.db
          .select({ status: ResponseTable.status, output: ResponseTable.output })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "queued", output: [] })
      expect(
        yield* database.db
          .select({ cancelRequestedAt: WorkflowRunTable.cancel_requested_at })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, workflowID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ cancelRequestedAt: null })
      expect(yield* EventV2.latestSequence(database.db, workflowID)).toBe(0)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(0)
      expect(yield* EventV2.latestSequence(database.db, missingResponseID)).toBe(-1)
    }),
  )

  it.effect("rejects an atomic response settlement owned by a different workflow", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const otherWorkflowID = Workflow.ID.make("wfl_response_other_owner")
      const otherStageID = Workflow.StageID.make("wfs_response_other_owner")
      const responseID = Responses.ID.make("resp_cross_workflow_settlement")
      yield* createWorkflow(events)
      yield* events.publish(WorkflowEvent.Created, {
        workflowID: otherWorkflowID,
        timestamp: DateTime.makeUnsafe(1_000),
        type: "responses",
        input: {},
        budget: {},
        stages: [
          {
            id: otherStageID,
            type: "deliver",
            ordinal: 0,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "responses/other-owner",
            input: { responseID },
          },
        ],
      })
      yield* events.publish(ResponseEvent.Created, created(responseID, { workflowID: otherWorkflowID }))

      const failed = yield* events
        .publish(
          WorkflowEvent.CancelRequested,
          { workflowID, timestamp: DateTime.makeUnsafe(3_000) },
          {
            related: [
              {
                definition: ResponseEvent.Completed,
                data: {
                  responseID,
                  timestamp: DateTime.makeUnsafe(3_000),
                  output: [{ type: "message", role: "assistant", content: "wrong owner" }],
                },
              },
            ],
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(
        yield* database.db
          .select({ status: ResponseTable.status })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "queued" })
      expect(
        yield* database.db
          .select({ cancelRequestedAt: WorkflowRunTable.cancel_requested_at })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, workflowID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ cancelRequestedAt: null })
    }),
  )

  it.effect("rejects a Response that does not match an explicitly linked deliver stage", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const linkedResponseID = Responses.ID.make("resp_explicit_deliver")
      const otherResponseID = Responses.ID.make("resp_explicit_deliver_other")
      yield* events.publish(WorkflowEvent.Created, {
        workflowID,
        timestamp: DateTime.makeUnsafe(1_000),
        type: "responses",
        input: {},
        budget: {},
        stages: [
          {
            id: stageID,
            type: "deliver",
            ordinal: 0,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "responses/explicit-deliver",
            input: { responseID: linkedResponseID },
          },
        ],
      })

      expect(
        Exit.isFailure(yield* events.publish(ResponseEvent.Created, created(otherResponseID)).pipe(Effect.exit)),
      ).toBe(true)
    }),
  )

  it.effect("rejects Core event admission when the workflow has no deliver stage", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responseID = Responses.ID.make("resp_without_deliver_stage")
      yield* events.publish(WorkflowEvent.Created, {
        workflowID,
        timestamp: DateTime.makeUnsafe(1_000),
        type: "responses",
        input: {},
        budget: {},
        stages: [
          {
            id: stageID,
            type: "implement",
            ordinal: 0,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "responses/no-deliver",
            input: {},
          },
        ],
      })

      const admitted = yield* events.publish(ResponseEvent.Created, created(responseID)).pipe(Effect.exit)

      expect(Exit.isFailure(admitted)).toBe(true)
    }),
  )

  it.effect("rejects a second active Response for a workflow-bound deliver stage", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const first = Responses.ID.make("resp_implicit_deliver_first")
      const second = Responses.ID.make("resp_implicit_deliver_second")
      yield* events.publish(WorkflowEvent.Created, {
        workflowID,
        timestamp: DateTime.makeUnsafe(1_000),
        type: "responses",
        input: {},
        budget: {},
        stages: [
          {
            id: stageID,
            type: "deliver",
            ordinal: 0,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "responses/workflow-bound-deliver",
            input: { responseBinding: "workflow" },
          },
        ],
      })
      yield* events.publish(ResponseEvent.Created, created(first))

      expect(Exit.isFailure(yield* events.publish(ResponseEvent.Created, created(second)).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.effect("admits distinct Responses for distinct explicit deliver bindings", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const first = Responses.ID.make("resp_explicit_multi_first")
      const second = Responses.ID.make("resp_explicit_multi_second")
      yield* events.publish(WorkflowEvent.Created, {
        workflowID,
        timestamp: DateTime.makeUnsafe(1_000),
        type: "responses",
        input: {},
        budget: {},
        stages: [
          {
            id: stageID,
            type: "deliver",
            ordinal: 0,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "responses/explicit-multi-first",
            input: { responseID: first },
          },
          {
            id: Workflow.StageID.make("wfs_responses_projector_second"),
            type: "deliver",
            ordinal: 1,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "responses/explicit-multi-second",
            input: { responseID: second },
          },
        ],
      })

      yield* events.publish(ResponseEvent.Created, created(first))
      yield* events.publish(ResponseEvent.Created, created(second))
    }),
  )

  it.effect("rejects a workflow terminal event that would orphan an active Response", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_terminal_sibling_guard")
      const failure: Workflow.Failure = {
        category: "authentication",
        code: "invalid_key",
        message: "provider rejected credentials",
      }
      yield* events.publish(WorkflowEvent.Created, {
        workflowID,
        timestamp: DateTime.makeUnsafe(1_000),
        type: "responses",
        input: {},
        budget: {},
        stages: [
          {
            id: stageID,
            type: "deliver",
            ordinal: 0,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "responses/terminal-sibling-guard",
            input: { responseID },
          },
        ],
      })
      yield* events.publish(ResponseEvent.Created, created(responseID))
      yield* events.publish(WorkflowEvent.Started, {
        workflowID,
        timestamp: DateTime.makeUnsafe(2_100),
      })
      yield* events.publish(WorkflowEvent.Stage.Leased, {
        workflowID,
        stageID,
        timestamp: DateTime.makeUnsafe(2_200),
        attempt: 1,
        leaseOwner: "worker-a",
        leaseExpiresAt: DateTime.makeUnsafe(10_000),
      })
      yield* events.publish(WorkflowEvent.Stage.Started, {
        workflowID,
        stageID,
        timestamp: DateTime.makeUnsafe(2_300),
        attempt: 1,
        leaseOwner: "worker-a",
      })
      yield* events.publish(WorkflowEvent.Stage.Failed, {
        workflowID,
        stageID,
        timestamp: DateTime.makeUnsafe(2_400),
        attempt: 1,
        leaseOwner: "worker-a",
        failure,
        usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 },
        source: "execution",
      })

      const terminal = {
        workflowID,
        timestamp: DateTime.makeUnsafe(2_500),
        failure,
        usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 1 },
      }
      expect(Exit.isFailure(yield* events.publish(WorkflowEvent.Failed, terminal).pipe(Effect.exit))).toBe(true)
      expect(
        yield* database.db
          .select({ status: ResponseTable.status })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "queued" })

      yield* events.publish(WorkflowEvent.Failed, terminal, {
        related: [
          {
            definition: ResponseEvent.Failed,
            data: {
              responseID,
              timestamp: terminal.timestamp,
              error: { type: failure.category, code: failure.code, message: failure.message },
            },
          },
        ],
      })
      expect(
        yield* database.db
          .select({ status: ResponseTable.status })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "failed" })
    }),
  )

  it.effect("rejects a Response admitted after workflow cancellation was requested", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responseID = Responses.ID.make("resp_cancel_requested_workflow")
      yield* createWorkflow(events)
      yield* events.publish(WorkflowEvent.CancelRequested, {
        workflowID,
        timestamp: DateTime.makeUnsafe(1_500),
      })

      expect(Exit.isFailure(yield* events.publish(ResponseEvent.Created, created(responseID)).pipe(Effect.exit))).toBe(
        true,
      )
    }),
  )

  it.effect("rejects a Response for an ordinary deliver stage without an explicit binding", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const responseID = Responses.ID.make("resp_unbound_ordinary_deliver")
      yield* events.publish(WorkflowEvent.Created, {
        workflowID,
        timestamp: DateTime.makeUnsafe(1_000),
        type: "development",
        input: {},
        budget: {},
        stages: [
          {
            id: stageID,
            type: "deliver",
            ordinal: 0,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "development/ordinary-deliver",
            input: {},
          },
        ],
      })

      expect(Exit.isFailure(yield* events.publish(ResponseEvent.Created, created(responseID)).pipe(Effect.exit))).toBe(
        true,
      )
    }),
  )

  it.effect("rejects a live previous-response event with a fabricated context snapshot", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_fabricated_parent")
      yield* createWorkflow(events)

      const failed = yield* events
        .publish(
          ResponseEvent.Created,
          created(responseID, {
            previousResponseID: Responses.ID.make("resp_missing_parent_for_event"),
            context: [{ type: "message", content: "fabricated" }],
          }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(-1)
    }),
  )

  it.effect("rejects payload-bearing terminal events for store:false without losing recoverable state", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_transient_redaction")
      yield* createWorkflow(events)
      yield* events.publish(
        ResponseEvent.Created,
        created(responseID, { store: false, context: [], input: [{ type: "redacted" }] }),
      )

      const failed = yield* events
        .publish(ResponseEvent.Completed, {
          responseID,
          timestamp: DateTime.makeUnsafe(3_000),
          output: [{ type: "message", content: "must not persist" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(0)
      expect(
        yield* database.db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, responseID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ type: "response.created.1" }])
      expect(
        yield* database.db
          .select({ status: ResponseTable.status })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "queued" })
    }),
  )

  it.effect("keeps pre-terminal store:false durable events append-only and payload-free", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const responseID = Responses.ID.make("resp_transient_continuation")
      const sentinel = "TASK20_TRANSIENT_TOOL_RESULT_SENTINEL"
      yield* createWorkflow(events)
      yield* events.publish(WorkflowEvent.Stage.Leased, {
        workflowID,
        stageID,
        timestamp: DateTime.makeUnsafe(2_100),
        attempt: 1,
        leaseOwner: "worker-a",
        leaseExpiresAt: DateTime.makeUnsafe(32_100),
      })
      yield* events.publish(WorkflowEvent.Stage.Started, {
        workflowID,
        stageID,
        timestamp: DateTime.makeUnsafe(2_200),
        attempt: 1,
        leaseOwner: "worker-a",
      })
      yield* events.publish(
        ResponseEvent.Created,
        created(responseID, { store: false, context: [], input: [{ type: "redacted" }] }),
      )
      yield* events.publish(WorkflowEvent.Stage.Checkpointed, {
        workflowID,
        stageID,
        timestamp: DateTime.makeUnsafe(2_300),
        attempt: 1,
        leaseOwner: "worker-a",
        checkpoint: {
          kind: "workflow.model.continuation.transient",
          version: 1,
          responseID,
          usage: { tokens: 10, turns: 1, toolCalls: 1, attempts: 0 },
          providerUsage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
        },
      })
      const before = yield* database.db.select().from(EventTable).all().pipe(Effect.orDie)
      expect(JSON.stringify(before)).not.toContain(sentinel)

      yield* events.publish(ResponseEvent.Completed, {
        responseID,
        timestamp: DateTime.makeUnsafe(3_000),
      })

      const after = yield* database.db.select().from(EventTable).all().pipe(Effect.orDie)
      expect(after.slice(0, before.length)).toEqual(before)
      expect(JSON.stringify(after)).not.toContain(sentinel)
      expect(JSON.stringify(after)).toContain("workflow.model.continuation.transient")

      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (temporary) => Effect.promise(() => temporary[Symbol.asyncDispose]()),
      )
      const replayLayer = AppNodeBuilder.build(
        LayerNode.group([Database.node, EventV2.node, WorkflowProjector.node, ResponsesProjector.node]),
        [[Database.node, Database.layerFromPath(path.join(directory.path, "pre-terminal-replay.sqlite"))]],
      )
      const replayed = yield* Effect.gen(function* () {
        const replayEvents = yield* EventV2.Service
        const replayDatabase = yield* Database.Service
        yield* replayEvents.replayBatches(
          before.map((event) => ({
            id: event.id,
            aggregateID: event.aggregate_id,
            seq: event.seq,
            type: event.type,
            data: event.data,
            batchID: event.batch_id!,
            batchIndex: event.batch_index!,
            batchSize: event.batch_size!,
          })),
        )
        return {
          checkpoint: yield* replayDatabase.db
            .select({ checkpoint: WorkflowStageTable.checkpoint })
            .from(WorkflowStageTable)
            .where(eq(WorkflowStageTable.id, stageID))
            .get()
            .pipe(Effect.orDie),
          inputs: yield* replayDatabase.db
            .select({ payload: ResponseItemTable.payload })
            .from(ResponseItemTable)
            .where(eq(ResponseItemTable.response_id, responseID))
            .all()
            .pipe(Effect.orDie),
        }
      }).pipe(Effect.provide(replayLayer), Effect.scoped)
      expect(replayed).toEqual({
        checkpoint: {
          checkpoint: {
            kind: "workflow.model.continuation.transient",
            version: 1,
            responseID,
            usage: { tokens: 10, turns: 1, toolCalls: 1, attempts: 0 },
            providerUsage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
          },
        },
        inputs: [],
      })
    }),
  )

  it.effect("requires complete terminal payloads for stored responses", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const completedID = Responses.ID.make("resp_stored_completed_contract")
      const failedID = Responses.ID.make("resp_stored_failed_contract")
      yield* createWorkflow(events)
      yield* events.publish(ResponseEvent.Created, created(completedID))

      expect(
        Exit.isFailure(
          yield* events
            .publish(ResponseEvent.Completed, {
              responseID: completedID,
              timestamp: DateTime.makeUnsafe(3_000),
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, completedID)).toBe(0)
      yield* events.publish(ResponseEvent.Completed, {
        responseID: completedID,
        timestamp: DateTime.makeUnsafe(3_100),
        output: [],
      })
      yield* events.publish(ResponseEvent.Created, created(failedID))
      expect(
        Exit.isFailure(
          yield* events
            .publish(ResponseEvent.Failed, {
              responseID: failedID,
              timestamp: DateTime.makeUnsafe(3_000),
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, completedID)).toBe(1)
      expect(yield* EventV2.latestSequence(database.db, failedID)).toBe(0)
    }),
  )

  it.effect("rejects direct store:false conversation events atomically", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const conversationID = Responses.ConversationID.make("conv_transient_projector")
      const responseID = Responses.ID.make("resp_transient_projector")
      yield* createWorkflow(events)
      yield* events.publish(ResponseEvent.Conversation.Created, {
        conversationID,
        timestamp: DateTime.makeUnsafe(2_000),
        metadata: {},
      })

      expect(
        Exit.isFailure(
          yield* events
            .publish(
              ResponseEvent.Created,
              created(responseID, {
                store: false,
                conversationID,
              }),
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* EventV2.latestSequence(database.db, responseID)).toBe(-1)
      expect(
        yield* database.db
          .select({ id: ResponseTable.id })
          .from(ResponseTable)
          .where(eq(ResponseTable.id, responseID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )
})
