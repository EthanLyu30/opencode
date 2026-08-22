export * as WorkflowRoleAgents from "./role-agents"

import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { WorkflowPermissions } from "./permissions"

const ids = {
  design: AgentV2.ID.make("workflow-role-design"),
  decompose: AgentV2.ID.make("workflow-role-decompose"),
  implement: AgentV2.ID.make("workflow-role-implement"),
  repair: AgentV2.ID.make("workflow-role-repair"),
  test: AgentV2.ID.make("workflow-role-test"),
  visual_review: AgentV2.ID.make("workflow-role-visual-review"),
  deliver: AgentV2.ID.make("workflow-role-deliver"),
} satisfies Record<WorkflowRole.Role, AgentV2.ID>

export function agentForRole(role: WorkflowRole.Role) {
  return ids[role]
}

/**
 * Reinstalls the workflow-owned profile as the last Location transform before
 * every role turn. Keeping this transform scoped to the turn makes the leaf
 * permission lookup authoritative without changing the public Agent contract
 * or broadening the workflow's persisted admission agent.
 */
export const reassert = Effect.fn("WorkflowRoleAgents.reassert")(function* (role: WorkflowRole.Role) {
  const agents = yield* AgentV2.Service
  const id = agentForRole(role)
  yield* agents.transform((editor) =>
    editor.update(id, (agent) => {
      agent.model = undefined
      agent.request = { headers: {}, body: {} }
      agent.system = undefined
      agent.description = undefined
      agent.mode = "subagent"
      agent.hidden = true
      agent.color = undefined
      agent.steps = undefined
      agent.permissions = WorkflowPermissions.forRole(role).map((rule) => ({ ...rule }))
    }),
  )
})
