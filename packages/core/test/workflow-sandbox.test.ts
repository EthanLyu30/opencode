import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
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
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowPermissions } from "@opencode-ai/core/workflow/permissions"
import { WorkflowRoleAgents } from "@opencode-ai/core/workflow/role-agents"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { WorkflowToolLineage } from "@opencode-ai/core/workflow/tool-lineage"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
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

const sandboxPolicies = new Map<
  string,
  { readonly workspace: "readonly" | "readwrite"; readonly outputDirectories: readonly string[] }
>()
let sandboxPolicyResolutions = 0
const access = {
  implement: { workspace: "readwrite", outputDirectories: [] },
  repair: { workspace: "readwrite", outputDirectories: [] },
  test: { workspace: "readonly", outputDirectories: ["test-output"] },
  deliver: { workspace: "readonly", outputDirectories: ["release"] },
} as const
const sandbox = WorkflowCommandSandbox.wslNode({
  distribution: "Ubuntu-24.04",
  resolvePolicy: (input) => {
    sandboxPolicyResolutions++
    return sandboxPolicies.get(policyKey(input))
  },
  limits: {
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1_024,
    maxProcesses: 64,
    maxMemoryBytes: 1_073_741_824,
    maxOpenFiles: 256,
  },
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      WorkflowProjector.node,
      WorkflowStore.node,
      LocationServiceMap.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [WorkflowCommandSandbox.node, sandbox],
    ],
  ),
)

