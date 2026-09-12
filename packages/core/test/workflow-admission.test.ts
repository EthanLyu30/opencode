import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { WorkflowVisualBuild } from "@opencode-ai/schema/workflow-visual-build"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ResponsesAdmission } from "@opencode-ai/core/responses/admission"
import { ResponseTable } from "@opencode-ai/core/responses/sql"
import { ResponsesStore } from "@opencode-ai/core/responses/store"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { WorkflowAdmission } from "@opencode-ai/core/workflow/admission"
import { WorkflowBenchmarkTransport } from "@opencode-ai/core/workflow/benchmark-transport"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { WorkflowRunTable } from "@opencode-ai/core/workflow/sql"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

let wakes = 0
let failWake = false
const execution = Layer.succeed(
  WorkflowExecution.Service,
  WorkflowExecution.Service.of({
    wake: Effect.suspend(() => {
      wakes++
      return failWake ? Effect.die(new Error("injected post-commit wake crash")) : Effect.void
    }),
    interrupt: () => Effect.void,
    active: Effect.succeed(new Set()),
  }),
)
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      ResponsesStore.node,
      WorkflowStore.node,
      WorkflowAdmission.node,
    ]),
    [
      [WorkflowExecution.node, execution],
      [ProjectV2.node, projects],
    ],
  ),
)

const benchmarkNow = 1_800_000_000_000
const benchmarkBinding = (port: number) =>
  WorkflowBenchmarkTransport.freezeProfile({
    authority: "server",
    profile: {
      schemaVersion: 1,
      campaignID: "task24-admission-campaign",
      runID: "task24-admission-run",
      brokerOrigin: `http://127.0.0.1:${port}`,
      providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
      expiresAt: benchmarkNow + 60_000,
      grant: `task24-admission-grant-${port}-that-is-long-enough`,
    },
    expectedCampaignID: "task24-admission-campaign",
    expectedRunID: "task24-admission-run",
    now: benchmarkNow,
  })
let activeBenchmarkBinding = benchmarkBinding(43191)
const dynamicBenchmarkTransport = Layer.succeed(
  WorkflowBenchmarkTransport.Service,
  WorkflowBenchmarkTransport.Service.of({
    get binding() {
      return activeBenchmarkBinding
    },
  }),
)
const measuredIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      ResponsesStore.node,
      WorkflowStore.node,
      WorkflowAdmission.node,
    ]),
    [
      [WorkflowExecution.node, execution],
      [ProjectV2.node, projects],
      [WorkflowBenchmarkTransport.node, dynamicBenchmarkTransport],
    ],
  ),
)

const input = (overrides: Partial<WorkflowVisualBuild.CreateInput> = {}) =>
  WorkflowVisualBuild.CreateInput.make({
    prompt: "Build the visual experience",
    budget: { maxAttempts: 3, maxTokens: 20_000, maxTurns: 20, maxToolCalls: 40 },
    visual: { maxRevisions: 1, maxTokens: 12_000, maxTurns: 12, maxToolCalls: 24 },
    preview: { kind: "static", entrypoint: "index.html" },
    delivery: "background",
    ...overrides,
  })

const workspace = () =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const value = await tmpdir()
      await Bun.write(`${value.path}/index.html`, "<!doctype html><title>Task 23.8</title>")
      return value
    }),
    (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
  )

const locationOf = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })

const rowCounts = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return [
    (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).length,
    (yield* db.select().from(WorkflowRunTable).all().pipe(Effect.orDie)).length,
    (yield* db.select().from(ResponseTable).all().pipe(Effect.orDie)).length,
    (yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)).length,
    (yield* db.select().from(EventTable).all().pipe(Effect.orDie)).length,
    (yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).length,
  ]
})

