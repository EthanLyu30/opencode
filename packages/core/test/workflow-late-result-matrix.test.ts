import { describe, expect } from "bun:test"
import { and, eq, inArray } from "drizzle-orm"
import { Clock, DateTime, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventTable } from "@opencode-ai/core/event/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowModelExecution } from "@opencode-ai/core/workflow/execution/model"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowStageTable } from "@opencode-ai/core/workflow/sql"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { ResponsesProjector } from "@opencode-ai/core/responses/projector"
import { ResponseTable } from "@opencode-ai/core/responses/sql"
import { ResponsesStore } from "@opencode-ai/core/responses/store"
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { ResponseEvent } from "@opencode-ai/schema/response-event"
import { Responses } from "@opencode-ai/schema/responses"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Session } from "@opencode-ai/schema/session"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Tool, ToolRuntime } from "@opencode-ai/llm"
import { testEffect } from "./lib/effect"

type Cutoff = "provider" | "tool" | "preview" | "capture"
type Fence = "cancel" | "lease-loss"

interface Control {
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
  readonly settled: Deferred.Deferred<void>
  readonly targetOrdinal: number
  readonly responseID: Responses.ID
  readonly cutoff: Cutoff
  readonly calls: string[]
  readonly disposed: Deferred.Deferred<void>
}

const controls = new Map<Workflow.ID, Control>()

const prefixKinds = [
  ["workflow.role.outcome", "workflow.design.spec", "workflow.design.reference-app"],
  ["workflow.role.outcome", "workflow.decomposition.plan"],
  ["workflow.role.outcome", "workflow.implementation-manifest", "tool-continuation"],
  ["workflow.role.outcome", "workflow.test.result", "workflow.test.log"],
  ["workflow.role.outcome", "workflow.implementation-manifest", "tool-continuation"],
  ["workflow.role.outcome", "workflow.test.result", "workflow.test.log"],
] as const

const prefixUsage = [
  { tokens: 5, turns: 1, toolCalls: 0, attempts: 0 },
  { tokens: 5, turns: 1, toolCalls: 0, attempts: 0 },
  { tokens: 5, turns: 2, toolCalls: 1, attempts: 0 },
  { tokens: 5, turns: 1, toolCalls: 0, attempts: 0 },
  { tokens: 5, turns: 2, toolCalls: 1, attempts: 0 },
  { tokens: 5, turns: 1, toolCalls: 0, attempts: 0 },
] as const

const expected = {
  provider: { prefixStages: 0, artifacts: 0, usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 } },
  tool: { prefixStages: 2, artifacts: 5, usage: { tokens: 10, turns: 2, toolCalls: 0, attempts: 3 } },
  preview: { prefixStages: 6, artifacts: 17, usage: { tokens: 30, turns: 8, toolCalls: 2, attempts: 7 } },
  capture: { prefixStages: 6, artifacts: 17, usage: { tokens: 30, turns: 8, toolCalls: 2, attempts: 7 } },
} satisfies Record<Cutoff, { prefixStages: number; artifacts: number; usage: Workflow.Usage }>

const sha = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

const commit = (workflowID: Workflow.ID, stageID: Workflow.StageID, kind: string, ordinal: number) => {
  const body = JSON.stringify({ kind, ordinal })
  return {
    kind,
    uri: `workflow://${workflowID}/stages/${stageID}/matrix-${ordinal}.json`,
    mime: "application/json",
    sha256: sha(`${workflowID}:${stageID}:${kind}:${ordinal}`),
    size: Buffer.byteLength(body),
    metadata: { matrixPrefix: true, ordinal },
  }
}

const producerBarrier = (control: Control) =>
  Deferred.succeed(control.entered, undefined).pipe(Effect.andThen(Deferred.await(control.release)))

const modelService = WorkflowModelExecution.Service.of({
  execute: ({ stage }) => {
    const control = controls.get(stage.workflowID)
    if (control === undefined || control.cutoff !== "provider") return Effect.die("missing provider cutoff control")
    return Effect.uninterruptible(
      Effect.sync(() => control.calls.push("provider.open")).pipe(
        Effect.andThen(producerBarrier(control)),
        Effect.ensuring(
          Effect.sync(() => control.calls.push("provider.close")).pipe(
            Effect.andThen(Deferred.succeed(control.disposed, undefined)),
            Effect.asVoid,
          ),
        ),
        Effect.as({ usage: { tokens: 999, turns: 99, toolCalls: 9, attempts: 0 } }),
      ),
    )
  },
})

