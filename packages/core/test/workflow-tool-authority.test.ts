import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { DateTime, Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowPermissions } from "@opencode-ai/core/workflow/permissions"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { WorkflowRoleAgents } from "@opencode-ai/core/workflow/role-agents"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowToolLineage } from "@opencode-ai/core/workflow/tool-lineage"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

let permissionAssertions = 0
let sandboxRuns = 0
let sandboxPolicyResolutions = 0
let processLaunches = 0
let outputBounds = 0

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const permissions = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.sync(() => permissionAssertions++),
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
        sandboxPolicyResolutions++
        processLaunches++
        return { exit: 0, output: "contained", truncated: false }
      }),
  }),
)
const outputs = Layer.succeed(
  ToolOutputStore.Service,
  ToolOutputStore.Service.of({
    limits: () => Effect.succeed({ maxLines: 2_000, maxBytes: 50 * 1_024 }),
    bound: (input) =>
      Effect.sync(() => {
        outputBounds++
        return { output: input.output, outputPaths: [] }
      }),
    cleanup: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      WorkflowProjector.node,
      WorkflowStore.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      LocationServiceMap.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [PermissionV2.node, permissions],
      [WorkflowCommandSandbox.node, sandbox],
      [ToolOutputStore.node, outputs],
    ],
  ),
)

