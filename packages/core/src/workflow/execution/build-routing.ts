export * as BuildRouting from "./build-routing"

import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { Schema } from "effect"
import { WorkflowRouting } from "../routing"
import { WorkflowBenchmarkTransport } from "../benchmark-transport"
import { ModelSelection } from "../model-selection"
import { CodingRouting } from "../coding/routing"
import { CodingModelSelection } from "../coding/model-selection"

export type Route = WorkflowRouting.Route | CodingRouting.Route
export type Role = WorkflowRole.Role | WorkflowCodingBuild.Role

export function sourceSelection(workflow: Workflow.Info) {
  return workflow.type === "coding-build"
    ? CodingModelSelection.fromWorkflow(workflow).source
    : ModelSelection.optionalFromWorkflow(workflow)
}

export function resolve(input: { readonly workflow: Workflow.Info; readonly stage: Workflow.Stage }): Route {
  const transport = WorkflowBenchmarkTransport.fromWorkflow(input.workflow)
  if (input.workflow.type === "coding-build") {
    const role = Schema.decodeUnknownSync(WorkflowCodingBuild.Role)(input.stage.type)
    return CodingRouting.resolve({
      role,
      budget: input.workflow.budget,
      selection: CodingModelSelection.fromWorkflow(input.workflow),
      benchmarkTransport: transport,
      requested: WorkflowRouting.requestedFromStage(role === "code_review" ? "design" : role, input.stage.input),
    })
  }
  const role = Schema.decodeUnknownSync(WorkflowRole.Role)(input.stage.type)
  return WorkflowRouting.resolve({
    role,
    budget: input.workflow.budget,
    selection: ModelSelection.optionalFromWorkflow(input.workflow),
    benchmarkTransport: transport,
    requested: WorkflowRouting.requestedFromStage(role, input.stage.input),
  })
}

export function forResponseModel(route: Route, modelID: string): Route {
  if (route.role !== "deliver")
    throw new Error("Only a deliver stage can execute an explicitly selected Response model")
  return WorkflowRouting.forResponseModel({ ...route, role: "deliver" }, modelID)
}
