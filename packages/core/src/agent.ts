export * as AgentV2 from "./agent"

import { makeLocationNode } from "./effect/app-node"
import { Array, Context, Effect, Layer, Schema, Types } from "effect"
import { Agent } from "@opencode-ai/schema/agent"
import { State } from "./state"
import { WorkflowRoleAgentProfiles } from "./workflow/role-agent-profiles"

export const ID = Agent.ID
export type ID = typeof ID.Type
export const defaultID = ID.make("build")

export const Color = Agent.Color

export const Info = Agent.Info
export type Info = Agent.Info

export interface Selection {
  readonly id: ID
  readonly info: Info | undefined
}

export class ReservedSelectionError extends Schema.TaggedErrorClass<ReservedSelectionError>()(
  "AgentV2.ReservedSelectionError",
  { agent: ID },
) {
  override get message() {
    return `Agent ${this.agent} is reserved for internal workflow settlement`
  }
}

type Data = {
  agents: Map<ID, Types.DeepMutable<Info>>
  default?: ID
}

export type Draft = {
  list: () => readonly Info[]
  get: (id: ID) => Info | undefined
  default: (id: ID | undefined) => void
  update: (id: ID, fn: (agent: Types.DeepMutable<Info>) => void) => void
  remove: (id: ID) => void
}

export interface Interface extends State.Transformable<Draft> {
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly default: () => Effect.Effect<Info | undefined>
  readonly resolve: (id?: ID | string) => Effect.Effect<Info | undefined>
  readonly select: (id?: ID | string) => Effect.Effect<Selection, ReservedSelectionError>
  readonly all: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Agent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = State.create<Data, Draft>({
      initial: () => ({ agents: new Map() }),
      draft: (draft) => ({
        list: () => Array.fromIterable(draft.agents.values()) as Info[],
        get: (id) => draft.agents.get(id),
        default: (id) => {
          draft.default = id
        },
        update: (id, fn) => {
          const current = draft.agents.get(id) ?? (Info.empty(id) as Types.DeepMutable<Info>)
          if (!draft.agents.has(id)) draft.agents.set(id, current)
          fn(current)
          current.id = id
        },
        remove: (id) => {
          draft.agents.delete(id)
        },
      }),
      finalize: (draft) => Effect.sync(() => WorkflowRoleAgentProfiles.install(draft)),
    })
    yield* state.reload()
    const selectable = (agent: Info | undefined) =>
      agent && agent.mode !== "subagent" && !agent.hidden ? agent : undefined
    const selectedDefault = () => {
      const data = state.get()
      const configured = data.default ? selectable(data.agents.get(data.default)) : undefined
      if (configured) return configured
      const build = selectable(data.agents.get(ID.make("build")))
      if (build) return build
      for (const agent of data.agents.values()) {
        const fallback = selectable(agent)
        if (fallback) return fallback
      }
    }

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("AgentV2.get")(function* (id) {
        return state.get().agents.get(id)
      }),
      default: Effect.fn("AgentV2.default")(function* () {
        return selectedDefault()
      }),
      resolve: Effect.fn("AgentV2.resolve")(function* (id) {
        if (id !== undefined) return state.get().agents.get(ID.make(id))
        return selectedDefault()
      }),
      select: Effect.fn("AgentV2.select")(function* (id) {
        if (id !== undefined) {
          const selected = ID.make(id)
          yield* requirePublicID(selected)
          return { id: selected, info: state.get().agents.get(selected) }
        }
        const info = selectedDefault()
        return { id: info?.id ?? defaultID, info }
      }),
      all: Effect.fn("AgentV2.all")(function* () {
        return Array.fromIterable(state.get().agents.values()).filter(
          (agent) => !WorkflowRoleAgentProfiles.isRoleAgent(agent.id),
        )
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [] })

export function requirePublicID(id: ID | string) {
  const selected = ID.make(id)
  return WorkflowRoleAgentProfiles.isRoleAgent(selected)
    ? Effect.fail(new ReservedSelectionError({ agent: selected }))
    : Effect.void
}