describe("Workflow tool authority", () => {
  it.live("settles only exact persisted authority and rejects every mismatch before side effects", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([workspace, foreign]) =>
        Effect.gen(function* () {
          permissionAssertions = 0
          sandboxRuns = 0
          sandboxPolicyResolutions = 0
          processLaunches = 0
          outputBounds = 0
          const location = Location.Ref.make({ directory: AbsolutePath.make(workspace.path) })
          const foreignLocation = Location.Ref.make({ directory: AbsolutePath.make(foreign.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_authority")
          const otherSessionID = SessionV2.ID.make("ses_workflow_authority_other")
          const missingSessionID = SessionV2.ID.make("ses_workflow_authority_missing")
          yield* Effect.promise(() => fs.writeFile(path.join(workspace.path, "admitted.txt"), "before"))
          yield* SessionV2.Service.use((sessions) =>
            Effect.all([
              sessions.create({ id: sessionID, location }),
              sessions.create({ id: otherSessionID, location }),
            ]),
          )
          const admitted = yield* admit("implement", location, sessionID, "primary")

          const allowed = yield* settle(location, admitted, {
            sessionID,
            agent: WorkflowRoleAgents.agentForRole("implement"),
            name: "bash",
            input: { command: "printf contained" },
          })
          expect(allowed.result.type).not.toBe("error")
          expect({
            permissionAssertions,
            sandboxRuns,
            sandboxPolicyResolutions,
            processLaunches,
            outputBounds,
          }).toEqual({
            permissionAssertions: 1,
            sandboxRuns: 1,
            sandboxPolicyResolutions: 1,
            processLaunches: 1,
            outputBounds: 1,
          })

          permissionAssertions = 0
          sandboxRuns = 0
          sandboxPolicyResolutions = 0
          processLaunches = 0
          outputBounds = 0
          const other = yield* admit("implement", location, sessionID, "other")
          const missingSession = yield* admit("implement", location, missingSessionID, "missing_session")
          const synthetic = yield* syntheticAuthority("implement", location, sessionID, "synthetic")
          const testRoute = WorkflowRouting.resolve({ role: "test", budget: admitted.route.budget })
          const attempts = [
            { authority: synthetic, want: "workflow_missing" },
            {
              authority: { ...admitted, stageID: Workflow.StageID.make("wfs_authority_missing") },
              want: "stage_missing",
            },
            { authority: { ...admitted, stageID: other.stageID }, want: "stage_missing" },
            { authority: { ...admitted, sessionID: otherSessionID }, want: "session_mismatch" },
            { authority: { ...missingSession, sessionID: missingSessionID }, want: "session_missing" },
            { authority: { ...admitted, route: testRoute }, want: "role_mismatch" },
            {
              authority: { ...admitted, agent: WorkflowRoleAgents.agentForRole("test") },
              want: "agent_mismatch",
            },
            { authority: { ...admitted, policyDigest: "0".repeat(64) }, want: "policy_mismatch" },
          ] as const

          for (const [index, attempt] of attempts.entries()) {
            const failure = yield* settle(location, attempt.authority, {
              sessionID: "sessionID" in attempt.authority ? attempt.authority.sessionID : sessionID,
              agent:
                "agent" in attempt.authority ? attempt.authority.agent : WorkflowRoleAgents.agentForRole("implement"),
              name: index === 0 ? "edit" : "bash",
              input:
                index === 0
                  ? { path: "admitted.txt", oldString: "before", newString: "forged" }
                  : { command: "printf forged" },
            }).pipe(Effect.flip)
            expect(failure).toMatchObject({ _tag: "ToolRegistry.WorkflowAuthorityError", code: attempt.want })
          }

          const foreignFailure = yield* settle(foreignLocation, admitted, {
            sessionID,
            agent: WorkflowRoleAgents.agentForRole("implement"),
            name: "bash",
            input: { command: "printf forged" },
          }).pipe(Effect.flip)
          expect(foreignFailure).toMatchObject({
            _tag: "ToolRegistry.WorkflowAuthorityError",
            code: "location_mismatch",
          })
          expect({
            permissionAssertions,
            sandboxRuns,
            sandboxPolicyResolutions,
            processLaunches,
            outputBounds,
          }).toEqual({
            permissionAssertions: 0,
            sandboxRuns: 0,
            sandboxPolicyResolutions: 0,
            processLaunches: 0,
            outputBounds: 0,
          })
          expect(yield* Effect.promise(() => fs.readFile(path.join(workspace.path, "admitted.txt"), "utf8"))).toBe(
            "before",
          )
        }),
      (directories) =>
        Effect.promise(() =>
          Promise.all(directories.map((directory) => directory[Symbol.asyncDispose]())).then(() => undefined),
        ),
    ),
  )

  it.live("rejects a materialization captured by another Location before any side effect", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([workspace, foreign]) =>
        Effect.gen(function* () {
          permissionAssertions = 0
          sandboxRuns = 0
          sandboxPolicyResolutions = 0
          processLaunches = 0
          outputBounds = 0
          const location = Location.Ref.make({ directory: AbsolutePath.make(workspace.path) })
          const foreignLocation = Location.Ref.make({ directory: AbsolutePath.make(foreign.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_authority_materialization")
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(workspace.path, "owned.txt"), "workspace-a"),
              fs.writeFile(path.join(foreign.path, "owned.txt"), "workspace-b"),
            ]),
          )
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location }))
          const admitted = yield* admit("implement", location, sessionID, "materialization_owner")
          const foreignMaterialization = yield* materialize(foreignLocation)

          const outcomes = yield* Effect.all(
            [
              settle(
                location,
                admitted,
                {
                  sessionID,
                  agent: WorkflowRoleAgents.agentForRole("implement"),
                  name: "edit",
                  input: { path: "owned.txt", oldString: "workspace-b", newString: "forged" },
                },
                foreignMaterialization,
              ).pipe(
                Effect.match({
                  onFailure: (error) => ({ error }),
                  onSuccess: (settlement) => ({ settlement }),
                }),
              ),
              settle(
                location,
                admitted,
                {
                  sessionID,
                  agent: WorkflowRoleAgents.agentForRole("implement"),
                  name: "bash",
                  input: { command: "printf forged" },
                },
                foreignMaterialization,
              ).pipe(
                Effect.match({
                  onFailure: (error) => ({ error }),
                  onSuccess: (settlement) => ({ settlement }),
                }),
              ),
            ],
            { concurrency: 1 },
          )
          const files = yield* Effect.promise(() =>
            Promise.all([
              fs.readFile(path.join(workspace.path, "owned.txt"), "utf8"),
              fs.readFile(path.join(foreign.path, "owned.txt"), "utf8"),
            ]),
          )
          expect({
            materializationErrors: outcomes.map(
              (outcome) =>
                "error" in outcome &&
                outcome.error instanceof ToolRegistry.WorkflowAuthorityError &&
                outcome.error.code === "materialization_invalid",
            ),
            permissionAssertions,
            sandboxRuns,
            sandboxPolicyResolutions,
            processLaunches,
            outputBounds,
            files,
          }).toEqual({
            materializationErrors: [true, true],
            permissionAssertions: 0,
            sandboxRuns: 0,
            sandboxPolicyResolutions: 0,
            processLaunches: 0,
            outputBounds: 0,
            files: ["workspace-a", "workspace-b"],
          })
        }),
      (directories) =>
        Effect.promise(() =>
          Promise.all(directories.map((directory) => directory[Symbol.asyncDispose]())).then(() => undefined),
        ),
    ),
  )
})

