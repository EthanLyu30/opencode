import { writeFileSync } from "node:fs"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { ResponsesProjector } from "@opencode-ai/core/responses/projector"
import { ResponsesStore } from "@opencode-ai/core/responses/store"
import { Workflow } from "@opencode-ai/schema/workflow"

const [databasePath, rawWorkflowID, rawPolicy, markerPath] = process.argv.slice(2)

if (!databasePath || !rawWorkflowID || !rawPolicy || !markerPath) {
  throw new Error("Expected database path, workflow ID, recovery policy, and marker path")
}
if (rawPolicy !== "restart_safe" && rawPolicy !== "manual_required") {
  throw new Error(`Unsupported recovery policy: ${rawPolicy}`)
}

const workflowID = Workflow.ID.make(rawWorkflowID)
const policy: Workflow.RecoveryPolicy = rawPolicy
const database = Database.layerFromPath(databasePath)
const executor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) =>
      Effect.sync(() => {
        writeFileSync(
          markerPath,
          JSON.stringify({ workflowID: stage.workflowID, stageID: stage.id, attempt: stage.attempt, policy }),
        )
        process.exit(17)
      }),
  }),
)
const worker = WorkflowExecutionLocal.nodeWith({
  ownerID: `worker-crash-${policy}`,
  leaseDurationMs: 60_000,
  heartbeatIntervalMs: 30_000,
  pollIntervalMs: 5,
  concurrency: 1,
})
const layer = AppNodeBuilder.build(
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
    [WorkflowExecution.node, worker],
  ],
)

await Effect.runPromise(
  Effect.gen(function* () {
    const workflow = yield* WorkflowV2.Service
    const execution = yield* WorkflowExecution.Service
    const detail = yield* workflow.get(workflowID)
    if (detail.stages[0]?.recoveryPolicy !== policy) {
      return yield* Effect.die("Worker recovery policy does not match the persisted stage")
    }
    yield* execution.wake
    yield* Effect.never
  }).pipe(Effect.provide(layer), Effect.scoped),
)
