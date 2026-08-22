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
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowToolLineage } from "@opencode-ai/core/workflow/tool-lineage"
import { WorkflowPermissions } from "@opencode-ai/core/workflow/permissions"
import { WorkflowRoleAgents } from "@opencode-ai/core/workflow/role-agents"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
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
let modelCredentialReads = 0
const persistedWorkflows = new Map<Workflow.ID, Workflow.Detail>()
const persistedStages = new Map<Workflow.StageID, Workflow.Stage>()
const workflowStore = Layer.mock(WorkflowStore.Service, {
  get: (workflowID) => Effect.succeed(persistedWorkflows.get(workflowID)),
  stage: (stageID) => Effect.succeed(persistedStages.get(stageID)),
})
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
    Effect.sync(() => {
      modelCredentialReads++
      return [
        new Credential.Info({
          id: Credential.ID.create(),
          integrationID,
          label: "offline",
          value: Credential.Key.make({ type: "key", key: "offline-fixture" }),
        }),
      ]
    }),
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
      LocationServiceMap.node,
      WorkflowModelExecution.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [Credential.node, credentials],
      [llmClient, modelClient],
      [WorkflowStore.node, workflowStore],
    ],
  ),
)

const sandboxAttempts: WorkflowCommandSandbox.Request[] = []
const sandboxLaunches: WorkflowCommandSandbox.Request[] = []
const sandboxPolicies = new Map<string, string>()
const modelSandbox = Layer.succeed(
  WorkflowCommandSandbox.Service,
  WorkflowCommandSandbox.Service.of({
    run: (input) =>
      Effect.sync(() => {
        sandboxAttempts.push(input)
        return sandboxPolicies.get(`${input.workflowID}\0${input.stageID}`) === input.policyDigest
      }).pipe(
        Effect.flatMap((matches) => {
          if (!matches)
            return Effect.fail(
              new WorkflowCommandSandbox.Rejected({ message: "Frozen workflow sandbox policy mismatch" }),
            )
          sandboxLaunches.push(input)
          return Effect.succeed({ exit: 0, output: "contained", truncated: false })
        }),
      ),
  }),
)
const sandboxModelIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ApplicationTools.node,
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      LocationServiceMap.node,
      WorkflowModelExecution.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [Credential.node, credentials],
      [llmClient, modelClient],
      [WorkflowCommandSandbox.node, modelSandbox],
      [WorkflowStore.node, workflowStore],
    ],
  ),
)

