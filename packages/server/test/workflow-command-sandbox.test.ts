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
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowProductionHostPlan } from "@opencode-ai/core/workflow/production-host-plan"
import { DateTime, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Docker } from "../src/workflow/docker"
import { WorkflowCommandSandboxServer } from "../src/workflow/command-sandbox"

const root = "D:\\OpenCode-Local\\tmp\\workflow-sandbox-tests"
const image = `opencode/workflow-sandbox@sha256:${"a".repeat(64)}`
const enginePath = path.join(root, "engine", "docker.exe")
type PersistedStage = NonNullable<Effect.Success<ReturnType<WorkflowStore.Interface["stage"]>>>
type MutableFixture = {
  readonly persisted: {
    run: WorkflowSchema.Info
    stage: PersistedStage
    session: SessionSchema.Info
  }
}

afterAll(async () => {
  if (path.resolve(root) !== root) throw new TypeError("Unexpected sandbox test root")
  await fs.rm(root, { recursive: true, force: true })
})

describe("WorkflowCommandSandboxServer", () => {
  test("installs a separate trusted frozen-test runner instead of accepting model shell text", async () => {
    await using fixture = await setup("test")
    expect(await fixture.hasFrozenTestRunner()).toBe(true)
  })

  test("runs only the admission-frozen argv directly without shell stdin", async () => {
    await using fixture = await setup("test")
    const location = fixture.persisted.run.location!
    await fs.writeFile(path.join(location.directory, "index.html"), "<!doctype html><main>ready</main>")
    const preview = PreviewPlan.freeze({ authority: "admission", location })
    const plan = WorkflowProductionHostPlan.freeze({ authority: "admission", location, preview })
    fixture.persisted.run = {
      ...fixture.persisted.run,
      input: WorkflowProductionHostPlan.withPlan({}, plan),
    }
    const result = await fixture.runFrozen(plan)
    expect(result).toEqual({ exit: 0, output: "sandbox output", truncated: false })
    const create = fixture.engine.one("container", "create")
    expect(create.argv.slice(-3)).toEqual([image, "bun", "test"])
    expect(fixture.engine.one("container", "start").stdin).toBeUndefined()
  })

  test("pipes hostile model command only to bash stdin and creates a digest-pinned, least-authority container", async () => {
    const command = `printf '%s' "$HOME"; touch D:\\host; echo --label=evil`
    await using fixture = await setup("implement", { callInput: { command } })

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
    expect(start.timeoutMs).toBeGreaterThan(0)
    expect(start.timeoutMs).toBeLessThanOrEqual(10_000)
    expect(start.maxOutputBytes).toBe(65_536)
    expect(fixture.engine.one("container", "rm").argv).toEqual([
      "container",
      "rm",
      "--force",
      fixture.engine.containerID,
    ])
  })

  test.each(["implement", "repair"] as const)("mounts the persisted workspace read-write for %s", async (role) => {
    await using fixture = await setup(role, { callInput: { command: "true", workdir: "src" } })
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
    [
      "wrong pending call id",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = {
          ...fixture.persisted.stage,
          checkpoint: {
            ...fixture.persisted.stage.checkpoint!,
            activeTurn: {
              calls: [{ id: "call-stale", name: "bash", input: { command: "true" } }],
              results: [],
              pendingCallID: "call-stale",
            },
          },
        }
      },
    ],
    [
      "wrong pending call name",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = {
          ...fixture.persisted.stage,
          checkpoint: {
            ...fixture.persisted.stage.checkpoint!,
            activeTurn: {
              calls: [{ id: "call-server-command-sandbox", name: "read", input: { command: "true" } }],
              results: [],
              pendingCallID: "call-server-command-sandbox",
            },
          },
        }
      },
    ],
    [
      "wrong pending call input",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = {
          ...fixture.persisted.stage,
          checkpoint: {
            ...fixture.persisted.stage.checkpoint!,
            activeTurn: {
              calls: [{ id: "call-server-command-sandbox", name: "bash", input: { command: "echo forged" } }],
              results: [],
              pendingCallID: "call-server-command-sandbox",
            },
          },
        }
      },
    ],
    [
      "already settled call",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = {
          ...fixture.persisted.stage,
          checkpoint: {
            ...fixture.persisted.stage.checkpoint!,
            activeTurn: {
              calls: [{ id: "call-server-command-sandbox", name: "bash", input: { command: "true" } }],
              results: [
                {
                  id: "call-server-command-sandbox",
                  name: "bash",
                  result: { type: "text", value: "done" },
                },
              ],
            },
          },
        }
      },
    ],
    [
      "non-pending checkpoint call",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = {
          ...fixture.persisted.stage,
          checkpoint: { ...fixture.persisted.stage.checkpoint!, activeTurn: undefined },
        }
      },
    ],
  ] as const)("rejects %s settlement lineage before Docker", async (_name, mutate) => {
    await using fixture = await setup("implement")
    mutate(fixture)

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.engine.invocations).toEqual([])
  })

  test("rejects command text that differs from the persisted Bash call", async () => {
    await using fixture = await setup("implement")

    const failure = await fixture.run({ command: "echo forged" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.engine.invocations).toEqual([])
  })

  test("rejects a fabricated deterministic assistant message id before Docker", async () => {
    await using fixture = await setup("implement")

    const failure = await fixture
      .run({ command: "true", assistantMessageID: SessionMessage.ID.make("msg_fabricated") })
      .catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.engine.invocations).toEqual([])
  })

  test("rejects a request agent that differs from the persisted role agent", async () => {
    await using fixture = await setup("implement")

    const failure = await fixture.run({ command: "true", agent: AgentV2.ID.make("build") }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.engine.invocations).toEqual([])
  })

  test.each([
    [
      "workflow session",
      (fixture: MutableFixture): void => {
        fixture.persisted.run = { ...fixture.persisted.run, sessionID: SessionSchema.ID.make("ses_changed") }
      },
    ],
    [
      "current stage",
      (fixture: MutableFixture): void => {
        fixture.persisted.run = { ...fixture.persisted.run, currentStageID: WorkflowSchema.StageID.make("wfs_changed") }
      },
    ],
    [
      "stage session",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = { ...fixture.persisted.stage, sessionID: SessionSchema.ID.make("ses_changed") }
      },
    ],
    [
      "stage status",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = { ...fixture.persisted.stage, status: "succeeded" }
      },
    ],
    [
      "lease owner",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = { ...fixture.persisted.stage, leaseOwner: "worker-revoked" }
      },
    ],
    [
      "lease attempt",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = { ...fixture.persisted.stage, attempt: 2 }
      },
    ],
    [
      "lease expiry",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = { ...fixture.persisted.stage, leaseExpiresAt: DateTime.makeUnsafe(0) }
      },
    ],
    [
      "workflow status",
      (fixture: MutableFixture): void => {
        fixture.persisted.run = { ...fixture.persisted.run, status: "cancelled" }
      },
    ],
    [
      "workflow location",
      (fixture: MutableFixture): void => {
        fixture.persisted.run = {
          ...fixture.persisted.run,
          location: Location.Ref.make({ directory: AbsolutePath.make("D:\\foreign") }),
        }
      },
    ],
    [
      "stage workflow",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = { ...fixture.persisted.stage, workflowID: WorkflowSchema.ID.make("wfl_changed") }
      },
    ],
    [
      "stage role",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = { ...fixture.persisted.stage, type: "test" }
      },
    ],
    [
      "stage policy",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = { ...fixture.persisted.stage, input: { revision: 2 } }
      },
    ],
    [
      "session location",
      (fixture: MutableFixture): void => {
        fixture.persisted.session = {
          ...fixture.persisted.session,
          location: Location.Ref.make({ directory: AbsolutePath.make("D:\\foreign") }),
        }
      },
    ],
    [
      "call settlement",
      (fixture: MutableFixture): void => {
        fixture.persisted.stage = {
          ...fixture.persisted.stage,
          checkpoint: {
            ...fixture.persisted.stage.checkpoint!,
            activeTurn: {
              calls: [{ id: "call-server-command-sandbox", name: "bash", input: { command: "true" } }],
              results: [
                {
                  id: "call-server-command-sandbox",
                  name: "bash",
                  result: { type: "text", value: "done" },
                },
              ],
            },
          },
        }
      },
    ],
  ] as const)("rechecks changed %s after create and never starts", async (_name, mutate) => {
    await using fixture = await setup("implement")
    fixture.engine.onCreate = async () => mutate(fixture)

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.lookups.workflow).toBe(2)
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
  })

  test("uses a fresh clock at the final authority gate", async () => {
    await using fixture = await setup("implement")
    fixture.engine.onCreate = async () => {
      fixture.hooks.onWorkflowLookup = () => {
        fixture.clock.now += 120_000
      }
    }

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
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

  test("fails closed when the configured docker.exe is missing", async () => {
    const missingEngine = path.join(root, `missing-engine-${crypto.randomUUID()}`, "docker.exe")
    await using fixture = await setup("implement", { config: { enginePath: missingEngine } })

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    expect(fixture.engine.invocations).toEqual([])
  })

  test("rejects a Location below a protected host root before Docker", async () => {
    await using fixture = await setup("implement")
    Reflect.set(fixture.config, "protectedRoots", [fixture.workspace])

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.engine.invocations).toEqual([])
  })

  test("revalidates the fixed docker.exe identity before every engine spawn", async () => {
    const engineRoot = path.join(root, `replace-engine-${crypto.randomUUID()}`)
    const replaceableEngine = path.join(engineRoot, "docker.exe")
    await fs.mkdir(engineRoot, { recursive: true })
    await fs.writeFile(replaceableEngine, "first")
    await using fixture = await setup("implement", { config: { enginePath: replaceableEngine } })
    fixture.engine.onCreate = async () => {
      await fs.rename(replaceableEngine, path.join(engineRoot, "docker.old.exe"))
      await fs.writeFile(replaceableEngine, "replacement")
    }

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    expect(fixture.engine.invocations.map((call) => call.argv.slice(0, 2))).toEqual([["container", "create"]])
    await fs.rm(engineRoot, { recursive: true, force: true })
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

  test("rejects a multiply-linked regular workspace leaf before Docker", async () => {
    await using fixture = await setup("implement")
    const outside = path.join(root, `hardlink-owner-${crypto.randomUUID()}.txt`)
    await fs.writeFile(outside, "outside-owned")
    await fs.link(outside, path.join(fixture.workspace, "linked.txt"))

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.engine.invocations).toEqual([])
    await fs.rm(outside, { force: true })
  })

  test("rechecks regular leaf link count after container creation and never starts a replaced mount", async () => {
    await using fixture = await setup("implement")
    const target = path.join(fixture.workspace, "source.txt")
    const outside = path.join(root, `hardlink-swap-${crypto.randomUUID()}.txt`)
    await fs.writeFile(target, "workspace-owned")
    await fs.writeFile(outside, "outside-owned")
    fixture.engine.onCreate = async () => {
      await fs.rm(target)
      await fs.link(outside, target)
    }

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
    await fs.rm(outside, { force: true })
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

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
    await fs.unlink(fixture.workspace)
    await fs.rm(original, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  test("detects a nested junction swap after create at the final recursive gate", async () => {
    await using fixture = await setup("implement")
    const nested = path.join(fixture.workspace, "src")
    const original = `${nested}-original`
    const outside = path.join(root, `nested-race-outside-${crypto.randomUUID()}`)
    await fs.mkdir(outside)
    fixture.engine.onCreate = async () => {
      await fs.rename(nested, original)
      await fs.symlink(outside, nested, "junction")
    }

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Rejected)
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
    await fs.unlink(nested)
    await fs.rm(original, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  test.each(["daemon", "image"] as const)(
    "maps a missing %s to typed-unavailable without fallback",
    async (failure) => {
      const command = "echo host-fallback > fallback.txt"
      await using fixture = await setup("implement", { engineFailure: failure, callInput: { command } })
      const result = await fixture.run({ command }).catch((error) => error)

      expect(result).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
      expect(await fs.exists(path.join(fixture.workspace, "fallback.txt"))).toBe(false)
      expect(fixture.engine.invocations.every((call) => call.executable === enginePath)).toBe(true)
    },
  )

  test.each(["cancelled", "timeout"] as const)(
    "%s execution kills and removes only the verified container once",
    async (mode) => {
      await using fixture = await setup("implement", { startFailure: mode, callInput: { command: "sleep 100" } })
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

  test("maps a Docker start failure to unavailable and kills/removes the verified container", async () => {
    await using fixture = await setup("implement", { startFailure: "engine" })

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    expect(fixture.engine.all("container", "kill")).toHaveLength(1)
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
  })

  test("returns the inspected container command exit rather than the Docker CLI exit", async () => {
    await using fixture = await setup("implement", { startFailure: "command", callInput: { command: "exit 23" } })

    const result = await fixture.run({ command: "exit 23" })

    expect(result.exit).toBe(23)
    expect(result.output).toContain("command failed")
  })

  test("does not start or remove a container whose inspected cid/name/labels do not match", async () => {
    await using fixture = await setup("implement", { inspectMismatch: true })
    const result = await fixture.run({ command: "true" }).catch((error) => error)

    expect(result).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("container", "kill")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toEqual([])
  })

  test.each(["malformed", "truncated"] as const)(
    "fails closed on a %s ownership inspection without cleaning an unverified cid",
    async (inspectFailure) => {
      await using fixture = await setup("implement", { inspectFailure })

      const failure = await fixture.run({ command: "true" }).catch((error) => error)

      expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
      expect(fixture.engine.all("container", "start")).toEqual([])
      expect(fixture.engine.all("container", "rm")).toEqual([])
    },
  )

  test.each(["timeout", "exit", "cancelled", "invalid-id", "inspect-once"] as const)(
    "discovers and removes an exact-owned container after %s during acquisition",
    async (acquisitionFailure) => {
      await using fixture = await setup("implement", { acquisitionFailure })

      const failure = await fixture.run({ command: "true" }).catch((error) => error)

      expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
      await waitUntil(() => fixture.engine.all("container", "rm").length === 1)
      expect(fixture.engine.all("container", "start")).toEqual([])
      expect(fixture.engine.one("container", "rm").argv).toEqual([
        "container",
        "rm",
        "--force",
        fixture.engine.containerID,
      ])
    },
  )

  test("returns at the caller deadline while bounded cleanup discovers a late-visible exact owner", async () => {
    await using fixture = await setup("implement", {
      acquisitionFailure: "late-timeout",
      callInput: { command: "true", timeout: 10 },
    })

    const failure = await fixture.run({ command: "true", timeout: 10 }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    expect(fixture.engine.all("container", "rm")).toEqual([])
    fixture.engine.containerVisible = true
    await waitUntil(() => fixture.engine.all("container", "rm").length === 1)
  })

  test("threads caller cancellation through acquisition ownership inspection", async () => {
    await using fixture = await setup("implement", { acquisitionFailure: "inspect-cancelled" })

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    const acquisitionInspect = fixture.engine.all("container", "inspect")[0]
    expect(acquisitionInspect?.signal).toBeInstanceOf(AbortSignal)
    await waitUntil(() => fixture.engine.all("container", "rm").length === 1)
  })

  test("reports verified-container removal failure as typed unavailable", async () => {
    await using fixture = await setup("implement", { cleanupFailure: "rm" })

    const failure = await fixture.run({ command: "true" }).catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
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
    const lists = fixture.engine.all("container", "ls")
    expect(lists).toHaveLength(2)
    expect(lists.every((list) => count(list.argv, "--filter") === 8)).toBe(true)
    expect(
      lists.every((list) =>
        valuesAfter(list.argv, "--filter").every((value) => /^label=io\.opencode\.workflow\.[a-z]+=/.test(value)),
      ),
    ).toBe(true)
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
    expect(fixture.engine.one("container", "rm").argv.at(-1)).toBe(fixture.engine.containerID)
  })

  test("recovery lets verified removal dominate a thrown kill race", async () => {
    await using fixture = await setup("implement", { recoveryFailure: "kill" })
    await fixture.run({ command: "true" })
    fixture.engine.invocations.splice(0)
    fixture.engine.recoveryIDs = [fixture.engine.containerID]
    fixture.engine.recoveryRunning = true

    const recovered = await fixture.recover()

    expect(recovered).toBe(1)
    expect(fixture.engine.all("container", "kill")).toHaveLength(1)
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
  })

  test("recovery skips kill for an exact-owned stopped container and accepts verified removal", async () => {
    await using fixture = await setup("implement", { recoveryFailure: "kill" })
    await fixture.run({ command: "true" })
    fixture.engine.invocations.splice(0)
    fixture.engine.recoveryIDs = [fixture.engine.containerID]

    const recovered = await fixture.recover()

    expect(recovered).toBe(1)
    expect(fixture.engine.all("container", "kill")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
  })

  test("recovery accepts a running-to-stopped kill race when rm and final absence are proven", async () => {
    await using fixture = await setup("implement", { recoveryFailure: "kill-exit" })
    await fixture.run({ command: "true" })
    fixture.engine.invocations.splice(0)
    fixture.engine.recoveryIDs = [fixture.engine.containerID]
    fixture.engine.recoveryRunning = true

    const recovered = await fixture.recover()

    expect(recovered).toBe(1)
    expect(fixture.engine.all("container", "kill")).toHaveLength(1)
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
    expect(fixture.engine.recoveryIDs).toEqual([])
  })

  test("recovery treats a verified empty ownership listing as already absent", async () => {
    await using fixture = await setup("implement")
    await fixture.run({ command: "true" })
    fixture.engine.invocations.splice(0)

    const recovered = await fixture.recover()

    expect(recovered).toBe(0)
    expect(fixture.engine.all("container", "kill")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toEqual([])
  })

  test("recovery stays unavailable when an exact-owned container remains after rm", async () => {
    await using fixture = await setup("implement", { recoveryFailure: "still-present" })
    await fixture.run({ command: "true" })
    fixture.engine.invocations.splice(0)
    fixture.engine.recoveryIDs = [fixture.engine.containerID]

    const failure = await fixture.recover().catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
  })

  test("recovery reports rm failure as typed unavailable after one exact attempt", async () => {
    await using fixture = await setup("implement", { recoveryFailure: "rm" })
    await fixture.run({ command: "true" })
    fixture.engine.invocations.splice(0)
    fixture.engine.recoveryIDs = [fixture.engine.containerID]

    const failure = await fixture.recover().catch((error) => error)

    expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
  })

  test.each(["list", "listing-junk", "inspect-json"] as const)(
    "maps recovery %s failure to typed unavailable",
    async (recoveryFailure) => {
      await using fixture = await setup("implement", { recoveryFailure })
      await fixture.run({ command: "true" })
      fixture.engine.invocations.splice(0)
      fixture.engine.recoveryIDs = [fixture.engine.containerID]

      const failure = await fixture.recover().catch((error) => error)

      expect(failure).toBeInstanceOf(WorkflowCommandSandbox.Unavailable)
    },
  )
})

describe("Docker production engine", () => {
  test("does not miss an abort delivered while the process is being spawned", async () => {
    const controller = new AbortController()
    let killed = 0
    const empty = () =>
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.close()
        },
      })
    const engine = Docker.makeProduction(() => {
      controller.abort()
      return {
        stdin: { write() {}, end() {} },
        stdout: empty(),
        stderr: empty(),
        exited: new Promise<number>(() => undefined),
        kill() {
          killed++
        },
      }
    })

    const failure = await engine
      .execute({
        executable: enginePath,
        argv: ["version"],
        env: {},
        timeoutMs: 100,
        maxOutputBytes: 100,
        signal: controller.signal,
      })
      .catch((error) => error)

    expect(failure).toBeInstanceOf(Docker.Cancelled)
    expect(killed).toBe(1)
  })
})

class FakeEngine implements Docker.Engine {
  readonly containerID = "a".repeat(64)
  readonly invocations: Docker.Invocation[] = []
  recoveryIDs: string[] = []
  recoveryRunning = false
  onCreate?: () => Promise<void>
  containerVisible = true
  private inspectAttempts = 0
  private name = ""
  private labels: Record<string, string> = {}

  constructor(
    private readonly options: {
      readonly engineFailure?: "daemon" | "image"
      readonly startFailure?: "cancelled" | "timeout" | "engine" | "command"
      readonly inspectMismatch?: boolean
      readonly recoveryFailure?:
        | "list"
        | "listing-junk"
        | "inspect-json"
        | "kill"
        | "kill-exit"
        | "rm"
        | "still-present"
      readonly inspectFailure?: "malformed" | "truncated"
      readonly cleanupFailure?: "rm"
      readonly acquisitionFailure?:
        | "timeout"
        | "exit"
        | "cancelled"
        | "invalid-id"
        | "inspect-once"
        | "inspect-cancelled"
        | "late-timeout"
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
      if (this.options.acquisitionFailure === "late-timeout") {
        this.containerVisible = false
        throw new Docker.Timeout("create timed out")
      }
      if (this.options.acquisitionFailure === "timeout") throw new Docker.Timeout("create timed out")
      if (this.options.acquisitionFailure === "cancelled") throw new Docker.Cancelled("create cancelled")
      if (this.options.acquisitionFailure === "exit")
        return { exit: 1, stdout: "", stderr: "create failed after allocation", truncated: false }
      if (this.options.acquisitionFailure === "invalid-id")
        return { exit: 0, stdout: "not-a-container-id", stderr: "", truncated: false }
      return { exit: 0, stdout: `${this.containerID}\n`, stderr: "", truncated: false }
    }
    if (input.argv[0] === "container" && input.argv[1] === "inspect") {
      const id = input.argv.at(-1)!
      const exact = id === this.containerID || id === this.name
      if (!this.containerVisible && id === this.name)
        return { exit: 1, stdout: "", stderr: "not found", truncated: false }
      this.inspectAttempts++
      if (this.options.acquisitionFailure === "inspect-cancelled" && this.inspectAttempts === 1)
        throw new Docker.Cancelled("cancelled during inspect")
      if (this.options.acquisitionFailure === "inspect-once" && this.inspectAttempts === 1)
        return { exit: 1, stdout: "", stderr: "transient inspect failure", truncated: false }
      if (this.options.inspectFailure === "malformed") return { exit: 0, stdout: "{", stderr: "", truncated: false }
      if (this.options.inspectFailure === "truncated") return { exit: 0, stdout: "[]", stderr: "", truncated: true }
      if (this.options.recoveryFailure === "inspect-json" && this.recoveryIDs.length > 0)
        return { exit: 0, stdout: "{", stderr: "", truncated: false }
      return {
        exit: 0,
        stdout: JSON.stringify([
          {
            Id: exact ? this.containerID : id,
            Name: `/${exact ? this.name : "foreign"}`,
            Config: { Labels: exact && !this.options.inspectMismatch ? this.labels : { foreign: "true" } },
            State: {
              Running: this.recoveryIDs.length > 0 ? this.recoveryRunning : false,
              ExitCode: this.options.startFailure === "command" ? 23 : 0,
            },
          },
        ]),
        stderr: "",
        truncated: false,
      }
    }
    if (input.argv[0] === "container" && input.argv[1] === "start") {
      if (this.options.startFailure === "cancelled") throw new Docker.Cancelled("cancelled")
      if (this.options.startFailure === "timeout") throw new Docker.Timeout("timeout")
      if (this.options.startFailure === "engine")
        return { exit: 1, stdout: "", stderr: "daemon disconnected", truncated: false }
      if (this.options.startFailure === "command")
        return { exit: 1, stdout: "", stderr: "command failed", truncated: false }
      return { exit: 0, stdout: "sandbox output", stderr: "", truncated: false }
    }
    if (input.argv[0] === "container" && input.argv[1] === "ls") {
      if (this.options.recoveryFailure === "list") throw new Error("daemon unavailable")
      if (this.options.recoveryFailure === "listing-junk")
        return { exit: 0, stdout: "not-a-container-id", stderr: "", truncated: false }
      return { exit: 0, stdout: this.recoveryIDs.join("\n"), stderr: "", truncated: false }
    }
    if (input.argv[0] === "container" && input.argv[1] === "kill" && this.options.recoveryFailure === "kill")
      throw new Error("kill failed")
    if (input.argv[0] === "container" && input.argv[1] === "kill" && this.options.recoveryFailure === "kill-exit")
      return { exit: 1, stdout: "", stderr: "not running", truncated: false }
    if (input.argv[0] === "container" && input.argv[1] === "rm" && this.options.cleanupFailure === "rm")
      throw new Error("rm failed")
    if (
      input.argv[0] === "container" &&
      input.argv[1] === "rm" &&
      this.options.recoveryFailure === "rm" &&
      this.recoveryIDs.length > 0
    )
      throw new Error("recovery rm failed")
    if (input.argv[0] === "container" && input.argv[1] === "rm" && this.recoveryIDs.length > 0) {
      if (this.options.recoveryFailure !== "still-present") this.recoveryIDs = []
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

async function waitUntil(check: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before deadline")
    await Bun.sleep(5)
  }
}

async function setup(
  role: WorkflowCommandSandbox.Request["role"],
  options: {
    readonly stageInput?: Readonly<Record<string, unknown>>
    readonly config?: Partial<WorkflowCommandSandboxServer.Config>
    readonly engineFailure?: "daemon" | "image"
    readonly startFailure?: "cancelled" | "timeout" | "engine" | "command"
    readonly inspectMismatch?: boolean
    readonly recoveryFailure?: "list" | "listing-junk" | "inspect-json" | "kill" | "kill-exit" | "rm" | "still-present"
    readonly inspectFailure?: "malformed" | "truncated"
    readonly cleanupFailure?: "rm"
    readonly acquisitionFailure?:
      | "timeout"
      | "exit"
      | "cancelled"
      | "invalid-id"
      | "inspect-once"
      | "inspect-cancelled"
      | "late-timeout"
    readonly callInput?: { readonly command: string; readonly workdir?: string; readonly timeout?: number }
  } = {},
) {
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(path.dirname(enginePath), { recursive: true })
  await fs.writeFile(enginePath, "fake docker test executable", { flag: "a" })
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
  const clock = { now }
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
    checkpoint: {
      kind: "workflow.model.continuation",
      version: 1,
      activeTurn: {
        calls: [{ id: "call-server-command-sandbox", name: "bash", input: options.callInput ?? { command: "true" } }],
        results: [],
        pendingCallID: "call-server-command-sandbox",
      },
    },
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
  const persisted: {
    run: WorkflowSchema.Info
    stage: PersistedStage
    session: SessionSchema.Info
  } = {
    run,
    stage,
    session,
  }
  const hooks: { onWorkflowLookup?: () => void } = {}
  const lookups = { workflow: 0, stage: 0, session: 0 }
  const workflowStore = WorkflowStore.Service.of({
    list: () => Effect.succeed([]),
    get: () => {
      lookups.workflow++
      hooks.onWorkflowLookup?.()
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
    assistantMessageID: workflowMessageID(stageID, "call-server-command-sandbox"),
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
  const layer = WorkflowCommandSandboxServer.makeLayer({ engine, config, now: () => clock.now }).pipe(
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
    clock,
    hooks,
    config,
    persisted,
    lookups,
    request,
    authority: () => initial,
    hasFrozenTestRunner: () =>
      Effect.runPromise(
        Effect.map(WorkflowCommandSandbox.Service, (sandbox) => typeof sandbox.runFrozenTest === "function").pipe(
          Effect.provide(layer),
        ),
      ),
    runFrozen: (plan: WorkflowProductionHostPlan.Plan) =>
      Effect.runPromise(
        Effect.flatMap(WorkflowCommandSandbox.Service, (sandbox) =>
          sandbox.runFrozenTest!({
            workflowID,
            stageID,
            revision: 0,
            argv: plan.functionalTest.argv,
            cwd: plan.functionalTest.cwd,
            policySha256: plan.functionalTest.policySha256,
            configSha256: plan.functionalTest.configSha256,
          }),
        ).pipe(Effect.provide(layer)),
      ),
    recover: async () => {
      const current = await authority()
      return WorkflowCommandSandboxServer.recover({
        engine,
        config,
        authority: {
          workflowID: current.workflowID,
          stageID: current.stageID,
          toolCallID: request.toolCallID,
          role: current.route.role,
          policyDigest: initial.policyDigest,
          sessionID: request.sessionID,
          agent: request.agent,
          leaseOwner: persisted.stage.leaseOwner!,
          attempt: persisted.stage.attempt,
        },
      })
    },
    run: (
      input: { readonly command: string; readonly workdir?: string } & Partial<
        Pick<WorkflowCommandSandbox.Request, "agent" | "assistantMessageID" | "toolCallID" | "timeout">
      >,
    ) =>
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

function workflowMessageID(stageID: WorkflowSchema.StageID, toolCallID: string) {
  const digest = createHash("sha256").update(toolCallID).digest("hex").slice(0, 16)
  return SessionMessage.ID.make(`msg_workflow_${stageID.slice(4)}_${digest}`)
}
