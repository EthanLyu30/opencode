export * as WorkflowPermissions from "./permissions"

import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { PermissionV2 } from "../permission"

const readable = ["read", "glob", "grep"] as const
const executable = [...readable, "bash"] as const
const mutable = [...executable, "edit"] as const

const allowed = {
  design: readable,
  decompose: readable,
  implement: mutable,
  repair: mutable,
  test: executable,
  visual_review: readable,
  deliver: executable,
} satisfies Record<WorkflowRole.Role, readonly string[]>

export function forRole(role: WorkflowRole.Role): PermissionV2.Ruleset {
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...allowed[role].map((action) => ({ action, resource: "*", effect: "allow" as const })),
  ]
}
