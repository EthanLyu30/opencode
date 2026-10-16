export * as BuildContract from "./build-contract"

import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { Schema } from "effect"
import { WorkflowRoleContract } from "./contract"
import { CodingContract } from "../coding/contract"
import { BuildRouting } from "./build-routing"

export type Contract = WorkflowRoleContract.Contract | CodingContract.Contract
export type Authority = WorkflowRoleContract.Authority | CodingContract.Authority
export type RoleResult = WorkflowRoleContract.RoleResult | CodingContract.RoleResult
export interface BuildInput extends Omit<WorkflowRoleContract.BuildInput, "route"> {
  readonly route: BuildRouting.Route
}

export function build(input: BuildInput): Contract {
  if (input.workflow.type === "coding-build") {
    const role = Schema.decodeUnknownSync(WorkflowCodingBuild.Role)(input.stage.type)
    if (input.route.role !== role) throw new Error("Coding route role mismatch")
    return CodingContract.build({ ...input, route: { ...input.route, role } })
  }
  const role = Schema.decodeUnknownSync(WorkflowRole.Role)(input.stage.type)
  if (input.route.role !== role) throw new Error("Visual route role mismatch")
  return WorkflowRoleContract.build({ ...input, route: { ...input.route, role } })
}
export function decode(contract: Contract, input: unknown): RoleResult {
  return "kind" in contract ? CodingContract.decode(contract, input) : WorkflowRoleContract.decode(contract, input)
}
export function decodeJson(contract: Contract, text: string): RoleResult {
  return "kind" in contract
    ? CodingContract.decodeJson(contract, text)
    : WorkflowRoleContract.decodeJson(contract, text)
}
export function verifyAuthority(
  input: Omit<Parameters<typeof WorkflowRoleContract.verifyAuthority>[0], "authority"> & {
    readonly authority: Authority
  },
): void {
  if (input.workflow.type === "coding-build") {
    if (!("kind" in input.authority)) throw new Error("Coding authority kind required")
    return CodingContract.verifyAuthority({ ...input, authority: input.authority })
  }
  if ("kind" in input.authority) throw new Error("Coding authority cannot settle a legacy workflow")
  return WorkflowRoleContract.verifyAuthority({ ...input, authority: input.authority })
}
