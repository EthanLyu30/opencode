import { describe, expect, test } from "bun:test"
import { AuthenticationReason, LLMError, QuotaExceededReason } from "@opencode-ai/llm"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowExecutionLocal } from "@opencode-ai/core/workflow/execution/local"
import { WorkflowExecutor } from "@opencode-ai/core/workflow/executor"
import { WorkflowModelExecution } from "@opencode-ai/core/workflow/execution/model"
import { WorkflowRetry } from "@opencode-ai/core/workflow/retry"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { DateTime, Effect, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

const budget: Workflow.Budget = {
  maxTokens: 120_000,
  maxTurns: 24,
  maxToolCalls: 80,
  maxAttempts: 3,
  maxDurationMs: 3_600_000,
}

const cases = [
  [
    "design",
    "kimi",
    "kimi-k3",
    "openai-chat",
    "max",
    ["chat", "reasoning_replay", "structured_output", "required_tool_choice"],
  ],
  [
    "decompose",
    "kimi",
    "kimi-k3",
    "openai-chat",
    "high",
    ["chat", "reasoning_replay", "structured_output", "required_tool_choice"],
  ],
  [
    "visual_review",
    "kimi",
    "kimi-k3",
    "openai-chat",
    "max",
    ["chat", "reasoning_replay", "vision_input", "structured_output", "required_tool_choice"],
  ],
  [
    "implement",
    "deepseek",
    "deepseek-v4-flash",
    "openai-responses",
    "max",
    ["responses", "structured_output", "required_tool_choice"],
  ],
  [
    "test",
    "deepseek",
    "deepseek-v4-flash",
    "openai-responses",
    "high",
    ["responses", "structured_output", "required_tool_choice"],
  ],
  [
    "repair",
    "deepseek",
    "deepseek-v4-flash",
    "openai-responses",
    "max",
    ["responses", "structured_output", "required_tool_choice"],
  ],
  [
    "deliver",
    "deepseek",
    "deepseek-v4-flash",
    "openai-responses",
    "high",
    ["responses", "structured_output", "required_tool_choice"],
  ],
] as const

describe("WorkflowRouting", () => {
  test.each(cases)("routes %s deterministically", (role, providerID, modelID, protocol, effort, capabilities) => {
    const route = WorkflowRouting.resolve({ role, budget })

    expect({
      role: route.role,
      providerID: route.providerID,
      modelID: route.modelID,
      protocol: route.protocol,
      reasoningEffort: route.reasoningEffort,
      requiredCapabilities: route.requiredCapabilities,
      modelProvider: String(route.model.provider),
      routedModelID: String(route.model.id),
      routedProtocol: route.model.route.protocol,
    }).toEqual({
      role,
      providerID,
      modelID,
      protocol,
      reasoningEffort: effort,
      requiredCapabilities: capabilities,
      modelProvider: providerID,
      routedModelID: modelID,
      routedProtocol: protocol,
    })
    expect(route.budget).toEqual(budget)
    expect(route.budget).not.toBe(budget)
    expect(Object.isFrozen(route.budget)).toBe(true)
  })

  test.each([
    ["design", { providerID: "kimi", modelID: "kimi-k2.7", protocol: "openai-chat" }, false, "chat"],
    [
      "implement",
      { providerID: "deepseek", modelID: "deepseek-v4-pro", protocol: "openai-responses" },
      true,
      "responses",
    ],
    [
      "implement",
      { providerID: "deepseek", modelID: "deepseek-v4-flash", protocol: "openai-chat" },
      false,
      "responses",
    ],
    [
      "visual_review",
      { providerID: "deepseek", modelID: "deepseek-v4-flash", protocol: "openai-responses" },
      false,
      "vision_input",
    ],
  ] as const)("rejects an incompatible %s override", (role, requested, planned, requiredCapability) => {
    try {
      WorkflowRouting.resolve({ role, budget, requested })
      throw new Error("expected routing policy violation")
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowRouting.PolicyViolation)
      if (!(error instanceof WorkflowRouting.PolicyViolation)) throw error
      expect(error.role).toBe(role)
      expect(error.requiredCapability).toBe(requiredCapability)
      expect(error.planned).toBe(planned)
    }
  })

  test("allows only an exact explicit restatement of the role route", () => {
    const route = WorkflowRouting.resolve({
      role: "implement",
      budget,
      requested: {
        providerID: "deepseek",
        modelID: "deepseek-v4-flash",
        protocol: "openai-responses",
      },
    })
    expect(route.modelID).toBe("deepseek-v4-flash")
  })

  test("redacts secret-shaped route overrides from policy diagnostics", () => {
    try {
      WorkflowRouting.resolve({
        role: "implement",
        budget,
        requested: {
          providerID: "deepseek",
          modelID: "sk-live-secret-route-value",
          protocol: "openai-responses",
        },
      })
      throw new Error("expected routing policy violation")
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowRouting.PolicyViolation)
      expect(JSON.stringify(error)).not.toContain("live-secret-route-value")
      expect(String(error)).not.toContain("live-secret-route-value")
    }
  })
})

