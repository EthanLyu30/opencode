import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorkflowSchema } from "@opencode-ai/core/workflow"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowAdmission } from "@opencode-ai/core/workflow/admission"
import { WorkflowRoleExecution } from "@opencode-ai/core/workflow/execution/role"
import { WorkflowRoleAgents } from "@opencode-ai/core/workflow/role-agents"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { Context, DateTime, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { type ApplicationServiceFactory, createEmbeddedRoutes, createRoutes, workflowReplacements } from "../src/routes"
import { WorkflowCommandSandboxServer } from "../src/workflow/command-sandbox"
import { DockerConfig } from "../src/workflow/docker-config"
import { WorkflowRuntimeRecovery } from "../src/workflow/runtime-recovery"
import { WorkflowVisualHostServer } from "../src/workflow/visual-host"
import { WorkflowProductionEvidenceServer } from "../src/workflow/production-evidence"

describe("Workflow runtime recovery", () => {
  test("starts unhealthy when Docker recovery configuration is unavailable", async () => {
    const fixture = persistedFixture()
    let executed = 0
    const service = await Effect.gen(function* () {
      return yield* WorkflowRuntimeRecovery.Service
    }).pipe(
      Effect.provide(
        WorkflowRuntimeRecovery.makeLayer({
          engine: {
            execute: async () => {
              executed++
              throw new Error("must not execute without validated Docker configuration")
            },
          },
          config: DockerConfig.fromEnvironment({}),
        }),
      ),
      Effect.provideService(WorkflowStore.Service, fixture.store),
      Effect.runPromise,
    )

    expect(service).toEqual({ healthy: false, recovered: 0, skipped: 0, ready: false })
    expect(executed).toBe(0)
  })

  test("reconstructs exact expired pending-call authority without requiring a Session assistant row", async () => {
    const fixture = persistedFixture()
    let recovered: WorkflowCommandSandboxServer.RecoveryAuthority | undefined
    let cleaned = 0

    const result = await WorkflowRuntimeRecovery.recoverExpired({
      store: fixture.store,
      now: () => fixture.now,
      recover: async (input) => {
        recovered = input.authority
        if (!(await input.finalGate())) return 0
        cleaned++
        return 1
      },
    })

    expect(result).toEqual({ healthy: true, recovered: 1, skipped: 0 })
    expect(cleaned).toBe(1)
    expect(recovered).toMatchObject({
      workflowID: fixture.run.id,
      stageID: fixture.stage.id,
      toolCallID: "call-runtime-recovery",
      role: "implement",
      sessionID: fixture.run.sessionID,
      agent: WorkflowRoleAgents.agentForRole("implement"),
      assistantMessageID: expect.stringMatching(/^msg_workflow_runtime_recovery_[a-f0-9]{16}$/),
      callDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      leaseOwner: "worker-expired",
      attempt: 2,
      policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  test("fences an active replacement lease at the final gate before cleanup", async () => {
    const fixture = persistedFixture()
    let cleaned = 0

    const result = await WorkflowRuntimeRecovery.recoverExpired({
      store: fixture.store,
      now: () => fixture.now,
      recover: async (input) => {
        fixture.stage = { ...fixture.stage, leaseExpiresAt: DateTime.makeUnsafe(fixture.now + 60_000) }
        if (!(await input.finalGate())) return 0
        cleaned++
        return 1
      },
    })

    expect(result).toEqual({ healthy: true, recovered: 0, skipped: 1 })
    expect(cleaned).toBe(0)
  })

  test("fences a rewritten lease expiry at the final gate even when the replacement is still expired", async () => {
    const fixture = persistedFixture()
    let cleaned = 0

    const result = await WorkflowRuntimeRecovery.recoverExpired({
      store: fixture.store,
      now: () => fixture.now,
      recover: async (input) => {
        fixture.stage = { ...fixture.stage, leaseExpiresAt: DateTime.makeUnsafe(fixture.now - 2) }
        if (!(await input.finalGate())) return 0
        cleaned++
        return 1
      },
    })

    expect(result).toEqual({ healthy: true, recovered: 0, skipped: 1 })
    expect(cleaned).toBe(0)
  })

  test("fences an in-place lease expiry mutation against the primitive captured by the outer recovery pass", async () => {
    const fixture = persistedFixture()
    let cleaned = 0

    const result = await WorkflowRuntimeRecovery.recoverExpired({
      store: fixture.store,
      now: () => fixture.now,
      recover: async (input) => {
        Reflect.set(fixture.stage, "leaseExpiresAt", DateTime.makeUnsafe(fixture.now - 2))
        if (!(await input.finalGate())) return 0
        cleaned++
        return 1
      },
    })

    expect(result).toEqual({ healthy: true, recovered: 0, skipped: 1 })
    expect(cleaned).toBe(0)
  })

  test.each(["call id", "call name", "call input", "settled result"] as const)(
    "skips an expired Stage with changed %s lineage",
    async (mutation) => {
      const fixture = persistedFixture()
      const checkpoint = fixture.checkpoint
      if (mutation === "call id") checkpoint.activeTurn.pendingCallID = "call-stale"
      if (mutation === "call name") checkpoint.activeTurn.calls[0].name = "read"
      if (mutation === "call input") checkpoint.activeTurn.calls[0].input = { command: "true", provider: "forged" }
      if (mutation === "settled result") {
        checkpoint.activeTurn.results.push({
          id: "call-runtime-recovery",
          name: "bash",
          result: { type: "text", value: "done" },
        })
      }
      let invoked = 0

      const result = await WorkflowRuntimeRecovery.recoverExpired({
        store: fixture.store,
        now: () => fixture.now,
        recover: async () => {
          invoked++
          return 1
        },
      })

      expect(result).toEqual({ healthy: true, recovered: 0, skipped: 1 })
      expect(invoked).toBe(0)
    },
  )

  test("marks recovery unhealthy on a bounded backend failure without throwing through startup", async () => {
    const fixture = persistedFixture()

    const result = await WorkflowRuntimeRecovery.recoverExpired({
      store: fixture.store,
      now: () => fixture.now,
      recover: async () => {
        throw new WorkflowCommandSandbox.Unavailable({ message: "daemon unavailable" })
      },
    })

    expect(result).toEqual({ healthy: false, recovered: 0, skipped: 0 })
  })

  test("fences an exact pending-call rewrite at the final gate even when call ID and lease stay unchanged", async () => {
    const fixture = persistedFixture()
    let cleaned = 0

    const result = await WorkflowRuntimeRecovery.recoverExpired({
      store: fixture.store,
      now: () => fixture.now,
      recover: async (input) => {
        fixture.checkpoint.activeTurn.calls[0].input = { command: "echo changed", workdir: "src" }
        if (!(await input.finalGate())) return 0
        cleaned++
        return 1
      },
    })

    expect(result).toEqual({ healthy: true, recovered: 0, skipped: 1 })
    expect(cleaned).toBe(0)
  })
})

describe("Workflow route composition", () => {
  test("constructs normal and embedded routes without Task23 environment", () => {
    expect(() => createRoutes()).not.toThrow()
    expect(() => createEmbeddedRoutes()).not.toThrow()
  })

  test("uses the exact Server nodes as the default Core Workflow replacements", () => {
    const production = WorkflowProductionEvidenceServer.compositionNodes()
    expect(workflowReplacements()).toEqual([
      [WorkflowVisualHost.node, production.visualHost],
      [WorkflowCommandSandbox.node, WorkflowCommandSandboxServer.node],
      [WorkflowRoleExecution.node, production.roleEvidence],
    ])
  })

  test("resolves injected valid Workflow replacements through the same route replacement function", async () => {
    let visualRecovered = false
    const visual = WorkflowVisualHost.Service.of({
      materializeReference: () => Effect.die("unused"),
      prepareImplementation: () => Effect.die("unused"),
      capture: () => Effect.die("unused"),
      lookupEvidence: () => Effect.die("unused"),
      commitEvidence: () => Effect.die("unused"),
      releaseEvidence: () => Effect.die("unused"),
      abandonEvidence: () => Effect.die("unused"),
      reconcileEvidence: () => Effect.die("unused"),
      recoverExpired: () => Effect.sync(() => (visualRecovered = true)),
    })
    const command = WorkflowCommandSandbox.Service.of({
      run: () => Effect.succeed({ exit: 7, output: "server replacement", truncated: false }),
    })
    const visualNode = makeGlobalNode({
      service: WorkflowVisualHost.Service,
      layer: Layer.succeed(WorkflowVisualHost.Service, visual),
      deps: [],
    })
    const commandNode = makeLocationNode({
      service: WorkflowCommandSandbox.Service,
      layer: Layer.succeed(WorkflowCommandSandbox.Service, command),
      deps: [],
    })
    const layer = AppNodeBuilder.build(
      LayerNode.group([WorkflowVisualHost.node, WorkflowCommandSandbox.node]),
      workflowReplacements({ visualHost: visualNode, commandSandbox: commandNode }),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* WorkflowVisualHost.Service
        const sandbox = yield* WorkflowCommandSandbox.Service
        yield* host.recoverExpired({ activeHostIDs: new Set(), expiredBefore: 0 })
        return yield* sandbox.run({
          role: "implement",
          workflowID: WorkflowSchema.ID.make("wfl_route_replacement"),
          stageID: WorkflowSchema.StageID.make("wfs_route_replacement"),
          policyDigest: "a".repeat(64),
          sessionID: SessionSchema.ID.make("ses_route_replacement"),
          agent: AgentV2.ID.make("build"),
          assistantMessageID: SessionMessage.ID.make("msg_route_replacement"),
          toolCallID: "call-route-replacement",
          command: "true",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(visualRecovered).toBe(true)
    expect(result).toEqual({ exit: 7, output: "server replacement", truncated: false })
  })

  test("runs fake-valid replacements from the actual normal and embedded route service layers", async () => {
    for (const mode of ["normal", "embedded"] as const) {
      const fixture = routeReplacementFixture(mode)
      const buildApplicationLayer = (
        replacements: Parameters<ApplicationServiceFactory>[1],
        build: Parameters<ApplicationServiceFactory>[2],
      ) => build(LayerNode.group([WorkflowVisualHost.node, WorkflowCommandSandbox.node]), replacements)
      const captured: { current?: ReturnType<typeof buildApplicationLayer> } = {}
      const buildApplicationServices = (
        _services: Parameters<ApplicationServiceFactory>[0],
        replacements: Parameters<ApplicationServiceFactory>[1],
        build: Parameters<ApplicationServiceFactory>[2],
      ) => {
        const layer = buildApplicationLayer(replacements, build)
        captured.current = layer
        return layer
      }
      const composition = {
        workflow: { visualHost: fixture.visualNode, commandSandbox: fixture.commandNode },
        buildApplicationServices,
      }

      if (mode === "normal") createRoutes(undefined, composition)
      else createEmbeddedRoutes(composition)
      const applicationLayer = captured.current
      if (applicationLayer === undefined) throw new Error(`${mode} route graph did not build application services`)

      const result = await Effect.runPromise(fixture.exercise.pipe(Effect.provide(applicationLayer)))
      expect(result).toEqual({ exit: 11, output: mode, truncated: false })
      expect(fixture.visualRecovered()).toBe(true)
    }
  })

  test("acquires WorkflowAdmission from the actual normal and embedded returned route graphs", async () => {
    for (const mode of ["normal", "embedded"] as const) {
      const fixture = routeReplacementFixture(mode)
      let admissionAcquired = false
      const build = routeApplicationFactory()
      const composition = {
        workflow: { visualHost: fixture.visualNode, commandSandbox: fixture.commandNode },
        buildApplicationServices: ((services, replacements) =>
          build(services, replacements).pipe(
            Layer.tap((context) =>
              Effect.sync(() => {
                Context.get(context, WorkflowAdmission.Service)
                admissionAcquired = true
              }),
            ),
          )) satisfies ApplicationServiceFactory,
      }
      const routeGraph = mode === "normal" ? createRoutes(undefined, composition) : createEmbeddedRoutes(composition)

      const web = HttpRouter.toWebHandler(routeGraph.pipe(Layer.provide(HttpServer.layerServices)), {
        disableLogger: true,
      })
      // The generated graph retains this request-only marker; the health endpoint does not consume it.
      const requestServices = Context.make(
        PermissionSaved.Service,
        PermissionSaved.Service.of({
          list: () => Effect.die("unused"),
          add: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
        }),
      )
      try {
        const response = await web.handler(new Request("http://localhost/api/health"), requestServices)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ healthy: true })
        expect(fixture.visualAcquired()).toBe(true)
        expect(admissionAcquired).toBe(true)
      } finally {
        await web.dispose()
      }
    }
  })

  test("builds a typed-unavailable visual host layer when production environment is absent", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* WorkflowVisualHost.Service
        return yield* host.recoverExpired({ activeHostIDs: new Set(), expiredBefore: 0 })
      }).pipe(
        Effect.provide(WorkflowVisualHostServer.productionLayer({ environment: {} })),
        Effect.scoped,
        Effect.flip,
      ),
    )

    expect(failure).toMatchObject({
      _tag: "WorkflowVisualHost.Failure",
      operation: "recover_expired",
      code: "visual_host_unavailable",
    })
  })
})

type Stage = NonNullable<Effect.Success<ReturnType<WorkflowStore.Interface["stage"]>>>
type MutableCheckpoint = {
  kind: "workflow.model.continuation"
  version: 1
  activeTurn: {
    calls: Array<Record<string, unknown>>
    results: Array<Record<string, unknown>>
    pendingCallID?: string
  }
}

function persistedFixture() {
  const now = 10_000
  const workflowID = WorkflowSchema.ID.make("wfl_runtime_recovery")
  const stageID = WorkflowSchema.StageID.make("wfs_runtime_recovery")
  const sessionID = SessionSchema.ID.make("ses_runtime_recovery")
  const location = Location.Ref.make({ directory: AbsolutePath.make("D:\\OpenCode-Local\\workspace") })
  const run: WorkflowSchema.Info = {
    id: workflowID,
    type: "visual-build",
    status: "running",
    currentStageID: stageID,
    input: {},
    budget: {},
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 2 },
    location,
    sessionID,
    agent: AgentV2.ID.make("build"),
    version: 1,
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(now - 1) },
  }
  const checkpoint: MutableCheckpoint = {
    kind: "workflow.model.continuation",
    version: 1,
    activeTurn: {
      calls: [{ id: "call-runtime-recovery", name: "bash", input: { command: "true", workdir: "src" } }],
      results: [],
      pendingCallID: "call-runtime-recovery",
    },
  }
  let stage: Stage = {
    id: stageID,
    workflowID,
    type: "implement",
    ordinal: 0,
    status: "running",
    attempt: 2,
    maxAttempts: 3,
    leaseOwner: "worker-expired",
    leaseExpiresAt: DateTime.makeUnsafe(now - 1),
    sessionID,
    recoveryPolicy: "restart_safe",
    idempotencyKey: "visual-build/implement/r0",
    input: { revision: 0 },
    checkpoint,
    time: {
      created: DateTime.makeUnsafe(0),
      updated: DateTime.makeUnsafe(now - 1),
      started: DateTime.makeUnsafe(now - 2),
    },
  }
  const store = WorkflowStore.Service.of({
    list: () => Effect.succeed([]),
    get: () => Effect.succeed({ run, stages: [stage], artifacts: [] }),
    stage: () => Effect.succeed(stage),
    artifacts: () => Effect.succeed([]),
    gateBudget: () => Effect.succeed(false),
    claimCandidates: () => Effect.succeed([]),
    claim: () => Effect.succeedNone,
    renew: () => Effect.succeed(false),
    expired: () => Effect.succeed([stage]),
  })
  return {
    now,
    run,
    checkpoint,
    get stage() {
      return stage
    },
    set stage(value: Stage) {
      stage = value
    },
    store,
  }
}

