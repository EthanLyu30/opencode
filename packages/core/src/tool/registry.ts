export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { AgentV2 } from "../agent"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { ToolOutputStore } from "../tool-output-store"
import { Hash } from "../util/hash"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { definition, permission, settle, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"
import { WorkflowToolLineage } from "../workflow/tool-lineage"
import { WorkflowRoleAgentProfiles } from "../workflow/role-agent-profiles"
import { WorkflowRoleAgents } from "../workflow/role-agents"
import { WorkflowRouting } from "../workflow/routing"
import { WorkflowStore } from "../workflow/store"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
}

export interface Interface {
  readonly materialize: (permissions?: PermissionV2.Ruleset) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  /** Opaque identity of the exact filtered executable registrations. */
  readonly fingerprint: string
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

const workflowSettlers = new WeakMap<
  Materialization,
  (input: ExecuteInput, lineage: WorkflowToolLineage.Descriptor) => Effect.Effect<Settlement, ToolOutputStore.Error>
>()

export interface WorkflowAuthorityInput extends ExecuteInput {
  readonly materialization: Materialization
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly route: WorkflowRouting.Route
  readonly policyDigest: string
}

export class WorkflowAuthorityError extends Schema.TaggedErrorClass<WorkflowAuthorityError>()(
  "ToolRegistry.WorkflowAuthorityError",
  {
    code: Schema.Literals([
      "workflow_missing",
      "stage_missing",
      "session_missing",
      "location_mismatch",
      "session_mismatch",
      "role_mismatch",
      "agent_mismatch",
      "policy_mismatch",
      "materialization_invalid",
    ]),
    message: Schema.String,
  },
) {}

export interface WorkflowAuthorityInterface {
  readonly settle: (
    input: WorkflowAuthorityInput,
  ) => Effect.Effect<Settlement, WorkflowAuthorityError | ToolOutputStore.Error>
}

export class WorkflowAuthorityService extends Context.Service<WorkflowAuthorityService, WorkflowAuthorityInterface>()(
  "@opencode/v2/ToolRegistry/WorkflowAuthority",
) {}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()
    const identities = new WeakMap<object, string>()
    const fingerprintFor = (identity: object) => {
      const existing = identities.get(identity)
      if (existing) return existing
      const created = crypto.randomUUID()
      identities.set(identity, created)
      return created
    }

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (
      input: ExecuteInput,
      advertised?: object,
      workflowLineage?: WorkflowToolLineage.Descriptor,
    ) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        ...(workflowLineage === undefined ? {} : { workflowLineage }),
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = []) {
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)
        const materialization: Materialization = {
          fingerprint: Hash.sha256(
            JSON.stringify(
              Array.from(registrations, ([name, registration]) => [name, fingerprintFor(registration.identity)]).sort(
                ([left], [right]) => left.localeCompare(right),
              ),
            ),
          ),
          definitions: Array.from(registrations, ([name, registration]) => definition(name, registration.tool)),
          settle: (input) => {
            if (WorkflowRoleAgentProfiles.isRoleAgent(input.agent))
              return Effect.succeed({
                result: {
                  type: "error" as const,
                  value: `Agent ${input.agent} is reserved for internal workflow settlement`,
                },
              })
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
        workflowSettlers.set(materialization, (input, lineage) => {
          const registration = registrations.get(input.call.name)
          if (registration) return settleWith(input, registration.identity, lineage)
          return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
        })
        return materialization
      }),
    })
  }),
)

const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

const workflowAuthorityLayer = Layer.effect(
  WorkflowAuthorityService,
  Effect.gen(function* () {
    yield* Service
    const workflows = yield* WorkflowStore.Service
    const sessions = yield* SessionStore.Service
    const location = yield* Location.Service
    const fail = (code: WorkflowAuthorityError["code"], message: string) =>
      Effect.fail(new WorkflowAuthorityError({ code, message }))

    return WorkflowAuthorityService.of({
      settle: Effect.fn("ToolRegistry.WorkflowAuthority.settle")(function* (input) {
        const detail = yield* workflows.get(input.workflowID)
        if (detail === undefined) return yield* fail("workflow_missing", "Persisted Workflow is required")
        const stage = yield* workflows.stage(input.stageID)
        if (stage === undefined) return yield* fail("stage_missing", "Persisted Workflow Stage is required")
        if (stage.workflowID !== detail.run.id)
          return yield* fail("stage_missing", "Persisted Workflow Stage does not belong to the Workflow")
        if (detail.run.location === undefined || !sameLocation(detail.run.location, location))
          return yield* fail("location_mismatch", "Persisted Workflow does not match the active Location")
        if (detail.run.sessionID === undefined || detail.run.sessionID !== input.sessionID)
          return yield* fail("session_mismatch", "Settlement Session does not match the persisted Workflow")
        if (stage.sessionID !== undefined && stage.sessionID !== input.sessionID)
          return yield* fail("session_mismatch", "Settlement Session does not match the persisted Stage")
        const session = yield* sessions.get(input.sessionID)
        if (session === undefined) return yield* fail("session_missing", "Persisted Session is required")
        if (!sameLocation(session.location, location) || !sameLocation(session.location, detail.run.location))
          return yield* fail("location_mismatch", "Persisted Session does not match the active Workflow Location")
        if (!Schema.is(WorkflowRole.Role)(stage.type) || stage.type !== input.route.role)
          return yield* fail("role_mismatch", "Settlement route does not match the persisted Stage role")
        const agent = WorkflowRoleAgents.agentForRole(stage.type)
        if (input.agent !== agent)
          return yield* fail("agent_mismatch", "Settlement agent does not match the persisted Stage role")
        const policyDigest = yield* WorkflowToolLineage.policyDigest({
          workflow: detail.run,
          stage,
          route: input.route,
          agent,
        }).pipe(
          Effect.mapError((error) => new WorkflowAuthorityError({ code: "policy_mismatch", message: error.message })),
        )
        if (policyDigest !== input.policyDigest)
          return yield* fail("policy_mismatch", "Settlement policy does not match persisted Workflow authority")
        const settle = workflowSettlers.get(input.materialization)
        if (settle === undefined)
          return yield* fail("materialization_invalid", "Workflow settlement requires a captured materialization")
        return yield* settle(input, {
          workflowID: detail.run.id,
          stageID: stage.id,
          sessionID: input.sessionID,
          agent,
          role: stage.type,
          policyDigest,
        })
      }),
    })
  }),
)

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})

export const workflowAuthorityNode = makeLocationNode({
  service: WorkflowAuthorityService,
  layer: workflowAuthorityLayer,
  deps: [node, WorkflowStore.node, SessionStore.node, Location.node],
})

function sameLocation(
  expected: { readonly directory: string; readonly workspaceID?: string },
  actual: { readonly directory: string; readonly workspaceID?: string },
) {
  return expected.directory === actual.directory && expected.workspaceID === actual.workspaceID
}