let ordinal = 0

function syntheticAuthority(
  role: "implement" | "test",
  location: Location.Ref,
  sessionID: SessionV2.ID,
  label: string,
) {
  const current = ++ordinal
  const budget: Workflow.Budget = { maxTurns: 4, maxToolCalls: 8, maxAttempts: 2 }
  const workflowID = Workflow.ID.make(`wfl_authority_${label}_${current}`)
  const stageID = Workflow.StageID.make(`wfs_authority_${label}_${current}`)
  const workflow = Workflow.Info.make({
    id: workflowID,
    type: "development",
    status: "running",
    input: { brief: label },
    budget,
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
    location,
    sessionID,
    agent: AgentV2.ID.make("build"),
    version: 1,
    time: { created: DateTime.makeUnsafe(current), updated: DateTime.makeUnsafe(current) },
  })
  const stage = Workflow.Stage.make({
    id: stageID,
    workflowID,
    type: role,
    ordinal: 0,
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    recoveryPolicy: "restart_safe",
    idempotencyKey: `authority/${label}/${current}`,
    input: { plan: label },
    time: { created: DateTime.makeUnsafe(current), updated: DateTime.makeUnsafe(current) },
  })
  const route = WorkflowRouting.resolve({ role, budget })
  return WorkflowToolLineage.policyDigest({
    workflow,
    stage,
    route,
    agent: WorkflowRoleAgents.agentForRole(role),
  }).pipe(Effect.map((policyDigest) => ({ workflowID, stageID, route, policyDigest })))
}

function admit(role: "implement" | "test", location: Location.Ref, sessionID: SessionV2.ID, label: string) {
  return Effect.gen(function* () {
    const synthetic = yield* syntheticAuthority(role, location, sessionID, label)
    yield* EventV2.Service.use((events) =>
      events.publish(WorkflowEvent.Created, {
        workflowID: synthetic.workflowID,
        timestamp: DateTime.makeUnsafe(ordinal),
        type: "development",
        input: { brief: label },
        budget: synthetic.route.budget,
        location,
        sessionID,
        agent: AgentV2.ID.make("build"),
        stages: [
          {
            id: synthetic.stageID,
            type: role,
            ordinal: 0,
            maxAttempts: 2,
            recoveryPolicy: "restart_safe" as const,
            idempotencyKey: `authority/${label}/${ordinal}`,
            input: { plan: label },
          },
        ],
      }),
    )
    const detail = yield* WorkflowStore.Service.use((store) => store.get(synthetic.workflowID))
    const stage = yield* WorkflowStore.Service.use((store) => store.stage(synthetic.stageID))
    if (!detail || !stage) return yield* Effect.die("persisted authority fixture missing")
    const policyDigest = yield* WorkflowToolLineage.policyDigest({
      workflow: detail.run,
      stage,
      route: synthetic.route,
      agent: WorkflowRoleAgents.agentForRole(role),
    })
    return { ...synthetic, policyDigest }
  })
}

function settle(
  location: Location.Ref,
  authority: Pick<ToolRegistry.WorkflowAuthorityInput, "workflowID" | "stageID" | "route" | "policyDigest">,
  call: {
    readonly sessionID: SessionV2.ID
    readonly agent: AgentV2.ID
    readonly name: string
    readonly input: unknown
  },
  captured?: ToolRegistry.Materialization,
) {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const service = yield* ToolRegistry.WorkflowAuthorityService
    const materialization = captured ?? (yield* registry.materialize(WorkflowPermissions.forRole("implement")))
    return yield* service.settle({
      materialization,
      ...authority,
      sessionID: call.sessionID,
      agent: call.agent,
      assistantMessageID: SessionMessage.ID.make("msg_workflow_authority"),
      call: { type: "tool-call", id: `call-workflow-authority-${ordinal}`, name: call.name, input: call.input },
    })
  }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))
}

function materialize(location: Location.Ref) {
  return ToolRegistry.Service.use((registry) => registry.materialize(WorkflowPermissions.forRole("implement"))).pipe(
    Effect.scoped,
    Effect.provide(LocationServiceMap.Service.get(location)),
  )
}
