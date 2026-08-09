import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { WorkflowGroup, WorkflowHistoryQuery } from "../src/groups/workflow"

describe("Workflow protocol group", () => {
  test("exposes the workflow group and decodes bounded durable-history queries", async () => {
    const query = await Effect.runPromise(
      Schema.decodeUnknownEffect(WorkflowHistoryQuery)({ after: "3", limit: "10" }),
    )

    expect(WorkflowGroup.identifier).toBe("server.workflow")
    expect(query).toEqual({ after: 3, limit: 10 })
  })
})
