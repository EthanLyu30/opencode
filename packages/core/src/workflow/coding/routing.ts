export * as CodingRouting from "./routing"

import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { WorkflowRouting } from "../routing"
import { WorkflowBenchmarkTransport } from "../benchmark-transport"
import { CodingModelSelection } from "./model-selection"

export interface Route extends Omit<WorkflowRouting.Route, "role"> {
  readonly role: WorkflowCodingBuild.Role
}
export interface Input {
  readonly role: WorkflowCodingBuild.Role
  readonly budget: Workflow.Budget
  readonly selection: CodingModelSelection.FrozenSelection
  readonly requested?: WorkflowRole.RequestedRoute
  readonly benchmarkTransport?: WorkflowBenchmarkTransport.Binding
  readonly now?: number
}
export function resolve(input: Input): Route {
  const role = Schema.decodeUnknownSync(WorkflowCodingBuild.Role)(input.role)
  const selection = CodingModelSelection.validate(input.selection)
  const route = WorkflowRouting.resolve({
    role: role === "code_review" ? "design" : role,
    budget: input.budget,
    selection: selection.source,
    requested: input.requested,
    benchmarkTransport: input.benchmarkTransport,
    now: input.now,
  })
  return Object.freeze({ ...route, role })
}
