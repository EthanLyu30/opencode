export * as WorkflowCodingBuild from "./workflow-coding-build"

import { Schema } from "effect"
import { DesignArtifact } from "./design-artifact"
import { Responses } from "./responses"
import { NonNegativeInt, optional, PositiveInt } from "./schema"
import { Workflow } from "./workflow"

const exact = { parseOptions: { onExcessProperty: "error" as const } }

export const Role = Schema.Literals([
  "design",
  "decompose",
  "implement",
  "test",
  "code_review",
  "repair",
  "deliver",
]).annotate({ identifier: "WorkflowCodingBuild.Role" })
export type Role = typeof Role.Type

export const Limits = Schema.Struct({
  maxRevisions: NonNegativeInt.check(Schema.isLessThanOrEqualTo(10)),
  maxTokens: PositiveInt,
  maxTurns: PositiveInt,
  maxToolCalls: PositiveInt,
}).annotate({ identifier: "WorkflowCodingBuild.Limits", ...exact })
export interface Limits extends Schema.Schema.Type<typeof Limits> {}

export const Checks = Schema.Struct({
  cwd: Schema.Union([Schema.Literal("."), DesignArtifact.SourcePath]),
  test: Schema.Literals(["bun-test", "bun-run-test"]),
  build: Schema.Literal("bun-run-build").pipe(optional),
  typecheck: Schema.Literal("bun-run-typecheck").pipe(optional),
}).annotate({ identifier: "WorkflowCodingBuild.Checks", ...exact })
export interface Checks extends Schema.Schema.Type<typeof Checks> {}

export const CreateInput = Schema.Struct({
  prompt: Schema.NonEmptyString,
  budget: Workflow.Budget,
  coding: Limits,
  checks: Checks,
  delivery: Schema.Literals(["foreground", "background"]),
}).annotate({ identifier: "WorkflowCodingBuild.CreateInput", ...exact })
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const Admission = Schema.Struct({
  workflow: Workflow.Info,
  response: Responses.Resource,
}).annotate({ identifier: "WorkflowCodingBuild.Admission", ...exact })
export interface Admission extends Schema.Schema.Type<typeof Admission> {}
