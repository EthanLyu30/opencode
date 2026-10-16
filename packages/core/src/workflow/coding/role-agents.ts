export * as CodingRoleAgents from "./role-agents"

import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { Effect } from "effect"
import { AgentV2 } from "../../agent"
import { CodingRoleAgentProfiles } from "./role-agent-profiles"

export const agentForRole = CodingRoleAgentProfiles.agentForRole
export const reassert = Effect.fn("CodingRoleAgents.reassert")(function* (role: WorkflowCodingBuild.Role) {
  const agents = yield* AgentV2.Service
  yield* agents.reload()
  if (CodingRoleAgentProfiles.matches(role, yield* agents.get(agentForRole(role)))) return
  return yield* Effect.die(new Error(`Coding role profile verification failed: ${role}`))
})
