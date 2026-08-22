export * as WorkflowRoleAgents from "./role-agents"

import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { agentForRole, matches, roleForAgent } from "./role-agent-profiles"

export { agentForRole, roleForAgent }

/**
 * Reloads all Location configuration and verifies the final immutable profile
 * before each role turn. Agent state owns installation after every transform;
 * this turn-time check is intentionally fail-closed.
 */
export const reassert = Effect.fn("WorkflowRoleAgents.reassert")(function* (role: WorkflowRole.Role) {
  const agents = yield* AgentV2.Service
  yield* agents.reload()
  if (matches(role, yield* agents.get(agentForRole(role)))) return
  return yield* Effect.die(new Error(`Workflow role profile verification failed: ${role}`))
})