const modelInput = (
  location: Location.Ref,
  sessionID: SessionV2.ID,
  saveCheckpoint: WorkflowModelExecution.Input["saveCheckpoint"],
  stageState: Pick<Workflow.Stage, "checkpoint" | "recoveryAction"> = {},
  identity: {
    readonly workflowID?: Workflow.ID
    readonly stageID?: Workflow.StageID
    readonly role?: WorkflowRole.Role
    readonly workflowInput?: Readonly<Record<string, unknown>>
    readonly stageInput?: Readonly<Record<string, unknown>>
    readonly persist?: boolean
  } = {},
): WorkflowModelExecution.Input => {
  const budget: Workflow.Budget = { maxTurns: 3, maxToolCalls: 2, maxAttempts: 2 }
  const role = identity.role ?? "design"
  const workflow = Workflow.Info.make({
    id: identity.workflowID ?? Workflow.ID.make("wfl_location_model"),
    type: "development",
    status: "running",
    input: identity.workflowInput ?? { brief: "Inspect the workspace" },
    budget,
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
    location,
    sessionID,
    agent: AgentV2.ID.make("broad-build"),
    version: 1,
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  })
  const stage = Workflow.Stage.make({
    id: identity.stageID ?? Workflow.StageID.make("wfs_location_model"),
    workflowID: workflow.id,
    type: role,
    ordinal: 0,
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    recoveryPolicy: "restart_safe",
    idempotencyKey: "location-model/design",
    input: identity.stageInput ?? {},
    ...stageState,
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  })
  if (identity.persist !== false) {
    persistedWorkflows.set(workflow.id, { run: workflow, stages: [stage], artifacts: [] })
    persistedStages.set(stage.id, stage)
  }
  return {
    workflow,
    stage,
    stages: [stage],
    artifacts: [],
    lease: { owner: "worker", attempt: 1, expiresAt: DateTime.makeUnsafe(60_000) },
    saveCheckpoint,
    route: WorkflowRouting.resolve({ role, budget }),
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

const expectedActions = {
  design: ["read", "glob", "grep"],
  decompose: ["read", "glob", "grep"],
  implement: ["read", "glob", "grep", "bash", "edit"],
  repair: ["read", "glob", "grep", "bash", "edit"],
  test: ["read", "glob", "grep", "bash"],
  visual_review: ["read", "glob", "grep"],
  deliver: ["read", "glob", "grep", "bash"],
} satisfies Record<WorkflowRole.Role, readonly string[]>

const expectedRules = (role: WorkflowRole.Role) => [
  { action: "*", resource: "*", effect: "deny" as const },
  ...expectedActions[role].map((action) => ({ action, resource: "*", effect: "allow" as const })),
]

describe("Workflow Location tools", () => {
  modelIt.live("rejects a real Session bound to a foreign Location before credentials or provider access", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([workspace, foreign]) =>
        Effect.gen(function* () {
          modelRequests.length = 0
          modelResponses.length = 0
          modelTimeline.length = 0
          modelCredentialReads = 0
          const location = Location.Ref.make({ directory: AbsolutePath.make(workspace.path) })
          const foreignLocation = Location.Ref.make({ directory: AbsolutePath.make(foreign.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_foreign_location")
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location: foreignLocation }))

          const failure = yield* WorkflowModelExecution.Service.use((models) =>
            models.execute(modelInput(location, sessionID, () => Effect.void)).pipe(Effect.flip),
          )

          expect(failure).toMatchObject({ failure: { code: "workflow_session_required" } })
          expect(modelCredentialReads).toBe(0)
          expect(modelRequests).toEqual([])
        }),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ),
  )

  modelIt.live("does not repeat a pending tool call even when retry recovery is requested", () =>
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
                  recoveryAction: "retry",
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

  modelIt.live("fails closed when a recovered active turn cannot prove the original tool catalog", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          modelRequests.length = 0
          modelResponses.length = 0
          modelTimeline.length = 0
          modelCredentialReads = 0
          const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_catalog_changed")
          let remainingExecutions = 0
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location }))
          const applicationTools = yield* ApplicationTools.Service
          const probe = (label: string, execute = () => Effect.succeed({})) =>
            Tool.withPermission(
              Tool.make({
                description: label,
                input: Schema.Struct({}),
                output: Schema.Struct({}),
                execute,
              }),
              "read",
            )
          yield* applicationTools.register({
            location_probe: probe("Original probe"),
            location_remaining: probe("Remaining probe", () =>
              Effect.sync(() => {
                remainingExecutions++
                return {}
              }),
            ),
          })
          const fingerprint = yield* ToolRegistry.Service.use((registry) =>
            registry
              .materialize(WorkflowPermissions.forRole("design"))
              .pipe(Effect.map((materialization) => materialization.fingerprint)),
          ).pipe(Effect.provide(LocationServiceMap.Service.get(location)), Effect.scoped)
          yield* applicationTools.register({ location_probe: probe("Replacement probe") })
          modelCredentialReads = 0

          const failure = yield* WorkflowModelExecution.Service.use((models) =>
            models
              .execute(
                modelInput(location, sessionID, () => Effect.void, {
                  checkpoint: continuation({
                    catalogFingerprint: fingerprint,
                    calls: [
                      { id: "call-settled", name: "location_probe", input: {} },
                      { id: "call-remaining", name: "location_remaining", input: {} },
                    ],
                    results: [
                      {
                        id: "call-settled",
                        name: "location_probe",
                        result: { type: "text", value: "already settled" },
                      },
                    ],
                  }),
                }),
              )
              .pipe(Effect.flip),
          )

          expect(failure).toMatchObject({ failure: { category: "ambiguous", code: "tool_catalog_ambiguous" } })
          expect(remainingExecutions).toBe(0)
          expect(modelRequests).toEqual([])
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
          expect(contexts).toHaveLength(1)
          expect(contexts[0]).toMatchObject({
            sessionID,
            agent: WorkflowRoleAgents.agentForRole("design"),
            assistantMessageID: expect.stringMatching(/^msg_workflow_/),
            toolCallID: "call-location-probe",
            workflowLineage: {
              workflowID: Workflow.ID.make("wfl_location_model"),
              stageID: Workflow.StageID.make("wfs_location_model"),
              sessionID,
              agent: WorkflowRoleAgents.agentForRole("design"),
              role: "design",
              policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          })
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

  sandboxModelIt.live("selects exact frozen policies for two workflows sharing one Location and Session", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          modelRequests.length = 0
          modelResponses.length = 0
          sandboxAttempts.length = 0
          sandboxLaunches.length = 0
          sandboxPolicies.clear()
          const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_shared_policy")
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location }))
          const first = modelInput(
            location,
            sessionID,
            () => Effect.void,
            {},
            {
              workflowID: Workflow.ID.make("wfl_shared_policy_first"),
              stageID: Workflow.StageID.make("wfs_shared_policy_first"),
              role: "implement",
              workflowInput: { flags: { second: 2, first: 1 }, brief: "First implementation" },
              stageInput: { mode: "strict", plan: { outputs: ["first"], flags: { second: 2, first: 1 } } },
            },
          )
          const second = modelInput(
            location,
            sessionID,
            () => Effect.void,
            {},
            {
              workflowID: Workflow.ID.make("wfl_shared_policy_second"),
              stageID: Workflow.StageID.make("wfs_shared_policy_second"),
              role: "implement",
              workflowInput: { brief: "Second implementation" },
              stageInput: { plan: { outputs: ["second"] } },
            },
          )
          const firstLineage = yield* WorkflowToolLineage.issue({
            workflow: first.workflow,
            stage: first.stage,
            route: first.route,
            agent: WorkflowRoleAgents.agentForRole("implement"),
          })
          const secondLineage = yield* WorkflowToolLineage.issue({
            workflow: second.workflow,
            stage: second.stage,
            route: second.route,
            agent: WorkflowRoleAgents.agentForRole("implement"),
          })
          expect(
            yield* WorkflowToolLineage.policyDigest({
              workflow: Workflow.Info.make({
                ...first.workflow,
                input: { brief: "First implementation", flags: { first: 1, second: 2 } },
              }),
              stage: Workflow.Stage.make({
                ...first.stage,
                input: { plan: { flags: { first: 1, second: 2 }, outputs: ["first"] }, mode: "strict" },
              }),
              route: first.route,
              agent: WorkflowRoleAgents.agentForRole("implement"),
            }),
          ).toBe(firstLineage.policyDigest)
          sandboxPolicies.set(`${first.workflow.id}\0${first.stage.id}`, firstLineage.policyDigest)
          sandboxPolicies.set(`${second.workflow.id}\0${second.stage.id}`, secondLineage.policyDigest)

          const enqueue = (callID: string) => {
            const calls = LLMResponse.fromEvents([
              LLMEvent.toolCall({ id: callID, name: "bash", input: { command: "printf contained" } }),
              LLMEvent.finish({ reason: "tool-calls" }),
            ])
            const outcome = LLMResponse.fromEvents([
              LLMEvent.textStart({ id: `${callID}-outcome` }),
              LLMEvent.textDelta({
                id: `${callID}-outcome`,
                text: JSON.stringify({ schemaVersion: 1, role: "implement", verdict: "ready", revision: 0 }),
              }),
              LLMEvent.textEnd({ id: `${callID}-outcome` }),
              LLMEvent.finish({ reason: "stop" }),
            ])
            if (!calls || !outcome) throw new Error("invalid offline responses")
            modelResponses.push(calls, outcome)
          }

          enqueue("call-shared-policy-first")
          expect((yield* WorkflowModelExecution.Service.use((models) => models.execute(first))).outcome).toMatchObject({
            role: "implement",
            verdict: "ready",
          })
          enqueue("call-shared-policy-second")
          expect((yield* WorkflowModelExecution.Service.use((models) => models.execute(second))).outcome).toMatchObject(
            {
              role: "implement",
              verdict: "ready",
            },
          )

          expect(sandboxLaunches).toHaveLength(2)
          expect(sandboxLaunches.map((request) => [request.workflowID, request.stageID, request.policyDigest])).toEqual(
            [
              [first.workflow.id, first.stage.id, firstLineage.policyDigest],
              [second.workflow.id, second.stage.id, secondLineage.policyDigest],
            ],
          )
          expect(firstLineage.policyDigest).not.toBe(secondLineage.policyDigest)

          const mismatched = modelInput(
            location,
            sessionID,
            () => Effect.void,
            {},
            {
              workflowID: first.workflow.id,
              stageID: first.stage.id,
              role: "implement",
              workflowInput: first.workflow.input,
              stageInput: { plan: { outputs: ["changed-after-freeze"] } },
              persist: false,
            },
          )
          const failure = yield* WorkflowModelExecution.Service.use((models) =>
            models.execute(mismatched).pipe(Effect.flip),
          )
          expect(failure).toMatchObject({ failure: { code: "workflow_tool_lineage_invalid" } })
          expect(sandboxAttempts).toHaveLength(2)
          expect(sandboxLaunches).toHaveLength(2)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("automatically installs every exact hidden role agent and filters each Location tool snapshot", () =>
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
              const id = WorkflowRoleAgents.agentForRole(role)
              ids.add(id)
              const profile = yield* agents.get(id)
              expect(profile).toMatchObject({
                id,
                mode: "subagent",
                hidden: true,
                permissions: expectedRules(role),
              })
              expect(Object.isFrozen(profile)).toBe(true)
              expect((yield* Effect.exit(agents.select(id)))._tag).toBe("Failure")
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

  it.live("keeps all workflow role profiles immutable across user transforms and concurrent turns", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })

          yield* Effect.gen(function* () {
            const agents = yield* AgentV2.Service
            yield* Effect.all(
              WorkflowRole.Role.literals.map((role) =>
                agents.transform((editor) =>
                  editor.update(WorkflowRoleAgents.agentForRole(role), (agent) => {
                    agent.mode = "primary"
                    agent.hidden = false
                    agent.description = "user override"
                    agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
                    const mutable = agent as unknown as Record<string, unknown>
                    mutable.userOverride = true
                  }),
                ),
              ),
              { concurrency: "unbounded" },
            )
            yield* Effect.all(WorkflowRole.Role.literals.map(WorkflowRoleAgents.reassert), {
              concurrency: "unbounded",
            })

            for (const role of WorkflowRole.Role.literals) {
              const id = WorkflowRoleAgents.agentForRole(role)
              expect(yield* agents.get(id)).toEqual({
                id,
                model: undefined,
                mode: "subagent",
                hidden: true,
                request: { headers: {}, body: {} },
                system: undefined,
                description: undefined,
                color: undefined,
                steps: undefined,
                permissions: expectedRules(role),
              })
            }
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
            const designLineage = yield* locationLineage("design", location, sessionID)
            const implementLineage = yield* locationLineage("implement", location, sessionID)
            const forbidden = yield* ToolRegistry.settleWorkflow(
              tools,
              {
                ...identity("design"),
                call: {
                  type: "tool-call",
                  id: "call-forbidden-edit",
                  name: "edit",
                  input: { path: "admitted.txt", oldString: "before", newString: "forbidden" },
                },
              },
              designLineage,
            )
            expect(forbidden.result).toMatchObject({ type: "error" })
            expect(yield* Effect.promise(() => fs.readFile(admitted, "utf8"))).toBe("before")

            const edited = yield* ToolRegistry.settleWorkflow(
              tools,
              {
                ...identity("implement"),
                call: {
                  type: "tool-call",
                  id: "call-admitted-edit",
                  name: "edit",
                  input: { path: "admitted.txt", oldString: "before", newString: "after" },
                },
              },
              implementLineage,
            )
            expect(edited.result.type).toBe("text")
            expect(yield* Effect.promise(() => fs.readFile(admitted, "utf8"))).toBe("after")

            const denied = yield* ToolRegistry.settleWorkflow(
              tools,
              {
                ...identity("implement"),
                call: {
                  type: "tool-call",
                  id: "call-outside-edit",
                  name: "edit",
                  input: { path: escaped, oldString: "outside", newString: "escaped" },
                },
              },
              implementLineage,
            )
            expect(denied.result).toMatchObject({ type: "error" })
            expect(yield* Effect.promise(() => fs.readFile(escaped, "utf8"))).toBe("outside")
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ),
  )

  it.live("advertises workflow Bash but fails closed without a sandbox backend", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([workspace, outside]) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(workspace.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_location_commands")
          const escaped = path.join(outside.path, "outside.txt")
          yield* Effect.promise(() => fs.writeFile(escaped, "outside"))
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location }))

          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const identity = (role: "implement" | "test" | "deliver") => ({
              sessionID,
              agent: WorkflowRoleAgents.agentForRole(role),
              assistantMessageID: SessionMessage.ID.make(`msg_workflow_location_${role}`),
            })

            for (const role of ["implement", "test", "deliver"] as const) {
              const filtered = yield* registry.materialize(WorkflowPermissions.forRole(role))
              expect(filtered.definitions.some((definition) => definition.name === "bash")).toBe(true)
              const denied = yield* ToolRegistry.settleWorkflow(
                filtered,
                {
                  ...identity(role),
                  call: {
                    type: "tool-call",
                    id: `call-forbidden-bash-${role}`,
                    name: "bash",
                    input: { command: `echo escaped > "${escaped}"` },
                  },
                },
                yield* locationLineage(role, location, sessionID),
              )
              expect(denied.result).toMatchObject({ type: "error" })
              expect(yield* Effect.promise(() => fs.readFile(escaped, "utf8"))).toBe("outside")
            }
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ),
  )
})

