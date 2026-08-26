import { LLM, type LLMRequest, type Message, type Model, type ToolDefinition } from "@opencode-ai/llm"
import { WorkflowRouting } from "../routing"
import { WorkflowSecretGuard } from "../secret-guard"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { Hash } from "../../util/hash"
import { WorkflowRoleContract } from "./contract"

const MAX_DESCRIPTOR_BYTES = 256 * 1024

export interface BuildInput {
  readonly model: Model
  readonly route: WorkflowRouting.Route
  readonly contract: WorkflowRoleContract.Contract
  readonly sequence: number
  readonly catalogFingerprint: string
  readonly messages: readonly Message[]
  readonly tools: readonly ToolDefinition.Input[]
  readonly remainingTokens: number | undefined
}

export interface FingerprintInput {
  readonly request: LLMRequest
  readonly route: WorkflowRouting.Route
  readonly contractFingerprint: string
  readonly sequence: number
  readonly catalogFingerprint: string
}

export function build(input: BuildInput) {
  const request = freezeRequest(
    LLM.request({
      model: input.model,
      system: input.contract.system,
      messages: input.messages,
      tools: input.tools,
      responseFormat: {
        type: "json",
        schema: WorkflowRoleContract.responseSchema(input.contract.output),
      },
      ...(input.remainingTokens === undefined ? {} : { generation: { maxTokens: input.remainingTokens } }),
    }),
  )
  return Object.freeze({
    request,
    fingerprint: fingerprintProviderRequest({
      request,
      route: input.route,
      contractFingerprint: input.contract.contractFingerprint,
      sequence: input.sequence,
      catalogFingerprint: input.catalogFingerprint,
    }),
  })
}

export function fingerprintProviderRequest(input: FingerprintInput): string {
  const normalized = input.request
  const descriptor = canonicalValue({
    descriptorVersion: 1,
    route: {
      role: input.route.role,
      providerID: input.route.providerID,
      modelID: input.route.modelID,
      protocol: input.route.protocol,
      reasoningEffort: input.route.reasoningEffort,
      requiredCapabilities: input.route.requiredCapabilities,
      model: modelDescriptor(input.request.model),
    },
    contractFingerprint: input.contractFingerprint,
    sequence: input.sequence,
    catalogFingerprint: input.catalogFingerprint,
    request: {
      id: normalized.id,
      system: normalized.system,
      messages: messageDescriptor(normalized.messages),
      tools: normalized.tools,
      toolChoice: normalized.toolChoice,
      generation: normalized.generation,
      providerOptions: normalized.providerOptions,
      http: normalized.http,
      responseFormat: normalized.responseFormat,
      cache: normalized.cache,
      metadata: normalized.metadata,
    },
  })
  WorkflowRoleContract.assertGenericProviderValue(descriptor)
  WorkflowSecretGuard.assertSafe(descriptor)
  const bytes = new TextEncoder().encode(WorkflowBusinessArtifact.encode(descriptor))
  if (bytes.byteLength > MAX_DESCRIPTOR_BYTES) throw new Error("Provider request authority descriptor is too large")
  return WorkflowBusinessArtifact.hash(descriptor)
}

function freezeRequest(request: LLMRequest): LLMRequest {
  Object.freeze(request.system)
  Object.freeze(request.messages)
  Object.freeze(request.tools)
  if (request.generation !== undefined) Object.freeze(request.generation)
  if (request.responseFormat !== undefined) Object.freeze(request.responseFormat)
  return Object.freeze(request)
}

function modelDescriptor(model: Model) {
  const endpoint = model.route.endpoint
  return {
    id: model.id,
    provider: model.provider,
    defaults: model.defaults,
    compatibility: model.compatibility,
    route: {
      id: model.route.id,
      provider: model.route.provider,
      protocol: model.route.protocol,
      endpoint: {
        baseURL: endpoint.baseURL,
        path: typeof endpoint.path === "string" ? endpoint.path : "dynamic",
        query: endpoint.query,
      },
      defaults: model.route.defaults,
      credentialAuthority: "host",
    },
  }
}

function messageDescriptor(messages: readonly Message[]): unknown {
  WorkflowRoleContract.assertTextSafe("", messages)
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content.map((part) => {
      if (part.type !== "media") return part
      const bytes = typeof part.data === "string" ? Buffer.from(part.data, "utf8") : Buffer.from(part.data)
      return {
        type: "media-digest",
        mediaType: part.mediaType,
        payloadKind: typeof part.data === "string" ? "utf8" : "bytes",
        payloadSha256: Hash.sha256(bytes),
        payloadSize: bytes.byteLength,
        filename: part.filename,
        metadata: part.metadata,
      }
    }),
    metadata: message.metadata,
    native: message.native,
  }))
}

function canonicalValue(value: unknown, active = new Set<object>()): unknown {
  if (value === undefined) return undefined
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Provider request authority contains a non-finite number")
    return value
  }
  if (typeof value !== "object" || value instanceof Uint8Array)
    throw new Error("Provider request authority contains a non-canonical value")
  if (active.has(value)) throw new Error("Provider request authority contains a cyclic value")
  active.add(value)
  const result = Array.isArray(value)
    ? value.map((item) => canonicalValue(item, active))
    : Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, canonicalValue(item, active)]),
      )
  active.delete(value)
  return result
}