describe("WorkflowAdmission", () => {
  measuredIt.effect("rejects exact-create reconciliation when the trusted transport binding changes", () =>
    Effect.gen(function* () {
      activeBenchmarkBinding = benchmarkBinding(43191)
      const root = yield* workspace()
      const admission = yield* WorkflowAdmission.Service
      const location = locationOf(root.path)
      const first = yield* admission.admitVisualBuild(input(), location, "transport-reconciliation")
      activeBenchmarkBinding = benchmarkBinding(43192)

      const failure = yield* admission.admitVisualBuild(input(), location, "transport-reconciliation").pipe(Effect.flip)

      expect(failure._tag).toBe("Workflow.ConflictError")
      expect(first.workflow.input[WorkflowBenchmarkTransport.RESERVED_INPUT_KEY]).toMatchObject({
        brokerOrigin: "http://127.0.0.1:43191",
      })
      expect(yield* rowCounts).toEqual([1, 1, 1, 1, 12, 3])
    }),
  )

  it.effect("rolls back the complete admission when the Workflow projector fails", () =>
    Effect.gen(function* () {
      const root = yield* workspace()
      const events = yield* EventV2.Service
      const admission = yield* WorkflowAdmission.Service
      yield* events.project(WorkflowEvent.Created, () => Effect.die(new Error("injected Workflow failure")))

      const result = yield* admission
        .admitVisualBuild(input(), locationOf(root.path), "workflow-projector-failure")
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* rowCounts).toEqual([0, 0, 0, 0, 0, 0])
    }),
  )

  it.effect("rolls back the complete admission when the Session projector fails", () =>
    Effect.gen(function* () {
      const root = yield* workspace()
      const events = yield* EventV2.Service
      const admission = yield* WorkflowAdmission.Service
      yield* events.project(SessionV1.Event.Created, () => Effect.die(new Error("injected Session failure")))

      const result = yield* admission
        .admitVisualBuild(input(), locationOf(root.path), "session-projector-failure")
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* rowCounts).toEqual([0, 0, 0, 0, 0, 0])
    }),
  )

  it.effect("rolls back the complete admission when the Response projector fails", () =>
    Effect.gen(function* () {
      const root = yield* workspace()
      const events = yield* EventV2.Service
      const admission = yield* WorkflowAdmission.Service
      yield* events.project(ResponseEvent.Created, () => Effect.die(new Error("injected Response failure")))

      const result = yield* admission
        .admitVisualBuild(input(), locationOf(root.path), "response-projector-failure")
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* rowCounts).toEqual([0, 0, 0, 0, 0, 0])
    }),
  )

  it.effect("reconciles an exact retry to one hidden Session, graph, stored Response, and wake", () =>
    Effect.gen(function* () {
      wakes = 0
      failWake = false
      const root = yield* workspace()
      const location = locationOf(root.path)
      const admission = yield* WorkflowAdmission.Service
      const workflows = yield* WorkflowStore.Service
      const responses = yield* ResponsesStore.Service
      const sessions = yield* SessionStore.Service
      const { db } = yield* Database.Service

      const first = yield* admission.admitVisualBuild(input(), location, "same-visual-build")
      const retried = yield* admission.admitVisualBuild(input(), location, "same-visual-build")

      expect(retried).toEqual(first)
      expect(wakes).toBe(1)
      expect(first.response).toMatchObject({
        workflowID: first.workflow.id,
        model: "deepseek-v4-pro",
        background: true,
        store: true,
      })
      const detail = yield* workflows.get(first.workflow.id)
      if (!detail) throw new Error("admitted workflow was not projected")
      expect(detail.stages).toHaveLength(9)
      expect(new Set(detail.stages.map((stage) => stage.id)).size).toBe(9)
      expect(detail.stages.find((stage) => stage.type === "deliver")?.input).toEqual({
        responseID: first.response.id,
        revision: 1,
      })
      expect((yield* sessions.get(first.workflow.sessionID!))?.visibility).toBe("workflow")
      expect(yield* sessions.getPublic(first.workflow.sessionID!)).toBeUndefined()

      const receiptItems = yield* responses.items(first.response.id, "context")
      expect(receiptItems).toHaveLength(1)
      expect(ResponsesAdmission.decodeVisualBuildReceipt(receiptItems[0].payload)).toMatchObject({
        schemaVersion: 1,
        ids: {
          workflowID: first.workflow.id,
          sessionID: first.workflow.sessionID,
          responseID: first.response.id,
        },
        location,
        request: input(),
      })

      const events = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.batch_id, first.workflow.id))
        .all()
        .pipe(Effect.orDie)
      const allEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      expect(events.length === 0 ? allEvents : events).toHaveLength(detail.stages.length + 3)
      expect(new Set(allEvents.map((event) => event.batch_id)).size).toBe(1)
      expect(
        allEvents.filter((event) => event.type === EventV2.versionedType(WorkflowEvent.Stage.Queued.type, 1)),
      ).toHaveLength(detail.stages.length)
      expect(yield* rowCounts).toEqual([1, 1, 1, 1, detail.stages.length + 3, 3])
    }),
  )

  it.effect("publishes complete related ownership metadata on every admission batch member", () =>
    Effect.gen(function* () {
      wakes = 0
      failWake = false
      const root = yield* workspace()
      const admission = yield* WorkflowAdmission.Service
      const source = yield* EventV2.Service
      const observed: EventV2.Payload[] = []
      const unsubscribe = yield* source.listen((event) => Effect.sync(() => observed.push(event)))
      yield* Effect.addFinalizer(() => unsubscribe)

      const result = yield* admission.admitVisualBuild(input(), locationOf(root.path), "complete-related-batch")
      const batchID = observed.find((event) => event.type === WorkflowEvent.Created.type)?.durable?.batch?.id
      const batch = observed.filter((event) => event.durable?.batch?.id === batchID)

      expect(batch).toHaveLength(12)
      for (const event of batch) {
        expect(event.durable?.related).toHaveLength(batch.length)
        expect(event.durable?.related).toContainEqual({
          type: SessionV1.Event.Created.type,
          data: expect.objectContaining({ sessionID: result.workflow.sessionID, visibility: "workflow" }),
        })
      }
    }),
  )

  it.effect("keeps a committed admission recoverable across a crash before wake", () =>
    Effect.gen(function* () {
      wakes = 0
      failWake = true
      const root = yield* workspace()
      const admission = yield* WorkflowAdmission.Service
      const request = input()
      const location = locationOf(root.path)

      const crashed = yield* admission.admitVisualBuild(request, location, "post-commit-wake-crash").pipe(Effect.exit)
      expect(Exit.isFailure(crashed)).toBe(true)
      expect(yield* rowCounts).toEqual([1, 1, 1, 1, 12, 3])

      failWake = false
      const recovered = yield* admission.admitVisualBuild(request, location, "post-commit-wake-crash")
      expect(recovered.workflow.status).toBe("queued")
      expect(wakes).toBe(1)
    }),
  )

  it.effect("rejects reuse of one idempotency key with changed admission authority", () =>
    Effect.gen(function* () {
      const firstRoot = yield* workspace()
      const secondRoot = yield* workspace()
      const admission = yield* WorkflowAdmission.Service
      const location = locationOf(firstRoot.path)
      yield* admission.admitVisualBuild(input(), location, "conflicting-key")

      const changed = [
        admission.admitVisualBuild(input({ prompt: "Different prompt" }), location, "conflicting-key"),
        admission.admitVisualBuild(
          input({ budget: { maxAttempts: 3, maxTokens: 19_999, maxTurns: 20, maxToolCalls: 40 } }),
          location,
          "conflicting-key",
        ),
        admission.admitVisualBuild(
          input({ visual: { maxRevisions: 0, maxTokens: 12_000, maxTurns: 12, maxToolCalls: 24 } }),
          location,
          "conflicting-key",
        ),
        admission.admitVisualBuild(input({ delivery: "foreground" }), location, "conflicting-key"),
        admission.admitVisualBuild(input(), locationOf(secondRoot.path), "conflicting-key"),
      ]
      for (const attempt of changed) {
        const error = yield* attempt.pipe(Effect.flip)
        expect(error._tag).toBe("Workflow.ConflictError")
      }
      expect(yield* rowCounts).toEqual([1, 1, 1, 1, 12, 3])
    }),
  )

  it.effect("derives an absent idempotency key from the strict request and Location", () =>
    Effect.gen(function* () {
      wakes = 0
      failWake = false
      const root = yield* workspace()
      const admission = yield* WorkflowAdmission.Service
      const location = locationOf(root.path)

      const first = yield* admission.admitVisualBuild(input(), location)
      const exact = yield* admission.admitVisualBuild(input(), location)
      const distinct = yield* admission.admitVisualBuild(input({ prompt: "A distinct visual build" }), location)

      expect(exact).toEqual(first)
      expect(distinct.workflow.id).not.toBe(first.workflow.id)
      expect(distinct.response.id).not.toBe(first.response.id)
      expect(wakes).toBe(2)
    }),
  )

  it.effect("rejects payload idempotency authority before publishing an event", () =>
    Effect.gen(function* () {
      const root = yield* workspace()
      const admission = yield* WorkflowAdmission.Service
      const payload = { ...input(), idempotencyKey: "payload-authority-is-forbidden" }

      expect(
        Exit.isFailure(
          yield* admission
            .admitVisualBuild(payload as WorkflowVisualBuild.CreateInput, locationOf(root.path))
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* rowCounts).toEqual([0, 0, 0, 0, 0, 0])
    }),
  )

  it.effect("rejects public benchmark transport authority before publishing an event", () =>
    Effect.gen(function* () {
      const root = yield* workspace()
      const admission = yield* WorkflowAdmission.Service
      for (const field of ["baseURL", "endpoint", "grant", "benchmarkTransport"] as const) {
        const payload = { ...input(), [field]: "forged-public-authority" }
        expect(
          Exit.isFailure(
            yield* admission
              .admitVisualBuild(payload as WorkflowVisualBuild.CreateInput, locationOf(root.path))
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }
      expect(yield* rowCounts).toEqual([0, 0, 0, 0, 0, 0])
    }),
  )

  it.effect("rejects non-normalized idempotency headers before publishing an event", () =>
    Effect.gen(function* () {
      const root = yield* workspace()
      const admission = yield* WorkflowAdmission.Service
      for (const key of ["", "e\u0301", "control\u0000key"]) {
        const failure = yield* admission.admitVisualBuild(input(), locationOf(root.path), key).pipe(Effect.flip)
        expect(failure._tag).toBe("WorkflowAdmission.InvalidIdempotencyKey")
      }
      expect(yield* rowCounts).toEqual([0, 0, 0, 0, 0, 0])
    }),
  )

  it.effect("returns a bounded typed error for an oversized admission receipt without partial writes", () =>
    Effect.gen(function* () {
      wakes = 0
      failWake = false
      const root = yield* workspace()
      const admission = yield* WorkflowAdmission.Service
      const responses = yield* ResponsesStore.Service
      const location = locationOf(root.path)

      const measured = yield* admission.admitVisualBuild(input({ prompt: "x" }), location, "measure-receipt")
      const measuredPayload = (yield* responses.items(measured.response.id, "context"))[0].payload
      const measuredBytes = new TextEncoder().encode(JSON.stringify(measuredPayload)).byteLength
      const atLimitPrompt = "x".repeat(ResponsesAdmission.MAX_VISUAL_BUILD_RECEIPT_BYTES - measuredBytes + 1)

      const atLimit = yield* admission.admitVisualBuild(input({ prompt: atLimitPrompt }), location, "at-limit")
      const atLimitPayload = (yield* responses.items(atLimit.response.id, "context"))[0].payload
      expect(new TextEncoder().encode(JSON.stringify(atLimitPayload)).byteLength).toBe(
        ResponsesAdmission.MAX_VISUAL_BUILD_RECEIPT_BYTES,
      )
      const beforeFailure = yield* rowCounts

      const secret = "TOP_SECRET_RECEIPT_BOUNDARY"
      const failure = yield* admission
        .admitVisualBuild(input({ prompt: atLimitPrompt + secret }), location, "over-limit")
        .pipe(Effect.flip)
      expect(failure._tag).toBe("WorkflowAdmission.InvalidAdmission")
      expect(failure.message.length).toBeLessThanOrEqual(128)
      expect(failure.message).not.toContain(secret)
      expect(yield* rowCounts).toEqual(beforeFailure)

      expect(wakes).toBe(2)
    }),
  )
})
