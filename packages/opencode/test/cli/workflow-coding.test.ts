import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliProcessIt } from "../lib/cli-process"
import { observeWorkflow, workflowCodingRunLimits, workflowRunLimits } from "../../src/cli/cmd/workflow"
import { fixtureAdmissionSnapshot } from "../../../core/test/fixtures/workflow-model-catalog"

const preload = path.join(import.meta.dir, "fixtures", "workflow-coding-server-preload.ts")
describe("coding workflow CLI", () => {
  test("coding progress uses frozen code-review routing and engineering labels without visual artifacts", async () => {
    const routes = fixtureAdmissionSnapshot().routes
    const codingRoutes = {
      design: routes.design,
      decompose: routes.decompose,
      implement: routes.implement,
      test: routes.test,
      code_review: routes.design,
      repair: routes.repair,
      deliver: routes.deliver,
    }
    const workflowID = "wfl_coding"
    const stage = (role: string, ordinal: number) => ({
      id: `wfs_${role}`,
      type: role,
      ordinal,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe",
      idempotencyKey: role,
      input: { revision: 0 },
    })
    const event = (seq: number, type: string, data: object) => ({
      id: `evt_${seq}`,
      type,
      durable: { aggregateID: workflowID, seq, version: 1 },
      data: { workflowID, timestamp: seq, ...data },
    })
    const artifact = (role: string, kind: string) => ({
      stageID: `wfs_${role}`,
      artifact: {
        id: `wfa_${role}`,
        workflowID,
        stageID: `wfs_${role}`,
        kind,
        uri: "workflow://private",
        mime: "application/json",
        sha256: "a".repeat(64),
        size: 1,
        metadata: {},
        timeCreated: 1,
      },
    })
    const progress: string[] = []
    const events = [
      event(0, "workflow.created", {
        type: "coding-build",
        input: { "workflow.coding-model-selection.v1": { routes: codingRoutes } },
        budget: { maxAttempts: 27 },
        stages: [stage("design", 0), stage("code_review", 1)],
      }),
      event(1, "workflow.stage.started", { stageID: "wfs_code_review", attempt: 1 }),
      event(2, "workflow.artifact.created", artifact("design", "workflow.coding.plan")),
      event(3, "workflow.artifact.created", artifact("code_review", "workflow.coding.review")),
      event(4, "workflow.succeeded", { usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 } }),
    ]
    const result = await observeWorkflow({
      workflowID,
      signal: new AbortController().signal,
      onProgress: (line) => progress.push(line),
      client: {
        events: async function* () {
          yield* events
        },
        history: async () => {
          throw new Error("no gap")
        },
        get: async () => {
          throw new Error("no approval")
        },
      },
    })
    expect(result.type).toBe("terminal")
    expect(progress).toEqual([
      `${routes.design.providerID}/${routes.design.modelID} code_review r0 started`,
      "Engineering plan recorded for r0",
      "Code review recorded for r0",
      "Workflow succeeded",
    ])
  })
  test("coding defaults allow the nine-stage graph without altering visual defaults or explicit budgets", () => {
    expect(workflowRunLimits().budget.maxAttempts).toBe(3)
    expect(workflowCodingRunLimits()).toEqual({
      budget: { maxTokens: 20000, maxTurns: 20, maxToolCalls: 40, maxAttempts: 27, maxDurationMs: 1800000 },
      coding: { maxRevisions: 1, maxTokens: 12000, maxTurns: 12, maxToolCalls: 24 },
    })
    expect(workflowCodingRunLimits('{"maxAttempts":2}').budget).toEqual({ maxAttempts: 2 })
    expect(() => workflowCodingRunLimits("bad-json")).toThrow()
    expect(() => workflowCodingRunLimits(undefined, '{"maxRevisions":11}')).toThrow()
  })
  cliProcessIt.live(
    "coding CLI uses typed admission, stable connection retries and code-review progress without preview",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(
          ["workflow", "run", "Fix the coding fixture", "--kind", "coding", "--format", "json"],
          { preload },
        )
        expect(result.exitCode).toBe(0)
        expect(JSON.parse(result.stdout)).toMatchObject({
          workflow: { id: "wfl_coding", status: "succeeded" },
          response: { workflowID: "wfl_coding", status: "completed" },
        })
        expect(result.stderr).toContain("code_review r0 started")
        expect(result.stderr).not.toContain("visual_review")
        expect(JSON.parse(result.stdout).artifacts).toEqual([
          {
            kind: "workflow.coding.delivery",
            mime: "application/vnd.opencode.workflow-coding-delivery+json",
            size: 1,
            timeCreated: 1,
          },
        ])
        expect(result.stdout).not.toContain("offline-artifact-canary")
      }),
    { timeout: 30000 },
  )
  cliProcessIt.live(
    "invalid or conflicting kind options fail before any embedded admission",
    ({ opencode }) =>
      Effect.gen(function* () {
        for (const flags of [
          ["--kind", "unknown"],
          ["--kind", "coding", "--visual-budget", "{}"],
          ["--checks", '{"cwd":".","test":"bun-test"}'],
          ["--coding-budget", "{}"],
          ["--kind", "coding", "--checks", '{"cwd":"..","test":"bun-test"}'],
        ]) {
          const result = yield* opencode.spawn(["workflow", "run", "Fix the coding fixture", ...flags], {
            preload,
            env: { OPENCODE_TEST_CODING_REJECT: "1" },
          })
          expect(result.exitCode).toBe(1)
          expect(result.stderr).not.toContain("CODING_ADMISSION_CALLED")
        }
      }),
    { timeout: 60000 },
  )
})
