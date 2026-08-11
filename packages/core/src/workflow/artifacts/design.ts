export * as WorkflowDesignArtifact from "./design"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { PositiveInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { Hash } from "../../util/hash"
import { WorkflowSecretGuard } from "../secret-guard"

export const SPEC_KIND = "workflow.design.spec"
export const SPEC_MIME = "application/vnd.opencode.design-spec+json"
export const REFERENCE_APP_KIND = "workflow.design.reference-app"
export const REFERENCE_APP_MIME = "application/vnd.opencode.reference-app+json"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const Base64 = Schema.String.check(Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/))
const ReferenceSourcePayload = Schema.Struct({
  path: DesignArtifact.SourcePath,
  sha256: DesignArtifact.Sha256,
  size: PositiveInt,
  encoding: Schema.Literal("base64"),
  contentBase64: Base64,
})
const ReferencePayload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  entrypoint: DesignArtifact.SourcePath,
  readySelector: Schema.NonEmptyString,
  projectStack: Schema.NonEmptyArray(Schema.NonEmptyString),
  files: Schema.NonEmptyArray(ReferenceSourcePayload),
}).annotate({ identifier: "WorkflowDesignArtifact.ReferencePayload", ...exact })

export interface SourceFile {
  readonly path: string
  readonly content: string
}

export interface ReferenceApp {
  readonly entrypoint: string
  readonly readySelector: string
  readonly projectStack: ReadonlyArray<string>
  readonly files: ReadonlyArray<SourceFile>
}

export function commitSpec(workflowID: Workflow.ID, input: unknown): Workflow.ArtifactCommit {
  WorkflowSecretGuard.assertSafe(input)
  const payload = Schema.decodeUnknownSync(DesignArtifact.Spec)(input)
  return commit({
    kind: SPEC_KIND,
    mime: SPEC_MIME,
    uri: `workflow://${workflowID}/design-spec.json`,
    payload,
  })
}

export function decodeSpec(artifact: Workflow.ArtifactCommit): DesignArtifact.Spec {
  const payload = metadataPayload(artifact)
  WorkflowSecretGuard.assertSafe(payload)
  const spec = Schema.decodeUnknownSync(DesignArtifact.Spec)(payload)
  validateCommit(artifact, encode(spec), SPEC_KIND, SPEC_MIME)
  return spec
}

export function commitReferenceApp(
  workflowID: Workflow.ID,
  inputSpec: DesignArtifact.Spec,
  files: ReadonlyArray<SourceFile>,
): Workflow.ArtifactCommit {
  WorkflowSecretGuard.assertSafe(inputSpec)
  const spec = Schema.decodeUnknownSync(DesignArtifact.Spec)(inputSpec)
  const actual = files.map((file) => {
    WorkflowSecretGuard.assertSafe(file)
    const path = Schema.decodeUnknownSync(DesignArtifact.SourcePath)(file.path)
    const content = new TextEncoder().encode(file.content)
    return {
      path,
      sha256: Hash.sha256(Buffer.from(content)),
      size: content.byteLength,
      encoding: "base64" as const,
      contentBase64: Buffer.from(content).toString("base64"),
    }
  })
  const expected = new Map(spec.referenceApp.files.map((file) => [file.path, file]))
  if (
    new Set(actual.map((file) => file.path)).size !== actual.length ||
    actual.length !== expected.size ||
    actual.some((file) => {
      const declared = expected.get(file.path)
      return !declared || declared.sha256 !== file.sha256 || declared.size !== file.size
    })
  ) {
    throw new Error("Reference app files do not match the hashed design manifest")
  }
  const payload = Schema.decodeUnknownSync(ReferencePayload)({
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
    payload,
  })
}

export function decodeReferenceApp(artifact: Workflow.ArtifactCommit): ReferenceApp {
  const payload = Schema.decodeUnknownSync(ReferencePayload)(metadataPayload(artifact))
  WorkflowSecretGuard.assertSafe(payload)
  validateCommit(artifact, encode(payload), REFERENCE_APP_KIND, REFERENCE_APP_MIME)
  const seen = new Set<string>()
  const files = payload.files.map((file) => {
    if (seen.has(file.path)) throw new Error("Reference source paths must be unique")
    seen.add(file.path)
    const content = Buffer.from(file.contentBase64, "base64")
    if (
      content.toString("base64") !== file.contentBase64 ||
      content.byteLength !== file.size ||
      Hash.sha256(content) !== file.sha256
    ) {
      throw new Error(`Reference source ${file.path} does not match its durable hash`)
    }
    const value = content.toString("utf8")
    WorkflowSecretGuard.assertSafe(value)
    return { path: file.path, content: value }
  })
  if (!seen.has(payload.entrypoint)) throw new Error("Reference entrypoint is missing from the durable source files")
  return {
    entrypoint: payload.entrypoint,
    readySelector: payload.readySelector,
    projectStack: payload.projectStack,
    files,
  }
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
  readonly payload: unknown
}): Workflow.ArtifactCommit {
  WorkflowSecretGuard.assertSafe(input.payload)
  const body = encode(input.payload)
  const encoded = new TextEncoder().encode(body)
  const artifact = {
    kind: input.kind,
    uri: input.uri,
    mime: input.mime,
    sha256: Hash.sha256(Buffer.from(encoded)),
    size: encoded.byteLength,
    metadata: { payload: input.payload },
  }
  WorkflowSecretGuard.assertSafe(artifact)
  return Workflow.ArtifactCommit.make(artifact)
}

function metadataPayload(artifact: Workflow.ArtifactCommit): unknown {
  WorkflowSecretGuard.assertSafe(artifact)
  if (Reflect.ownKeys(artifact.metadata).length !== 1 || !Object.hasOwn(artifact.metadata, "payload"))
    throw new Error("Durable artifact metadata must contain exactly one self-contained payload")
  return artifact.metadata.payload
}

function validateCommit(artifact: Workflow.ArtifactCommit, body: string, kind: string, mime: string): void {
  const encoded = new TextEncoder().encode(body)
  if (
    artifact.kind !== kind ||
    artifact.mime !== mime ||
    artifact.sha256 !== Hash.sha256(Buffer.from(encoded)) ||
    artifact.size !== encoded.byteLength
  ) {
    throw new Error("Durable artifact payload does not match its commit")
  }
}
