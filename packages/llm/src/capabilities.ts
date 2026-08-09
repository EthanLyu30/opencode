import { Data } from "effect"
import { ModelID, ProviderID } from "./schema"

export type ProviderCapability =
  | "chat"
  | "responses"
  | "reasoning_replay"
  | "vision_input"
  | "structured_output"
  | "required_tool_choice"

export type ProviderProtocol = "openai-chat" | "openai-responses"

export interface ModelCapabilityProfile {
  readonly provider: ProviderID
  readonly model: ModelID
  readonly protocol: ProviderProtocol
  readonly capabilities: ReadonlySet<ProviderCapability>
  readonly plannedCapabilities: ReadonlySet<ProviderCapability>
}

export interface ModelCapabilityInput {
  readonly provider: string | ProviderID
  readonly model: string | ModelID
  readonly required: ProviderCapability
}

export class UnsupportedModelCapability extends Data.TaggedError("UnsupportedModelCapability")<{
  readonly provider: ProviderID
  readonly model: ModelID
  readonly required: ProviderCapability
  readonly supported: ReadonlyArray<ProviderCapability>
  readonly planned: boolean
}> {
  override get message() {
    const timing = this.planned ? " yet; it is planned" : ""
    const supported = this.supported.length === 0 ? "none" : this.supported.join(", ")
    return `${this.provider}/${this.model} does not support ${this.required}${timing} (supported: ${supported})`
  }
}

interface CapabilityDefinition {
  readonly provider: string
  readonly model: string
  readonly protocol: ProviderProtocol
  readonly capabilities: ReadonlyArray<ProviderCapability>
  readonly plannedCapabilities?: ReadonlyArray<ProviderCapability>
}

const definitions = [
  {
    provider: "kimi",
    model: "kimi-k3",
    protocol: "openai-chat",
    capabilities: ["chat", "reasoning_replay", "vision_input", "structured_output", "required_tool_choice"],
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    protocol: "openai-responses",
    capabilities: ["chat", "responses", "structured_output", "required_tool_choice"],
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    // Promotion gate: after official Responses support and Task14 wire fixtures
    // are verified, switch the preferred protocol and move "responses" below.
    protocol: "openai-chat",
    capabilities: ["chat", "structured_output"],
    plannedCapabilities: ["responses"],
  },
] as const satisfies ReadonlyArray<CapabilityDefinition>

const key = (provider: string | ProviderID, model: string | ModelID) => `${provider}\u0000${model}`
const byModel = new Map(definitions.map((definition) => [key(definition.provider, definition.model), definition]))

const readonlySet = <Value>(values: Iterable<Value>): ReadonlySet<Value> => {
  const source = new Set(values)
  const mutators = new Set<PropertyKey>(["add", "delete", "clear"])
  let view: ReadonlySet<Value>
  view = new Proxy(source, {
    has: (target, property) => !mutators.has(property) && Reflect.has(target, property),
    get: (target, property) => {
      if (mutators.has(property)) return undefined
      if (property === "forEach") {
        return (callback: (value: Value, value2: Value, set: ReadonlySet<Value>) => void, thisArg?: unknown) =>
          target.forEach((value) => callback.call(thisArg, value, value, view))
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return Object.freeze(view)
}

const materialize = (definition: CapabilityDefinition): ModelCapabilityProfile =>
  Object.freeze({
    provider: ProviderID.make(definition.provider),
    model: ModelID.make(definition.model),
    protocol: definition.protocol,
    capabilities: readonlySet(definition.capabilities),
    plannedCapabilities: readonlySet(definition.plannedCapabilities ?? []),
  })

export const getModelCapabilityProfile = (
  provider: string | ProviderID,
  model: string | ModelID,
): ModelCapabilityProfile | undefined => {
  const definition = byModel.get(key(provider, model))
  return definition === undefined ? undefined : materialize(definition)
}

export const supportsModelCapability = (input: ModelCapabilityInput) =>
  getModelCapabilityProfile(input.provider, input.model)?.capabilities.has(input.required) ?? false

export const requireModelCapability = (input: ModelCapabilityInput): ModelCapabilityProfile => {
  const profile = getModelCapabilityProfile(input.provider, input.model)
  if (profile?.capabilities.has(input.required)) return profile

  throw new UnsupportedModelCapability({
    provider: ProviderID.make(input.provider),
    model: ModelID.make(input.model),
    required: input.required,
    supported: profile === undefined ? [] : [...profile.capabilities],
    planned: profile?.plannedCapabilities.has(input.required) ?? false,
  })
}
