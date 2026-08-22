export * as WorkflowDeliveryArtifact from "./workflow-delivery-artifact"

import { Schema } from "effect"
import { DesignArtifact } from "./design-artifact"
import { NonNegativeInt } from "./schema"

const exact = { parseOptions: { onExcessProperty: "error" as const } }

export const MAX_SUMMARY_CHARS = 4_096

const Summary = Schema.NonEmptyString.check(
  Schema.makeFilter<string>((value) =>
    value.length <= MAX_SUMMARY_CHARS ? undefined : `Delivery summary must not exceed ${MAX_SUMMARY_CHARS} characters`,
  ),
)

export const Delivery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  implementationSha256: DesignArtifact.Sha256,
  testSha256: DesignArtifact.Sha256,
  visualReviewSha256: DesignArtifact.Sha256,
  summary: Summary,
}).annotate({ identifier: "WorkflowDeliveryArtifact.Delivery", ...exact })
export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}