const visualService = WorkflowVisualHost.Service.of({
  materializeReference: (input: WorkflowVisualHost.MaterializeReferenceInput) => {
    const control = controls.get(input.workflowID)
    if (control === undefined || (control.cutoff !== "preview" && control.cutoff !== "capture")) {
      return Effect.die("missing preview cutoff control")
    }
    const hostID = WorkflowVisualHost.HostID.make(sha(String(input.workflowID)))
    const acquire = Effect.gen(function* () {
      if (control.cutoff === "preview") {
        control.calls.push("preview.open")
        yield* producerBarrier(control)
      }
      return WorkflowVisualHost.preparedPreview({
        hostID,
        url: `http://127.0.0.1:31337/${hostID}/`,
        workflowID: input.workflowID,
        kind: "reference",
        revision: 0,
        configSha256: "a".repeat(64),
        sourceSha256: "b".repeat(64),
        readySelectorSha256: "c".repeat(64),
        scope: yield* Effect.scope,
      })
    })
    return Effect.acquireRelease(Effect.uninterruptible(acquire), () =>
      Effect.sync(() => control.calls.push(`${control.cutoff}.close`)).pipe(
        Effect.andThen(Deferred.succeed(control.disposed, undefined)),
        Effect.asVoid,
      ),
    )
  },
  capture: (input: WorkflowVisualHost.CaptureInput) => {
    const control = controls.get(input.preview.identity.workflowID)
    if (control === undefined || control.cutoff !== "capture") return Effect.die("missing capture cutoff control")
    return Effect.uninterruptible(
      Effect.sync(() => control.calls.push("capture.open")).pipe(
        Effect.andThen(producerBarrier(control)),
        Effect.as({ evidenceID: sha("late-capture") } as never),
      ),
    )
  },
} as never)

const referenceApp = {
  entrypoint: "index.html",
  readySelector: "#ready",
  projectStack: ["HTML"],
  files: [{ path: "index.html", content: '<main id="ready">matrix</main>' }],
}

const matrixExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ workflow, stage, stages, artifacts, remainingDurationMs, lease, saveCheckpoint }) => {
      const control = controls.get(stage.workflowID)
      if (control === undefined) return Effect.die(`missing late-result control for ${stage.workflowID}`)
      if (stage.ordinal < control.targetOrdinal) {
        return Effect.succeed({
          usage: prefixUsage[stage.ordinal]!,
          artifacts: prefixKinds[stage.ordinal]!.map((kind, index) =>
            commit(stage.workflowID, stage.id, kind, stage.ordinal * 10 + index),
          ),
        })
      }
      if (stage.attempt !== 1) return Effect.never
      const lateBody = `LATE_${stage.workflowID}_${stage.id}`
      const producer = (() => {
        if (control.cutoff === "provider") {
          return Effect.uninterruptible(
            (
              modelService.execute({
                workflow,
                stage,
                stages,
                artifacts,
                remainingDurationMs,
                lease,
                saveCheckpoint,
              } as never) as Effect.Effect<unknown, never>
            ).pipe(Effect.andThen(Deferred.succeed(control.settled, undefined)), Effect.asVoid),
          )
        }
        if (control.cutoff === "tool") {
          const delayed = Tool.make({
            description: "matrix delayed native tool",
            parameters: Schema.Struct({ value: Schema.String }),
            success: Schema.Struct({ output: Schema.String }),
            execute: () =>
              Effect.uninterruptible(
                Effect.sync(() => control.calls.push("tool.open")).pipe(
                  Effect.andThen(producerBarrier(control)),
                  Effect.ensuring(
                    Effect.sync(() => control.calls.push("tool.close")).pipe(
                      Effect.andThen(Deferred.succeed(control.disposed, undefined)),
                      Effect.asVoid,
                    ),
                  ),
                  Effect.as({ output: lateBody }),
                ),
              ),
          })
          return Effect.uninterruptible(
            ToolRuntime.dispatch(
              { matrix_tool: delayed },
              { type: "tool-call", id: "call-matrix-late", name: "matrix_tool", input: { value: lateBody } },
            ).pipe(Effect.orDie, Effect.andThen(Deferred.succeed(control.settled, undefined)), Effect.asVoid),
          )
        }
        if (control.cutoff === "preview") {
          return Effect.uninterruptible(
            visualService
              .materializeReference({ workflowID: stage.workflowID, referenceApp })
              .pipe(
                Effect.orDie,
                Effect.scoped,
                Effect.andThen(Deferred.succeed(control.settled, undefined)),
                Effect.asVoid,
              ),
          )
        }
        return Effect.uninterruptible(
          visualService.materializeReference({ workflowID: stage.workflowID, referenceApp }).pipe(
            Effect.flatMap((preview) =>
              visualService.capture({
                preview,
                stageID: stage.id,
                viewport: { name: "desktop", width: 1440, height: 900 },
              }),
            ),
            Effect.scoped,
            Effect.orDie,
            Effect.andThen(Deferred.succeed(control.settled, undefined)),
            Effect.asVoid,
          ),
        )
      })()
      return producer.pipe(
        Effect.as({
          usage: { tokens: 999, turns: 99, toolCalls: 9, attempts: 0 },
          artifacts: [
            {
              kind: "late-result",
              uri: `artifact://${stage.workflowID}/late-result.json`,
              mime: "application/json",
              sha256: sha(lateBody),
              size: Buffer.byteLength(lateBody),
              metadata: { lateBody },
            },
          ],
          responseSettlement: {
            type: "completed" as const,
            responseID: control.responseID,
            output: [{ type: "message" as const, role: "assistant" as const, content: lateBody }],
            store: true,
          },
        }),
      )
    },
  }),
)