function locationLineage(role: WorkflowRole.Role, location: Location.Ref, sessionID: SessionV2.ID) {
  const input = modelInput(
    location,
    sessionID,
    () => Effect.void,
    {},
    {
      workflowID: Workflow.ID.make(`wfl_location_tool_${role}`),
      stageID: Workflow.StageID.make(`wfs_location_tool_${role}`),
      role,
    },
  )
  return WorkflowToolLineage.issue({
    workflow: input.workflow,
    stage: input.stage,
    route: input.route,
    agent: WorkflowRoleAgents.agentForRole(role),
  })
}

function continuation(input: {
  readonly catalogFingerprint?: string
  readonly calls?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly input: unknown }>
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
      calls: input.calls ?? [{ id: "call-ambiguous", name: "location_probe", input: {} }],
      results: input.results,
      ...(input.pendingCallID === undefined ? {} : { pendingCallID: input.pendingCallID }),
    },
    ...(input.catalogFingerprint === undefined ? {} : { catalogFingerprint: input.catalogFingerprint }),
    usage: {
      tokens: 0,
      turns: 1,
      toolCalls: input.results.length + (input.pendingCallID === undefined ? 0 : 1),
      attempts: 0,
    },
    providerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    responseOutput: [],
    artifacts: [],
  }
}
