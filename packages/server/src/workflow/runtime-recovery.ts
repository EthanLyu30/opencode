export * as WorkflowRuntimeRecovery from "./runtime-recovery"

import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowBenchmarkTransport } from "@opencode-ai/core/workflow/benchmark-transport"
import { WorkflowRoleAgents } from "@opencode-ai/core/workflow/role-agents"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowToolLineage } from "@opencode-ai/core/workflow/tool-lineage"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Context, DateTime, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { Docker } from "./docker"
import { DockerConfig } from "./docker-config"
import { ProductionHostRuntime } from "./production-host-runtime"
import { WorkflowCommandSandboxServer } from "./command-sandbox"
import { CodingAuthority } from "@opencode-ai/core/workflow/coding/authority"
import { CodingRouting } from "@opencode-ai/core/workflow/coding/routing"
import { CodingModelSelection } from "@opencode-ai/core/workflow/coding/model-selection"
import { BuildRoleAgents } from "@opencode-ai/core/workflow/execution/build-role-agents"
import { CodingHostPlan } from "@opencode-ai/core/workflow/coding/host-plan"
import { CodingRoleAgentProfiles } from "@opencode-ai/core/workflow/coding/role-agent-profiles"

const EXPIRED_RUNTIME_BATCH_SIZE = 100

function isExecutableRole(
  value: string,
): value is Extract<WorkflowCommandSandbox.Request["role"], "implement" | "repair" | "test" | "deliver"> {
  return value === "implement" || value === "repair" || value === "test" || value === "deliver"
}

export interface Result {
  readonly healthy: boolean
  readonly recovered: number
  readonly skipped: number
}

export interface RecoverInput {
  readonly authority: WorkflowCommandSandboxServer.RecoveryAuthority
  readonly finalGate: () => Promise<boolean>
}

export interface Interface extends Result {
  readonly ready: boolean
}

export class Service extends Context.Service<Service, Interface>()("@opencode/server/WorkflowRuntimeRecovery") {}

export async function recoverExpired(input: {
  readonly store: WorkflowStore.Interface
  readonly now: () => number
  readonly recover: (input: RecoverInput) => Promise<number>
  readonly codingAuthority?: CodingAuthority.Interface
}): Promise<Result> {
  let recovered = 0
  let skipped = 0
  let healthy = true
  let snapshots: Awaited<ReturnType<typeof loadExpired>>
  try {
    snapshots = await loadExpired(input.store, input.now())
  } catch {
    return { healthy: false, recovered, skipped }
  }
  const captured = snapshots.map((snapshot) => ({
    snapshot,
    leaseExpiresAtEpoch:
      snapshot.leaseExpiresAt === undefined ? undefined : DateTime.toEpochMillis(snapshot.leaseExpiresAt),
  }))
  for (const { snapshot, leaseExpiresAtEpoch } of captured) {
    try {
      const candidates = await currentAuthority(
        input.store,
        snapshot,
        leaseExpiresAtEpoch,
        input.now(),
        input.codingAuthority,
      )
      if (candidates === undefined) {
        skipped++
        continue
      }
      for (const candidate of candidates) {
        let fenced = false
        const count = await input.recover({
          authority: candidate.authority,
          finalGate: async () => {
            const current = await currentAuthority(
              input.store,
              snapshot,
              leaseExpiresAtEpoch,
              input.now(),
              input.codingAuthority,
            )
            const valid =
              current !== undefined && current.some((value) => sameAuthority(value.authority, candidate.authority))
            if (!valid) fenced = true
            return valid
          },
        })
        if (fenced) skipped++
        else recovered += count
      }
    } catch {
      healthy = false
    }
  }
  return { healthy, recovered, skipped }
}

export function makeLayer(input: {
  readonly engine: Docker.Engine
  readonly config: DockerConfig.Config
  readonly now?: () => number
  readonly codingAuthority?: CodingAuthority.Interface
}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = yield* WorkflowStore.Service
      const config = yield* Effect.tryPromise({
        try: () => DockerConfig.validate(input.config),
        catch: (error) => error,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (config === undefined) {
        return Service.of({ healthy: false, recovered: 0, skipped: 0, ready: false })
      }
      const result = yield* Effect.promise(() =>
        recoverExpired({
          store,
          now: input.now ?? Date.now,
          codingAuthority: input.codingAuthority,
          recover: ({ authority, finalGate }) =>
            WorkflowCommandSandboxServer.recover({ engine: input.engine, config, authority, finalGate }),
        }),
      )
      return Service.of({ ...result, ready: result.healthy })
    }),
  )
}

