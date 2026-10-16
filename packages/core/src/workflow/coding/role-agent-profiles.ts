export * as CodingRoleAgentProfiles from "./role-agent-profiles"

import { Agent } from "@opencode-ai/schema/agent"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { Types } from "effect"
import { CodingPermissions } from "./permissions"

const fields = new Set([
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

export function agentForRole(role: WorkflowCodingBuild.Role) {
  return Agent.ID.make(`workflow-coding-role-${role}`)
}
export function roleForAgent(id: Agent.ID) {
  return WorkflowCodingBuild.Role.literals.find((role) => agentForRole(role) === id)
}
export function isRoleAgent(id: Agent.ID) {
  return roleForAgent(id) !== undefined
}

export function install(editor: {
  readonly update: (id: Agent.ID, update: (agent: Types.DeepMutable<Agent.Info>) => void) => void
}) {
  const installed: Types.DeepMutable<Agent.Info>[] = []
  for (const role of WorkflowCodingBuild.Role.literals) {
    const id = agentForRole(role)
    editor.update(id, (agent) => {
      const value = agent as unknown as Record<string, unknown>
      for (const key of Object.keys(value)) if (!fields.has(key)) delete value[key]
      agent.id = id
      agent.model = undefined
      agent.request = Object.freeze({ headers: Object.freeze({}), body: Object.freeze({}) })
      agent.system = undefined
      agent.description = undefined
      agent.mode = "subagent"
      agent.hidden = true
      agent.color = undefined
      agent.steps = undefined
      agent.permissions = Object.freeze(
        CodingPermissions.forRole(role).map((rule) => Object.freeze({ ...rule })),
      ) as Types.DeepMutable<Agent.Info>["permissions"]
      installed.push(agent)
    })
  }
  installed.forEach(Object.freeze)
}

export function matches(role: WorkflowCodingBuild.Role, agent: Agent.Info | undefined): boolean {
  const expected = CodingPermissions.forRole(role)
  return (
    agent !== undefined &&
    Object.isFrozen(agent) &&
    Object.keys(agent).length === fields.size &&
    Object.keys(agent).every((field) => fields.has(field)) &&
    agent.id === agentForRole(role) &&
    agent.model === undefined &&
    Object.keys(agent.request.headers).length === 0 &&
    Object.keys(agent.request.body).length === 0 &&
    agent.system === undefined &&
    agent.description === undefined &&
    agent.mode === "subagent" &&
    agent.hidden &&
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