const options: WorkflowExecutionLocal.Options = {
  ownerID: "worker-late-result-matrix",
  leaseDurationMs: 60_000,
  heartbeatIntervalMs: 30_000,
  pollIntervalMs: 30_000,
  concurrency: 1,
}

const matrixIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      WorkflowV2.node,
      WorkflowStore.node,
      WorkflowExecutor.node,
      WorkflowExecution.node,
      ResponsesProjector.node,
      ResponsesStore.node,
      ResponsesV2.node,
    ]),
    [
      [WorkflowExecutor.node, matrixExecutor],
      [WorkflowExecution.node, WorkflowExecutionLocal.nodeWith(options)],
    ],
  ),
)

const drain = Effect.gen(function* () {
  for (let index = 0; index < 200; index++) yield* Effect.yieldNow
})

const waitUntil = Effect.fnUntraced(function* (predicate: () => Effect.Effect<boolean>, message: string) {
  for (let index = 0; index < 1_000; index++) {
    if (yield* predicate()) return
    yield* Effect.yieldNow
  }
  return yield* Effect.die(message)
})

const makeInput = (cutoff: Cutoff, fence: Fence, prefixStages: number, responseID: Responses.ID) => {
  const workflowID = Workflow.ID.make(`wfl_late_${cutoff}_${fence.replace("-", "_")}`)
  const stages = Array.from({ length: prefixStages + 1 }, (_, ordinal) => ({
    id: Workflow.StageID.make(`wfs_late_${cutoff}_${fence.replace("-", "_")}_${ordinal}`),
    type: ordinal === prefixStages ? "deliver" : "build",
    ordinal,
    maxAttempts: 3,
    recoveryPolicy: "restart_safe" as const,
    idempotencyKey: `late-result/${cutoff}/${fence}/${ordinal}`,
    input: ordinal === prefixStages ? { responseID } : {},
  }))
  return {
    workflowID,
    input: {
      id: workflowID,
      type: "development" as const,
      input: { brief: `${cutoff} ${fence} late-result matrix` },
      budget: { maxAttempts: 20 },
      stages: [stages[0]!, ...stages.slice(1)],
    } satisfies Workflow.CreateInput,
  }
}

const artifactKinds = (detail: Workflow.Detail) =>
  detail.artifacts.reduce<Record<string, number>>((counts, artifact) => {
    counts[artifact.kind] = (counts[artifact.kind] ?? 0) + 1
    return counts
  }, {})

const assertPrefix = (cutoff: Cutoff, detail: Workflow.Detail) => {
  expect(detail.artifacts).toHaveLength(expected[cutoff].artifacts)
  expect(detail.run.usage).toEqual(expected[cutoff].usage)
  if (cutoff === "provider") expect(artifactKinds(detail)).toEqual({})
  if (cutoff === "tool") {
    expect(artifactKinds(detail)).toEqual({
      "workflow.role.outcome": 2,
      "workflow.design.spec": 1,
      "workflow.design.reference-app": 1,
      "workflow.decomposition.plan": 1,
    })
  }
  if (cutoff === "preview" || cutoff === "capture") {
    expect(artifactKinds(detail)).toEqual({
      "workflow.role.outcome": 6,
      "workflow.design.spec": 1,
      "workflow.design.reference-app": 1,
      "workflow.decomposition.plan": 1,
      "workflow.implementation-manifest": 2,
      "tool-continuation": 2,
      "workflow.test.result": 2,
      "workflow.test.log": 2,
    })
  }
}

