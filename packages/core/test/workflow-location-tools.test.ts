import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, LLMResponse, type LLMRequest } from "@opencode-ai/llm"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Credential } from "@opencode-ai/core/credential"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowModelExecution } from "@opencode-ai/core/workflow/execution/model"
import { WorkflowPermissions } from "@opencode-ai/core/workflow/permissions"
import { WorkflowRoleAgents } from "@opencode-ai/core/workflow/role-agents"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ApplicationTools.node,
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      LocationServiceMap.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

const modelRequests: LLMRequest[] = []
const modelResponses: LLMResponse[] = []
const modelTimeline: string[] = []
const modelClient = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: () => Stream.die("unused"),
    generate: (request) =>
      Effect.sync(() => {
        modelRequests.push(request)
        modelTimeline.push(`provider:${modelRequests.length}`)
        const response = modelResponses.shift()
        if (!response) throw new Error("missing model response")
        return response
      }),
  }),
)
const credentials = Layer.mock(Credential.Service, {
  list: (integrationID) =>
    Effect.succeed([
      new Credential.Info({
        id: Credential.ID.create(),
        integrationID,
        label: "offline",
        value: Credential.Key.make({ type: "key", key: "offline-fixture" }),
      }),
    ]),
})
const modelIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ApplicationTools.node,
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      WorkflowModelExecution.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [Credential.node, credentials],
      [llmClient, modelClient],
    ],
  ),
)

const modelInput = (
  location: Location.Ref,
  sessionID: SessionV2.ID,
  saveCheckpoint: WorkflowModelExecution.Input["saveCheckpoint"],
  stageState: Pick<Workflow.Stage, "checkpoint" | "recoveryAction"> = {},
): WorkflowModelExecution.Input => {
  const budget: Workflow.Budget = { maxTurns: 3, maxToolCalls: 2, maxAttempts: 2 }
  const workflow = Workflow.Info.make({
    id: Workflow.ID.make("wfl_location_model"),
    type: "development",
    status: "running",
    input: { brief: "Inspect the workspace" },
    budget,
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
    location,
    sessionID,
    agent: AgentV2.ID.make("broad-build"),
    version: 1,
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  })
  const stage = Workflow.Stage.make({
    id: Workflow.StageID.make("wfs_location_model"),
    workflowID: workflow.id,
    type: "design",
    ordinal: 0,
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    recoveryPolicy: "restart_safe",
    idempotencyKey: "location-model/design",
    input: {},
    ...stageState,
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  })
  return {
    workflow,
    stage,
    stages: [stage],
    artifacts: [],
    lease: { owner: "worker", attempt: 1, expiresAt: DateTime.makeUnsafe(60_000) },
    saveCheckpoint,
    route: WorkflowRouting.resolve({ role: "design", budget }),
  }
}

const expected = {
  design: ["glob", "grep", "read"],
  decompose: ["glob", "grep", "read"],
  implement: ["apply_patch", "bash", "edit", "glob", "grep", "read", "write"],
  repair: ["apply_patch", "bash", "edit", "glob", "grep", "read", "write"],
  test: ["bash", "glob", "grep", "read"],
  visual_review: ["glob", "grep", "read"],
  deliver: ["bash", "glob", "grep", "read"],
} satisfies Record<WorkflowRole.Role, readonly string[]>

