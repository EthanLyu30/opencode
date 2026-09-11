import { describe, expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Cause, DateTime, Duration, Effect, Exit, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal, handleLiveLifecycleConflict } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { WorkflowStageTable } from "@opencode-ai/core/workflow/sql"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { ResponsesProjector } from "@opencode-ai/core/responses/projector"
import { ResponsesStore } from "@opencode-ai/core/responses/store"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Session } from "@opencode-ai/schema/session"
import { Agent } from "@opencode-ai/schema/agent"
import { testEffect } from "./lib/effect"

const stalledExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({ execute: () => Effect.never }),
)

const lateResultExecutor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) =>
      stage.attempt === 1
        ? Effect.sleep(Duration.millis(50)).pipe(
            Effect.as({
              usage: { tokens: 37, turns: 3, toolCalls: 2, attempts: 0 },
              artifacts: [
                {
                  kind: "late-result",
                  uri: `artifact://${stage.workflowID}/late-result.json`,
                  mime: "application/json",
                  sha256: "d".repeat(64),
                  size: 2,
                  metadata: { attempt: 1 },
                },
              ],
            }),
          )
        : Effect.never,
  }),
)

const liveOptions: WorkflowExecutionLocal.Options = {
  ownerID: "worker-periodic-live",
  leaseDurationMs: 100,
  heartbeatIntervalMs: 20,
  pollIntervalMs: 5,
  concurrency: 1,
}

const recoveryOptions: WorkflowExecutionLocal.Options = {
  ownerID: "worker-periodic-recovery",
  leaseDurationMs: 5_000,
  heartbeatIntervalMs: 1_000,
  pollIntervalMs: 10,
  concurrency: 1,
}

const makeWorkerIt = (executor: Layer.Layer<WorkflowExecutor.Service>, options: WorkflowExecutionLocal.Options) =>
  testEffect(
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
        [WorkflowExecution.node, WorkflowExecutionLocal.nodeWith(options)],
        [WorkflowExecutor.node, executor],
      ],
    ),
  )

const stalledLiveIt = makeWorkerIt(stalledExecutor, liveOptions)
const stalledRecoveryIt = makeWorkerIt(stalledExecutor, recoveryOptions)
const lateResultIt = makeWorkerIt(lateResultExecutor, recoveryOptions)

const input = (
  suffix: string,
  recoveryPolicy: Workflow.RecoveryPolicy = "restart_safe",
  maxAttempts = 3,
): Workflow.CreateInput => ({
  id: Workflow.ID.make(`wfl_periodic_${suffix}`),
  type: "development",
  input: { brief: `Periodic lease recovery ${suffix}` },
  budget: { maxAttempts },
  stages: [
    {
      id: Workflow.StageID.make(`wfs_periodic_${suffix}`),
      type: "build",
      ordinal: 0,
      maxAttempts,
      recoveryPolicy,
      idempotencyKey: `periodic/${suffix}`,
      input: {},
    },
  ],
})

const admit = (workflow: WorkflowV2.Interface, value: Workflow.CreateInput) =>
  workflow.admit({
    ...value,
    location: Location.Ref.make({ directory: AbsolutePath.make("D:\\OpenCode-Audit") }),
    sessionID: Session.ID.make("ses_periodic_lease_recovery"),
    agent: Agent.ID.make("build"),
  })

const drain = Effect.gen(function* () {
  for (let index = 0; index < 100; index++) yield* Effect.yieldNow
})

const started = Effect.fnUntraced(function* (workflow: WorkflowV2.Interface, workflowID: Workflow.ID) {
  for (let index = 0; index < 100; index++) {
    const detail = yield* workflow.get(workflowID)
    if (detail.stages[0]?.status === "running") return detail
    yield* Effect.yieldNow
  }
  return yield* Effect.die("workflow stage did not start")
})

