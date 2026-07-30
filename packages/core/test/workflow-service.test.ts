import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { Workflow } from "@opencode-ai/schema/workflow"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(WorkflowV2.node))

const workflowID = Workflow.ID.make("wfl_service")
const createInput: Workflow.CreateInput = {
  id: workflowID,
  type: "development",
  input: { brief: "Build a page" },
  budget: { maxAttempts: 3 },
  stages: [
    {
      type: "design",
      ordinal: 0,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe" as const,
      idempotencyKey: "wfl_service/design",
      input: { format: "structured" },
    },
  ],
}

describe("Workflow", () => {
  it.effect("reconciles an exact create retry and rejects a changed type", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const first = yield* workflow.create(createInput)
      const same = yield* workflow.create(createInput)
      expect(same).toEqual(first)

      const conflict = yield* workflow.create({ ...createInput, type: "other" }).pipe(Effect.flip)
      expect(conflict._tag).toBe("Workflow.ConflictError")
    }),
  )

  it.effect("keeps secret guard failures in the typed error channel", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const error = yield* workflow
        .create({ ...createInput, id: Workflow.ID.make("wfl_secret"), input: { apiKey: "sk-live-secret" } })
        .pipe(Effect.flip)
      expect(error._tag).toBe("Workflow.UnsafePersistenceError")
      if (error._tag !== "Workflow.UnsafePersistenceError") throw new Error("expected unsafe persistence error")
      expect(error.path).toBe("$.input.apiKey")
    }),
  )

  it.effect("projects a monotonic budget increase before returning", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      yield* workflow.create(createInput)

      const updated = yield* workflow.updateBudget({
        workflowID,
        budget: { maxAttempts: 5, maxTokens: 10_000 },
      })
      expect(updated.budget).toEqual({ maxAttempts: 5, maxTokens: 10_000 })
      expect((yield* workflow.get(workflowID)).run.budget).toEqual({ maxAttempts: 5, maxTokens: 10_000 })
    }),
  )
})