export const layer = Layer.unwrap(
  Effect.map(CodingAuthority.Service, (codingAuthority) =>
    makeLayer({ engine: Docker.production, config: productionDockerConfig(process.env), codingAuthority }),
  ),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [WorkflowStore.node, CodingAuthority.node] })

function productionDockerConfig(environment: Readonly<Record<string, string | undefined>>) {
  try {
    return ProductionHostRuntime.load(environment).dockerConfig
  } catch {
    return ProductionHostRuntime.unavailableDockerConfig()
  }
}

async function loadExpired(store: WorkflowStore.Interface, now: number) {
  return Effect.runPromise(store.expired({ now, limit: EXPIRED_RUNTIME_BATCH_SIZE }))
}

async function currentAuthority(
  store: WorkflowStore.Interface,
  snapshot: Awaited<ReturnType<typeof loadExpired>>[number],
  snapshotLeaseExpiresAtEpoch: number | undefined,
  now: number,
  codingAuthority?: CodingAuthority.Interface,
): Promise<readonly { readonly authority: WorkflowCommandSandboxServer.RecoveryAuthority }[] | undefined> {
  if (snapshotLeaseExpiresAtEpoch === undefined) return undefined
  const [detail, stage, expired] = await Promise.all([
    Effect.runPromise(store.get(snapshot.workflowID)),
    Effect.runPromise(store.stage(snapshot.id)),
    loadExpired(store, now),
  ])
  if (
    detail === undefined ||
    stage === undefined ||
    detail.run.id !== snapshot.workflowID ||
    detail.run.status !== "running" ||
    detail.run.currentStageID !== snapshot.id ||
    stage.id !== snapshot.id ||
    stage.workflowID !== snapshot.workflowID ||
    stage.status !== snapshot.status ||
    (stage.status !== "leased" && stage.status !== "running") ||
    stage.leaseOwner === undefined ||
    stage.leaseOwner !== snapshot.leaseOwner ||
    stage.attempt !== snapshot.attempt ||
    stage.leaseExpiresAt === undefined ||
    DateTime.toEpochMillis(stage.leaseExpiresAt) !== snapshotLeaseExpiresAtEpoch ||
    DateTime.toEpochMillis(stage.leaseExpiresAt) >= now ||
    !expired.some(
      (candidate) =>
        candidate.id === stage.id &&
        candidate.workflowID === stage.workflowID &&
        candidate.leaseOwner === stage.leaseOwner &&
        candidate.attempt === stage.attempt &&
        candidate.leaseExpiresAt !== undefined &&
        DateTime.toEpochMillis(candidate.leaseExpiresAt) === snapshotLeaseExpiresAtEpoch,
    ) ||
    !isExecutableRole(stage.type) ||
    detail.run.sessionID === undefined ||
    stage.sessionID !== detail.run.sessionID
  ) {
    return undefined
  }
  const role = stage.type
  if (
    detail.run.type === "coding-build" &&
    (!codingAuthority ||
      !(await Effect.runPromise(
        codingAuthority.require(detail.run).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true })),
      )))
  )
    return undefined
  if (detail.run.type === "coding-build" && role === "test") {
    try {
      if (detail.run.location === undefined) return undefined
      const plan = CodingHostPlan.decode(detail.run.input?.[CodingHostPlan.RESERVED_INPUT_KEY], detail.run.location)
      // These bounded host checks run before a provider turn exists. Reconstruct only
      // their admitted ownership; the same expired-lease fence still gates every removal.
      return plan.commands.map((command) => ({
        authority: {
          workflowID: detail.run.id,
          stageID: stage.id,
          toolCallID: `host-coding-${command.id}-${plan.configSha256.slice(0, 16)}`,
          role: "test" as const,
          policyDigest: plan.sha256,
          sessionID: detail.run.sessionID!,
          agent: CodingRoleAgentProfiles.agentForRole("test"),
          leaseOwner: stage.leaseOwner!,
          attempt: stage.attempt,
        },
      }))
    } catch {
      return undefined
    }
  }
  const call = pendingBashCall(stage.checkpoint)
  if (call === undefined) return undefined
  let route: WorkflowRouting.Route | CodingRouting.Route
  try {
    // Cleanup reconstructs pinned ownership only; it never spends or reuses an expired broker grant.
    route =
      detail.run.type === "coding-build"
        ? CodingRouting.resolve({
            role,
            budget: CodingRouting.budget(detail.run),
            selection: CodingModelSelection.fromWorkflow(detail.run),
          })
        : WorkflowRouting.resolve({
            role,
            budget: detail.run.budget,
            requested: WorkflowRouting.requestedFromStage(role, stage.input),
            benchmarkTransport: WorkflowBenchmarkTransport.fromWorkflow(detail.run, now),
          })
  } catch {
    return undefined
  }
  const agent = BuildRoleAgents.agentForRole(detail.run, role)
  const policyDigest = await Effect.runPromise(
    WorkflowToolLineage.policyDigest({ workflow: detail.run, stage, route, agent }),
  ).catch(() => undefined)
  if (policyDigest === undefined) return undefined
  const assistantMessageID = SessionMessage.ID.make(
    `msg_workflow_${stage.id.slice(4)}_${createHash("sha256").update(call.id).digest("hex").slice(0, 16)}`,
  )
  return [
    {
      authority: {
        workflowID: detail.run.id,
        stageID: stage.id,
        toolCallID: call.id,
        role,
        policyDigest,
        sessionID: detail.run.sessionID,
        agent,
        leaseOwner: stage.leaseOwner,
        attempt: stage.attempt,
        assistantMessageID,
        callDigest: call.digest,
      },
    },
  ]
}

