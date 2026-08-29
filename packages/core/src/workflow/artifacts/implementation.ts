export * as WorkflowImplementationArtifact from "./implementation"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Change, LegacyManifest, Manifest, ManifestV2 } from "@opencode-ai/schema/workflow-implementation-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { WorkflowBusinessArtifact } from "./business"
import { Snapshot } from "../../snapshot"

export const encode = WorkflowBusinessArtifact.encode

export const KIND = "workflow.implementation-manifest"
export const MIME = "application/vnd.opencode.workflow-implementation+json"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const PayloadV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  locationSha256: DesignArtifact.Sha256,
  artifactKind: Schema.Literal(KIND),
  manifest: LegacyManifest,
}).annotate({ identifier: "WorkflowImplementationArtifact.PayloadV1", ...exact })
const PayloadV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  locationSha256: DesignArtifact.Sha256,
  artifactKind: Schema.Literal(KIND),
  manifest: ManifestV2,
}).annotate({ identifier: "WorkflowImplementationArtifact.PayloadV2", ...exact })
const Payload = Schema.Union([PayloadV1, PayloadV2])

export function hash(input: unknown): string {
  return WorkflowBusinessArtifact.hash(Schema.decodeUnknownSync(Manifest)(input))
}

export function commit(workflowID: Workflow.ID, location: Location.Ref, input: unknown): Workflow.ArtifactCommit {
  const owner = WorkflowBusinessArtifact.safeWorkflowID(workflowID)
  const manifest = Schema.decodeUnknownSync(Manifest)(input)
  if (manifest.workflowID !== owner) throw new Error("Implementation manifest belongs to a different workflow")
  const workspace = WorkflowBusinessArtifact.locationSha256(location)
  const payload = Schema.decodeUnknownSync(Payload)({
    schemaVersion: manifest.schemaVersion,
    workflowID: owner,
    revision: manifest.revision,
    locationSha256: workspace,
    artifactKind: KIND,
    manifest,
  })
  return WorkflowBusinessArtifact.commit({
    kind: KIND,
    mime: MIME,
    uri: uri(owner, workspace, manifest.revision),
    payload,
  })
}

export function decode(
  input: Workflow.ArtifactCommit,
  expectedWorkflowID: Workflow.ID,
  location: Location.Ref,
): Manifest {
  const artifact = WorkflowBusinessArtifact.requireCommit(input)
  const payload = Schema.decodeUnknownSync(Payload)(WorkflowBusinessArtifact.metadataPayload(artifact))
  const owner = WorkflowBusinessArtifact.safeWorkflowID(expectedWorkflowID)
  const workspace = WorkflowBusinessArtifact.locationSha256(location)
  if (payload.workflowID !== owner || payload.manifest.workflowID !== owner)
    throw new Error("Implementation manifest belongs to a different workflow")
  if (payload.locationSha256 !== workspace) throw new Error("Implementation manifest belongs to a different workspace")
  if (payload.revision !== payload.manifest.revision)
    throw new Error("Implementation manifest revision is not canonical")
  WorkflowBusinessArtifact.validateCommit(artifact, payload, KIND, MIME, uri(owner, workspace, payload.revision))
  return payload.manifest
}

export function decodeExact(
  input: Workflow.ArtifactCommit,
  expectedWorkflowID: Workflow.ID,
  location: Location.Ref,
): ManifestV2 {
  return Schema.decodeUnknownSync(ManifestV2)(decode(input, expectedWorkflowID, location))
}

export function derive(input: {
  readonly workflowID: Workflow.ID
  readonly revision: number
  readonly snapshotRef: Snapshot.ID
  readonly before: readonly Snapshot.Entry[]
  readonly after: readonly Snapshot.Entry[]
}): ManifestV2 {
  const before = Snapshot.canonicalEntries(input.before)
  const after = Snapshot.canonicalEntries(input.after)
  const previous = new Map(before.map((entry) => [entry.path, entry] as const))
  const current = new Map(after.map((entry) => [entry.path, entry] as const))
  const paths = [...new Set([...previous.keys(), ...current.keys()])].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  const changes: Change[] = []
  for (const file of paths) {
    const prior = previous.get(file)
    const next = current.get(file)
    if (prior === undefined && next !== undefined) {
      changes.push({ change: "added", path: file, afterSha256: next.sha256 })
      continue
    }
    if (prior !== undefined && next === undefined) {
      changes.push({ change: "deleted", path: file, beforeSha256: prior.sha256 })
      continue
    }
    if (prior === undefined || next === undefined) throw new Error("Implementation entry topology is invalid")
    if (prior.sha256 === next.sha256 && prior.type === next.type && prior.size === next.size) continue
    if (prior.sha256 === next.sha256)
      throw new Error("Implementation type or size changes require distinct exact content hashes")
    changes.push({ change: "modified", path: file, beforeSha256: prior.sha256, afterSha256: next.sha256 })
  }
  return Schema.decodeUnknownSync(ManifestV2)({
    schemaVersion: 2,
    workflowID: input.workflowID,
    revision: input.revision,
    snapshotRef: input.snapshotRef,
    workspaceSha256: Snapshot.workspaceSha256(after),
    changes,
  })
}

function uri(workflowID: string, workspace: string, revision: number): string {
  return `workflow://artifact/${workflowID}/workspace-${workspace}/implementation-r${revision}.json`
}
