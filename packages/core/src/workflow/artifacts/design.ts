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
const SpecPayload = Schema.Struct({
  workflowID: DesignArtifact.SafeWorkflowID,
  artifactKind: Schema.Literal(SPEC_KIND),
  spec: DesignArtifact.Spec,
}).annotate({ identifier: "WorkflowDesignArtifact.SpecPayload", ...exact })
const ReferenceSourcePayload = Schema.Struct({
  path: DesignArtifact.SourcePath,
  sha256: DesignArtifact.Sha256,
  size: PositiveInt,
  encoding: Schema.Literal("base64"),
  contentBase64: Base64,
})
const ReferencePayload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  artifactKind: Schema.Literal(REFERENCE_APP_KIND),
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
  const owner = safeWorkflowID(workflowID)
  WorkflowSecretGuard.assertSafe(input)
  const spec = Schema.decodeUnknownSync(DesignArtifact.Spec)(input)
  const payload = Schema.decodeUnknownSync(SpecPayload)({ workflowID: owner, artifactKind: SPEC_KIND, spec })
  return commit({
    kind: SPEC_KIND,
    mime: SPEC_MIME,
    uri: specURI(owner),
    payload,
  })
}

export function decodeSpec(artifact: Workflow.ArtifactCommit, expectedWorkflowID: Workflow.ID): DesignArtifact.Spec {
  const owner = safeWorkflowID(expectedWorkflowID)
  const payload = Schema.decodeUnknownSync(SpecPayload)(metadataPayload(artifact))
  WorkflowSecretGuard.assertSafe(payload)
  if (payload.workflowID !== owner) throw new Error("Design specification belongs to a different workflow")
  validateCommit(artifact, encode(payload), SPEC_KIND, SPEC_MIME, specURI(payload.workflowID))
  return payload.spec
}

export function commitReferenceApp(
  workflowID: Workflow.ID,
  inputSpec: DesignArtifact.Spec,
  files: ReadonlyArray<SourceFile>,
): Workflow.ArtifactCommit {
  const owner = safeWorkflowID(workflowID)
  WorkflowSecretGuard.assertSafe(inputSpec)
  const spec = Schema.decodeUnknownSync(DesignArtifact.Spec)(inputSpec)
  const expected = new Map(
    spec.referenceApp.files.map((file) => [DesignArtifact.sourceCollisionKey(file.path), file] as const),
  )
  for (const file of files) WorkflowSecretGuard.assertSafe(file)
  const actualPaths = files.map((file) => Schema.decodeUnknownSync(DesignArtifact.SourcePath)(file.path))
  assertSourceTopology(actualPaths)
  const actualKeys = new Set<string>()
  const actual = files.map((file, index) => {
    const path = actualPaths[index]
    const key = DesignArtifact.sourceCollisionKey(path)
    if (actualKeys.has(key)) throw new Error("Reference source paths must be unique")
    actualKeys.add(key)
    const content = new TextEncoder().encode(file.content)
    const declared = expected.get(key)
    const sha256 = Hash.sha256(Buffer.from(content))
    if (!declared || declared.sha256 !== sha256 || declared.size !== content.byteLength)
      throw new Error("Reference app files do not match the hashed design manifest")
    return {
      path: declared.path,
      sha256,
      size: content.byteLength,
      encoding: "base64" as const,
      contentBase64: Buffer.from(content).toString("base64"),
    }
  })
  if (actual.length !== expected.size) {
    throw new Error("Reference app files do not match the hashed design manifest")
  }
  const payload = Schema.decodeUnknownSync(ReferencePayload)({
    schemaVersion: 1,
    workflowID: owner,
    artifactKind: REFERENCE_APP_KIND,
    entrypoint: spec.referenceApp.entrypoint,
    readySelector: spec.referenceApp.readySelector,
    projectStack: spec.projectStack,
    files: actual,
  })
  return commit({
    kind: REFERENCE_APP_KIND,
    mime: REFERENCE_APP_MIME,
    uri: referenceURI(owner),
    payload,
  })
}

export function decodeReferenceApp(artifact: Workflow.ArtifactCommit, expectedWorkflowID: Workflow.ID): ReferenceApp {
  const owner = safeWorkflowID(expectedWorkflowID)
  const payload = Schema.decodeUnknownSync(ReferencePayload)(metadataPayload(artifact))
  WorkflowSecretGuard.assertSafe(payload)
  if (payload.workflowID !== owner) throw new Error("Reference app belongs to a different workflow")
  validateCommit(artifact, encode(payload), REFERENCE_APP_KIND, REFERENCE_APP_MIME, referenceURI(payload.workflowID))
  assertSourceTopology(payload.files.map((file) => file.path))
  const seen = new Set<string>()
  const files = payload.files.map((file) => {
    const key = DesignArtifact.sourceCollisionKey(file.path)
    if (seen.has(key)) throw new Error("Reference source paths must be unique")
    seen.add(key)
    const content = Buffer.from(file.contentBase64, "base64")
    if (
      content.toString("base64") !== file.contentBase64 ||
      content.byteLength !== file.size ||
      Hash.sha256(content) !== file.sha256
    ) {
      throw new Error(`Reference source ${file.path} does not match its durable hash`)
    }
    const value = new TextDecoder("utf-8", { fatal: true }).decode(content)
    const reencoded = new TextEncoder().encode(value)
    if (!Buffer.from(reencoded).equals(content)) throw new Error(`Reference source ${file.path} is not canonical UTF-8`)
    WorkflowSecretGuard.assertSafe(value)
    return { path: file.path, content: value }
  })
  if (!payload.files.some((file) => file.path === payload.entrypoint))
    throw new Error("Reference entrypoint is missing from the durable source files")
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

function validateCommit(
  artifact: Workflow.ArtifactCommit,
  body: string,
  kind: string,
  mime: string,
  uri: string,
): void {
  const encoded = new TextEncoder().encode(body)
  if (
    artifact.kind !== kind ||
    artifact.mime !== mime ||
    artifact.uri !== uri ||
    artifact.sha256 !== Hash.sha256(Buffer.from(encoded)) ||
    artifact.size !== encoded.byteLength
  ) {
    throw new Error("Durable artifact payload does not match its commit")
  }
}

function safeWorkflowID(input: unknown): DesignArtifact.SafeWorkflowID {
  return Schema.decodeUnknownSync(DesignArtifact.SafeWorkflowID)(input)
}

function assertSourceTopology(paths: ReadonlyArray<string>): void {
  const error = DesignArtifact.sourceTopologyError(paths)
  if (error !== undefined) throw new Error(error)
}

function specURI(workflowID: DesignArtifact.SafeWorkflowID): string {
  return `workflow://artifact/${workflowID}/design-spec.json`
}

function referenceURI(workflowID: DesignArtifact.SafeWorkflowID): string {
  return `workflow://artifact/${workflowID}/reference-app/manifest.json`
}