const executionInput: WorkflowExecutor.ExecutionInput = {
  workflow: Workflow.Info.make({
    id: Workflow.ID.make("wfl_routing"),
    type: "development",
    status: "running",
    input: { brief: "Build the page" },
    budget,
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
    version: 0,
    time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
  }),
  stage: Workflow.Stage.make({
    id: Workflow.StageID.make("wfs_routing"),
    workflowID: Workflow.ID.make("wfl_routing"),
    type: "design",
    ordinal: 0,
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    recoveryPolicy: "restart_safe",
    idempotencyKey: "wfl_routing/design",
    input: {},
    time: {
      created: DateTime.makeUnsafe(1),
      updated: DateTime.makeUnsafe(1),
      started: DateTime.makeUnsafe(1),
    },
  }),
  stages: [
    Workflow.Stage.make({
      id: Workflow.StageID.make("wfs_routing_future"),
      workflowID: Workflow.ID.make("wfl_routing"),
      type: "decompose",
      ordinal: 1,
      status: "pending",
      attempt: 0,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe",
      idempotencyKey: "wfl_routing/decompose",
      input: {},
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
    }),
  ],
  artifacts: [],
  lease: { owner: "worker", attempt: 1, expiresAt: DateTime.makeUnsafe(60_000) },
}

const runExecutor = (layer: Layer.Layer<WorkflowModelExecution.Service>, input = executionInput) =>
  Effect.gen(function* () {
    const executor = yield* WorkflowExecutor.Service
    return yield* executor.execute(input)
  }).pipe(Effect.scoped, Effect.provide(WorkflowExecutor.roleLayer.pipe(Layer.provide(layer))), Effect.runPromise)

const automaticIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([WorkflowExecutor.node, WorkflowModelExecution.node]), [
    [
      WorkflowModelExecution.node,
      WorkflowModelExecution.layerWith((input) =>
        Effect.succeed({
          outcome: { schemaVersion: 1, role: input.route.role, verdict: "ready", revision: 0 },
          checkpoint: { automaticModelID: input.route.modelID },
          usage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 },
        }),
      ),
    ],
  ]),
)

const roleWorkerOptions: WorkflowExecutionLocal.Options = {
  ownerID: "worker-role-routing",
  leaseDurationMs: 5_000,
  heartbeatIntervalMs: 1_000,
  pollIntervalMs: 5,
  concurrency: 1,
}

const roleModelLayer = WorkflowModelExecution.layerWith((input) => {
  const revision = typeof input.stage.input.forceRevision === "number" ? input.stage.input.forceRevision : 0
  const verdict =
    input.route.role === "test" || input.route.role === "visual_review"
      ? "pass"
      : input.route.role === "deliver"
        ? "complete"
        : "ready"
  return Effect.succeed({
    outcome: { schemaVersion: 1, role: input.route.role, verdict, revision },
    usage: { tokens: 11, turns: 1, toolCalls: 0, attempts: 0 },
  })
})

const roleWorkerIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      WorkflowV2.node,
      WorkflowStore.node,
      WorkflowExecutor.node,
      WorkflowModelExecution.node,
      WorkflowExecution.node,
    ]),
    [
      [WorkflowExecution.node, WorkflowExecutionLocal.nodeWith(roleWorkerOptions)],
      [WorkflowModelExecution.node, roleModelLayer],
    ],
  ),
)

const roleWorkflowInput = (
  suffix: string,
  roles: readonly [WorkflowRole.Role, ...WorkflowRole.Role[]],
  stageInput: (role: WorkflowRole.Role) => Readonly<Record<string, unknown>> = () => ({}),
): Workflow.CreateInput => {
  const makeStage = (role: WorkflowRole.Role, ordinal: number): Workflow.StageInput => ({
    id: Workflow.StageID.make(`wfs_role_${suffix}_${ordinal}`),
    type: role,
    ordinal,
    maxAttempts: 1,
    recoveryPolicy: "restart_safe" as const,
    idempotencyKey: `role/${suffix}/${role}/${ordinal}`,
    input: stageInput(role),
  })
  const [first, ...rest] = roles
  return {
    id: Workflow.ID.make(`wfl_role_${suffix}`),
    type: "development",
    input: { brief: `Build ${suffix}` },
    budget: { ...budget, maxAttempts: 12 },
    stages: [makeStage(first, 0), ...rest.map((role, index) => makeStage(role, index + 1))],
  }
}

