import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkflowVisualBuild } from "@opencode-ai/schema/workflow-visual-build"
import { makeWorkflowGroup, VisualBuildHeaders, WorkflowGroup, WorkflowHistoryQuery } from "../src/groups/workflow"

class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware>()("test/WorkflowLocation") {}

const visualBuild = {
  prompt: "Build a production landing page",
  budget: { maxAttempts: 2 },
  visual: { maxRevisions: 1, maxTokens: 12_000, maxTurns: 12, maxToolCalls: 24 },
  delivery: "background",
} as const

describe("Workflow protocol group", () => {
  test("exposes the workflow group and decodes bounded durable-history queries", async () => {
    const query = await Effect.runPromise(Schema.decodeUnknownEffect(WorkflowHistoryQuery)({ after: "3", limit: "10" }))

    expect(WorkflowGroup.identifier).toBe("server.workflow")
    expect(query).toEqual({ after: 3, limit: 10 })
  })

  test("exposes the exact visual-build endpoint and bounded idempotency header", () => {
    const group = makeWorkflowGroup(LocationMiddleware)
    const endpoint = group.endpoints["workflow.visualBuildCreate"]

    expect(endpoint.name).toBe("workflow.visualBuildCreate")
    expect(endpoint.method).toBe("POST")
    expect(endpoint.path).toBe("/api/workflow/visual-build")
    expect(endpoint.middlewares.size).toBe(1)
    expect(Schema.decodeUnknownSync(VisualBuildHeaders)({ "idempotency-key": "visual-build_retry.1" })).toEqual({
      "idempotency-key": "visual-build_retry.1",
    })
    expect(() => Schema.decodeUnknownSync(VisualBuildHeaders)({ "idempotency-key": "has a space" })).toThrow()
    expect(() => Schema.decodeUnknownSync(VisualBuildHeaders)({ "idempotency-key": "x".repeat(129) })).toThrow()
  })

  test("accepts only safe string values in visual-build preview environments", () => {
    const withEnvironment = (env: Record<string, unknown>) => ({
      ...visualBuild,
      preview: { kind: "script", argv: ["bun", "run", "preview"], env },
    })

    const decoded = Schema.decodeUnknownSync(WorkflowVisualBuild.CreateInput)(withEnvironment({ NODE_ENV: "test" }))
    expect(decoded.preview?.kind).toBe("script")
    if (decoded.preview?.kind !== "script") throw new Error("expected a script preview")
    expect(decoded.preview.env).toEqual({ NODE_ENV: "test" })
    expect(() => Schema.decodeUnknownSync(WorkflowVisualBuild.CreateInput)(withEnvironment({ PORT: 4096 }))).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowVisualBuild.CreateInput)(withEnvironment({ "BAD-NAME": "x" })),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowVisualBuild.CreateInput)(withEnvironment({ NODE_OPTIONS: "x\ny" })),
    ).toThrow()
  })

  test.each(["directory", "workspaceID", "url", "model", "provider", "command", "placement", "idempotencyKey"])(
    "strictly rejects public visual-build field %s",
    (field) => {
      expect(() =>
        Schema.decodeUnknownSync(WorkflowVisualBuild.CreateInput)({ ...visualBuild, [field]: "forged" }),
      ).toThrow()
    },
  )
})
