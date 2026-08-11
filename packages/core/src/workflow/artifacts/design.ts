export * as WorkflowDesignArtifact from "./design"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Schema } from "effect"
import { Hash } from "../../util/hash"
import { WorkflowSecretGuard } from "../secret-guard"

export const SPEC_KIND = "workflow.design.spec"
export const SPEC_MIME = "application/vnd.opencode.design-spec+json"
export const REFERENCE_APP_KIND = "workflow.design.reference-app"
export const REFERENCE_APP_MIME = "application/vnd.opencode.reference-app+json"

export interface SourceFile {
  readonly path: string
  readonly content: string | Uint8Array
}

export function commitSpec(workflowID: Workflow.ID, input: unknown): Workflow.ArtifactCommit {
  WorkflowSecretGuard.assertSafe(input)
  const spec = Schema.decodeUnknownSync(DesignArtifact.Spec)(input)
  const body = encode(spec)
  return commit({
    kind: SPEC_KIND,
    mime: SPEC_MIME,
    uri: `workflow://${workflowID}/design-spec.json`,
    body,
    metadata: { schemaVersion: spec.schemaVersion, artifact: "design-spec.json" },
  })
}

export function decodeSpec(artifact: Workflow.ArtifactCommit, body: string): DesignArtifact.Spec {
  validateCommit(artifact, body, SPEC_KIND, SPEC_MIME)
  const value = JSON.parse(body)
  WorkflowSecretGuard.assertSafe(value)
  return Schema.decodeUnknownSync(DesignArtifact.Spec)(value)
}

export function commitReferenceApp(
  workflowID: Workflow.ID,
  spec: DesignArtifact.Spec,
  files: ReadonlyArray<SourceFile>,
): Workflow.ArtifactCommit {
  const actual = files.map((file) => ({
    path: file.path,
    sha256: Hash.sha256(Buffer.from(bytes(file.content))),
    size: bytes(file.content).byteLength,
  }))
  WorkflowSecretGuard.assertSafe(actual)
  const expected = new Map(spec.referenceApp.files.map((file) => [file.path, file]))
  if (
    actual.length !== expected.size ||
    actual.some((file) => {
      const declared = expected.get(file.path)
      return !declared || declared.sha256 !== file.sha256 || declared.size !== file.size
    })
  ) {
    throw new Error("Reference app files do not match the hashed design manifest")
  }
  const body = encode({
    schemaVersion: 1,
    entrypoint: spec.referenceApp.entrypoint,
    readySelector: spec.referenceApp.readySelector,
    projectStack: spec.projectStack,
    files: actual,
  })
  return commit({
    kind: REFERENCE_APP_KIND,
    mime: REFERENCE_APP_MIME,
    uri: `workflow://${workflowID}/reference-app/manifest.json`,
    body,
    metadata: { schemaVersion: 1, artifact: "reference-app/", entrypoint: spec.referenceApp.entrypoint },
  })
}

export function encode(value: unknown): string {
  return stable(value)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`
}

function commit(input: {
  readonly kind: string
  readonly mime: string
  readonly uri: string
  readonly body: string
  readonly metadata: Record<string, unknown>
}): Workflow.ArtifactCommit {
  const encoded = new TextEncoder().encode(input.body)
  const artifact = {
    kind: input.kind,
    uri: input.uri,
    mime: input.mime,
    sha256: Hash.sha256(Buffer.from(encoded)),
    size: encoded.byteLength,
    metadata: input.metadata,
  }
  WorkflowSecretGuard.assertSafe(artifact)
  return Workflow.ArtifactCommit.make(artifact)
}

function validateCommit(artifact: Workflow.ArtifactCommit, body: string, kind: string, mime: string): void {
  WorkflowSecretGuard.assertSafe(artifact)
  const encoded = new TextEncoder().encode(body)
  if (
    artifact.kind !== kind ||
    artifact.mime !== mime ||
    artifact.sha256 !== Hash.sha256(Buffer.from(encoded)) ||
    artifact.size !== encoded.byteLength
  ) {
    throw new Error("Durable artifact body does not match its commit")
  }
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value
}
