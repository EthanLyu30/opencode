import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliProcessIt } from "../lib/cli-process"
import { observeWorkflow } from "../../src/cli/cmd/workflow"

const preload = path.join(import.meta.dir, "fixtures", "workflow-server-preload.ts")

describe("workflow observer", () => {
  test("uses exclusive cursors and repairs duplicate, gap, paged history, and reconnect delivery once", async () => {
    const eventCalls: Array<{ workflowID: string; after?: number }> = []
    const historyCalls: Array<{ workflowID: string; after?: number; limit?: number }> = []
    const progress: string[] = []
    const created = workflowCreated(1)
    const design = stageEvent(2, "workflow.stage.started", "wfs_design")
    const testStage = stageEvent(3, "workflow.stage.started", "wfs_test_0")
    const budget = workflowEvent(4, "workflow.budget.threshold_reached", {
      workflowID: "wfl_fixture",
      timestamp: 4,
      percent: 80,
      dimension: "tokens",
      usage: usage(),
      budget: { maxTokens: 20_000 },
    })
    const repair = stageEvent(5, "workflow.stage.started", "wfs_repair_1")
    const visual = stageEvent(6, "workflow.stage.started", "wfs_visual_1")
    const artifact = workflowEvent(7, "workflow.artifact.created", {
      workflowID: "wfl_fixture",
      timestamp: 7,
      stageID: "wfs_visual_1",
      artifact: {
        id: "wfa_fixture",
        workflowID: "wfl_fixture",
        stageID: "wfs_visual_1",
        kind: "workflow.visual-review",
        uri: "workflow://must-not-be-used",
        mime: "application/json",
        sha256: "a".repeat(64),
        size: 1,
        metadata: { prompt: "must-not-be-used" },
        timeCreated: 7,
      },
    })
    const terminal = workflowEvent(8, "workflow.succeeded", {
      workflowID: "wfl_fixture",
      timestamp: 8,
      usage: usage(),
    })
    let connection = 0

    const result = await observeWorkflow({
      workflowID: "wfl_fixture",
      signal: new AbortController().signal,
      client: {
        events(input) {
          eventCalls.push(input)
          const current = connection++
          return stream(current === 0 ? [created, design] : [design, terminal])
        },
        async history(input) {
          historyCalls.push(input)
          if (input.after === 2) return { data: [testStage, budget], hasMore: true }
          if (input.after === 4) return { data: [repair, visual, artifact], hasMore: false }
          throw new Error(`unexpected history cursor ${String(input.after)}`)
        },
        async get() {
          throw new Error("terminal observation must not fetch workflow state")
        },
      },
      onProgress: (line) => progress.push(line),
      sleep: async () => undefined,
    })

    expect(result).toMatchObject({ type: "terminal", status: "succeeded", seq: 8 })
    expect(eventCalls).toEqual([{ workflowID: "wfl_fixture" }, { workflowID: "wfl_fixture", after: 2 }])
    expect(historyCalls).toEqual([
      { workflowID: "wfl_fixture", after: 2, limit: 100 },
      { workflowID: "wfl_fixture", after: 4, limit: 100 },
    ])
    expect(progress).toEqual([
      "Kimi K3 design r0 started",
      "DeepSeek V4 Flash test r0 started",
      "Budget 80% tokens",
      "DeepSeek V4 Pro repair r1 started",
      "Kimi K3 visual_review r1 started",
      "Visual evidence recorded for r1",
      "Workflow succeeded",
    ])
  })

  test("bounds empty and duplicate-only reconnects with the exact backoff schedule", async () => {
    for (const scenario of ["empty", "duplicate"] as const) {
      const eventCalls: Array<{ workflowID: string; after?: number }> = []
      const delays: number[] = []
      let failure: unknown
      try {
        await observeWorkflow({
          workflowID: "wfl_fixture",
          signal: new AbortController().signal,
          client: {
            events(input) {
              eventCalls.push(input)
              if (eventCalls.length > 6) throw new Error("observer exceeded its reconnect bound")
              if (scenario === "duplicate") return stream([workflowCreated(1)])
              return stream([])
            },
            async history() {
              throw new Error("duplicate or empty reconnects must not request history")
            },
            async get() {
              throw new Error("duplicate or empty reconnects must not fetch workflow state")
            },
          },
          onProgress: () => undefined,
          sleep: async (ms) => {
            delays.push(ms)
          },
        })
      } catch (error) {
        failure = error
      }

      if (!(failure instanceof Error)) throw new Error(`${scenario}: observer did not reach its reconnect bound`)
      expect(failure.name).toBe("WorkflowObservationError")
      expect(failure.message).toBe("Workflow event stream reconnect limit reached")
      expect(delays).toEqual([50, 100, 250, 500, 1_000])
      expect(eventCalls).toEqual([
        { workflowID: "wfl_fixture" },
        { workflowID: "wfl_fixture", after: scenario === "duplicate" ? 1 : 0 },
        { workflowID: "wfl_fixture", after: scenario === "duplicate" ? 1 : 0 },
        { workflowID: "wfl_fixture", after: scenario === "duplicate" ? 1 : 0 },
        { workflowID: "wfl_fixture", after: scenario === "duplicate" ? 1 : 0 },
        { workflowID: "wfl_fixture", after: scenario === "duplicate" ? 1 : 0 },
      ])
    }
  })

  test("resets reconnect backoff only after a processed cursor advance", async () => {
    const eventCalls: Array<{ workflowID: string; after?: number }> = []
    const delays: number[] = []
    const deliveries = [
      [] as ReadonlyArray<unknown>,
      [] as ReadonlyArray<unknown>,
      [workflowCreated(1)],
      [] as ReadonlyArray<unknown>,
      [
        workflowEvent(2, "workflow.succeeded", {
          workflowID: "wfl_fixture",
          timestamp: 2,
          usage: usage(),
        }),
      ],
    ]

    const result = await observeWorkflow({
      workflowID: "wfl_fixture",
      signal: new AbortController().signal,
      client: {
        events(input) {
          eventCalls.push(input)
          const delivery = deliveries.shift()
          if (!delivery) throw new Error("observer made an unexpected reconnect")
          return stream(delivery)
        },
        async history() {
          throw new Error("contiguous reconnects must not request history")
        },
        async get() {
          throw new Error("terminal observation must not fetch workflow state")
        },
      },
      onProgress: () => undefined,
      sleep: async (ms) => {
        delays.push(ms)
      },
    })

    expect(result).toEqual({ type: "terminal", status: "succeeded", seq: 2 })
    expect(delays).toEqual([50, 100, 50, 100])
    expect(eventCalls).toEqual([
      { workflowID: "wfl_fixture" },
      { workflowID: "wfl_fixture", after: 0 },
      { workflowID: "wfl_fixture", after: 0 },
      { workflowID: "wfl_fixture", after: 1 },
      { workflowID: "wfl_fixture", after: 1 },
    ])
  })

  test("confirms waiting approval from durable workflow state before returning", async () => {
    const gets: string[] = []
    const progress: string[] = []
    const result = await observeWorkflow({
      workflowID: "wfl_fixture",
      signal: new AbortController().signal,
      client: {
        events: () =>
          stream([
            workflowCreated(1),
            workflowEvent(2, "workflow.approval.requested", {
              workflowID: "wfl_fixture",
              timestamp: 2,
              reason: "budget_exhausted",
              failure: {
                category: "unknown",
                code: "approval_required",
                message: "raw-secret-must-not-render",
              },
            }),
          ]),
        async history() {
          throw new Error("contiguous approval must not request history")
        },
        async get(input) {
          gets.push(input.workflowID)
          return workflowDetail("waiting_approval")
        },
      },
      onProgress: (line) => progress.push(line),
      sleep: async () => undefined,
    })

    expect(result).toMatchObject({ type: "approval", status: "waiting_approval", seq: 2 })
    expect(gets).toEqual(["wfl_fixture"])
    expect(progress).toEqual(["Approval required"])
    expect(progress.join(" ")).not.toContain("raw-secret")
  })

  test("surfaces a durable event schema error instead of treating it as a reconnect", async () => {
    let failure: unknown
    try {
      await observeWorkflow({
        workflowID: "wfl_fixture",
        signal: new AbortController().signal,
        client: {
          events: () => stream([{ ...workflowCreated(1), durable: { aggregateID: "wfl_other", seq: 1, version: 1 } }]),
          async history() {
            throw new Error("history must not run for a malformed contiguous event")
          },
          async get() {
            throw new Error("get must not run for a malformed contiguous event")
          },
        },
        onProgress: () => undefined,
        sleep: async () => {
          throw new Error("schema failure was incorrectly retried")
        },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error("observer did not surface an Error")
    expect(failure.message).toContain("Workflow event authority is invalid")
  })

  test("rejects non-authoritative durable event schemas before advancing or reconnecting", async () => {
    const malformed = [
      {
        label: "unknown event type",
        event: workflowEvent(1, "workflow.raw-secret-sentinel", {
          workflowID: "wfl_fixture",
          timestamp: 1,
        }),
      },
      {
        label: "missing event-specific field",
        event: workflowEvent(1, "workflow.succeeded", {
          workflowID: "wfl_fixture",
          timestamp: 1,
        }),
      },
      {
        label: "wrong durable version",
        event: {
          ...workflowEvent(1, "workflow.succeeded", {
            workflowID: "wfl_fixture",
            timestamp: 1,
            usage: usage(),
          }),
          durable: { aggregateID: "wfl_fixture", seq: 1, version: 2 },
        },
      },
      {
        label: "wrong event-specific field type",
        event: workflowEvent(1, "workflow.stage.started", {
          workflowID: "wfl_fixture",
          timestamp: 1,
          stageID: "wfs_design",
          attempt: "raw-secret-sentinel",
        }),
      },
    ] as const

    for (const item of malformed) {
      let eventCalls = 0
      let historyCalls = 0
      let sleeps = 0
      let failure: unknown
      try {
        await observeWorkflow({
          workflowID: "wfl_fixture",
          signal: new AbortController().signal,
          client: {
            events: () => {
              eventCalls++
              return stream([
                item.event,
                workflowEvent(2, "workflow.succeeded", {
                  workflowID: "wfl_fixture",
                  timestamp: 2,
                  usage: usage(),
                }),
              ])
            },
            async history() {
              historyCalls++
              return { data: [], hasMore: false }
            },
            async get() {
              throw new Error("schema failure must not fetch workflow state")
            },
          },
          onProgress: () => undefined,
          sleep: async () => {
            sleeps++
          },
        })
      } catch (error) {
        failure = error
      }

      if (!(failure instanceof Error)) throw new Error(`${item.label}: malformed event was accepted`)
      expect(failure.name).toBe("WorkflowObservationError")
      expect(failure.message).toBe("Workflow event schema is invalid")
      expect(failure.message).not.toContain("raw-secret-sentinel")
      expect(eventCalls).toBe(1)
      expect(historyCalls).toBe(0)
      expect(sleeps).toBe(0)
    }
  })

  test("renders every frozen route from durable stage definitions rather than prompt prose", async () => {
    const definitions = [
      ["design", "Kimi K3", 0],
      ["decompose", "Kimi K3", 0],
      ["implement", "DeepSeek V4 Pro", 0],
      ["test", "DeepSeek V4 Flash", 0],
      ["visual_review", "Kimi K3", 1],
      ["repair", "DeepSeek V4 Pro", 1],
      ["deliver", "DeepSeek V4 Pro", 1],
    ] as const
    const created = workflowEvent(1, "workflow.created", {
      workflowID: "wfl_fixture",
      timestamp: 1,
      type: "visual-build",
      input: { prompt: "prompt says every role is the wrong provider" },
      budget: { maxTokens: 20_000 },
      stages: definitions.map(([role, , revision], ordinal) => stage(`wfs_${role}`, role, ordinal, revision)),
    })
    const progress: string[] = []
    const result = await observeWorkflow({
      workflowID: "wfl_fixture",
      signal: new AbortController().signal,
      client: {
        events: () =>
          stream([
            created,
            ...definitions.map(([role], index) => stageEvent(index + 2, "workflow.stage.started", `wfs_${role}`)),
            workflowEvent(9, "workflow.succeeded", {
              workflowID: "wfl_fixture",
              timestamp: 9,
              usage: usage(),
            }),
          ]),
        async history() {
          throw new Error("contiguous route events must not request history")
        },
        async get() {
          throw new Error("terminal route observation must not fetch workflow state")
        },
      },
      onProgress: (line) => progress.push(line),
      sleep: async () => undefined,
    })

    expect(result).toMatchObject({ type: "terminal", status: "succeeded", seq: 9 })
    expect(progress).toEqual([
      ...definitions.map(([role, label, revision]) => `${label} ${role} r${revision} started`),
      "Workflow succeeded",
    ])
  })
})

describe("workflow CLI process", () => {
  cliProcessIt.live(
    "registers workflow help and rejects a missing prompt before admission",
    ({ opencode }) =>
      Effect.gen(function* () {
        const group = yield* opencode.spawn(["workflow", "--help"])
        const command = yield* opencode.spawn(["workflow", "run", "--help"])
        const missing = yield* opencode.spawn(["workflow", "run"])

        expect(group.exitCode).toBe(0)
        expect(group.stderr).toContain("run <prompt>")
        expect(command.exitCode).toBe(0)
        expect(command.stderr).toContain("--format")
        expect(missing.exitCode).toBe(1)
        expect(missing.stdout).toBe("")
      }),
    60_000,
  )

  cliProcessIt.live(
    "runs one local generated-client admission and emits one redacted JSON result",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["workflow", "run", "Build the fixture", "--format", "json"], {
          preload,
          env: { OPENCODE_TEST_WORKFLOW_SCENARIO: "success" },
          timeoutMs: 20_000,
        })

        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim().split("\n")).toHaveLength(1)
        expect(JSON.parse(result.stdout)).toEqual({
          workflow: {
            id: "wfl_fixture",
            status: "succeeded",
            usage: usage(),
            time: { created: 1, updated: 8, completed: 8 },
          },
          response: {
            id: "resp_fixture",
            workflowID: "wfl_fixture",
            status: "completed",
            background: true,
            store: true,
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            createdAt: 1,
            completedAt: 8,
          },
          artifacts: [
            {
              kind: "workflow.delivery",
              mime: "application/vnd.opencode.workflow-delivery+json",
              size: 123,
              timeCreated: 8,
            },
            {
              kind: "workflow.artifact",
              mime: "application/octet-stream",
              size: 7,
              timeCreated: 8,
            },
          ],
        })
        expect(result.stderr).toContain("Kimi K3 design r0 started")
        expect(result.stderr).toContain("DeepSeek V4 Flash test r0 started")
        expect(result.stderr).toContain("Kimi K3 visual_review r1 started")
        expect(result.stderr).toContain("Budget 80% tokens")

        const visible = result.stdout + result.stderr
        for (const forbidden of [
          "raw-output-secret",
          "raw-error-secret",
          "metadata-secret",
          "provider-secret",
          "credentials-secret",
          "preview-env-secret",
          "data:image/png;base64",
          "workflow://",
          "http://127.0.0.1",
        ]) {
          expect(visible).not.toContain(forbidden)
        }
      }),
    60_000,
  )

  cliProcessIt.live(
    "maps approval, failure, and durable cancellation to exact exit codes",
    ({ opencode }) =>
      Effect.gen(function* () {
        const cases = [
          ["approval", 2, "waiting_approval"],
          ["failed", 1, "failed"],
          ["cancelled", 130, "cancelled"],
        ] as const

        for (const [scenario, exitCode, status] of cases) {
          const result = yield* opencode.spawn(["workflow", "run", "Build the fixture", "--format", "json"], {
            preload,
            env: { OPENCODE_TEST_WORKFLOW_SCENARIO: scenario },
            timeoutMs: 20_000,
          })
          expect(result.exitCode).toBe(exitCode)
          expect(result.stdout.trim().split("\n")).toHaveLength(1)
          expect(JSON.parse(result.stdout)).toMatchObject({ workflow: { status }, artifacts: [] })
          expect(result.stdout + result.stderr).not.toContain("raw-error-secret")
        }
      }),
    90_000,
  )

  cliProcessIt.live(
    "maps admission transport and durable event schema failures to a redacted exit 1 result",
    ({ opencode }) =>
      Effect.gen(function* () {
        for (const scenario of ["transport", "schema"] as const) {
          const result = yield* opencode.spawn(["workflow", "run", "Build the fixture", "--format", "json"], {
            preload,
            env: { OPENCODE_TEST_WORKFLOW_SCENARIO: scenario },
            timeoutMs: 20_000,
          })
          expect(result.exitCode).toBe(1)
          expect(result.stdout.trim().split("\n")).toHaveLength(1)
          expect(JSON.parse(result.stdout)).toEqual({ workflow: null, response: null, artifacts: [] })
          expect(result.stdout + result.stderr).not.toContain("raw-error-secret")
        }
      }),
    60_000,
  )

  cliProcessIt.live(
    "awaits one un-aborted durable cancel acknowledgement and exits promptly on SIGINT",
    ({ opencode }) =>
      Effect.gen(function* () {
        const child = yield* opencode.start(["workflow", "run", "Build the fixture", "--format", "json"], {
          preload,
          env: { OPENCODE_TEST_WORKFLOW_SCENARIO: "sigint" },
          timeoutMs: 10_000,
        })
        yield* child.waitForStderr("Workflow admitted", 8_000)
        const cancellationStartedAt = Date.now()
        const result = yield* child.result.pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die(new Error("workflow child did not exit promptly after SIGINT")),
          }),
        )

        expect(result.exitCode).toBe(130)
        expect(Date.now() - cancellationStartedAt).toBeLessThan(5_000)
        expect(result.stderr).toContain("Cancellation acknowledged")
        expect(result.stdout.trim().split("\n")).toHaveLength(1)
        expect(JSON.parse(result.stdout)).toMatchObject({ workflow: { status: "cancel_requested" } })
      }),
    60_000,
  )

  cliProcessIt.live(
    "resolves a SIGINT race from one cancel conflict and one un-aborted terminal read",
    ({ opencode }) =>
      Effect.gen(function* () {
        const child = yield* opencode.start(["workflow", "run", "Build the fixture", "--format", "json"], {
          preload,
          env: { OPENCODE_TEST_WORKFLOW_SCENARIO: "sigint-terminal-race" },
          timeoutMs: 10_000,
        })
        yield* child.waitForStderr("Workflow admitted", 8_000)
        const cancellationStartedAt = Date.now()
        const result = yield* child.result.pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die(new Error("workflow child did not resolve the SIGINT terminal race promptly")),
          }),
        )

        expect(result.exitCode).toBe(130)
        expect(Date.now() - cancellationStartedAt).toBeLessThan(5_000)
        expect(result.stdout.trim().split("\n")).toHaveLength(1)
        expect(JSON.parse(result.stdout)).toMatchObject({
          workflow: { id: "wfl_fixture", status: "succeeded" },
          response: { id: "resp_fixture", workflowID: "wfl_fixture", status: "queued" },
          artifacts: [],
        })
        expect(result.stdout + result.stderr).not.toContain("raw-error-secret")
      }),
    60_000,
  )

  cliProcessIt.live(
    "keeps non-terminal cancel conflicts and genuine cancel failures on redacted exit 1",
    ({ opencode }) =>
      Effect.gen(function* () {
        for (const scenario of ["sigint-conflict-nonterminal", "sigint-cancel-failure"] as const) {
          const result = yield* opencode.spawn(["workflow", "run", "Build the fixture", "--format", "json"], {
            preload,
            env: { OPENCODE_TEST_WORKFLOW_SCENARIO: scenario },
            timeoutMs: 10_000,
          })
          expect(result.exitCode).toBe(1)
          expect(result.stdout.trim().split("\n")).toHaveLength(1)
          expect(JSON.parse(result.stdout)).toEqual({ workflow: null, response: null, artifacts: [] })
          expect(result.stdout + result.stderr).not.toContain("raw-error-secret")
        }
      }),
    60_000,
  )
})

