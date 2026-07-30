import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { WorkflowState } from "@opencode-ai/core/workflow/state"

describe("workflow schema", () => {
  test("uses stable prefixed identifiers", () => {
    expect(Workflow.ID.create()).toStartWith("wfl_")
    expect(Workflow.StageID.create()).toStartWith("wfs_")
    expect(Workflow.ArtifactID.create()).toStartWith("wfa_")
  })

  test("decodes a durable created event", () => {
    const decoded = Schema.decodeUnknownSync(WorkflowEvent.Durable)({
      id: "evt_created",
      type: "workflow.created",
      durable: { aggregateID: "wfl_test", seq: 0, version: 1 },
      data: {
        workflowID: "wfl_test",
        timestamp: 1_717_171_717_000,
        type: "development",
        input: { brief: "Build a page" },
        budget: { maxAttempts: 3 },
        stages: [{
          id: "wfs_design",
          type: "design",
          ordinal: 0,
          maxAttempts: 3,
          recoveryPolicy: "restart_safe",
          idempotencyKey: "wfl_test/design",
          input: {},
        }],
      },
    })
    expect(decoded.type).toBe("workflow.created")
  })
})

describe("workflow stage transitions", () => {
  test.each([
    ["pending", "leased"],
    ["leased", "running"],
    ["running", "succeeded"],
    ["running", "retry_wait"],
    ["running", "waiting_approval"],
    ["retry_wait", "leased"],
    ["waiting_approval", "retry_wait"],
  ] as const)("%s -> %s is allowed", (from, to) => {
    expect(() => WorkflowState.assertStageTransition(from, to)).not.toThrow()
  })

  test("a terminal stage cannot return to running", () => {
    expect(() => WorkflowState.assertStageTransition("succeeded", "running")).toThrow("succeeded -> running")
  })
})
