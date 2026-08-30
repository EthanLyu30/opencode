export * as WorkflowVisualBuild from "./workflow-visual-build"

import { Schema } from "effect"
import { DesignArtifact } from "./design-artifact"
import { NonNegativeInt, optional, PositiveInt } from "./schema"
import { VisualReview } from "./visual-review"
import { Workflow } from "./workflow"
import { Responses } from "./responses"

const exact = { parseOptions: { onExcessProperty: "error" as const } }

const MaxRevisions = NonNegativeInt.check(Schema.isLessThanOrEqualTo(VisualReview.MAX_VISUAL_REVISIONS))

/**
 * Bounds the visual-review loop. Screenshot byte ceilings are fixed host
 * policy and deliberately are not caller-controlled fields.
 */
export const VisualLimits = Schema.Struct({
  maxRevisions: MaxRevisions,
  maxTokens: PositiveInt,
  maxTurns: PositiveInt,
  maxToolCalls: PositiveInt,
}).annotate({ identifier: "WorkflowVisualBuild.VisualLimits", ...exact })
export interface VisualLimits extends Schema.Schema.Type<typeof VisualLimits> {}

/** A Location-relative directory. Core resolves and canonicalizes it. */
export const ProjectDirectory = Schema.Union([Schema.Literal("."), DesignArtifact.SourcePath]).annotate({
  identifier: "WorkflowVisualBuild.ProjectDirectory",
})
export type ProjectDirectory = typeof ProjectDirectory.Type

const EnvironmentName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))
const EnvironmentValue = Schema.String.check(Schema.isPattern(/^[^\u0000\r\n]*$/))
const Environment = Schema.Record(EnvironmentName, EnvironmentValue)

const StaticPreviewInput = Schema.Struct({
  kind: Schema.Literal("static"),
  cwd: ProjectDirectory.pipe(optional),
  entrypoint: DesignArtifact.SourcePath,
}).annotate({ identifier: "WorkflowVisualBuild.StaticPreviewInput", ...exact })

const ScriptArgv = Schema.NonEmptyArray(Schema.NonEmptyString.check(Schema.isPattern(/^[^\u0000]*$/)))

const ScriptPreviewInput = Schema.Struct({
  kind: Schema.Literal("script"),
  cwd: ProjectDirectory.pipe(optional),
  argv: ScriptArgv,
  env: Environment.pipe(optional),
}).annotate({ identifier: "WorkflowVisualBuild.ScriptPreviewInput", ...exact })

/**
 * A user-owned admission choice. It has no placement, URL, provider, model,
 * or shell-string field. The server decodes this before calling Core freeze.
 */
export const TrustedPreviewInput = Schema.Union([StaticPreviewInput, ScriptPreviewInput], { mode: "oneOf" }).pipe(
  Schema.toTaggedUnion("kind"),
)
export type TrustedPreviewInput = typeof TrustedPreviewInput.Type

export const CreateInput = Schema.Struct({
  prompt: Schema.NonEmptyString,
  budget: Workflow.Budget,
  visual: VisualLimits,
  preview: TrustedPreviewInput.pipe(optional),
  delivery: Schema.Literals(["foreground", "background"]),
}).annotate({ identifier: "WorkflowVisualBuild.CreateInput", ...exact })
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const Admission = Schema.Struct({
  workflow: Workflow.Info,
  response: Responses.Resource,
}).annotate({ identifier: "WorkflowVisualBuild.Admission" })
export interface Admission extends Schema.Schema.Type<typeof Admission> {}