function usage() {
  return { tokens: 15, turns: 6, toolCalls: 3, attempts: 2 }
}

function workflowCreated(seq: number) {
  return workflowEvent(seq, "workflow.created", {
    workflowID: "wfl_fixture",
    timestamp: seq,
    type: "visual-build",
    input: { prompt: "prompt-must-not-be-used-for-routing" },
    budget: { maxTokens: 20_000 },
    stages: [
      stage("wfs_design", "design", 0, 0),
      stage("wfs_test_0", "test", 1, 0),
      stage("wfs_repair_1", "repair", 2, 1),
      stage("wfs_visual_1", "visual_review", 3, 1),
    ],
  })
}

function stage(id: string, type: string, ordinal: number, revision: number) {
  return {
    id,
    type,
    ordinal,
    maxAttempts: 3,
    recoveryPolicy: "restart_safe",
    idempotencyKey: `${type}/r${revision}`,
    input: { revision },
  }
}

function stageEvent(seq: number, type: string, stageID: string) {
  return workflowEvent(seq, type, {
    workflowID: "wfl_fixture",
    timestamp: seq,
    stageID,
    attempt: 1,
  })
}

function workflowEvent(seq: number, type: string, data: Record<string, unknown>) {
  return {
    id: `evt_${seq}`,
    type,
    durable: { aggregateID: "wfl_fixture", seq, version: 1 },
    metadata: { raw: "must-not-render" },
    data,
  }
}

function stream(events: ReadonlyArray<unknown>) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events
    },
  }
}

function workflowDetail(status: "waiting_approval" | "succeeded" | "failed" | "cancelled") {
  return {
    run: {
      id: "wfl_fixture",
      type: "visual-build",
      status,
      input: { prompt: "raw-secret-must-not-render" },
      budget: { maxTokens: 20_000 },
      usage: usage(),
      version: 8,
      time: { created: 1, updated: 8, ...(status === "waiting_approval" ? {} : { completed: 8 }) },
    },
    stages: [],
    artifacts: [],
  }
}
