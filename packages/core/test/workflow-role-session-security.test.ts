import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowRoleAgents } from "@opencode-ai/core/workflow/role-agents"
import { Effect, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

const requests: LLMRequest[] = []
let responses: LLMEvent[][] = []
let sandboxRuns = 0

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      return Stream.fromIterable(responses.shift() ?? [])
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const systemContext = Layer.succeed(
  SystemContextRegistry.Service,
  SystemContextRegistry.Service.of({
    register: () => Effect.die("unused"),
    load: () => Effect.succeed(SystemContext.empty),
  }),
)
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("reserved workflow Bash reached permission assertion"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const sandbox = Layer.succeed(
  WorkflowCommandSandbox.Service,
  WorkflowCommandSandbox.Service.of({
    run: () =>
      Effect.sync(() => {
        sandboxRuns++
        return { exit: 0, output: "should not execute", truncated: false }
      }),
  }),
)
const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
const safeAgent = AgentV2.ID.make("safe")
const runnerLayer = AppNodeBuilder.build(LayerNode.group([SessionRunnerLLM.node, BashTool.node]), [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode(location)],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [WorkflowCommandSandbox.node, sandbox],
  [Config.node, config],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const runner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => runner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      BashTool.node,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [ProjectV2.node, projects],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode(location)],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [WorkflowCommandSandbox.node, sandbox],
      [Config.node, config],
    ],
  ),
)

const attemptedBash = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "call-bash", name: "bash", input: { command: "echo escaped" } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

describe("reserved workflow role public Session boundaries", () => {
  it.effect("rejects create impersonation before persistence or SessionRunner sandbox execution", () =>
    Effect.gen(function* () {
      requests.length = 0
      responses = [attemptedBash, []]
      sandboxRuns = 0
      const sessions = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(safeAgent, (agent) => {
          agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
        }),
      )

      const rejected = yield* sessions
        .create({ location, agent: WorkflowRoleAgents.agentForRole("implement") })
        .pipe(Effect.flip)
      expect(rejected).toMatchObject({ _tag: "AgentV2.ReservedSelectionError" })
      expect(yield* sessions.list()).toEqual([])

      const created = yield* sessions.create({ location, agent: safeAgent })
      yield* sessions.prompt({ sessionID: created.id, prompt: Prompt.make({ text: "Try Bash" }), resume: false })
      yield* sessions.resume(created.id)

      expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("bash")
      expect(sandboxRuns).toBe(0)
      expect((yield* sessions.get(created.id)).agent).toBe(safeAgent)
    }),
  )

  it.effect("rejects switch impersonation and keeps the runner on the prior public agent", () =>
    Effect.gen(function* () {
      requests.length = 0
      responses = [attemptedBash, []]
      sandboxRuns = 0
      const sessions = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(safeAgent, (agent) => {
          agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
        }),
      )
      const created = yield* sessions.create({ location, agent: safeAgent })

      const rejected = yield* sessions
        .switchAgent({ sessionID: created.id, agent: WorkflowRoleAgents.agentForRole("test") })
        .pipe(Effect.flip)
      expect(rejected).toMatchObject({ _tag: "AgentV2.ReservedSelectionError" })
      yield* sessions.prompt({ sessionID: created.id, prompt: Prompt.make({ text: "Try Bash" }), resume: false })
      yield* sessions.resume(created.id)

      expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("bash")
      expect(sandboxRuns).toBe(0)
      expect((yield* sessions.get(created.id)).agent).toBe(safeAgent)
    }),
  )
})
