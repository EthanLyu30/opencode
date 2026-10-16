export * as CodingPermissions from "./permissions"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { WorkflowPermissions } from "../permissions"

export function forRole(role: WorkflowCodingBuild.Role) {
  return WorkflowPermissions.forRole(role === "code_review" ? "design" : role)
}