function pendingBashCall(
  checkpoint: Readonly<Record<string, unknown>> | undefined,
): { readonly id: string; readonly digest: string } | undefined {
  if (checkpoint?.kind !== "workflow.model.continuation" || (checkpoint.version !== 1 && checkpoint.version !== 2))
    return undefined
  const activeTurn = checkpoint.activeTurn
  if (activeTurn === null || typeof activeTurn !== "object" || Array.isArray(activeTurn)) return undefined
  const pendingCallID = Reflect.get(activeTurn, "pendingCallID")
  const calls = Reflect.get(activeTurn, "calls")
  const results = Reflect.get(activeTurn, "results")
  if (typeof pendingCallID !== "string" || pendingCallID === "" || !Array.isArray(calls) || !Array.isArray(results))
    return undefined
  if (
    calls.length === 0 ||
    results.length >= calls.length ||
    calls.filter((call) => call !== null && typeof call === "object" && Reflect.get(call, "id") === pendingCallID)
      .length !== 1 ||
    results.some((result, index) => {
      const call = calls[index]
      return (
        result === null ||
        typeof result !== "object" ||
        call === null ||
        typeof call !== "object" ||
        Reflect.get(result, "id") !== Reflect.get(call, "id") ||
        Reflect.get(result, "name") !== Reflect.get(call, "name")
      )
    }) ||
    results.some(
      (result) => result !== null && typeof result === "object" && Reflect.get(result, "id") === pendingCallID,
    )
  ) {
    return undefined
  }
  const pending = calls[results.length]
  const input = pending !== null && typeof pending === "object" ? Reflect.get(pending, "input") : undefined
  if (
    pending === null ||
    typeof pending !== "object" ||
    Reflect.get(pending, "id") !== pendingCallID ||
    Reflect.get(pending, "name") !== "bash" ||
    !validCallInput(input)
  ) {
    return undefined
  }
  const exact = {
    id: pendingCallID,
    name: "bash",
    input: {
      command: input.command,
      ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
      ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
    },
  }
  return {
    id: pendingCallID,
    digest: createHash("sha256").update(JSON.stringify(exact)).digest("hex"),
  }
}

function validCallInput(
  value: unknown,
): value is { readonly command: string; readonly workdir?: string; readonly timeout?: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.some((key) => key !== "command" && key !== "workdir" && key !== "timeout")) return false
  if (typeof Reflect.get(value, "command") !== "string") return false
  if (Object.hasOwn(value, "workdir") && typeof Reflect.get(value, "workdir") !== "string") return false
  return (
    !Object.hasOwn(value, "timeout") ||
    (Number.isSafeInteger(Reflect.get(value, "timeout")) && Number(Reflect.get(value, "timeout")) > 0)
  )
}

function sameAuthority(
  left: WorkflowCommandSandboxServer.RecoveryAuthority,
  right: WorkflowCommandSandboxServer.RecoveryAuthority,
) {
  return (
    left.workflowID === right.workflowID &&
    left.stageID === right.stageID &&
    left.toolCallID === right.toolCallID &&
    left.role === right.role &&
    left.policyDigest === right.policyDigest &&
    left.sessionID === right.sessionID &&
    left.agent === right.agent &&
    left.leaseOwner === right.leaseOwner &&
    left.attempt === right.attempt &&
    left.assistantMessageID === right.assistantMessageID &&
    left.callDigest === right.callDigest
  )
}