describe("late execution result fencing matrix", () => {
  for (const cutoff of ["provider", "tool", "preview", "capture"] as const) {
    for (const fence of ["cancel", "lease-loss"] as const) {
      matrixIt.effect(`${cutoff} x ${fence} rejects every late durable output`, () =>
        Effect.gen(function* () {
          const workflow = yield* WorkflowV2.Service
          const execution = yield* WorkflowExecution.Service
          const responses = yield* ResponsesV2.Service
          const database = yield* Database.Service
          const responseID = Responses.ID.make(`resp_late_${cutoff}_${fence.replace("-", "_")}`)
          const config = expected[cutoff]
          const value = makeInput(cutoff, fence, config.prefixStages, responseID)
          const control: Control = {
            entered: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
            settled: yield* Deferred.make<void>(),
            targetOrdinal: config.prefixStages,
            responseID,
            cutoff,
            calls: [],
            disposed: yield* Deferred.make<void>(),
          }
          controls.set(value.workflowID, control)
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(control.release, undefined).pipe(
              Effect.andThen(Effect.sync(() => controls.delete(value.workflowID))),
              Effect.asVoid,
            ),
          )

          const beforeClock = yield* Clock.currentTimeMillis
          yield* workflow.admit({
            ...value.input,
            location: Location.Ref.make({ directory: AbsolutePath.make("D:\\OpenCode-Audit") }),
            sessionID: Session.ID.make(`ses_late_${cutoff}_${fence.replace("-", "_")}`),
            agent: Agent.ID.make("build"),
          })
          yield* responses.create({
            id: responseID,
            workflowID: value.workflowID,
            model: "deepseek-v4-flash",
            background: false,
            store: true,
            requestHash: `sha256:${responseID}`,
            input: [{ type: "message", role: "user", content: `${cutoff} ${fence}` }],
          })
          yield* responses.start(responseID)
          yield* waitUntil(() => Deferred.isDone(control.entered), `producer did not enter: ${cutoff}`)
          // Exhaust only pre-fence admission/prefix wakes while the lease is still live.
          // No TestClock adjustment or workflow wake is permitted after the SQL fence below.
          yield* drain

          const running = yield* workflow.get(value.workflowID)
          const target = running.stages[config.prefixStages]!
          expect(target).toMatchObject({
            status: "running",
            attempt: 1,
            leaseOwner: options.ownerID,
          })
          assertPrefix(cutoff, running)

          if (fence === "cancel") {
            const cancelFiber = yield* Effect.forkChild(workflow.cancel(value.workflowID))
            yield* waitUntil(
              () =>
                workflow.history({ workflowID: value.workflowID, limit: 500 }).pipe(
                  Effect.map((history) =>
                    history.events.some((event) => event.type === WorkflowEvent.CancelRequested.type),
                  ),
                  Effect.orDie,
                ),
              "cancel fence was not durably published",
            )
            yield* Deferred.succeed(control.release, undefined)
            yield* Deferred.await(control.settled)
            yield* Fiber.join(cancelFiber)
            yield* drain

            const detail = yield* workflow.get(value.workflowID)
            const response = yield* responses.get(responseID)
            const history = yield* workflow.history({ workflowID: value.workflowID, limit: 500 })
            expect(detail.run.status).toBe("cancelled")
            expect(detail.stages[config.prefixStages]!.status).toBe("cancelled")
            assertPrefix(cutoff, detail)
            expect(response).toMatchObject({ status: "cancelled", output: [] })
            expect(response.error).toBeUndefined()
            expect(response.usage).toBeUndefined()
            expect(history.events.filter((event) => event.type === WorkflowEvent.CancelRequested.type)).toHaveLength(1)
            expect(history.events.filter((event) => event.type === WorkflowEvent.Stage.Cancelled.type)).toHaveLength(1)
            expect(history.events.filter((event) => event.type === WorkflowEvent.Cancelled.type)).toHaveLength(1)
            expect(history.events.filter((event) => event.type === WorkflowEvent.Artifact.Created.type)).toHaveLength(
              config.artifacts,
            )
            expect(history.events.filter((event) => event.type === WorkflowEvent.Stage.Succeeded.type)).toHaveLength(
              config.prefixStages,
            )
            expect(JSON.stringify(history)).not.toContain("LATE_")
            expect(control.calls).toEqual([`${cutoff}.open`, `${cutoff}.close`])

            const rows = yield* database.db
              .select({
                aggregateID: EventTable.aggregate_id,
                type: EventTable.type,
                batchID: EventTable.batch_id,
                batchIndex: EventTable.batch_index,
                batchSize: EventTable.batch_size,
              })
              .from(EventTable)
              .where(inArray(EventTable.aggregate_id, [value.workflowID, responseID]))
              .all()
              .pipe(Effect.orDie)
            const request = rows.find(
              (row) =>
                row.aggregateID === value.workflowID &&
                row.type === EventV2.versionedType(WorkflowEvent.CancelRequested.type, 1),
            )!
            const responseCancelled = rows.find(
              (row) =>
                row.aggregateID === responseID &&
                row.type ===
                  EventV2.versionedType(ResponseEvent.Cancelled.type, ResponseEvent.Cancelled.durable!.version),
            )!
            expect(request.batchID).toBeDefined()
            expect(responseCancelled.batchID).toBe(request.batchID)
            expect([request.batchIndex, responseCancelled.batchIndex].sort()).toEqual([0, 1])
            expect(request.batchSize).toBe(2)
            expect(responseCancelled.batchSize).toBe(2)

            const raw = yield* database.db
              .select({ output: ResponseTable.output, error: ResponseTable.error, usage: ResponseTable.usage })
              .from(ResponseTable)
              .where(eq(ResponseTable.id, responseID))
              .get()
              .pipe(Effect.orDie)
            expect(raw).toEqual({ output: [], error: null, usage: null })

            const countBeforeSecondCancel = rows.length
            yield* workflow.cancel(value.workflowID)
            const countAfterSecondCancel = yield* database.db
              .select({ id: EventTable.id })
              .from(EventTable)
              .where(inArray(EventTable.aggregate_id, [value.workflowID, responseID]))
              .all()
              .pipe(Effect.orDie)
            expect(countAfterSecondCancel).toHaveLength(countBeforeSecondCancel)
          } else {
            const now = DateTime.toEpochMillis(yield* DateTime.now)
            const originalExpiry = DateTime.toEpochMillis(target.leaseExpiresAt!)
            const expiredAt = now - 1
            const updated = yield* database.db
              .update(WorkflowStageTable)
              .set({ lease_expires_at: expiredAt })
              .where(
                and(
                  eq(WorkflowStageTable.workflow_id, value.workflowID),
                  eq(WorkflowStageTable.id, target.id),
                  eq(WorkflowStageTable.status, "running"),
                  eq(WorkflowStageTable.attempt, target.attempt),
                  eq(WorkflowStageTable.lease_owner, target.leaseOwner!),
                  eq(WorkflowStageTable.lease_expires_at, originalExpiry),
                ),
              )
              .returning({ id: WorkflowStageTable.id })
              .all()
              .pipe(Effect.orDie)
            expect(updated).toEqual([{ id: target.id }])
            const eventCountAtFence = yield* database.db
              .select({ id: EventTable.id })
              .from(EventTable)
              .where(inArray(EventTable.aggregate_id, [value.workflowID, responseID]))
              .all()
              .pipe(Effect.orDie)

            yield* Deferred.succeed(control.release, undefined)
            yield* Deferred.await(control.settled)
            yield* waitUntil(
              () => execution.active.pipe(Effect.map((active) => !active.has(value.workflowID))),
              "stale execution resources were not disposed",
            )
            yield* drain

            const detail = yield* workflow.get(value.workflowID)
            const response = yield* responses.get(responseID)
            const stage = detail.stages[config.prefixStages]!
            expect(detail.run.status).toBe("running")
            expect(stage).toMatchObject({
              status: "running",
              attempt: 1,
              leaseOwner: options.ownerID,
            })
            expect(DateTime.toEpochMillis(stage.leaseExpiresAt!)).toBe(expiredAt)
            expect(response.status).toBe("in_progress")
            assertPrefix(cutoff, detail)
            const eventCountAfterLateResult = yield* database.db
              .select({ id: EventTable.id })
              .from(EventTable)
              .where(inArray(EventTable.aggregate_id, [value.workflowID, responseID]))
              .all()
              .pipe(Effect.orDie)
            expect(eventCountAfterLateResult).toHaveLength(eventCountAtFence.length)
            expect(control.calls).toEqual([`${cutoff}.open`, `${cutoff}.close`])
          }
          const afterClock = yield* Clock.currentTimeMillis
          expect(afterClock).toBe(beforeClock)
        }),
      )
    }
  }
})
