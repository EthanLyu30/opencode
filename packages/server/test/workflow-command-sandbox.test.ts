import { afterAll, describe, expect, test } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { WorkflowSchema } from "@opencode-ai/core/workflow"
import { WorkflowCommandSandbox } from "@opencode-ai/core/workflow/command-sandbox"
import { WorkflowRoleAgents } from "@opencode-ai/core/workflow/role-agents"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { WorkflowStore } from "@opencode-ai/core/workflow/store"
import { WorkflowToolLineage } from "@opencode-ai/core/workflow/tool-lineage"
import { DateTime, Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Docker } from "../src/workflow/docker"
import { WorkflowCommandSandboxServer } from "../src/workflow/command-sandbox"

const root = "D:\\OpenCode-Local\\tmp\\workflow-sandbox-tests"
const image = `opencode/workflow-sandbox@sha256:${"a".repeat(64)}`
const enginePath = "D:\\Applications\\Docker\\resources\\bin\\docker.exe"
type PersistedStage = NonNullable<Effect.Success<ReturnType<WorkflowStore.Interface["stage"]>>>

afterAll(async () => {
  if (path.resolve(root) !== root) throw new TypeError("Unexpected sandbox test root")
  await fs.rm(root, { recursive: true, force: true })
})

describe("WorkflowCommandSandboxServer", () => {
  test("pipes hostile model command only to bash stdin and creates a digest-pinned, least-authority container", async () => {
    await using fixture = await setup("implement")
    const command = `printf '%s' "$HOME"; touch D:\\host; echo --label=evil`

    const result = await fixture.run({ command })

    expect(result).toEqual({ exit: 0, output: "sandbox output", truncated: false })
    const create = fixture.engine.one("container", "create")
    expect(create.executable).toBe(enginePath)
    for (const value of [
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--user",
      "65532:65532",
      "--pids-limit",
      "64",
      "--memory",
      "1073741824",
      "--cpus",
      "1.5",
      "--stop-timeout",
      "3",
      image,
      "/bin/bash",
      "-se",
    ])
      expect(create.argv).toContain(value)
    expect(count(create.argv, "--pull")).toBe(1)
    expect(count(create.argv, "--network")).toBe(1)
    expect(count(create.argv, "--mount")).toBe(1)
    expect(count(create.argv, "--tmpfs")).toBe(2)
    expect(valuesAfter(create.argv, "--tmpfs")).toEqual([
      "/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777",
      "/home/sandbox:rw,nosuid,nodev,noexec,size=16777216,mode=700,uid=65532,gid=65532",
    ])
    expect(create.argv.join("\0")).not.toContain(command)
    expect(create.argv).not.toContain("--device")
    expect(create.argv).not.toContain("--privileged")
    expect(create.argv.join("\0").toLowerCase()).not.toContain("docker.sock")
    expect(create.argv.join("\0").toLowerCase()).not.toContain("users\\administrator")
    expect(create.env).toEqual({
      DOCKER_CONFIG: fixture.dockerConfig,
      TEMP: fixture.temp,
      TMP: fixture.temp,
    })
    expect(Object.values(create.env).every((value) => value.startsWith("D:\\"))).toBe(true)
    expect(create.timeoutMs).toBe(5_000)
    expect(create.maxOutputBytes).toBe(65_536)
    const start = fixture.engine.one("container", "start")
    expect(start.argv).toEqual(["container", "start", "--attach", "--interactive", fixture.engine.containerID])
    expect(start.stdin).toBe(`${command}\n`)
    expect(start.timeoutMs).toBe(10_000)
    expect(start.maxOutputBytes).toBe(65_536)
    expect(fixture.engine.one("container", "rm").argv).toEqual([
      "container",
      "rm",
      "--force",
      fixture.engine.containerID,
    ])
  })

  test.each(["implement", "repair"] as const)("mounts the persisted workspace read-write for %s", async (role) => {
    await using fixture = await setup(role)
    await fixture.run({ command: "true", workdir: "src" })

    const mount = valuesAfter(fixture.engine.one("container", "create").argv, "--mount")
    expect(mount).toHaveLength(1)
    expect(mount[0]).toBe(`type=bind,src=${fixture.workspace},dst=/workspace`)
    expect(valueAfter(fixture.engine.one("container", "create").argv, "--workdir")).toBe("/workspace/src")
  })

  test.each(["test", "deliver"] as const)(
    "mounts the persisted workspace read-only with zero model-derived writable exceptions for %s",
    async (role) => {
      await using fixture = await setup(role, {
        stageInput: {
          revision: 0,
          outputDirectories: ["model-output"],
          finalizationDirectories: ["model-release"],
        },
      })
      await fixture.run({ command: "true" })

      expect(valuesAfter(fixture.engine.one("container", "create").argv, "--mount")).toEqual([
        `type=bind,src=${fixture.workspace},dst=/workspace,readonly`,
      ])
    },
  )

  test.each(["design", "decompose", "visual_review"] as const)(
    "rejects Bash for the %s role before Docker",
    async (role) => {
      await using fixture = await setup(role)
      const failure = await fixture.run({ command: "true" }).catch((error) => error)

      expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
      expect(fixture.engine.invocations).toEqual([])
    },
  )

  test("re-loads Workflow, Stage, Session, active Location, and recomputed policy before launch", async () => {
    await using fixture = await setup("implement")
    fixture.persisted.stage = { ...fixture.persisted.stage, input: { revision: 1 } }

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toMatchObject({
      _tag: "WorkflowCommandSandbox.Rejected",
      message: expect.stringContaining("policy"),
    })
    expect(fixture.lookups).toEqual({ workflow: 1, stage: 1, session: 1 })
    expect(fixture.engine.invocations).toEqual([])
  })

  test.each([
    ["unpinned image", { image: "opencode/workflow-sandbox:latest" }],
    ["relative engine", { enginePath: "docker.exe" }],
    ["C drive engine", { enginePath: "C:\\Program Files\\Docker\\docker.exe" }],
    ["C drive Docker config", { dockerConfig: "C:\\docker-config" }],
    ["C drive temp", { temp: "C:\\Temp\\workflow" }],
  ] as const)("fails typed-unavailable for %s without invoking Docker", async (_name, overrides) => {
    await using fixture = await setup("implement", { config: overrides })
    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    expect(fixture.engine.invocations).toEqual([])
  })

  test.each([
    ["traversal", "..\\outside"],
    ["absolute", "D:\\outside"],
    ["device alias", "CON"],
    ["mount option injection", "comma,dir"],
  ] as const)("rejects %s workdir syntax before Docker", async (_name, workdir) => {
    await using fixture = await setup("implement")
    const failure = await fixture.run({ command: "true", workdir }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.engine.invocations).toEqual([])
  })

  test("rejects junctions in the mounted workspace before Docker", async () => {
    await using fixture = await setup("implement")
    const outside = path.join(root, `outside-${crypto.randomUUID()}`)
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(fixture.workspace, "linked"), "junction")

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.engine.invocations).toEqual([])
    await fs.rm(outside, { recursive: true, force: true })
  })

  test("detects a workspace junction swap after create and removes only the verified container", async () => {
    await using fixture = await setup("implement")
    const original = `${fixture.workspace}-original`
    const outside = path.join(root, `race-outside-${crypto.randomUUID()}`)
    await fs.mkdir(outside)
    fixture.engine.onCreate = async () => {
      await fs.rename(fixture.workspace, original)
      await fs.symlink(outside, fixture.workspace, "junction")
    }

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
    await fs.unlink(fixture.workspace)
    await fs.rm(original, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  test.each(["daemon", "image"] as const)(
    "maps a missing %s to typed-unavailable without fallback",
    async (failure) => {
      await using fixture = await setup("implement", { engineFailure: failure })
      const result = await fixture.run({ command: "echo host-fallback > fallback.txt" }).catch((error) => error)

      expect(result).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
      expect(await fs.exists(path.join(fixture.workspace, "fallback.txt"))).toBe(false)
      expect(fixture.engine.invocations.every((call) => call.executable === enginePath)).toBe(true)
    },
  )

  test.each(["cancelled", "timeout"] as const)(
    "%s execution kills and removes only the verified container once",
    async (mode) => {
      await using fixture = await setup("implement", { startFailure: mode })
      const result = await fixture.run({ command: "sleep 100" }).catch((error) => error)

      expect(result).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
      expect(fixture.engine.all("container", "kill")).toHaveLength(1)
      expect(fixture.engine.one("container", "kill").argv).toEqual(["container", "kill", fixture.engine.containerID])
      expect(fixture.engine.all("container", "rm")).toHaveLength(1)
      expect(fixture.engine.one("container", "rm").argv).toEqual([
        "container",
        "rm",
        "--force",
        fixture.engine.containerID,
      ])
    },
  )

  test("does not start or remove a container whose inspected cid/name/labels do not match", async () => {
    await using fixture = await setup("implement", { inspectMismatch: true })
    const result = await fixture.run({ command: "true" }).catch((error) => error)

    expect(result).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("container", "kill")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toEqual([])
  })

  test("recovery filters by every opaque ownership label and removes only exact cid/name/lease matches", async () => {
    await using fixture = await setup("implement")
    await fixture.run({ command: "true" })
    fixture.engine.invocations.splice(0)
    const authority = fixture.authority()
    fixture.engine.recoveryIDs = [fixture.engine.containerID, "b".repeat(64)]

    const recovered = await WorkflowCommandSandboxServer.recover({
      engine: fixture.engine,
      config: fixture.config,
      authority: {
        workflowID: authority.workflowID,
        stageID: authority.stageID,
        toolCallID: fixture.request.toolCallID,
        role: authority.route.role,
        policyDigest: authority.policyDigest,
        sessionID: fixture.request.sessionID,
        agent: fixture.request.agent,
        leaseOwner: fixture.persisted.stage.leaseOwner!,
        attempt: fixture.persisted.stage.attempt,
      },
    })

    expect(recovered).toBe(1)
    const list = fixture.engine.one("container", "ls")
    expect(count(list.argv, "--filter")).toBe(8)
    expect(
      valuesAfter(list.argv, "--filter").every((value) => /^label=io\.opencode\.workflow\.[a-z]+=/.test(value)),
    ).toBe(true)
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
    expect(fixture.engine.one("container", "rm").argv.at(-1)).toBe(fixture.engine.containerID)
  })
})

class FakeEngine implements Docker.Engine {
  readonly containerID = "a".repeat(64)
  readonly invocations: Docker.Invocation[] = []
  recoveryIDs: string[] = []
  onCreate?: () => Promise<void>
  private name = ""
  private labels: Record<string, string> = {}

  constructor(
    private readonly options: {
      readonly engineFailure?: "daemon" | "image"
      readonly startFailure?: "cancelled" | "timeout"
      readonly inspectMismatch?: boolean
    },
  ) {}

  execute = async (input: Docker.Invocation): Promise<Docker.Result> => {
    this.invocations.push(input)
    if (input.argv[0] === "container" && input.argv[1] === "create") {
      if (this.options.engineFailure === "daemon") {
        return { exit: 1, stdout: "", stderr: "Cannot connect to the Docker daemon", truncated: false }
      }
      if (this.options.engineFailure === "image") {
        return { exit: 1, stdout: "", stderr: "No such image", truncated: false }
      }
      this.name = valueAfter(input.argv, "--name")
      this.labels = Object.fromEntries(valuesAfter(input.argv, "--label").map((value) => value.split("=", 2)))
      await this.onCreate?.()
      return { exit: 0, stdout: `${this.containerID}\n`, stderr: "", truncated: false }
    }
    if (input.argv[0] === "container" && input.argv[1] === "inspect") {
      const id = input.argv.at(-1)!
      const exact = id === this.containerID
      return {
        exit: 0,
        stdout: JSON.stringify([
          {
            Id: id,
            Name: `/${exact ? this.name : "foreign"}`,
            Config: { Labels: exact && !this.options.inspectMismatch ? this.labels : { foreign: "true" } },
          },
        ]),
        stderr: "",
        truncated: false,
      }
    }
    if (input.argv[0] === "container" && input.argv[1] === "start") {
      if (this.options.startFailure === "cancelled") throw new Docker.Cancelled("cancelled")
      if (this.options.startFailure === "timeout") throw new Docker.Timeout("timeout")
      return { exit: 0, stdout: "sandbox output", stderr: "", truncated: false }
    }
    if (input.argv[0] === "container" && input.argv[1] === "ls") {
      return { exit: 0, stdout: this.recoveryIDs.join("\n"), stderr: "", truncated: false }
    }
    return { exit: 0, stdout: "", stderr: "", truncated: false }
  }

  one(...prefix: string[]) {
    const matches = this.all(...prefix)
    expect(matches).toHaveLength(1)
    return matches[0]
  }

  all(...prefix: string[]) {
    return this.invocations.filter((input) => prefix.every((value, index) => input.argv[index] === value))
  }
}

async function setup(
  role: WorkflowCommandSandbox.Request["role"],
  options: {
    readonly stageInput?: Readonly<Record<string, unknown>>
    readonly config?: Partial<WorkflowCommandSandboxServer.Config>
    readonly engineFailure?: "daemon" | "image"
    readonly startFailure?: "cancelled" | "timeout"
    readonly inspectMismatch?: boolean
  } = {},
) {
  await fs.mkdir(root, { recursive: true })
  const workspace = await fs.mkdtemp(path.join(root, "workspace-"))
  await fs.mkdir(path.join(workspace, "src"))
  const dockerConfig = path.join(root, `config-${crypto.randomUUID()}`)
  const temp = path.join(root, `temp-${crypto.randomUUID()}`)
  await fs.mkdir(dockerConfig)
  await fs.mkdir(temp)
  const workflowID = WorkflowSchema.ID.make("wfl_server_command_sandbox")
  const stageID = WorkflowSchema.StageID.make("wfs_server_command_sandbox")
  const sessionID = SessionSchema.ID.make("ses_server_command_sandbox")
  const agent = WorkflowRoleAgents.agentForRole(role)
  const now = Date.now()
  const location = Location.Ref.make({ directory: AbsolutePath.make(workspace) })
  const run: WorkflowSchema.Info = {
    id: workflowID,
    type: "visual-build",
    status: "running",
    currentStageID: stageID,
    input: {},
    budget: {},
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
    location,
    sessionID,
    agent: AgentV2.ID.make("build"),
    version: 1,
    time: { created: DateTime.makeUnsafe(now - 1_000), updated: DateTime.makeUnsafe(now) },
  }
  const stage: PersistedStage = {
    id: stageID,
    workflowID,
    type: role,
    ordinal: 0,
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    leaseOwner: "server-worker-1",
    leaseExpiresAt: DateTime.makeUnsafe(now + 60_000),
    recoveryPolicy: "restart_safe",
    idempotencyKey: `visual-build/${role}/r0`,
    input: options.stageInput ?? { revision: 0 },
    time: {
      created: DateTime.makeUnsafe(now - 1_000),
      updated: DateTime.makeUnsafe(now),
      started: DateTime.makeUnsafe(now),
    },
  }
  const session = SessionSchema.Info.make({
    id: sessionID,
    projectID: ProjectV2.ID.global,
    title: "workflow",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location,
    time: { created: DateTime.makeUnsafe(now), updated: DateTime.makeUnsafe(now) },
  })
  const persisted: { run: WorkflowSchema.Info; stage: PersistedStage; session: SessionSchema.Info } = {
    run,
    stage,
    session,
  }
  const lookups = { workflow: 0, stage: 0, session: 0 }
  const workflowStore = WorkflowStore.Service.of({
    list: () => Effect.succeed([]),
    get: () => {
      lookups.workflow++
      return Effect.succeed({ run: persisted.run, stages: [persisted.stage], artifacts: [] })
    },
    stage: () => {
      lookups.stage++
      return Effect.succeed(persisted.stage)
    },
    artifacts: () => Effect.succeed([]),
    gateBudget: () => Effect.succeed(false),
    claimCandidates: () => Effect.succeed([]),
    claim: () => Effect.succeedNone,
    renew: () => Effect.succeed(false),
    expired: () => Effect.succeed([]),
  })
  const sessionStore = SessionStore.Service.of({
    get: () => {
      lookups.session++
      return Effect.succeed(persisted.session)
    },
    context: () => Effect.succeed([]),
    runnerContext: () => Effect.succeed([]),
    message: () => Effect.succeed(undefined),
  })
  const engine = new FakeEngine(options)
  const config: WorkflowCommandSandboxServer.Config = {
    enginePath,
    image,
    dockerConfig,
    temp,
    limits: {
      timeoutMs: 10_000,
      engineTimeoutMs: 5_000,
      cleanupTimeoutMs: 2_000,
      maxOutputBytes: 65_536,
      memoryBytes: 1_073_741_824,
      cpus: 1.5,
      pids: 64,
    },
    ...options.config,
  }
  const request = {
    role,
    workflowID,
    stageID,
    sessionID,
    agent,
    assistantMessageID: SessionMessage.ID.make("msg_server_command_sandbox"),
    toolCallID: "call-server-command-sandbox",
  }
  const authority = async () => {
    const route = WorkflowRouting.resolve({
      role,
      budget: persisted.run.budget,
      requested: WorkflowRouting.requestedFromStage(role, persisted.stage.input),
    })
    const policyDigest = await Effect.runPromise(
      WorkflowToolLineage.policyDigest({ workflow: persisted.run, stage: persisted.stage, route, agent }),
    )
    return { workflowID, stageID, route, policyDigest }
  }
  const initial = await authority()
  const layer = WorkflowCommandSandboxServer.makeLayer({ engine, config, now: () => now }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(WorkflowStore.Service, workflowStore),
        Layer.succeed(SessionStore.Service, sessionStore),
        Layer.succeed(
          Location.Service,
          Location.Service.of({
            directory: AbsolutePath.make(workspace),
            project: { id: ProjectV2.ID.global, directory: AbsolutePath.make(workspace) },
          }),
        ),
      ),
    ),
  )

  return {
    workspace,
    dockerConfig,
    temp,
    engine,
    config,
    persisted,
    lookups,
    request,
    authority: () => initial,
    run: (input: { readonly command: string; readonly workdir?: string }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* WorkflowCommandSandbox.Service).run({
            ...request,
            policyDigest: initial.policyDigest,
            ...input,
          })
        }).pipe(Effect.provide(layer)),
      ),
    async [Symbol.asyncDispose]() {
      await fs.rm(workspace, { recursive: true, force: true })
      await fs.rm(dockerConfig, { recursive: true, force: true })
      await fs.rm(temp, { recursive: true, force: true })
    },
  }
}

function valuesAfter(values: readonly string[], flag: string) {
  return values.flatMap((value, index) =>
    value === flag && values[index + 1] !== undefined ? [values[index + 1]] : [],
  )
}

function valueAfter(values: readonly string[], flag: string) {
  const found = valuesAfter(values, flag)
  if (found.length !== 1) throw new TypeError(`Expected one ${flag}`)
  return found[0]
}

function count(values: readonly string[], value: string) {
  return values.filter((candidate) => candidate === value).length
}
