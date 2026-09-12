export * as WorkflowRouting from "./routing"

import { Capabilities, type Model } from "@opencode-ai/llm"
import { DeepSeek, Kimi } from "@opencode-ai/llm/providers"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Data, Schema } from "effect"
import { WorkflowBenchmarkTransport } from "./benchmark-transport"
import { WorkflowSecretGuard } from "./secret-guard"

type Capability = Capabilities.ProviderCapability

interface Policy {
  readonly providerID: "kimi" | "deepseek"
  readonly modelID: "kimi-k3" | "deepseek-v4-flash" | "deepseek-v4-pro"
  readonly protocol: WorkflowRole.Protocol
  readonly reasoningEffort: WorkflowRole.ReasoningEffort
  readonly requiredCapability: Capability
  readonly requiredCapabilities: ReadonlyArray<Capability>
}

const policies = {
  design: {
    providerID: "kimi",
    modelID: "kimi-k3",
    protocol: "openai-chat",
    reasoningEffort: "max",
    requiredCapability: "chat",
    requiredCapabilities: ["chat", "reasoning_replay", "structured_output", "required_tool_choice"],
  },
  decompose: {
    providerID: "kimi",
    modelID: "kimi-k3",
    protocol: "openai-chat",
    reasoningEffort: "high",
    requiredCapability: "chat",
    requiredCapabilities: ["chat", "reasoning_replay", "structured_output", "required_tool_choice"],
  },
  implement: {
    providerID: "deepseek",
    modelID: "deepseek-v4-pro",
    protocol: "openai-responses",
    reasoningEffort: "max",
    requiredCapability: "responses",
    requiredCapabilities: ["responses", "structured_output", "required_tool_choice"],
  },
  test: {
    providerID: "deepseek",
    modelID: "deepseek-v4-flash",
    protocol: "openai-responses",
    reasoningEffort: "high",
    requiredCapability: "responses",
    requiredCapabilities: ["responses", "structured_output", "required_tool_choice"],
  },
  visual_review: {
    providerID: "kimi",
    modelID: "kimi-k3",
    protocol: "openai-chat",
    reasoningEffort: "max",
    requiredCapability: "vision_input",
    requiredCapabilities: ["chat", "reasoning_replay", "vision_input", "structured_output", "required_tool_choice"],
  },
  repair: {
    providerID: "deepseek",
    modelID: "deepseek-v4-pro",
    protocol: "openai-responses",
    reasoningEffort: "max",
    requiredCapability: "responses",
    requiredCapabilities: ["responses", "structured_output", "required_tool_choice"],
  },
  deliver: {
    providerID: "deepseek",
    modelID: "deepseek-v4-pro",
    protocol: "openai-responses",
    reasoningEffort: "high",
    requiredCapability: "responses",
    requiredCapabilities: ["responses", "structured_output", "required_tool_choice"],
  },
} as const satisfies Record<WorkflowRole.Role, Policy>

export class PolicyViolation extends Data.TaggedError("WorkflowRouting.PolicyViolation")<{
  readonly role: WorkflowRole.Role
  readonly providerID: string
  readonly modelID: string
  readonly protocol: WorkflowRole.Protocol
  readonly requiredCapability: Capability
  readonly supported: ReadonlyArray<Capability>
  readonly planned: boolean
}> {
  override get message() {
    const planned = this.planned ? " (planned, not currently available)" : ""
    return `${this.providerID}/${this.modelID}/${this.protocol} cannot satisfy ${this.role}:${this.requiredCapability}${planned}`
  }
}

export class InvalidRouteOverride extends Data.TaggedError("WorkflowRouting.InvalidRouteOverride")<{
  readonly role: WorkflowRole.Role
}> {
  override get message() {
    return `The ${this.role} stage route override is malformed`
  }
}

export interface Route {
  readonly role: WorkflowRole.Role
  readonly providerID: "kimi" | "deepseek"
  readonly modelID: "kimi-k3" | "deepseek-v4-flash" | "deepseek-v4-pro"
  readonly protocol: WorkflowRole.Protocol
  readonly reasoningEffort: WorkflowRole.ReasoningEffort
  readonly requiredCapabilities: ReadonlyArray<Capability>
  readonly budget: Workflow.Budget
  readonly model: Model
  readonly benchmarkTransport?: WorkflowBenchmarkTransport.Binding
}

