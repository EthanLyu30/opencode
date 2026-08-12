import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowStageTable } from "@opencode-ai/core/workflow/sql"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { ResponsesProjector } from "@opencode-ai/core/responses/projector"
import { ResponsesStore } from "@opencode-ai/core/responses/store"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { tmpdir } from "./fixture/tmpdir"

const workerPath = fileURLToPath(new URL("./workflow-crash-worker.ts", import.meta.url))

const createInput = (policy: Workflow.RecoveryPolicy, suffix: string, maxAttempts = 3): Workflow.CreateInput => ({
  id: Workflow.ID.make(`wfl_crash_${suffix}`),
  type: "development",
  input: { brief: `Crash ${policy}` },
  budget: { maxAttempts },
  stages: [
    {
      id: Workflow.StageID.make(`wfs_crash_${suffix}`),
      type: "build",
      ordinal: 0,
      maxAttempts,
      recoveryPolicy: policy,
      idempotencyKey: `crash/${suffix}`,
      input: {},
    },
  ],
})

const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    while (!predicate(yield* effect)) yield* Effect.sleep(10)
  }).pipe(Effect.timeout("5 seconds"))

async function runCrash(policy: "restart_safe" | "manual_required", maxAttempts = 3) {
  await using temporary = await tmpdir()
  const suffix = `${policy}_${crypto.randomUUID()}`
  const input = createInput(policy, suffix, maxAttempts)
  const workflowID = input.id!
  const stageID = input.stages[0].id!
  const databasePath = path.join(temporary.path, "workflow-crash.sqlite")
  const markerPath = path.join(temporary.path, "started.json")
  const database = Database.layerFromPath(databasePath)
  const seedLayer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      WorkflowV2.node,
      WorkflowStore.node,
      ResponsesProjector.node,
      ResponsesStore.node,
      ResponsesV2.node,
    ]),
    [[Database.node, database]],
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      yield* workflow.create(input)
    }).pipe(Effect.provide(seedLayer), Effect.scoped),
  )

  const child = Bun.spawn([process.execPath, workerPath, databasePath, workflowID, policy, markerPath], {
    cwd: path.dirname(workerPath),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Crash worker timed out for ${policy}`)), 5_000)
      }),
    ])
    const [output, errorOutput] = await Promise.all([stdout, stderr])
    if (exitCode !== 17) {
      throw new Error(`Crash worker exited ${exitCode}\nstdout: ${output}\nstderr: ${errorOutput}`)
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await child.exited
    await Promise.allSettled([stdout, stderr])
  }
  const marker = JSON.parse(await readFile(markerPath, "utf8"))
  expect(marker).toEqual({ workflowID, stageID, attempt: 1, policy })

  await Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .update(WorkflowStageTable)
        .set({ lease_expires_at: DateTime.toEpochMillis(yield* DateTime.now) - 1 })
        .where(eq(WorkflowStageTable.id, stageID))
        .run()
        .pipe(Effect.orDie)
    }).pipe(Effect.provide(database), Effect.scoped),
  )

  const calls: number[] = []
  const executor = Layer.succeed(
    WorkflowExecutor.Service,
    WorkflowExecutor.Service.of({
      execute: ({ stage }) =>
        Effect.sync(() => {
          calls.push(stage.attempt)
          return { usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 } }
        }),
    }),
  )
  const restartLayer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      WorkflowV2.node,
      WorkflowStore.node,
      WorkflowExecutor.node,
      WorkflowExecution.node,
      ResponsesProjector.node,
      ResponsesStore.node,
      ResponsesV2.node,
    ]),
    [
      [Database.node, database],
      [WorkflowExecutor.node, executor],
      [
        WorkflowExecution.node,
        WorkflowExecutionLocal.nodeWith({
          ownerID: `worker-restart-${policy}`,
          leaseDurationMs: 5_000,
          heartbeatIntervalMs: 1_000,
          pollIntervalMs: 5,
          concurrency: 1,
        }),
      ],
    ],
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      if (policy === "restart_safe") {
        if (maxAttempts === 1) {
          yield* eventually(workflow.get(workflowID), (detail) => detail.run.status === "waiting_approval")
          const detail = yield* workflow.get(workflowID)
          expect(detail.stages[0].attempt).toBe(1)
          expect(detail.stages[0].error?.code).toBe("max_attempts_exhausted")
          expect(calls).toEqual([])
          return
        }
        yield* eventually(workflow.get(workflowID), (detail) => detail.run.status === "succeeded")
        const detail = yield* workflow.get(workflowID)
        const history = yield* workflow.history({ workflowID, limit: 50 })
        const types = history.events.map((event) => event.type)
        expect(detail.stages[0].attempt).toBe(2)
        expect(calls).toEqual([2])
        expect(types.filter((type) => type === "workflow.stage.leased")).toHaveLength(2)
        expect(types.filter((type) => type === "workflow.stage.started")).toHaveLength(2)
        expect(types).toEqual(
          expect.arrayContaining([
            "workflow.created",
            "workflow.stage.leased",
            "workflow.stage.started",
            "workflow.stage.retry_scheduled",
            "workflow.stage.succeeded",
            "workflow.succeeded",
          ]),
        )
        return
      }

      const detail = yield* workflow.get(workflowID)
      expect(detail.run.status).toBe("waiting_approval")
      expect(detail.stages[0].status).toBe("waiting_approval")
      yield* Effect.sleep(50)
      expect(calls).toEqual([])
    }).pipe(Effect.provide(restartLayer), Effect.scoped),
  )
}

test("a crashed restart-safe worker resumes at attempt two", () => runCrash("restart_safe"), 15_000)

test("a crashed restart-safe worker cannot exceed a one-attempt stage limit", () => runCrash("restart_safe", 1), 15_000)

test("a crashed manual-recovery worker waits for approval", () => runCrash("manual_required"), 15_000)

test("a cancellation requested after a worker crash survives restart and fences stale settlement", async () => {
  await using temporary = await tmpdir()
  const suffix = `cancel_${crypto.randomUUID()}`
  const input = createInput("restart_safe", suffix)
  const workflowID = input.id!
  const stageID = input.stages[0].id!
  const databasePath = path.join(temporary.path, "workflow-crash-cancel.sqlite")
  const markerPath = path.join(temporary.path, "started.json")
  const database = Database.layerFromPath(databasePath)
  const seedLayer = AppNodeBuilder.build(LayerNode.group([Database.node, WorkflowV2.node, WorkflowStore.node]), [
    [Database.node, database],
  ])
  await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      yield* workflow.create(input)
    }).pipe(Effect.provide(seedLayer), Effect.scoped),
  )

  const child = Bun.spawn([process.execPath, workerPath, databasePath, workflowID, "restart_safe", markerPath], {
    cwd: path.dirname(workerPath),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const exitCode = await child.exited
  const [output, errorOutput] = await Promise.all([stdout, stderr])
  if (exitCode !== 17) throw new Error(`Crash worker exited ${exitCode}\nstdout: ${output}\nstderr: ${errorOutput}`)

  await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const db = (yield* Database.Service).db
      yield* workflow.cancel(workflowID)
      yield* db
        .update(WorkflowStageTable)
        .set({ lease_expires_at: DateTime.toEpochMillis(yield* DateTime.now) - 1 })
        .where(eq(WorkflowStageTable.id, stageID))
        .run()
        .pipe(Effect.orDie)
    }).pipe(Effect.provide(seedLayer), Effect.scoped),
  )

  const calls: number[] = []
  const restartLayer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      WorkflowV2.node,
      WorkflowStore.node,
      WorkflowExecutor.node,
      WorkflowExecution.node,
    ]),
    [
      [Database.node, database],
      [
        WorkflowExecutor.node,
        Layer.succeed(
          WorkflowExecutor.Service,
          WorkflowExecutor.Service.of({
            execute: ({ stage }) =>
              Effect.sync(() => {
                calls.push(stage.attempt)
                return { usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 } }
              }),
          }),
        ),
      ],
      [
        WorkflowExecution.node,
        WorkflowExecutionLocal.nodeWith({
          ownerID: "worker-restart-cancel",
          leaseDurationMs: 5_000,
          heartbeatIntervalMs: 1_000,
          pollIntervalMs: 5,
          concurrency: 1,
        }),
      ],
    ],
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const events = yield* EventV2.Service
      yield* eventually(workflow.get(workflowID), (detail) => detail.run.status === "cancelled")
      const detail = yield* workflow.get(workflowID)
      const stale = yield* events
        .publish(WorkflowEvent.Stage.Succeeded, {
          workflowID,
          stageID,
          timestamp: yield* DateTime.now,
          attempt: 1,
          leaseOwner: "worker-crash-restart_safe",
          usage: { tokens: 1, turns: 1, toolCalls: 1, attempts: 0 },
        })
        .pipe(Effect.exit)

      expect(detail.run.status).toBe("cancelled")
      expect(detail.stages[0].status).toBe("cancelled")
      expect(calls).toEqual([])
      expect(Exit.isFailure(stale)).toBe(true)
      const settled = yield* workflow.get(workflowID)
      expect(settled.run.usage).toEqual({ tokens: 0, turns: 0, toolCalls: 0, attempts: 1 })
      expect(settled.artifacts).toEqual([])
    }).pipe(Effect.provide(restartLayer), Effect.scoped),
  )
}, 15_000)