const expireExactLease = Effect.fnUntraced(function* (detail: Workflow.Detail) {
  const database = yield* Database.Service
  const stage = detail.stages[0]!
  const observed = DateTime.toEpochMillis(stage.leaseExpiresAt!)
  const now = DateTime.toEpochMillis(yield* DateTime.now)
  const updated = yield* database.db
    .update(WorkflowStageTable)
    .set({ lease_expires_at: now - 1 })
    .where(
      and(
        eq(WorkflowStageTable.workflow_id, detail.run.id),
        eq(WorkflowStageTable.id, stage.id),
        eq(WorkflowStageTable.status, "running"),
        eq(WorkflowStageTable.attempt, stage.attempt),
        eq(WorkflowStageTable.lease_owner, stage.leaseOwner!),
        eq(WorkflowStageTable.lease_expires_at, observed),
      ),
    )
    .returning({ id: WorkflowStageTable.id })
    .all()
    .pipe(Effect.orDie)
  expect(updated).toEqual([{ id: stage.id }])
  return { stage, expiredAt: now - 1 }
})

const eventsOf = <Event extends { readonly type: string }>(events: readonly Event[], type: string) =>
  events.filter((event) => event.type === type)

describe("periodic expired lease recovery", () => {
  stalledRecoveryIt.effect("quietly retires a live publisher only after another generation settled its authority", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const workflows = yield* WorkflowStore.Service
      const events = yield* EventV2.Service
      const value = input("live_publish_lost")
      yield* admit(workflow, value)
      const initial = yield* started(workflow, value.id!)
      const stage = initial.stages[0]!
      const timestamp = yield* DateTime.now

      yield* events.publish(WorkflowEvent.Stage.Succeeded, {
        workflowID: stage.workflowID,
        stageID: stage.id,
        timestamp,
        attempt: stage.attempt,
        leaseOwner: stage.leaseOwner,
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
      })

      const conflict = Cause.die(new WorkflowProjector.LifecycleConflict(stage.workflowID, stage.id))
      const handled = yield* handleLiveLifecycleConflict({
        cause: conflict,
        store: workflows,
        stage,
        ownerID: recoveryOptions.ownerID,
        now: DateTime.toEpochMillis(timestamp),
      }).pipe(Effect.exit)
      expect(Exit.isSuccess(handled)).toBe(true)
    }),
  )

  stalledRecoveryIt.effect(
    "does not hide a lifecycle defect while the exact live generation still owns its lease",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const workflows = yield* WorkflowStore.Service
        const value = input("live_publish_real_defect")
        yield* admit(workflow, value)
        const initial = yield* started(workflow, value.id!)
        const stage = initial.stages[0]!
        const now = DateTime.toEpochMillis(yield* DateTime.now)
        const conflict = Cause.die(new WorkflowProjector.LifecycleConflict(stage.workflowID, stage.id))

        const handled = yield* handleLiveLifecycleConflict({
          cause: conflict,
          store: workflows,
          stage,
          ownerID: recoveryOptions.ownerID,
          now,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(handled)).toBe(true)
      }),
  )

  stalledLiveIt.effect("a heartbeat renewal wins over a stale expired-generation recovery", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const workflows = yield* WorkflowStore.Service
      const events = yield* EventV2.Service
      const value = input("heartbeat_wins")
      yield* admit(workflow, value)
      const initial = yield* started(workflow, value.id!)
      const stage = initial.stages[0]!
      const observed = DateTime.toEpochMillis(stage.leaseExpiresAt!)
      const renewed = yield* workflows.renew({
        stageID: stage.id,
        owner: stage.leaseOwner!,
        attempt: stage.attempt,
        now: observed - 1,
        expiresAt: observed + 100,
      })
      expect(renewed).toBe(true)

      const stale = yield* events
        .publish(WorkflowEvent.Stage.RetryScheduled, {
          workflowID: value.id!,
          stageID: stage.id,
          timestamp: DateTime.makeUnsafe(observed + 1),
          attempt: stage.attempt,
          leaseOwner: stage.leaseOwner,
          failure: { category: "transient", code: "lease_expired", message: "stale recovery" },
          usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
          notBefore: DateTime.makeUnsafe(observed + 1),
          leaseFence: {
            variant: "expired_recovery",
            expectedStatus: "running",
            observedLeaseExpiresAt: DateTime.makeUnsafe(observed),
          },
        } as never)
        .pipe(Effect.exit)

      expect(Exit.isFailure(stale)).toBe(true)
      const detail = yield* workflow.get(value.id!)
      const history = yield* workflow.history({ workflowID: value.id!, limit: 100 })
      expect(detail.stages[0]).toMatchObject({
        status: "running",
        attempt: 1,
        leaseOwner: stage.leaseOwner,
      })
      expect(DateTime.toEpochMillis(detail.stages[0]!.leaseExpiresAt!)).toBe(observed + 100)
      expect(eventsOf(history.events, WorkflowEvent.Stage.RetryScheduled.type)).toHaveLength(0)
      expect(eventsOf(history.events, WorkflowEvent.Approval.Requested.type)).toHaveLength(0)
    }),
  )

  stalledRecoveryIt.effect("a running restart-safe expiry schedules exactly one retry on later ticks", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const value = input("restart_safe_once")
      yield* admit(workflow, value)
      const initial = yield* started(workflow, value.id!)
      const { stage, expiredAt } = yield* expireExactLease(initial)

      yield* TestClock.adjust(Duration.millis(10))
      yield* drain
      yield* TestClock.adjust(Duration.millis(50))
      yield* drain

      const detail = yield* workflow.get(value.id!)
      const history = yield* workflow.history({ workflowID: value.id!, limit: 100 })
      const retries = eventsOf(history.events, WorkflowEvent.Stage.RetryScheduled.type)
      expect(retries).toHaveLength(1)
      expect(retries[0]!.data).toMatchObject({
        workflowID: value.id!,
        stageID: stage.id,
        attempt: 1,
        leaseOwner: stage.leaseOwner,
        failure: { code: "lease_expired" },
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
        leaseFence: {
          variant: "expired_recovery",
          expectedStatus: "running",
        },
      })
      expect(
        DateTime.toEpochMillis(
          (retries[0]!.data as { leaseFence: { observedLeaseExpiresAt: DateTime.Utc } }).leaseFence
            .observedLeaseExpiresAt,
        ),
      ).toBe(expiredAt)
      expect(eventsOf(history.events, WorkflowEvent.Approval.Requested.type)).toHaveLength(0)
      expect(detail.stages[0]).toMatchObject({ status: "retry_wait", attempt: 1 })
      expect(detail.stages[0]!.leaseOwner).toBeUndefined()
      expect(detail.stages[0]!.leaseExpiresAt).toBeUndefined()
      expect(detail.run.status).toBe("running")
      expect(detail.run.usage).toEqual({ tokens: 0, turns: 0, toolCalls: 0, attempts: 1 })
    }),
  )

  stalledRecoveryIt.effect("a manual-required expiry requests approval exactly once on later ticks", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const value = input("manual_once", "manual_required")
      yield* admit(workflow, value)
      const initial = yield* started(workflow, value.id!)
      const { stage, expiredAt } = yield* expireExactLease(initial)

      yield* TestClock.adjust(Duration.millis(10))
      yield* drain
      yield* TestClock.adjust(Duration.millis(50))
      yield* drain

      const detail = yield* workflow.get(value.id!)
      const history = yield* workflow.history({ workflowID: value.id!, limit: 100 })
      const approvals = eventsOf(history.events, WorkflowEvent.Approval.Requested.type)
      expect(approvals).toHaveLength(1)
      expect(approvals[0]!.data).toMatchObject({
        workflowID: value.id!,
        stageID: stage.id,
        attempt: 1,
        leaseOwner: stage.leaseOwner,
        reason: "ambiguous_execution",
        failure: { code: "lease_expired" },
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
        leaseFence: {
          variant: "expired_recovery",
          expectedStatus: "running",
        },
      })
      expect(
        DateTime.toEpochMillis(
          (approvals[0]!.data as { leaseFence: { observedLeaseExpiresAt: DateTime.Utc } }).leaseFence
            .observedLeaseExpiresAt,
        ),
      ).toBe(expiredAt)
      expect(eventsOf(history.events, WorkflowEvent.Stage.RetryScheduled.type)).toHaveLength(0)
      expect(detail.stages[0]).toMatchObject({ status: "waiting_approval", attempt: 1 })
      expect(detail.stages[0]!.leaseOwner).toBeUndefined()
      expect(detail.stages[0]!.leaseExpiresAt).toBeUndefined()
      expect(detail.run.status).toBe("waiting_approval")
      expect(detail.run.usage).toEqual({ tokens: 0, turns: 0, toolCalls: 0, attempts: 1 })
    }),
  )

  stalledRecoveryIt.effect("an exhausted restart-safe expiry requests approval exactly once on later ticks", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const value = input("exhausted_once", "restart_safe", 1)
      yield* admit(workflow, value)
      const initial = yield* started(workflow, value.id!)
      const { stage, expiredAt } = yield* expireExactLease(initial)

      yield* TestClock.adjust(Duration.millis(10))
      yield* drain
      yield* TestClock.adjust(Duration.millis(50))
      yield* drain

      const detail = yield* workflow.get(value.id!)
      const history = yield* workflow.history({ workflowID: value.id!, limit: 100 })
      const approvals = eventsOf(history.events, WorkflowEvent.Approval.Requested.type)
      expect(approvals).toHaveLength(1)
      expect(approvals[0]!.data).toMatchObject({
        workflowID: value.id!,
        stageID: stage.id,
        attempt: 1,
        leaseOwner: stage.leaseOwner,
        reason: "ambiguous_execution",
        failure: { code: "max_attempts_exhausted" },
        leaseFence: { variant: "expired_recovery", expectedStatus: "running" },
      })
      expect(
        DateTime.toEpochMillis(
          (approvals[0]!.data as { leaseFence: { observedLeaseExpiresAt: DateTime.Utc } }).leaseFence
            .observedLeaseExpiresAt,
        ),
      ).toBe(expiredAt)
      expect(eventsOf(history.events, WorkflowEvent.Stage.RetryScheduled.type)).toHaveLength(0)
      expect(detail.stages[0]).toMatchObject({ status: "waiting_approval", attempt: 1 })
      expect(detail.run.status).toBe("waiting_approval")
    }),
  )

  lateResultIt.effect("an old fiber released after recovery publishes none of its late result", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const value = input("late_result")
      yield* admit(workflow, value)
      const initial = yield* started(workflow, value.id!)
      yield* expireExactLease(initial)

      yield* TestClock.adjust(Duration.millis(10))
      yield* drain
      yield* TestClock.adjust(Duration.millis(40))
      yield* drain

      const detail = yield* workflow.get(value.id!)
      const history = yield* workflow.history({ workflowID: value.id!, limit: 100 })
      expect(eventsOf(history.events, WorkflowEvent.Stage.RetryScheduled.type)).toHaveLength(1)
      expect(eventsOf(history.events, WorkflowEvent.Artifact.Created.type)).toHaveLength(0)
      expect(eventsOf(history.events, WorkflowEvent.Stage.Succeeded.type)).toHaveLength(0)
      expect(eventsOf(history.events, WorkflowEvent.Succeeded.type)).toHaveLength(0)
      expect(detail.artifacts).toEqual([])
      expect(detail.run.usage.tokens).toBe(0)
      expect(detail.run.usage.turns).toBe(0)
      expect(detail.run.usage.toolCalls).toBe(0)
    }),
  )
})
