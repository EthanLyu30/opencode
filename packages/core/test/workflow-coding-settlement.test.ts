import { expect } from "bun:test"
import { DateTime, Effect, Layer, Stream } from "effect"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { WorkflowV2 } from "../src/workflow"
import { WorkflowExecution } from "../src/workflow/execution"
import { WorkflowExecutionLocal } from "../src/workflow/execution/local"
import { WorkflowExecutor } from "../src/workflow/executor"
import { testEffect } from "./lib/effect"
import { codingFixture } from "./fixtures/workflow-coding"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([WorkflowV2.node, EventV2.node, WorkflowExecution.node]), [
    [
      WorkflowExecution.node,
      WorkflowExecutionLocal.nodeWith({
        ownerID: "coding-final-gate-test",
        leaseDurationMs: 5000,
        heartbeatIntervalMs: 1000,
        pollIntervalMs: 5,
        concurrency: 1,
      }),
    ],
    [
      WorkflowExecutor.node,
      Layer.succeed(
        WorkflowExecutor.Service,
        WorkflowExecutor.Service.of({
          execute: () => Effect.succeed({ usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 }, artifacts: [] }),
        }),
      ),
    ],
  ]),
)

it.live(
  "Local fences a coding code_review result without a trusted receipt instead of treating it as a generic stage",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const workflow = yield* WorkflowV2.Service
      const execution = yield* WorkflowExecution.Service
      const workflowID = Workflow.ID.make("wfl_coding_final_gate")
      // Internal event fixture deliberately bypasses admission to test the independent final gate.
      yield* events.publish(WorkflowEvent.Created, {
        workflowID,
        timestamp: yield* DateTime.now,
        type: "coding-build",
        location: codingFixture().workflow.location!,
        input: {},
        budget: { maxAttempts: 3 },
        stages: [
          {
            id: Workflow.StageID.make("wfs_coding_final_gate"),
            type: "code_review",
            ordinal: 0,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "coding-build/code_review/r0",
            input: { revision: 0 },
          },
        ],
      })
      yield* execution.wake
      yield* workflow.events({ workflowID }).pipe(
        Stream.filter((event) => event.type === "workflow.failed"),
        Stream.runHead,
        Effect.timeout("5 seconds"),
      )
      const detail = yield* workflow.get(workflowID)
      expect(detail.run.status).toBe("failed")
      expect(detail.stages[0]!.error?.code).toBe("invalid_role_evidence")
      expect(detail.artifacts).toEqual([])
      const history = yield* workflow.history({ workflowID, limit: 100 })
      expect(
        history.events.some(
          (event) => event.type === "workflow.succeeded" || event.type === "workflow.artifact.created",
        ),
      ).toBe(false)
    }),
)
