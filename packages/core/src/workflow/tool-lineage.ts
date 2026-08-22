export * as WorkflowToolLineage from "./tool-lineage"

import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Effect, Schema } from "effect"
import { AgentV2 } from "../agent"
import { SessionSchema } from "../session/schema"
import { Hash } from "../util/hash"
import { WorkflowRouting } from "./routing"

const domain = "opencode.workflow.tool-policy"
const version = 1 as const
const issued = new WeakSet<object>()
declare const TypeId: unique symbol

export interface Lineage {
  readonly [TypeId]: true
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly role: WorkflowRole.Role
  readonly policyDigest: string
}

export interface Descriptor {
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly role: WorkflowRole.Role
  readonly policyDigest: string
}

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("WorkflowToolLineage.Invalid", {
  message: Schema.String,
}) {}

export interface IssueInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly route: WorkflowRouting.Route
  readonly agent: AgentV2.ID
}

export function issue(input: IssueInput): Effect.Effect<Lineage, Invalid> {
  return policyDigest(input).pipe(
    Effect.map((policyDigest) => {
      const lineage = Object.freeze({
        workflowID: input.workflow.id,
        stageID: input.stage.id,
        sessionID: input.workflow.sessionID!,
        agent: input.agent,
        role: input.route.role,
        policyDigest,
      }) as Lineage
      issued.add(lineage)
      return lineage
    }),
  )
}

export function policyDigest(input: IssueInput): Effect.Effect<string, Invalid> {
  if (input.workflow.location === undefined || input.workflow.sessionID === undefined)
    return Effect.fail(new Invalid({ message: "Workflow tool lineage requires persisted placement" }))
  if (input.stage.workflowID !== input.workflow.id)
    return Effect.fail(new Invalid({ message: "Workflow tool lineage stage does not belong to the workflow" }))
  if (input.stage.type !== input.route.role)
    return Effect.fail(new Invalid({ message: "Workflow tool lineage stage does not match the resolved role" }))

  return Effect.try({
    try: () => {
      const workflowRequestHash = digest("workflow-request", {
        type: input.workflow.type,
        input: input.workflow.input,
        budget: input.workflow.budget,
        location: input.workflow.location,
        sessionID: input.workflow.sessionID,
        agent: input.workflow.agent ?? null,
      })
      const stageRequestHash = digest("stage-request", {
        type: input.stage.type,
        ordinal: input.stage.ordinal,
        maxAttempts: input.stage.maxAttempts,
        recoveryPolicy: input.stage.recoveryPolicy,
        idempotencyKey: input.stage.idempotencyKey,
        input: input.stage.input,
      })
      const routePolicyHash = digest("route-policy", {
        role: input.route.role,
        providerID: input.route.providerID,
        modelID: input.route.modelID,
        protocol: input.route.protocol,
        reasoningEffort: input.route.reasoningEffort,
        requiredCapabilities: input.route.requiredCapabilities,
        budget: input.route.budget,
      })
      return digest("policy", {
        workflowID: input.workflow.id,
        stageID: input.stage.id,
        role: input.route.role,
        workflowRequestHash,
        stageRequestHash,
        routePolicyHash,
      })
    },
    catch: () => new Invalid({ message: "Workflow tool policy contains a non-canonical value" }),
  })
}

export function inspect(lineage: Lineage | undefined): Descriptor | undefined {
  if (lineage === undefined || !issued.has(lineage)) return undefined
  return lineage
}

function digest(scope: string, value: unknown) {
  return Hash.sha256(`${domain}\0${version}\0${scope}\0${canonical(value)}`)
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value !== "object") throw new TypeError("Workflow tool policy contains a non-canonical value")
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}
