export * as WorkflowBusinessArtifact from "./business"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { Hash } from "../../util/hash"
import { WorkflowSecretGuard } from "../secret-guard"
import { WorkflowDesignArtifact } from "./design"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const StrictCommit = Schema.Struct(Workflow.ArtifactCommit.fields).annotate({
  identifier: "WorkflowBusinessArtifact.Commit",
  ...exact,
})

export function encode(value: unknown): string {
  return WorkflowDesignArtifact.encode(value)
}

export function hash(value: unknown): string {
  const bytes = new TextEncoder().encode(encode(value))
  return Hash.sha256(Buffer.from(bytes))
}

export function locationSha256(input: Location.Ref): string {
  const location = Schema.decodeUnknownSync(Location.Ref)(input)
  WorkflowSecretGuard.assertSafe(location)
  return hash(location)
}

export function safeWorkflowID(input: unknown): DesignArtifact.SafeWorkflowID {
  return Schema.decodeUnknownSync(DesignArtifact.SafeWorkflowID)(input)
}

export function commit(input: {
  readonly kind: string
  readonly mime: string
  readonly uri: string
  readonly payload: unknown
}): Workflow.ArtifactCommit {
  WorkflowSecretGuard.assertSafe(input.payload)
  const bytes = new TextEncoder().encode(encode(input.payload))
  const artifact = {
    kind: input.kind,
    uri: input.uri,
    mime: input.mime,
    sha256: Hash.sha256(Buffer.from(bytes)),
    size: bytes.byteLength,
    metadata: { payload: input.payload },
  }
  WorkflowSecretGuard.assertSafe(artifact)
  return Workflow.ArtifactCommit.make(artifact)
}

export function requireCommit(input: unknown): Workflow.ArtifactCommit {
  WorkflowSecretGuard.assertSafe(input)
  return Schema.decodeUnknownSync(StrictCommit)(input)
}

export function metadataPayload(artifact: Workflow.ArtifactCommit): unknown {
  if (Reflect.ownKeys(artifact.metadata).length !== 1 || !Object.hasOwn(artifact.metadata, "payload"))
    throw new Error("Durable artifact metadata must contain exactly one self-contained payload")
  return artifact.metadata.payload
}

export function validateCommit(
  artifact: Workflow.ArtifactCommit,
  payload: unknown,
  kind: string,
  mime: string,
  uri: string,
): void {
  const bytes = new TextEncoder().encode(encode(payload))
  if (
    artifact.kind !== kind ||
    artifact.mime !== mime ||
    artifact.uri !== uri ||
    artifact.sha256 !== Hash.sha256(Buffer.from(bytes)) ||
    artifact.size !== bytes.byteLength
  )
    throw new Error("Durable artifact payload does not match its commit")
}
