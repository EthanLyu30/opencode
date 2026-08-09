import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventTable } from "@opencode-ai/core/event/sql"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowSecretGuard } from "@opencode-ai/core/workflow/secret-guard"
import { WorkflowArtifactTable, WorkflowRunTable, WorkflowStageTable } from "@opencode-ai/core/workflow/sql"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { Workflow } from "@opencode-ai/schema/workflow"
import { testEffect } from "./lib/effect"

const persistenceIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      WorkflowV2.node,
      WorkflowStore.node,
      WorkflowExecutor.node,
      WorkflowExecution.node,
    ]),
    [
      [
        WorkflowExecutor.node,
        Layer.succeed(
          WorkflowExecutor.Service,
          WorkflowExecutor.Service.of({
            execute: () =>
              Effect.fail({
                failure: {
                  category: "build" as const,
                  code: "sk-code-secret",
                  message: "request failed: Bearer live-secret and sk-test-secret",
                  ref: "Bearer ref-secret",
                },
                usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
              }),
          }),
        ),
      ],
      [
        WorkflowExecution.node,
        WorkflowExecutionLocal.nodeWith({
          ownerID: "worker-secret-scan",
          leaseDurationMs: 5_000,
          heartbeatIntervalMs: 1_000,
          pollIntervalMs: 5,
          concurrency: 1,
        }),
      ],
    ],
  ),
)

const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    while (!predicate(yield* effect)) yield* Effect.sleep(10)
  }).pipe(Effect.timeout("2 seconds"))

describe("WorkflowSecretGuard", () => {
  test.each([
    [{ apiKey: "sk-test-secret" }, "apiKey"],
    [{ headers: { Authorization: "Bearer live-secret" } }, "Authorization"],
    [{ uri: "https://example.test/file?token=live-secret" }, "token"],
    [{ password: "s3cr3t" }, "password"],
    [{ secret: "s3cr3t" }, "secret"],
    [{ access_token: "s3cr3t" }, "access_token"],
    [{ refresh_token: "s3cr3t" }, "refresh_token"],
    [{ cookie: "session=abc" }, "cookie"],
    [{ "set-cookie": "session=abc" }, "set-cookie"],
  ])("rejects sensitive persisted input %#", (value, field) => {
    expect(() => WorkflowSecretGuard.assertSafe(value)).toThrow(field)
  })

  test("rejects sensitive query params in url fields", () => {
    expect(() => WorkflowSecretGuard.assertSafe({ endpoint: "https://api.test/v1?key=abc&signature=xyz" })).toThrow()
  })

  test("allows safe values", () => {
    expect(() =>
      WorkflowSecretGuard.assertSafe({ name: "test", count: 42, enabled: true, items: ["a", "b"] }),
    ).not.toThrow()
  })

  test("sanitizes failure text without retaining the secret", () => {
    const value = WorkflowSecretGuard.sanitizeText("request failed: Bearer live-secret and sk-test-secret")
    expect(value).toBe("request failed: Bearer [REDACTED] and [REDACTED]")
  })

  test("sanitizes api key in text", () => {
    expect(WorkflowSecretGuard.sanitizeText("key: sk-abc123def456")).toBe("key: [REDACTED]")
  })

  test("rejects every repeated direct secret without regular expression state leaking", () => {
    expect(() => WorkflowSecretGuard.assertSafe("Bearer repeated-secret")).toThrow()
    expect(() => WorkflowSecretGuard.assertSafe("Bearer repeated-secret")).toThrow()
  })

  test("rejects cycles with a typed persistence error at the repeated path", () => {
    const value: Record<string, unknown> = {}
    value.self = value

    try {
      WorkflowSecretGuard.assertSafe(value)
      throw new Error("expected unsafe persistence error")
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowSecretGuard.UnsafePersistenceError)
      if (!(error instanceof WorkflowSecretGuard.UnsafePersistenceError)) throw error
      expect(error.path).toBe("$.self")
    }
  })

  test.each([undefined, 1n, () => "not json"])("rejects non-json persisted input %#", (value) => {
    expect(() => WorkflowSecretGuard.assertSafe(value)).toThrow(WorkflowSecretGuard.UnsafePersistenceError)
  })

  persistenceIt.live(
    "keeps rejected secrets and sanitized executor failures out of durable storage and logs",
    () =>
      Effect.gen(function* () {
        const workflow = yield* WorkflowV2.Service
        const db = (yield* Database.Service).db
        const rejectedID = Workflow.ID.make(`wfl_secret_rejected_${crypto.randomUUID()}`)
        const rejected = yield* workflow
          .create({
            id: rejectedID,
            type: "development",
            input: {
              apiKey: "sk-test-secret",
              environment: { MOONSHOT_API_KEY: "sk-test-secret", DEEPSEEK_API_KEY: "sk-test-secret" },
            },
            budget: { maxAttempts: 1 },
            stages: [
              {
                id: Workflow.StageID.make(`wfs_secret_rejected_${crypto.randomUUID()}`),
                type: "build",
                ordinal: 0,
                maxAttempts: 1,
                recoveryPolicy: "restart_safe",
                idempotencyKey: "secret/rejected",
                input: {},
              },
            ],
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)

        const workflowID = Workflow.ID.make(`wfl_secret_scan_${crypto.randomUUID()}`)
        yield* workflow.create({
          id: workflowID,
          type: "development",
          input: { brief: "Scan durable persistence" },
          budget: { maxAttempts: 1 },
          stages: [
            {
              id: Workflow.StageID.make(`wfs_secret_scan_${crypto.randomUUID()}`),
              type: "build",
              ordinal: 0,
              maxAttempts: 1,
              recoveryPolicy: "restart_safe",
              idempotencyKey: "secret/scan",
              input: {},
            },
          ],
        })
        yield* eventually(workflow.get(workflowID), (detail) => detail.run.status === "failed")

        const eventRows = yield* db.select({ data: EventTable.data }).from(EventTable).all().pipe(Effect.orDie)
        const runRows = yield* db
          .select({ id: WorkflowRunTable.id, input: WorkflowRunTable.input })
          .from(WorkflowRunTable)
          .all()
          .pipe(Effect.orDie)
        const stageRows = yield* db
          .select({ checkpoint: WorkflowStageTable.checkpoint, error: WorkflowStageTable.error })
          .from(WorkflowStageTable)
          .all()
          .pipe(Effect.orDie)
        const artifactRows = yield* db
          .select({ metadata: WorkflowArtifactTable.metadata })
          .from(WorkflowArtifactTable)
          .all()
          .pipe(Effect.orDie)
        const logRows = [...(yield* TestConsole.logLines), ...(yield* TestConsole.errorLines)]
        const durable = JSON.stringify({ eventRows, runRows, stageRows, artifactRows, logRows })

        expect(runRows.some((row) => row.id === rejectedID)).toBe(false)
        for (const secret of [
          "sk-test-secret",
          "sk-code-secret",
          "Bearer live-secret",
          "Bearer ref-secret",
          "MOONSHOT_API_KEY",
          "DEEPSEEK_API_KEY",
        ]) {
          expect(durable).not.toContain(secret)
        }
      }),
    5_000,
  )
})
