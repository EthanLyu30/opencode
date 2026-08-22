export * as WorkflowImplementationArtifact from "./workflow-implementation-artifact"

import { Schema } from "effect"
import { DesignArtifact } from "./design-artifact"
import { NonNegativeInt, optional } from "./schema"

const exact = { parseOptions: { onExcessProperty: "error" as const } }

const Change = Schema.Struct({
  path: DesignArtifact.SourcePath,
  beforeSha256: DesignArtifact.Sha256.pipe(optional),
  afterSha256: DesignArtifact.Sha256,
}).annotate({ identifier: "WorkflowImplementationArtifact.Change", ...exact })

const ManifestShape = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  snapshotRef: Schema.NonEmptyString,
  workspaceSha256: DesignArtifact.Sha256,
  changes: Schema.NonEmptyArray(Change),
})

const validChangeTopology = Schema.makeFilter<Schema.Schema.Type<typeof ManifestShape>>((value) =>
  DesignArtifact.sourceTopologyError(value.changes.map((change) => change.path)),
)

export const Manifest = ManifestShape.check(validChangeTopology).annotate({
  identifier: "WorkflowImplementationArtifact.Manifest",
  ...exact,
})
export interface Manifest extends Schema.Schema.Type<typeof Manifest> {}
