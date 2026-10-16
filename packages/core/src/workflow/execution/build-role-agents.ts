export * as BuildRoleAgents from "./build-role-agents"

import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Schema } from "effect"
import { WorkflowRoleAgents } from "../role-agents"
import { CodingRoleAgents } from "../coding/role-agents"
import { BuildRouting } from "./build-routing"

export function agentForRole(workflow: Workflow.Info, role: BuildRouting.Role) {
  return workflow.type === "coding-build"
    ? CodingRoleAgents.agentForRole(Schema.decodeUnknownSync(WorkflowCodingBuild.Role)(role))
    : WorkflowRoleAgents.agentForRole(Schema.decodeUnknownSync(WorkflowRole.Role)(role))
}
export function reassert(workflow: Workflow.Info, role: BuildRouting.Role) {
  return workflow.type === "coding-build"
    ? CodingRoleAgents.reassert(Schema.decodeUnknownSync(WorkflowCodingBuild.Role)(role))
    : WorkflowRoleAgents.reassert(Schema.decodeUnknownSync(WorkflowRole.Role)(role))
}
