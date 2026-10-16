export * as WorkflowCodingArtifact from "./workflow-coding-artifact"

import { Schema } from "effect"
import { DesignArtifact } from "./design-artifact"
import { NonNegativeInt } from "./schema"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const identity = {
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
}
const Summary = Schema.NonEmptyString.check(Schema.isMaxLength(4096))

const PlanShape = Schema.Struct({
  ...identity,
  objective: Summary,
  constraints: Schema.Array(Summary),
  interfaces: Schema.NonEmptyArray(Summary),
  files: Schema.NonEmptyArray(DesignArtifact.SourcePath),
  risks: Schema.Array(Summary),
  acceptanceCriteria: Schema.NonEmptyArray(Summary),
  checkPlanSha256: DesignArtifact.Sha256,
})
export const Plan = PlanShape.annotate({ identifier: "WorkflowCodingArtifact.Plan", ...exact }).check(
  Schema.makeFilter<typeof PlanShape.Type>((value) => DesignArtifact.sourceTopologyError(value.files)),
)
export interface Plan extends Schema.Schema.Type<typeof Plan> {}

export const Finding = Schema.Struct({
  id: DesignArtifact.SafeIdentifier,
  path: DesignArtifact.SourcePath,
  severity: Schema.Literals(["critical", "important", "minor"]),
  blocking: Schema.Boolean,
  summary: Summary,
}).annotate({ identifier: "WorkflowCodingArtifact.Finding", ...exact })
export interface Finding extends Schema.Schema.Type<typeof Finding> {}
const ReviewShape = Schema.Struct({
  ...identity,
  implementationSha256: DesignArtifact.Sha256,
  testSha256: DesignArtifact.Sha256,
  verdict: Schema.Literals(["pass", "revise"]),
  findings: Schema.Array(Finding),
})
export const Review = ReviewShape.annotate({ identifier: "WorkflowCodingArtifact.Review", ...exact }).check(
  Schema.makeFilter<typeof ReviewShape.Type>((value) => {
    if (new Set(value.findings.map((finding) => finding.id)).size !== value.findings.length)
      return "Coding review finding IDs must be unique"
    if (value.findings.some((finding) => finding.severity === "critical" && !finding.blocking))
      return "Critical coding findings must block delivery"
    const blocked = value.findings.some((finding) => finding.blocking)
    return (value.verdict === "revise") === blocked ? undefined : "Coding review verdict must match blocking findings"
  }),
)
export interface Review extends Schema.Schema.Type<typeof Review> {}

export const Delivery = Schema.Struct({
  ...identity,
  implementationSha256: DesignArtifact.Sha256,
  testSha256: DesignArtifact.Sha256,
  codeReviewSha256: DesignArtifact.Sha256,
  summary: Summary,
}).annotate({ identifier: "WorkflowCodingArtifact.Delivery", ...exact })
export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}
