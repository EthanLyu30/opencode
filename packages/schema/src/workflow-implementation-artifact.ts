export * as WorkflowImplementationArtifact from "./workflow-implementation-artifact"

import { Schema } from "effect"
import { DesignArtifact } from "./design-artifact"
import { NonNegativeInt, optional } from "./schema"

const exact = { parseOptions: { onExcessProperty: "error" as const } }

const LegacyChange = Schema.Struct({
  path: DesignArtifact.SourcePath,
  beforeSha256: DesignArtifact.Sha256.pipe(optional),
  afterSha256: DesignArtifact.Sha256,
}).annotate({ identifier: "WorkflowImplementationArtifact.LegacyChange", ...exact })

const LegacyManifestShape = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  snapshotRef: Schema.NonEmptyString,
  workspaceSha256: DesignArtifact.Sha256,
  changes: Schema.NonEmptyArray(LegacyChange),
})

const validLegacyTopology = Schema.makeFilter<Schema.Schema.Type<typeof LegacyManifestShape>>((value) =>
  DesignArtifact.sourceTopologyError(value.changes.map((change) => change.path)),
)

export const LegacyManifest = LegacyManifestShape.check(validLegacyTopology).annotate({
  identifier: "WorkflowImplementationArtifact.LegacyManifest",
  ...exact,
})
export interface LegacyManifest extends Schema.Schema.Type<typeof LegacyManifest> {}

const AddedChange = Schema.Struct({
  change: Schema.Literal("added"),
  path: DesignArtifact.SourcePath,
  afterSha256: DesignArtifact.Sha256,
}).annotate({ identifier: "WorkflowImplementationArtifact.AddedChange", ...exact })

const ModifiedChangeShape = Schema.Struct({
  change: Schema.Literal("modified"),
  path: DesignArtifact.SourcePath,
  beforeSha256: DesignArtifact.Sha256,
  afterSha256: DesignArtifact.Sha256,
})
const ModifiedChange = ModifiedChangeShape.check(
  Schema.makeFilter<Schema.Schema.Type<typeof ModifiedChangeShape>>((value) =>
    value.beforeSha256 === value.afterSha256 ? "Modified entries require different before and after hashes" : undefined,
  ),
).annotate({ identifier: "WorkflowImplementationArtifact.ModifiedChange", ...exact })

const DeletedChange = Schema.Struct({
  change: Schema.Literal("deleted"),
  path: DesignArtifact.SourcePath,
  beforeSha256: DesignArtifact.Sha256,
}).annotate({ identifier: "WorkflowImplementationArtifact.DeletedChange", ...exact })

export const Change = Schema.Union([AddedChange, ModifiedChange, DeletedChange]).annotate({
  identifier: "WorkflowImplementationArtifact.Change",
})
export type Change = typeof Change.Type

const ManifestV2Shape = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  snapshotRef: Schema.NonEmptyString,
  workspaceSha256: DesignArtifact.Sha256,
  changes: Schema.NonEmptyArray(Change),
})

const validChangeTopology = Schema.makeFilter<Schema.Schema.Type<typeof ManifestV2Shape>>((value) =>
  DesignArtifact.sourceTopologyError(value.changes.map((change) => change.path)),
)

export const ManifestV2 = ManifestV2Shape.check(validChangeTopology).annotate({
  identifier: "WorkflowImplementationArtifact.ManifestV2",
  ...exact,
})
export interface ManifestV2 extends Schema.Schema.Type<typeof ManifestV2> {}

/** Compatibility decoder for durable v1 history and exact v2 manifests. */
export const Manifest = Schema.Union([LegacyManifest, ManifestV2]).annotate({
  identifier: "WorkflowImplementationArtifact.Manifest",
})
export type Manifest = typeof Manifest.Type
