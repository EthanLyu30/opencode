export * as WorkflowRole from "./workflow-role"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema"

export const Role = Schema.Literals([
  "design",
  "decompose",
  "implement",
  "test",
  "visual_review",
  "repair",
  "deliver",
]).annotate({ identifier: "WorkflowRole.Role" })
export type Role = typeof Role.Type

export const Protocol = Schema.Literals(["openai-chat", "openai-responses"]).annotate({
  identifier: "WorkflowRole.Protocol",
})
export type Protocol = typeof Protocol.Type

export const ReasoningEffort = Schema.Literals(["high", "max"]).annotate({
  identifier: "WorkflowRole.ReasoningEffort",
})
export type ReasoningEffort = typeof ReasoningEffort.Type

export const RequestedRoute = Schema.Struct({
  providerID: Schema.NonEmptyString,
  modelID: Schema.NonEmptyString,
  protocol: Protocol,
}).annotate({ identifier: "WorkflowRole.RequestedRoute" })
export interface RequestedRoute extends Schema.Schema.Type<typeof RequestedRoute> {}

const ReadyOutcome = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: Schema.Literals(["design", "decompose", "implement", "repair"]),
  verdict: Schema.Literal("ready"),
  revision: NonNegativeInt,
})

const ReviewOutcome = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: Schema.Literals(["test", "visual_review"]),
  verdict: Schema.Literals(["pass", "revise"]),
  revision: NonNegativeInt,
})

const DeliveryOutcome = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: Schema.Literal("deliver"),
  verdict: Schema.Literal("complete"),
  revision: NonNegativeInt,
})

/** The only structured model result allowed to drive a role transition. */
export const Outcome = Schema.Union([ReadyOutcome, ReviewOutcome, DeliveryOutcome]).annotate({
  identifier: "WorkflowRole.Outcome",
})
export type Outcome = typeof Outcome.Type