describe("Workflow command sandbox", () => {
  it.live("rejects a synthetic lineage before leaf or sandbox authority", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (workspace) =>
        Effect.gen(function* () {
          sandboxPolicyResolutions = 0
          const location = Location.Ref.make({ directory: AbsolutePath.make(workspace.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_sandbox_synthetic_lineage")
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location }))

          const settled = yield* Effect.gen(function* () {
            const materialized = yield* (yield* ToolRegistry.Service).materialize(
              WorkflowPermissions.forRole("implement"),
            )
            const synthetic = yield* syntheticAuthority("implement", location, sessionID)
            return yield* (yield* ToolRegistry.WorkflowAuthorityService)
              .settle({
                materialization: materialized,
                ...synthetic,
                sessionID,
                agent: WorkflowRoleAgents.agentForRole("implement"),
                assistantMessageID: SessionMessage.ID.make("msg_workflow_sandbox_synthetic_lineage"),
                call: {
                  type: "tool-call",
                  id: "call-workflow-sandbox-synthetic-lineage",
                  name: "bash",
                  input: { command: "printf forged > forged.txt" },
                },
              })
              .pipe(Effect.flip)
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))

          expect(settled).toMatchObject({ _tag: "ToolRegistry.WorkflowAuthorityError", code: "workflow_missing" })
          expect(sandboxPolicyResolutions).toBe(0)
          expect(
            yield* Effect.promise(() => fs.stat(path.join(workspace.path, "forged.txt")).catch(() => undefined)),
          ).toBeUndefined()
        }),
      (workspace) => Effect.promise(() => workspace[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects reserved-agent Bash when generic settlement smuggles forged workflow lineage", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (workspace) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(workspace.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_sandbox_forged_lineage")
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location }))

          const settled = yield* Effect.gen(function* () {
            const materialized = yield* (yield* ToolRegistry.Service).materialize(
              WorkflowPermissions.forRole("implement"),
            )
            return yield* materialized.settle({
              sessionID,
              agent: WorkflowRoleAgents.agentForRole("implement"),
              assistantMessageID: SessionMessage.ID.make("msg_workflow_sandbox_forged_lineage"),
              call: {
                type: "tool-call",
                id: "call-workflow-sandbox-forged-lineage",
                name: "bash",
                input: { command: "printf forged > forged.txt" },
              },
              workflowLineage: {
                workflowID: "wfl_forged",
                stageID: "wfs_forged",
                policyDigest: "0".repeat(64),
              },
            } as ToolRegistry.ExecuteInput & { readonly workflowLineage: object })
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))

          expect(settled.result).toMatchObject({
            type: "error",
            value: expect.stringContaining("reserved for internal workflow settlement"),
          })
          expect(
            yield* Effect.promise(() => fs.stat(path.join(workspace.path, "forged.txt")).catch(() => undefined)),
          ).toBeUndefined()
        }),
      (workspace) => Effect.promise(() => workspace[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not launch when no exact frozen sandbox policy matches verified lineage", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (workspace) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(workspace.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_sandbox_policy_mismatch")
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location }))

          const settled = yield* Effect.gen(function* () {
            const materialized = yield* (yield* ToolRegistry.Service).materialize(
              WorkflowPermissions.forRole("implement"),
            )
            return yield* settleAuthorized(
              materialized,
              {
                sessionID,
                agent: WorkflowRoleAgents.agentForRole("implement"),
                assistantMessageID: SessionMessage.ID.make("msg_workflow_sandbox_policy_mismatch"),
                call: {
                  type: "tool-call",
                  id: "call-workflow-sandbox-policy-mismatch",
                  name: "bash",
                  input: { command: "printf mismatched > mismatched.txt" },
                },
              },
              yield* admit("implement", location, sessionID),
            )
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))

          expect(settled.result).toMatchObject({
            type: "error",
            value: expect.stringContaining("frozen sandbox policy"),
          })
          expect(
            yield* Effect.promise(() => fs.stat(path.join(workspace.path, "mismatched.txt")).catch(() => undefined)),
          ).toBeUndefined()
        }),
      (workspace) => Effect.promise(() => workspace[Symbol.asyncDispose]()),
    ),
  )

  it.live("executes arbitrary contained implementation and repair commands with declared writes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (workspace) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(workspace.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_sandbox_execution")
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location }))

          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            let call = 0
            const execute = (role: "implement" | "repair", command: string) =>
              Effect.gen(function* () {
                const materialized = yield* registry.materialize(WorkflowPermissions.forRole(role))
                const issued = yield* admit(role, location, sessionID)
                sandboxPolicies.set(policyKey(issued), access[role])
                return yield* settleAuthorized(
                  materialized,
                  {
                    sessionID,
                    agent: WorkflowRoleAgents.agentForRole(role),
                    assistantMessageID: SessionMessage.ID.make(`msg_workflow_sandbox_${role}`),
                    call: {
                      type: "tool-call",
                      id: `call-workflow-sandbox-${++call}`,
                      name: "bash",
                      input: { command },
                    },
                  },
                  issued,
                )
              })

            for (const role of WorkflowRole.Role.literals) {
              expect(
                (yield* registry.materialize(WorkflowPermissions.forRole(role))).definitions
                  .map((definition) => definition.name)
                  .sort(),
              ).toEqual(expectedCatalog[role])
            }

            const build = yield* execute("implement", "mkdir -p dist && printf built > dist/build.txt")
            expect(build.output?.structured).toMatchObject({ exit: 0 })
            expect((yield* execute("implement", "printf arbitrary > arbitrary.txt")).output?.structured).toMatchObject({
              exit: 0,
            })
            expect((yield* execute("repair", "printf repaired > repaired.txt")).output?.structured).toMatchObject({
              exit: 0,
            })
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))

          expect(yield* Effect.promise(() => fs.readFile(path.join(workspace.path, "dist", "build.txt"), "utf8"))).toBe(
            "built",
          )
          expect(yield* Effect.promise(() => fs.readFile(path.join(workspace.path, "arbitrary.txt"), "utf8"))).toBe(
            "arbitrary",
          )
          expect(yield* Effect.promise(() => fs.readFile(path.join(workspace.path, "repaired.txt"), "utf8"))).toBe(
            "repaired",
          )
        }),
      (workspace) => Effect.promise(() => workspace[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects implementation traversal, absolute, subprocess, network, and host-shell escapes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([workspace, outside]) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(workspace.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_sandbox_boundaries")
          const source = path.join(workspace.path, "source.txt")
          const outsideFile = path.join(outside.path, "outside.txt")
          const absoluteEscape = path.join(outside.path, "absolute-escape.txt")
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(source, "source"), fs.writeFile(outsideFile, "outside")]),
          )
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location }))

          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            let call = 0
            const execute = (role: "implement", command: string) =>
              Effect.gen(function* () {
                const materialized = yield* registry.materialize(WorkflowPermissions.forRole(role))
                const issued = yield* admit(role, location, sessionID)
                sandboxPolicies.set(policyKey(issued), access[role])
                return yield* settleAuthorized(
                  materialized,
                  {
                    sessionID,
                    agent: WorkflowRoleAgents.agentForRole(role),
                    assistantMessageID: SessionMessage.ID.make(`msg_workflow_sandbox_boundary_${role}`),
                    call: {
                      type: "tool-call",
                      id: `call-workflow-sandbox-boundary-${++call}`,
                      name: "bash",
                      input: { command },
                    },
                  },
                  issued,
                )
              })
            const reject = (role: "implement", command: string) =>
              execute(role, command).pipe(
                Effect.map((settled) => expect(settled.output?.structured).not.toMatchObject({ exit: 0 })),
              )

            yield* reject("implement", "printf escaped > ../outside.txt")
            yield* reject("implement", `printf escaped > '${toWsl(absoluteEscape)}'`)
            yield* reject("implement", "sh -c 'printf escaped > ../outside.txt'")
            yield* reject("implement", "python3 -c 'import socket; socket.create_connection((\"1.1.1.1\", 53), 1)'")
            yield* reject("implement", "/init /c 'echo escaped'")
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))

          expect(yield* Effect.promise(() => fs.readFile(source, "utf8"))).toBe("source")
          expect(yield* Effect.promise(() => fs.readFile(outsideFile, "utf8"))).toBe("outside")
          expect(yield* Effect.promise(() => fs.readdir(outside.path))).toEqual(["outside.txt"])
        }),
      (directories) =>
        Effect.promise(() =>
          Promise.all(directories.map((directory) => directory[Symbol.asyncDispose]())).then(() => undefined),
        ),
    ),
  )

  it.live("rejects symbolic-link and junction workspaces before executing Bash", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([workspace, outside]) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(workspace.path) })
          const sessionID = SessionV2.ID.make("ses_workflow_sandbox_links")
          const outsideFile = path.join(outside.path, "outside.txt")
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(outsideFile, "outside"),
              fs.symlink(outsideFile, path.join(workspace.path, "outside-link.txt"), "file"),
              fs.symlink(outside.path, path.join(workspace.path, "outside-junction"), "junction"),
            ]),
          )
          yield* SessionV2.Service.use((sessions) => sessions.create({ id: sessionID, location }))

          yield* Effect.gen(function* () {
            const materialized = yield* (yield* ToolRegistry.Service).materialize(
              WorkflowPermissions.forRole("implement"),
            )
            for (const [id, command] of [
              ["symlink", "printf escaped > outside-link.txt"],
              ["junction", "printf escaped > outside-junction/created.txt"],
            ] as const) {
              const issued = yield* admit("implement", location, sessionID)
              sandboxPolicies.set(policyKey(issued), access.implement)
              const settled = yield* settleAuthorized(
                materialized,
                {
                  sessionID,
                  agent: WorkflowRoleAgents.agentForRole("implement"),
                  assistantMessageID: SessionMessage.ID.make("msg_workflow_sandbox_links"),
                  call: { type: "tool-call", id: `call-workflow-sandbox-${id}`, name: "bash", input: { command } },
                },
                issued,
              )
              expect(settled.result).toMatchObject({
                type: "error",
                value: expect.stringContaining("symbolic links or junctions"),
              })
            }
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))

          expect(yield* Effect.promise(() => fs.readFile(outsideFile, "utf8"))).toBe("outside")
          expect(yield* Effect.promise(() => fs.readdir(outside.path))).toEqual(["outside.txt"])
        }),
      (directories) =>
        Effect.promise(() =>
          Promise.all(directories.map((directory) => directory[Symbol.asyncDispose]())).then(() => undefined),
        ),
    ),
  )
})

