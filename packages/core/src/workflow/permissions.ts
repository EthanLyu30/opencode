export * as WorkflowPermissions from "./permissions"

import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { PermissionV2 } from "../permission"

const readable = ["read", "glob", "grep"] as const
const verifiable = [...readable, "workflow_command"] as const
const mutable = [...readable, "edit", "workflow_command"] as const

const allowed = {
  design: readable,
  decompose: readable,
  implement: mutable,
  repair: mutable,
  test: verifiable,
  visual_review: readable,
  deliver: [...readable, "workflow_finalize"],
} satisfies Record<WorkflowRole.Role, readonly string[]>

export function forRole(role: WorkflowRole.Role): PermissionV2.Ruleset {
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...allowed[role].map((action) => ({ action, resource: "*", effect: "allow" as const })),
  ]
}