function routeReplacementFixture(mode: "normal" | "embedded") {
  let recovered = false
  let acquired = false
  const visual = WorkflowVisualHost.Service.of({
    materializeReference: () => Effect.die("unused"),
    prepareImplementation: () => Effect.die("unused"),
    capture: () => Effect.die("unused"),
    lookupEvidence: () => Effect.die("unused"),
    commitEvidence: () => Effect.die("unused"),
    releaseEvidence: () => Effect.die("unused"),
    abandonEvidence: () => Effect.die("unused"),
    reconcileEvidence: () => Effect.die("unused"),
    recoverExpired: () => Effect.sync(() => (recovered = true)),
  })
  const visualNode = makeGlobalNode({
    service: WorkflowVisualHost.Service,
    layer: Layer.effect(
      WorkflowVisualHost.Service,
      Effect.sync(() => {
        acquired = true
        return visual
      }),
    ),
    deps: [],
  })
  const commandNode = makeLocationNode({
    service: WorkflowCommandSandbox.Service,
    layer: Layer.succeed(
      WorkflowCommandSandbox.Service,
      WorkflowCommandSandbox.Service.of({
        run: () => Effect.succeed({ exit: 11, output: mode, truncated: false }),
      }),
    ),
    deps: [],
  })
  return {
    visualNode,
    commandNode,
    visualRecovered: () => recovered,
    visualAcquired: () => acquired,
    exercise: Effect.gen(function* () {
      const host = yield* WorkflowVisualHost.Service
      const command = yield* WorkflowCommandSandbox.Service
      yield* host.recoverExpired({ activeHostIDs: new Set(), expiredBefore: 0 })
      return yield* command.run({
        role: "implement",
        workflowID: WorkflowSchema.ID.make(`wfl_route_${mode}`),
        stageID: WorkflowSchema.StageID.make(`wfs_route_${mode}`),
        policyDigest: "a".repeat(64),
        sessionID: SessionSchema.ID.make(`ses_route_${mode}`),
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make(`msg_route_${mode}`),
        toolCallID: `call-route-${mode}`,
        command: "true",
      })
    }),
  }
}

function routeApplicationFactory() {
  const databaseNode = makeGlobalNode({
    service: Database.Service,
    layer: Database.layerFromPath(":memory:"),
    deps: [],
  })
  const cleanupNode = makeGlobalNode({
    name: ToolOutputStore.cleanupNode.name,
    layer: Layer.empty,
    deps: [],
  })
  const recoveryNode = makeGlobalNode({
    service: WorkflowRuntimeRecovery.Service,
    layer: Layer.succeed(
      WorkflowRuntimeRecovery.Service,
      WorkflowRuntimeRecovery.Service.of({ healthy: true, recovered: 0, skipped: 0, ready: true }),
    ),
    deps: [],
  })
  return (services: Parameters<ApplicationServiceFactory>[0], replacements: Parameters<ApplicationServiceFactory>[1]) =>
    AppNodeBuilder.build(services, [
      ...replacements,
      [Database.node, databaseNode],
      [ToolOutputStore.cleanupNode, cleanupNode],
      [WorkflowRuntimeRecovery.node, recoveryNode],
    ])
}