describe("Workflow Location tools", () => {
  modelIt.live("does not repeat a pending tool call without explicit recovery", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          modelRequests.length = 0
          modelResponses.length = 0
          modelTimeline.length = 0
          const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_location_pending")
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location }))

          const failure = yield* WorkflowModelExecution.Service.use((models) =>
            models
              .execute(
                modelInput(location, sessionID, () => Effect.void, {
                  checkpoint: continuation({ pendingCallID: "call-ambiguous", results: [] }),
                }),
              )
              .pipe(Effect.flip),
          )

          expect(failure).toMatchObject({ failure: { category: "ambiguous", code: "tool_execution_ambiguous" } })
          expect(modelRequests).toEqual([])
          expect(modelTimeline).toEqual([])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  modelIt.live("resumes a durably settled tool result without invoking the tool again", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          modelRequests.length = 0
          modelResponses.length = 0
          modelTimeline.length = 0
          const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_location_settled")
          const response = LLMResponse.fromEvents([
            LLMEvent.textStart({ id: "outcome" }),
            LLMEvent.textDelta({
              id: "outcome",
              text: JSON.stringify({ schemaVersion: 1, role: "design", verdict: "ready", revision: 0 }),
            }),
            LLMEvent.textEnd({ id: "outcome" }),
            LLMEvent.finish({ reason: "stop" }),
          ])
          if (!response) return yield* Effect.die("invalid offline response")
          modelResponses.push(response)
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location }))
          yield* ApplicationTools.Service.use((tools) =>
            tools.register({
              location_probe: Tool.withPermission(
                Tool.make({
                  description: "Must not execute after durable settlement",
                  input: Schema.Struct({}),
                  output: Schema.Struct({}),
                  execute: () => Effect.die("settled tool repeated"),
                }),
                "read",
              ),
            }),
          )

          const result = yield* WorkflowModelExecution.Service.use((models) =>
            models.execute(
              modelInput(location, sessionID, () => Effect.void, {
                checkpoint: continuation({
                  results: [
                    {
                      id: "call-ambiguous",
                      name: "location_probe",
                      result: { type: "text", value: "already settled" },
                    },
                  ],
                }),
              }),
            ),
          )

          expect(result.outcome).toMatchObject({ role: "design", verdict: "ready" })
          expect(modelRequests).toHaveLength(1)
          expect(modelTimeline).toEqual(["provider:1"])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  modelIt.live("uses one Location snapshot, the persisted Session, and the role agent through settlement", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          modelRequests.length = 0
          modelResponses.length = 0
          modelTimeline.length = 0
          const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_location_model")
          const contexts: Tool.Context[] = []
          const first = LLMResponse.fromEvents([
            LLMEvent.toolCall({ id: "call-location-probe", name: "location_probe", input: {} }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ])
          const second = LLMResponse.fromEvents([
            LLMEvent.textStart({ id: "outcome" }),
            LLMEvent.textDelta({
              id: "outcome",
              text: JSON.stringify({ schemaVersion: 1, role: "design", verdict: "ready", revision: 0 }),
            }),
            LLMEvent.textEnd({ id: "outcome" }),
            LLMEvent.finish({ reason: "stop" }),
          ])
          if (!first || !second) return yield* Effect.die("invalid offline responses")
          modelResponses.push(first, second)

          yield* SessionV2.Service.use((sessions) =>
            sessions.create({ id: sessionID, location, agent: AgentV2.ID.make("broad-build") }),
          )
          const applicationTools = yield* ApplicationTools.Service
          yield* applicationTools.register({
            location_probe: Tool.withPermission(
              Tool.make({
                description: "Capture workflow invocation identity",
                input: Schema.Struct({}),
                output: Schema.Struct({}),
                execute: (_, context) =>
                  Effect.sync(() => {
                    modelTimeline.push("tool")
                    contexts.push(context)
                    return {}
                  }),
              }),
              "read",
            ),
          })

          const result = yield* WorkflowModelExecution.Service.use((models) =>
            models.execute(
              modelInput(location, sessionID, (checkpoint) =>
                Effect.sync(() => {
                  const active = checkpoint.activeTurn
                  modelTimeline.push(
                    typeof active === "object" && active !== null && "pendingCallID" in active
                      ? "checkpoint:pending"
                      : "checkpoint:settled",
                  )
                }),
              ),
            ),
          )

          expect(result.outcome).toEqual({ schemaVersion: 1, role: "design", verdict: "ready", revision: 0 })
          expect(modelRequests).toHaveLength(2)
          expect(modelRequests[0]?.tools.map((definition) => definition.name).sort()).toEqual([
            "glob",
            "grep",
            "location_probe",
            "read",
          ])
          expect(modelRequests[1]?.tools.map((definition) => definition.name).sort()).toEqual([
            "glob",
            "grep",
            "location_probe",
            "read",
          ])
          expect(contexts).toEqual([
            {
              sessionID,
              agent: WorkflowRoleAgents.agentForRole("design"),
              assistantMessageID: expect.stringMatching(/^msg_workflow_/),
              toolCallID: "call-location-probe",
            },
          ])
          expect(modelTimeline).toEqual([
            "provider:1",
            "checkpoint:pending",
            "tool",
            "checkpoint:settled",
            "provider:2",
          ])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("installs exact hidden role agents and filters each Location tool snapshot", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_location_matrix")
          yield* SessionV2.Service.use((sessions) =>
            sessions.create({ id: sessionID, location, agent: AgentV2.ID.make("broad-build") }),
          )

          yield* Effect.gen(function* () {
            const agents = yield* AgentV2.Service
            const registry = yield* ToolRegistry.Service
            const ids = new Set<AgentV2.ID>()

            for (const role of WorkflowRole.Role.literals) {
              yield* WorkflowRoleAgents.reassert(role)
              const id = WorkflowRoleAgents.agentForRole(role)
              ids.add(id)
              expect(yield* agents.get(id)).toMatchObject({
                id,
                mode: "subagent",
                hidden: true,
                permissions: WorkflowPermissions.forRole(role),
              })
              expect(
                (yield* registry.materialize(WorkflowPermissions.forRole(role))).definitions
                  .map((definition) => definition.name)
                  .sort(),
              ).toEqual(expected[role])
            }

            expect(ids.size).toBe(WorkflowRole.Role.literals.length)
            expect(yield* agents.resolve("broad-build")).toBeUndefined()
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("settles admitted edits through the real Session and contains writes to its Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([workspace, outside]) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(workspace.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_location_edit")
          const admitted = path.join(workspace.path, "admitted.txt")
          const escaped = path.join(outside.path, "outside.txt")
          yield* Effect.promise(() => Promise.all([fs.writeFile(admitted, "before"), fs.writeFile(escaped, "outside")]))
          yield* SessionV2.Service.use((sessions) =>
            sessions.create({ id: sessionID, location, agent: AgentV2.ID.make("broad-build") }),
          )

          yield* Effect.gen(function* () {
            yield* WorkflowRoleAgents.reassert("design")
            yield* WorkflowRoleAgents.reassert("implement")
            const registry = yield* ToolRegistry.Service
            const tools = yield* registry.materialize(WorkflowPermissions.forRole("implement"))
            const identity = (role: "design" | "implement") => ({
              sessionID,
              agent: WorkflowRoleAgents.agentForRole(role),
              assistantMessageID: SessionMessage.ID.make("msg_workflow_location_edit"),
            })
            const forbidden = yield* tools.settle({
              ...identity("design"),
              call: {
                type: "tool-call",
                id: "call-forbidden-edit",
                name: "edit",
                input: { path: "admitted.txt", oldString: "before", newString: "forbidden" },
              },
            })
            expect(forbidden.result).toMatchObject({ type: "error" })
            expect(yield* Effect.promise(() => fs.readFile(admitted, "utf8"))).toBe("before")

            const edited = yield* tools.settle({
              ...identity("implement"),
              call: {
                type: "tool-call",
                id: "call-admitted-edit",
                name: "edit",
                input: { path: "admitted.txt", oldString: "before", newString: "after" },
              },
            })
            expect(edited.result.type).toBe("text")
            expect(yield* Effect.promise(() => fs.readFile(admitted, "utf8"))).toBe("after")

            const denied = yield* tools.settle({
              ...identity("implement"),
              call: {
                type: "tool-call",
                id: "call-outside-edit",
                name: "edit",
                input: { path: escaped, oldString: "outside", newString: "escaped" },
              },
            })
            expect(denied.result).toMatchObject({ type: "error" })
            expect(yield* Effect.promise(() => fs.readFile(escaped, "utf8"))).toBe("outside")
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ),
  )
})

function continuation(input: {
  readonly pendingCallID?: string
  readonly results: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly result: { readonly type: "text"; readonly value: string }
  }>
}) {
  return {
    kind: "workflow.model.continuation" as const,
    version: 1 as const,
    providerID: "kimi",
    modelID: "kimi-k3",
    completedTurns: 1,
    turns: [],
    activeTurn: {
      calls: [{ id: "call-ambiguous", name: "location_probe", input: {} }],
      results: input.results,
      ...(input.pendingCallID === undefined ? {} : { pendingCallID: input.pendingCallID }),
    },
    usage: { tokens: 0, turns: 1, toolCalls: 1, attempts: 0 },
    providerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    responseOutput: [],
    artifacts: [],
  }
}