const expectedCatalog = {
  design: ["glob", "grep", "read"],
  decompose: ["glob", "grep", "read"],
  implement: ["apply_patch", "bash", "edit", "glob", "grep", "read", "write"],
  repair: ["apply_patch", "bash", "edit", "glob", "grep", "read", "write"],
  test: ["glob", "grep", "read"],
  visual_review: ["glob", "grep", "read"],
  deliver: ["glob", "grep", "read"],
} satisfies Record<WorkflowRole.Role, readonly string[]>

function toWsl(value: string) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value)
  if (!match) throw new Error(`Expected Windows path: ${value}`)
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replaceAll("\\", "/")}`
}

let authorityOrdinal = 0

function syntheticAuthority(role: WorkflowRole.Role, location: Location.Ref, sessionID: SessionV2.ID) {
  const budget: Workflow.Budget = { maxTurns: 4, maxToolCalls: 8, maxAttempts: 2 }
  const suffix = `${role}_${++authorityOrdinal}`
  const workflowID = Workflow.ID.make(`wfl_sandbox_${suffix}`)
  const stageID = Workflow.StageID.make(`wfs_sandbox_${suffix}`)
  const workflow = Workflow.Info.make({
    id: workflowID,
    type: "development",
    status: "running",
    input: { brief: "Exercise the contained command backend" },
    budget,
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
    location,
    sessionID,
    agent: AgentV2.ID.make("build"),
    version: 1,
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
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
    idempotencyKey: `sandbox/${role}`,
    input: { plan: role },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  })
  const route = WorkflowRouting.resolve({ role, budget })
  return WorkflowToolLineage.policyDigest({
    workflow,
    stage,
    route,
    agent: WorkflowRoleAgents.agentForRole(role),
  }).pipe(Effect.map((policyDigest) => ({ workflowID, stageID, role, route, policyDigest })))
}

function admit(role: WorkflowRole.Role, location: Location.Ref, sessionID: SessionV2.ID) {
  return Effect.gen(function* () {
    const synthetic = yield* syntheticAuthority(role, location, sessionID)
    const events = yield* EventV2.Service
    yield* events.publish(WorkflowEvent.Created, {
      workflowID: synthetic.workflowID,
      timestamp: DateTime.makeUnsafe(authorityOrdinal),
      type: "development",
      input: { brief: "Exercise the contained command backend" },
      budget: { maxTurns: 4, maxToolCalls: 8, maxAttempts: 2 },
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
          idempotencyKey: `sandbox/${role}/${authorityOrdinal}`,
          input: { plan: role },
        },
      ],
    })
    const store = yield* WorkflowStore.Service
    const detail = yield* store.get(synthetic.workflowID)
    const stage = yield* store.stage(synthetic.stageID)
    if (!detail || !stage) return yield* Effect.die("persisted workflow authority fixture missing")
    const policyDigest = yield* WorkflowToolLineage.policyDigest({
      workflow: detail.run,
      stage,
      route: synthetic.route,
      agent: WorkflowRoleAgents.agentForRole(role),
    })
    return { ...synthetic, policyDigest }
  })
}

function settleAuthorized(
  materialization: ToolRegistry.Materialization,
  input: ToolRegistry.ExecuteInput,
  authority: Pick<ToolRegistry.WorkflowAuthorityInput, "workflowID" | "stageID" | "route" | "policyDigest">,
) {
  return ToolRegistry.WorkflowAuthorityService.use((service) =>
    service.settle({ materialization, ...authority, ...input }),
  )
}

function policyKey(input: {
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly role: WorkflowRole.Role
  readonly policyDigest: string
}) {
  return `${input.workflowID}\0${input.stageID}\0${input.role}\0${input.policyDigest}`
}
