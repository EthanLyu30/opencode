import { LLM, LLMRequest, Model, type Message, type ToolDefinition } from "@opencode-ai/llm"
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
  const request = ownRequest(
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

function ownRequest(request: LLMRequest): LLMRequest {
  const owned = new LLMRequest({
    id: request.id,
    model: ownModel(request.model),
    system: cloneAndFreeze(request.system),
    messages: cloneAndFreeze(request.messages),
    tools: cloneAndFreeze(request.tools),
    toolChoice: cloneAndFreeze(request.toolChoice),
    generation: cloneAndFreeze(request.generation),
    providerOptions: cloneAndFreeze(request.providerOptions),
    http: cloneAndFreeze(request.http),
    responseFormat: cloneAndFreeze(request.responseFormat),
    cache: cloneAndFreeze(request.cache),
    metadata: cloneAndFreeze(request.metadata),
  })
  deepFreeze(owned.system)
  deepFreeze(owned.messages)
  deepFreeze(owned.tools)
  deepFreeze(owned.toolChoice)
  deepFreeze(owned.generation)
  deepFreeze(owned.providerOptions)
  deepFreeze(owned.http)
  deepFreeze(owned.responseFormat)
  deepFreeze(owned.cache)
  deepFreeze(owned.metadata)
  return Object.freeze(owned)
}

function ownModel(model: Model): Model {
  const route = model.route
  const endpoint = cloneAndFreeze(route.endpoint)
  const auth = Object.freeze({ ...route.auth })
  const transport = Object.freeze({ ...route.transport })
  const defaults = cloneAndFreeze(route.defaults)
  const rerouted = route.with({
    endpoint,
    auth,
    transport,
    headers: defaults.headers,
    limits: defaults.limits,
    generation: defaults.generation,
    providerOptions: defaults.providerOptions,
    http: defaults.http,
  })
  deepFreeze(rerouted.endpoint)
  deepFreeze(rerouted.defaults)
  const ownedRoute = Object.freeze({
    ...rerouted,
    body: Object.freeze({ ...rerouted.body }),
  })
  return Object.freeze(
    new Model({
      id: model.id,
      provider: model.provider,
      route: ownedRoute,
      defaults: cloneAndFreeze(model.defaults),
      compatibility: cloneAndFreeze(model.compatibility),
    }),
  )
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
  if (typeof value !== "object" || isBinaryValue(value))
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

function cloneAndFreeze<T>(value: T): T {
  const cloned = cloneOwned(value)
  deepFreeze(cloned)
  // The clone preserves every data-property prototype while replacing each owned value recursively.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return cloned as T
}

function cloneOwned(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value
  if (typeof value === "function") return value
  if (value instanceof Uint8Array) return immutableBytes(value)
  if (value instanceof ArrayBuffer) return value.slice(0)
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) return value.slice(0)
  if (ArrayBuffer.isView(value)) {
    const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    return new DataView(bytes)
  }
  const existing = seen.get(value)
  if (existing !== undefined) return existing
  if (Array.isArray(value)) {
    const result: unknown[] = []
    seen.set(value, result)
    for (const item of value) result.push(cloneOwned(item, seen))
    return result
  }
  const result: Record<PropertyKey, unknown> = {}
  Object.setPrototypeOf(result, Object.getPrototypeOf(value))
  seen.set(value, result)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) continue
    if ("value" in descriptor) descriptor.value = cloneOwned(descriptor.value, seen)
    Object.defineProperty(result, key, descriptor)
  }
  return result
}

function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return
  if (typeof value === "function" || isBinaryValue(value) || seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen)
  }
  Object.freeze(value)
}

function immutableBytes(input: Uint8Array): Uint8Array {
  const target = Uint8Array.from(input)
  return new Proxy(target, {
    get: (bytes, key) => {
      if (key === "buffer") return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      const value = Reflect.get(bytes, key, bytes)
      if (typeof value !== "function" || key === "constructor") return value
      return (...args: unknown[]) => Reflect.apply(value, Uint8Array.from(bytes), args)
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
  })
}

function isBinaryValue(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return (
    value instanceof ArrayBuffer ||
    value instanceof Uint8Array ||
    ArrayBuffer.isView(value) ||
    (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)
  )
}