const waitForTerminal = (workflow: WorkflowV2.Interface, workflowID: Workflow.ID) =>
  workflow.events({ workflowID }).pipe(
    Stream.filter((event) => event.type === "workflow.succeeded" || event.type === "workflow.failed"),
    Stream.runHead,
    Effect.timeout("3 seconds"),
  )

describe("WorkflowExecutor role integration", () => {
  automaticIt.effect("uses role routing from the default WorkflowExecutor node", () =>
    Effect.gen(function* () {
      const executor = yield* WorkflowExecutor.Service
      const result = yield* executor.execute(executionInput)
      expect(result.checkpoint).toEqual({ automaticModelID: "kimi-k3" })
    }),
  )

  test("passes the immutable role route to model execution and commits a validated outcome artifact", async () => {
    const result = await runExecutor(
      WorkflowModelExecution.layerWith((input) =>
        Effect.succeed({
          outcome: { schemaVersion: 1, role: input.route.role, verdict: "ready", revision: 0 },
          checkpoint: {
            providerID: input.route.providerID,
            modelID: input.route.modelID,
            protocol: input.route.protocol,
            reasoningEffort: input.route.reasoningEffort,
          },
          usage: { tokens: 25, turns: 1, toolCalls: 1, attempts: 0 },
          artifacts: [],
        }),
      ),
    )

    expect(result.checkpoint).toEqual({
      providerID: "kimi",
      modelID: "kimi-k3",
      protocol: "openai-chat",
      reasoningEffort: "max",
    })
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts?.[0]).toMatchObject({
      kind: "workflow.role.outcome",
      mime: "application/vnd.opencode.workflow-role-outcome+json",
      metadata: { schemaVersion: 1, role: "design", verdict: "ready", revision: 0 },
    })
    expect(result.artifacts?.[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("maps and sanitizes provider authentication failures", async () => {
    const failure = await Effect.gen(function* () {
      const executor = yield* WorkflowExecutor.Service
      return yield* executor.execute(executionInput).pipe(Effect.flip)
    }).pipe(
      Effect.scoped,
      Effect.provide(
        WorkflowExecutor.roleLayer.pipe(
          Layer.provide(
            WorkflowModelExecution.layerWith(() =>
              Effect.fail(
                new LLMError({
                  module: "route",
                  method: "stream",
                  reason: new AuthenticationReason({
                    kind: "invalid",
                    message: "Bearer live-secret-token is invalid",
                  }),
                }),
              ),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    )

    expect(failure.failure).toMatchObject({ category: "authentication", code: "authentication" })
    expect(JSON.stringify(failure)).not.toContain("live-secret-token")
    expect(
      WorkflowRetry.decide({
        failure: failure.failure,
        attempt: 1,
        maxAttempts: 3,
        now: 0,
        randomUnit: 0,
      }).type,
    ).toBe("fail")
  })

  test("maps provider quota failures to the non-retry recovery policy", async () => {
    const failure = await Effect.gen(function* () {
      const executor = yield* WorkflowExecutor.Service
      return yield* executor.execute(executionInput).pipe(Effect.flip)
    }).pipe(
      Effect.scoped,
      Effect.provide(
        WorkflowExecutor.roleLayer.pipe(
          Layer.provide(
            WorkflowModelExecution.layerWith(() =>
              Effect.fail(
                new LLMError({
                  module: "route",
                  method: "stream",
                  reason: new QuotaExceededReason({ message: "account quota exhausted" }),
                }),
              ),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    )

    expect(failure.failure).toMatchObject({ category: "quota", code: "quota" })
    expect(
      WorkflowRetry.decide({
        failure: failure.failure,
        attempt: 1,
        maxAttempts: 3,
        now: 0,
        randomUnit: 0,
      }).type,
    ).toBe("fail")
  })

  test("rejects a stage-level protocol downgrade before model execution", async () => {
    const failure = await Effect.gen(function* () {
      const executor = yield* WorkflowExecutor.Service
      return yield* executor
        .execute({
          ...executionInput,
          stage: Workflow.Stage.make({
            ...executionInput.stage,
            type: "implement",
            input: {
              route: {
                providerID: "deepseek",
                modelID: "deepseek-v4-flash",
                protocol: "openai-chat",
              },
            },
          }),
        })
        .pipe(Effect.flip)
    }).pipe(
      Effect.scoped,
      Effect.provide(
        WorkflowExecutor.roleLayer.pipe(
          Layer.provide(
            WorkflowModelExecution.layerWith(() =>
              Effect.die("the provider boundary must not run for an invalid role override"),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    )

    expect(failure.failure).toMatchObject({
      category: "invalid_request",
      code: "role_route_violation",
    })
    expect(
      WorkflowRetry.decide({
        failure: failure.failure,
        attempt: 1,
        maxAttempts: 3,
        now: 0,
        randomUnit: 0,
      }).type,
    ).toBe("fail")
  })

  test("classifies a malformed route override separately from a policy mismatch", async () => {
    const failure = await runExecutor(
      WorkflowModelExecution.layerWith(() =>
        Effect.die("the provider boundary must not run for a malformed route override"),
      ),
      {
        ...executionInput,
        stage: Workflow.Stage.make({
          ...executionInput.stage,
          input: { route: { providerID: "kimi" } },
        }),
      },
    ).catch((error) => error)

    expect(failure.failure).toMatchObject({
      category: "invalid_request",
      code: "invalid_route_override",
    })
  })

  test("rejects model execution artifacts that impersonate the reserved role outcome", async () => {
    const failure = await runExecutor(
      WorkflowModelExecution.layerWith(() =>
        Effect.succeed({
          outcome: { schemaVersion: 1, role: "design", verdict: "ready", revision: 0 },
          artifacts: [
            {
              kind: "workflow.role.outcome",
              uri: "artifact://forged-role-outcome.json",
              mime: "application/json",
              sha256: "a".repeat(64),
              size: 2,
              metadata: {},
            },
          ],
          usage: { tokens: 4, turns: 1, toolCalls: 0, attempts: 0 },
        }),
      ),
    ).catch((error) => error)

    expect(failure.failure).toMatchObject({ category: "schema", code: "invalid_role_outcome" })
    expect(failure.usage.tokens).toBe(4)
  })

  test("maps malformed model outcomes to a schema failure", async () => {
    const failure = await Effect.gen(function* () {
      const executor = yield* WorkflowExecutor.Service
      return yield* executor.execute(executionInput).pipe(Effect.flip)
    }).pipe(
      Effect.scoped,
      Effect.provide(
        WorkflowExecutor.roleLayer.pipe(
          Layer.provide(
            WorkflowModelExecution.layerWith(() =>
              Effect.succeed({
                outcome: { role: "design", verdict: "looks-good" },
                usage: { tokens: 3, turns: 1, toolCalls: 0, attempts: 0 },
              }),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    )

    expect(failure.failure).toMatchObject({ category: "schema", code: "invalid_role_outcome" })
    expect(failure.usage).toEqual({ tokens: 3, turns: 1, toolCalls: 0, attempts: 0 })
  })
})

describe("Workflow role execution state authority", () => {
  roleWorkerIt.live("completes the fixed role chain through persisted outcome artifacts", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const input = roleWorkflowInput("happy", ["design", "decompose", "implement", "test", "visual_review", "deliver"])
      yield* workflow.create(input)
      yield* waitForTerminal(workflow, input.id!)

      const detail = yield* workflow.get(input.id!)
      expect(detail.run.status).toBe("succeeded")
      expect(detail.stages.map((stage) => stage.status)).toEqual(Array.from({ length: 6 }, () => "succeeded"))
      expect(detail.artifacts.filter((artifact) => artifact.kind === "workflow.role.outcome")).toHaveLength(6)
    }),
  )

  roleWorkerIt.live("rejects an out-of-order role before the model boundary", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const input = roleWorkflowInput("deliver_only", ["deliver"])
      yield* workflow.create(input)
      yield* waitForTerminal(workflow, input.id!)

      const detail = yield* workflow.get(input.id!)
      expect(detail.run.status).toBe("failed")
      expect(detail.stages[0].error?.code).toBe("role_transition_violation")
      expect(detail.artifacts).toHaveLength(0)
    }),
  )

  roleWorkerIt.live("does not mark a truncated role chain as successful", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const input = roleWorkflowInput("truncated", ["design"])
      yield* workflow.create(input)
      yield* waitForTerminal(workflow, input.id!)

      const detail = yield* workflow.get(input.id!)
      const history = yield* workflow.history({ workflowID: input.id!, limit: 30 })
      const failed = history.events.find((event) => event.type === "workflow.failed")
      expect(detail.run.status).toBe("failed")
      expect(detail.stages[0].status).toBe("failed")
      expect(detail.stages[0].error?.code).toBe("incomplete_role_workflow")
      expect(failed?.type === "workflow.failed" ? failed.data.failure.code : undefined).toBe("incomplete_role_workflow")
    }),
  )

  roleWorkerIt.live("rejects a model outcome with the wrong repair revision", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const input = roleWorkflowInput("wrong_revision", ["design"], () => ({ forceRevision: 9 }))
      yield* workflow.create(input)
      yield* waitForTerminal(workflow, input.id!)

      const detail = yield* workflow.get(input.id!)
      expect(detail.run.status).toBe("failed")
      expect(detail.stages[0].error?.code).toBe("invalid_role_outcome")
      expect(detail.run.usage.tokens).toBe(11)
      expect(detail.artifacts).toHaveLength(0)
    }),
  )
})