export interface ResolveInput {
  readonly role: WorkflowRole.Role
  readonly budget: Workflow.Budget
  readonly requested?: WorkflowRole.RequestedRoute
  readonly benchmarkTransport?: WorkflowBenchmarkTransport.Binding
  /** Trusted deterministic clock seam for benchmark admission and recovery tests. */
  readonly now?: number
}

export function forResponseModel(route: Route, modelID: string): Route {
  if (route.role !== "deliver") {
    throw new Error("Only a deliver stage can execute an explicitly selected Response model")
  }
  if (route.providerID !== "deepseek" || route.protocol !== "openai-responses") {
    throw new Error("Only DeepSeek Responses routes can execute a linked Response model")
  }

  if (modelID !== route.modelID) throw new Error("The linked Response model must match the fixed deliver route")

  for (const required of route.requiredCapabilities) {
    Capabilities.requireModelCapability({ provider: route.providerID, model: modelID, required })
  }

  return Object.freeze({
    ...route,
    modelID,
    model: DeepSeek.configure({
      ...(route.benchmarkTransport === undefined
        ? {}
        : { baseURL: WorkflowBenchmarkTransport.baseURL(route.benchmarkTransport, "deepseek") }),
      providerOptions: { deepseek: { reasoningEffort: route.reasoningEffort } },
    }).responses(modelID),
  })
}

export function resolve(input: ResolveInput): Route {
  const policy = policies[input.role]
  if (input.requested && !matches(policy, input.requested)) throw violation(input.role, input.requested, policy)

  for (const required of policy.requiredCapabilities) {
    try {
      Capabilities.requireModelCapability({ provider: policy.providerID, model: policy.modelID, required })
    } catch (error) {
      if (!(error instanceof Capabilities.UnsupportedModelCapability)) throw error
      throw new PolicyViolation({
        role: input.role,
        providerID: error.provider,
        modelID: error.model,
        protocol: policy.protocol,
        requiredCapability: error.required,
        supported: error.supported,
        planned: error.planned,
      })
    }
  }

  const benchmarkTransport =
    input.benchmarkTransport === undefined
      ? undefined
      : WorkflowBenchmarkTransport.decodeBinding(input.benchmarkTransport, input.now ?? Date.now())
  const model =
    policy.providerID === "kimi"
      ? Kimi.configure({
          ...(benchmarkTransport === undefined
            ? {}
            : { baseURL: WorkflowBenchmarkTransport.baseURL(benchmarkTransport, "kimi", input.now) }),
          providerOptions: { kimi: { reasoningEffort: policy.reasoningEffort } },
        }).model(policy.modelID)
      : DeepSeek.configure({
          ...(benchmarkTransport === undefined
            ? {}
            : { baseURL: WorkflowBenchmarkTransport.baseURL(benchmarkTransport, "deepseek", input.now) }),
          providerOptions: { deepseek: { reasoningEffort: policy.reasoningEffort } },
        }).responses(policy.modelID)

  return Object.freeze({
    role: input.role,
    providerID: policy.providerID,
    modelID: policy.modelID,
    protocol: policy.protocol,
    reasoningEffort: policy.reasoningEffort,
    requiredCapabilities: Object.freeze([...policy.requiredCapabilities]),
    budget: Object.freeze({ ...input.budget }),
    model,
    ...(benchmarkTransport === undefined ? {} : { benchmarkTransport }),
  })
}

export function requestedFromStage(role: WorkflowRole.Role, input: Readonly<Record<string, unknown>>) {
  if (!Object.hasOwn(input, "route")) return undefined
  if (Schema.is(WorkflowRole.RequestedRoute)(input.route)) return input.route
  throw new InvalidRouteOverride({ role })
}

function matches(policy: Policy, requested: WorkflowRole.RequestedRoute) {
  return (
    requested.providerID === policy.providerID &&
    requested.modelID === policy.modelID &&
    requested.protocol === policy.protocol
  )
}

function violation(role: WorkflowRole.Role, requested: WorkflowRole.RequestedRoute, policy: Policy) {
  const profile = Capabilities.getModelCapabilityProfile(requested.providerID, requested.modelID)
  return new PolicyViolation({
    role,
    providerID: WorkflowSecretGuard.sanitizeText(requested.providerID),
    modelID: WorkflowSecretGuard.sanitizeText(requested.modelID),
    protocol: requested.protocol,
    requiredCapability: policy.requiredCapability,
    supported: profile === undefined ? [] : [...profile.capabilities],
    planned: profile?.plannedCapabilities.has(policy.requiredCapability) ?? false,
  })
}
