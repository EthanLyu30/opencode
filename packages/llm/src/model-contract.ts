import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { Schema } from "effect"
import type { LLMRequest } from "./schema"

export namespace ModelContract {
  const brand: unique symbol = Symbol("ModelContract.Binding")
  export interface Input {
    readonly providerID: WorkflowModelCatalog.ProviderID
    readonly modelID: string
    readonly profileID: string
    readonly profileSha256: string
    readonly capabilities: readonly string[]
    readonly effortLevels: readonly string[]
    readonly sourceSha256: string
  }
  export interface Binding extends Input {
    readonly [brand]: true
  }
  const owned = new WeakSet<Binding>()
  const codec = Schema.Struct({
    providerID: WorkflowModelCatalog.ProviderID,
    modelID: WorkflowModelCatalog.ModelID,
    profileID: Schema.String,
    profileSha256: WorkflowModelCatalog.Sha256,
    capabilities: Schema.Array(Schema.String),
    effortLevels: Schema.Array(Schema.String),
    sourceSha256: WorkflowModelCatalog.Sha256,
  }).annotate({ parseOptions: { onExcessProperty: "error" } })
  const invalid = () => new Error("Invalid verified model contract")

  export function bind(input: unknown): Binding {
    const decoded = Schema.decodeUnknownOption(codec)(input)
    if (decoded._tag === "None") throw invalid()
    const value = decoded.value
    const profile = WorkflowModelCatalog.adapterProfile(value.profileID)
    if (
      !profile ||
      profile.providerID !== value.providerID ||
      profile.wireContractSha256 !== value.profileSha256 ||
      value.capabilities.length === 0 ||
      value.effortLevels.length === 0 ||
      new Set(value.capabilities).size !== value.capabilities.length ||
      new Set(value.effortLevels).size !== value.effortLevels.length ||
      value.capabilities.some((capability) => !profile.capabilities.includes(capability)) ||
      value.effortLevels.some((effort) => !profile.effortLevels.includes(effort)) ||
      (value.providerID === "kimi" && /^(?:kimi[-_:])?k?2(?:[._:-]|$)/i.test(value.modelID))
    )
      throw invalid()
    const binding: Binding = Object.freeze({
      ...value,
      capabilities: Object.freeze([...value.capabilities]),
      effortLevels: Object.freeze([...value.effortLevels]),
      [brand]: true as const,
    })
    owned.add(binding)
    return binding
  }

  export function require(binding: Binding, providerID: string, modelID: string, protocol?: string) {
    if (!owned.has(binding) || binding.providerID !== providerID || binding.modelID !== modelID) throw invalid()
    const profile = WorkflowModelCatalog.adapterProfile(binding.profileID)!
    if (protocol !== undefined && profile.protocol !== protocol) throw invalid()
    return profile
  }

  export function validateRequest(binding: Binding, request: LLMRequest) {
    require(binding, String(request.model.provider), String(request.model.id), request.model.route.protocol)
    const effort =
      binding.providerID === "kimi"
        ? (request.providerOptions?.kimi?.reasoningEffort ?? "max")
        : (request.providerOptions?.deepseek?.reasoningEffort ?? "high")
    if (typeof effort !== "string" || !binding.effortLevels.includes(effort)) throw invalid()
    const needed = [
      ...(request.responseFormat ? ["structured_output"] : []),
      ...(request.toolChoice?.type === "required" ? ["required_tool_choice"] : []),
      ...(request.messages.some((message) => message.content.some((part) => part.type === "media"))
        ? ["vision_input"]
        : []),
      ...(binding.providerID === "kimi" &&
      request.messages.some((message) => message.content.some((part) => part.type === "reasoning"))
        ? ["reasoning_replay"]
        : []),
    ]
    if (needed.some((capability) => !binding.capabilities.includes(capability))) throw invalid()
  }
}
