export * as WorkflowRoleAgentProfiles from "./role-agent-profiles"

import { Agent } from "@opencode-ai/schema/agent"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Types } from "effect"
import { WorkflowPermissions } from "./permissions"

const ids = {
  design: Agent.ID.make("workflow-role-design"),
  decompose: Agent.ID.make("workflow-role-decompose"),
  implement: Agent.ID.make("workflow-role-implement"),
  repair: Agent.ID.make("workflow-role-repair"),
  test: Agent.ID.make("workflow-role-test"),
  visual_review: Agent.ID.make("workflow-role-visual-review"),
  deliver: Agent.ID.make("workflow-role-deliver"),
} satisfies Record<WorkflowRole.Role, Agent.ID>

const profileFields = new Set([
  "id",
  "model",
  "request",
  "system",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "permissions",
])

type Editor = {
  readonly update: (id: Agent.ID, update: (agent: Types.DeepMutable<Agent.Info>) => void) => void
}

export function agentForRole(role: WorkflowRole.Role) {
  return ids[role]
}

export function isRoleAgent(id: Agent.ID) {
  return WorkflowRole.Role.literals.some((role) => agentForRole(role) === id)
}

export function roleForAgent(id: Agent.ID) {
  return WorkflowRole.Role.literals.find((role) => agentForRole(role) === id)
}

/**
 * This finalizer is deliberately separate from Agent configuration transforms:
 * every Location owns all seven profiles, and replayed user configuration is
 * unable to remove or broaden them because this runs after every reload.
 */
export function install(editor: Editor) {
  const installed: Types.DeepMutable<Agent.Info>[] = []
  for (const role of WorkflowRole.Role.literals) {
    const id = agentForRole(role)
    editor.update(id, (agent) => {
      const value = agent as unknown as Record<string, unknown>
      for (const key of Object.keys(value)) if (!profileFields.has(key)) delete value[key]
      agent.model = undefined
      agent.request = Object.freeze({ headers: Object.freeze({}), body: Object.freeze({}) })
      agent.system = undefined
      agent.description = undefined
      agent.mode = "subagent"
      agent.hidden = true
      agent.color = undefined
      agent.steps = undefined
      agent.permissions = Object.freeze(
        WorkflowPermissions.forRole(role).map((rule) => Object.freeze({ ...rule })),
      ) as Types.DeepMutable<Agent.Info>["permissions"]
      installed.push(agent)
    })
  }
  installed.forEach(Object.freeze)
}

export function matches(role: WorkflowRole.Role, agent: Agent.Info | undefined) {
  if (!agent) return false
  const expected = WorkflowPermissions.forRole(role)
  return (
    Object.isFrozen(agent) &&
    Object.keys(agent).length === profileFields.size &&
    Object.keys(agent).every((field) => profileFields.has(field)) &&
    agent.id === agentForRole(role) &&
    agent.model === undefined &&
    Object.keys(agent.request.headers).length === 0 &&
    Object.keys(agent.request.body).length === 0 &&
    agent.system === undefined &&
    agent.description === undefined &&
    agent.mode === "subagent" &&
    agent.hidden === true &&
    agent.color === undefined &&
    agent.steps === undefined &&
    agent.permissions.length === expected.length &&
    agent.permissions.every(
      (rule, index) =>
        rule.action === expected[index]?.action &&
        rule.resource === expected[index]?.resource &&
        rule.effect === expected[index]?.effect,
    )
  )
}
