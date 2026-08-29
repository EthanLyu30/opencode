import { afterAll, describe, expect, test } from "bun:test"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Docker } from "../src/workflow/docker"
import { DockerConfig } from "../src/workflow/docker-config"
import { DockerProcessOwnership } from "../src/workflow/docker-process-ownership"
import { ProcessOwnership } from "../src/workflow/process-ownership"

const root = "D:\\OpenCode-Local\\tmp\\workflow-preview-docker-tests"
const image = `opencode/workflow-sandbox@sha256:${"a".repeat(64)}`

afterAll(async () => {
  if (path.resolve(root) !== root) throw new TypeError("Unexpected preview Docker test root")
  await fs.rm(root, { recursive: true, force: true })
})

describe("DockerProcessOwnership", () => {
  test("imports sealed script preview bytes without a mutable workspace bind", async () => {
    await using fixture = await setup()
    const captured = Buffer.from("setInterval(() => 'captured', 60_000)\n")
    const entry = {
      path: RelativePath.make("server.mjs"),
      type: "file" as const,
      sha256: createHash("sha256").update(captured).digest("hex"),
      size: captured.byteLength,
    }
    const archive = await WorkflowWorkspaceMaterialization.seal([entry], async () => captured)
    fixture.engine.onContainerCreate = async () => {
      const target = path.join(fixture.workspace, "server.mjs")
      await fs.writeFile(target, "mutated")
      await fs.writeFile(target, captured)
    }

    const owned = await fixture.service.start({ ...fixture.startInput(), archive })

    expect(valuesAfter(fixture.engine.one("container", "create").argv, "--mount")).toEqual([
      `type=bind,src=${fixture.capabilityTemp},dst=/opencode/tmp`,
    ])
    const imported = fixture.engine.one("container", "cp")
    expect(Buffer.from(imported.stdin!).includes(captured)).toBe(true)
    expect(fixture.engine.one("container", "start")).toBeDefined()
    await fixture.service.stop({ identity: fixture.identity, process: owned })
  })

  test("creates an exact-label internal-network preview with only admitted mounts and one loopback publication", async () => {
    await using fixture = await setup()

    const owned = await fixture.service.start(fixture.startInput())
    const [exit, stdout, stderr] = await Promise.all([owned.exited, readText(owned.stdout), readText(owned.stderr)])

    expect(exit).toBe(23)
    expect(stdout).toBe("preview stdout")
    expect(stderr).toBe("preview stderr")
    const network = fixture.engine.one("network", "create")
    expect(network.argv).toContain("--internal")
    expect(count(network.argv, "--label")).toBe(5)
    expect(network.env).toEqual(fixture.dockerEnv)
    const create = fixture.engine.one("container", "create")
    expect(create.executable).toBe(fixture.config.enginePath)
    expect(valuesAfter(create.argv, "--mount")).toEqual([
      `type=bind,src=${fixture.workspace},dst=/workspace,readonly`,
      `type=bind,src=${fixture.capabilityTemp},dst=/opencode/tmp`,
    ])
    expect(valuesAfter(create.argv, "--publish")).toEqual([`127.0.0.1:${fixture.port}:18080/tcp`])
    expect(valuesAfter(create.argv, "--network")).toEqual([fixture.engine.networkName])
    expect(valuesAfter(create.argv, "--label")).toHaveLength(5)
    expect(valuesAfter(create.argv, "--env")).toEqual([
      "APP_MODE=preview",
      "CI=1",
      "HOME=/home/sandbox",
      "LANG=C.UTF-8",
      "NO_COLOR=1",
      `OPENCODE_PREVIEW_PORT=${fixture.port}`,
      "TEMP=/opencode/tmp",
      "TMP=/opencode/tmp",
    ])
    expect(create.argv).toContain("--read-only")
    expect(valuesAfter(create.argv, "--cap-drop")).toEqual(["ALL"])
    expect(valuesAfter(create.argv, "--security-opt")).toEqual(["no-new-privileges=true"])
    expect(valuesAfter(create.argv, "--user")).toEqual(["65532:65532"])
    expect(valuesAfter(create.argv, "--tmpfs")).toEqual([
      "/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777",
      "/home/sandbox:rw,nosuid,nodev,noexec,size=16777216,mode=700,uid=65532,gid=65532",
    ])
    expect(create.argv.slice(-9)).toEqual([
      image,
      "/usr/local/bin/opencode-preview-supervisor",
      "--listen",
      "0.0.0.0:18080",
      "--target",
      `127.0.0.1:${fixture.port}`,
      "--",
      "node",
      "server.mjs",
    ])
    expect(create.argv).not.toContain("--privileged")
    expect(create.argv).not.toContain("--device")
    expect(create.argv.join("\0").toLowerCase()).not.toContain("docker.sock")
    expect(create.argv.join("\0").toLowerCase()).not.toContain("users\\administrator")
    expect(fixture.engine.one("container", "start").argv).toEqual(["container", "start", fixture.engine.containerID])

    await fixture.service.stop({ identity: fixture.identity, process: owned })

    expect(fixture.engine.all("container", "kill")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
  })

  test.each([
    ["C drive workspace", "workspace"],
    ["C drive capability temp", "temp"],
    ["C drive Docker config", "config"],
  ] as const)("rejects %s before creating Docker resources", async (_name, target) => {
    await using fixture = await setup()
    const input = fixture.startInput()
    const config = target === "config" ? { ...fixture.config, dockerConfig: "C:\\docker-config" } : fixture.config
    const service = DockerProcessOwnership.make({ engine: fixture.engine, config, hostRoot: fixture.hostRoot })
    const changed =
      target === "workspace"
        ? { ...input, plan: Object.freeze({ ...input.plan, locationRoot: "C:\\workspace", cwd: "C:\\workspace" }) }
        : target === "temp"
          ? { ...input, tempRoot: "C:\\temp" }
          : input

    await expect(service.start(changed as Parameters<ProcessOwnership.Service["start"]>[0])).rejects.toThrow()
    expect(fixture.engine.invocations).toEqual([])
  })

  test("rejects a workspace junction before Docker", async () => {
    await using fixture = await setup()
    const outside = path.join(root, `outside-${crypto.randomUUID()}`)
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(fixture.workspace, "linked"), "junction")

    await expect(fixture.service.start(fixture.startInput())).rejects.toThrow()
    expect(fixture.engine.invocations).toEqual([])
    await fs.rm(outside, { recursive: true, force: true })
  })

  test("rejects a multiply-linked regular preview leaf before Docker", async () => {
    await using fixture = await setup()
    const target = path.join(fixture.workspace, "server.mjs")
    const outside = path.join(fixture.caseRoot, "outside-preview.mjs")
    await fs.rm(target)
    await fs.writeFile(outside, "outside-owned")
    await fs.link(outside, target)

    await expect(fixture.service.start(fixture.startInput())).rejects.toThrow()
    expect(fixture.engine.invocations).toEqual([])
  })

  test("rechecks regular preview leaf link count after container creation and never starts", async () => {
    await using fixture = await setup()
    const target = path.join(fixture.workspace, "server.mjs")
    const outside = path.join(fixture.caseRoot, "late-hardlink.mjs")
    fixture.engine.onContainerCreate = async () => {
      await fs.link(target, outside)
    }

    await expect(fixture.service.start(fixture.startInput())).rejects.toThrow()
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
  })

  test("rejects a preview Location which overlaps any shared protected host root", async () => {
    await using fixture = await setup()
    Reflect.set(fixture.config, "protectedRoots", [fixture.workspace])

    await expect(fixture.service.start(fixture.startInput())).rejects.toThrow()
    expect(fixture.engine.invocations).toEqual([])
  })

  test("revalidates the fixed docker.exe identity before every preview engine spawn", async () => {
    await using fixture = await setup()
    const enginePath = fixture.config.enginePath
    fixture.engine.onNetworkCreate = async () => {
      await fs.rename(enginePath, path.join(path.dirname(enginePath), "docker.old.exe"))
      await fs.writeFile(enginePath, "replacement")
    }

    await expect(fixture.service.start(fixture.startInput())).rejects.toThrow()
    expect(fixture.engine.all("network", "create")).toHaveLength(1)
    expect(fixture.engine.all("container", "create")).toEqual([])
  })

  test("revalidates workspace identity after create and never starts a swapped mount", async () => {
    await using fixture = await setup()
    const parked = `${fixture.workspace}-parked`
    const outside = path.join(root, `swap-${crypto.randomUUID()}`)
    await fs.mkdir(outside)
    fixture.engine.onContainerCreate = async () => {
      await fs.rename(fixture.workspace, parked)
      await fs.symlink(outside, fixture.workspace, "junction")
    }

    await expect(fixture.service.start(fixture.startInput())).rejects.toThrow()

    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
    await fs.unlink(fixture.workspace)
    await fs.rm(parked, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  test.each(["missing", "wrong"] as const)(
    "never starts or removes a container with %s ownership labels",
    async (labelFailure) => {
      await using fixture = await setup({ labelFailure })

      await expect(fixture.service.start(fixture.startInput())).rejects.toThrow()

      expect(fixture.engine.all("container", "start")).toEqual([])
      expect(fixture.engine.all("container", "kill")).toEqual([])
      expect(fixture.engine.all("container", "rm")).toEqual([])
    },
  )

  test("does nothing when start is already cancelled", async () => {
    await using fixture = await setup()
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))

    await expect(fixture.service.start({ ...fixture.startInput(), signal: controller.signal })).rejects.toThrow()
    expect(fixture.engine.invocations).toEqual([])
  })

  test("does not create a container when cancellation arrives after network creation", async () => {
    await using fixture = await setup()
    const controller = new AbortController()
    fixture.engine.onNetworkCreate = async () => controller.abort(new Error("cancelled"))

    await expect(fixture.service.start({ ...fixture.startInput(), signal: controller.signal })).rejects.toThrow()

    expect(fixture.engine.all("container", "create")).toEqual([])
    await waitUntil(() => fixture.engine.all("network", "rm").length === 1, 250)
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
  })

  test("does not create after the absolute start deadline elapses", async () => {
    const clock = { now: 1_000 }
    await using fixture = await setup({ now: () => clock.now })
    fixture.engine.onNetworkCreate = async () => {
      clock.now = 1_101
    }

    await expect(fixture.service.start({ ...fixture.startInput(), deadline: 1_100 })).rejects.toThrow()

    expect(fixture.engine.all("container", "create")).toEqual([])
    await waitUntil(() => fixture.engine.all("network", "rm").length === 1, 250)
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
  })

  test("settles at the absolute deadline while stalled ownership authentication cleans up detached", async () => {
    await using fixture = await setup()
    const inspection = deferred<void>()
    fixture.engine.stallFirstNetworkInspect = inspection.promise
    const startedAt = Date.now()
    const start = fixture.service.start({ ...fixture.startInput(), deadline: startedAt + 40 })

    const observed = await Promise.race([
      start.then(
        () => ({ kind: "resolved" as const, elapsed: Date.now() - startedAt }),
        (cause) => ({ kind: "rejected" as const, cause, elapsed: Date.now() - startedAt }),
      ),
      new Promise<{ readonly kind: "still-pending"; readonly elapsed: number }>((resolve) =>
        setTimeout(() => resolve({ kind: "still-pending", elapsed: Date.now() - startedAt }), 250),
      ),
    ])

    inspection.resolve()
    await start.catch(() => undefined)
    await waitUntil(() => fixture.engine.all("network", "rm").length === 1, 250)
    expect(observed.kind).toBe("rejected")
    expect(observed.elapsed).toBeLessThan(200)
    expect(fixture.engine.all("container", "create")).toEqual([])
  })

  test("settles at the absolute caller boundary while non-Docker preflight remains stalled", async () => {
    const preflight = deferred<void>()
    await using fixture = await setup({ beforePreflight: () => preflight.promise })
    const startedAt = Date.now()
    const start = fixture.service.start({ ...fixture.startInput(), deadline: startedAt + 40 })

    const observed = await Promise.race([
      start.then(
        () => ({ kind: "resolved" as const, elapsed: Date.now() - startedAt }),
        (cause) => ({ kind: "rejected" as const, cause, elapsed: Date.now() - startedAt }),
      ),
      new Promise<{ readonly kind: "still-pending"; readonly elapsed: number }>((resolve) =>
        setTimeout(() => resolve({ kind: "still-pending", elapsed: Date.now() - startedAt }), 250),
      ),
    ])

    preflight.resolve()
    await start.catch(() => undefined)
    expect(observed.kind).toBe("rejected")
    expect(observed.elapsed).toBeLessThan(200)
    expect(fixture.engine.all("network", "create")).toEqual([])
  })

  test("authenticates and removes a network whose create promise returns its ID after caller rejection", async () => {
    await using fixture = await setup()
    const creation = deferred<void>()
    fixture.engine.onNetworkCreate = () => creation.promise
    const startedAt = Date.now()
    const start = fixture.service.start({ ...fixture.startInput(), deadline: startedAt + 40 })

    const observed = await Promise.race([
      start.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 250)),
    ])
    creation.resolve()
    await start.catch(() => undefined)
    await waitUntil(() => fixture.engine.all("network", "rm").length === 1, 1_000)

    expect(observed).toBe("rejected")
    expect(fixture.engine.all("container", "create")).toEqual([])
  })

  test("rediscovers an exact deterministic network when create rejects without returning its ID", async () => {
    await using fixture = await setup()
    fixture.engine.onNetworkCreate = async () => {
      throw new Docker.Cancelled("create was cancelled after the network appeared")
    }

    await expect(fixture.service.start(fixture.startInput())).rejects.toThrow()

    await waitUntil(() => fixture.engine.all("network", "inspect").length === 1, 250)
    await waitUntil(() => fixture.engine.all("network", "rm").length === 1, 250)
    expect(fixture.engine.all("network", "inspect")).toHaveLength(1)
    expect(fixture.engine.one("network", "inspect").argv[2]).toMatch(/^ocpn-[a-f0-9]+$/)
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
  })

  test("rediscovers a late network by deterministic name when abort rejection loses its ID", async () => {
    await using fixture = await setup()
    fixture.engine.onNetworkCreate = rejectAfterAbort
    const startedAt = Date.now()

    await expect(fixture.service.start({ ...fixture.startInput(), deadline: startedAt + 40 })).rejects.toBeInstanceOf(
      Docker.Timeout,
    )
    await waitUntil(() => fixture.engine.all("network", "rm").length === 1, 1_000)

    expect(fixture.engine.all("network", "inspect").some((call) => call.argv[2]?.startsWith("ocpn-"))).toBe(true)
    expect(fixture.engine.all("container", "create")).toEqual([])
  })

  test("keeps bounded exact-name discovery alive when a rejected network create becomes visible later", async () => {
    await using fixture = await setup({ engineTimeoutMs: 120, cleanupTimeoutMs: 20 })
    const invocationRejected = deferred<void>()
    fixture.engine.networkVisible = false
    fixture.engine.onNetworkCreate = (signal) => rejectAfterAbort(signal, () => invocationRejected.resolve())
    const startedAt = Date.now()

    await expect(fixture.service.start({ ...fixture.startInput(), deadline: startedAt + 40 })).rejects.toBeInstanceOf(
      Docker.Timeout,
    )
    await invocationRejected.promise
    await waitUntil(() => fixture.engine.all("network", "inspect").length >= 1, 500)
    expect(fixture.engine.all("network", "rm")).toEqual([])
    await Bun.sleep(35)

    fixture.engine.networkVisible = true
    await waitUntil(() => fixture.engine.all("network", "rm").length === 1, 1_000)

    expect(fixture.engine.all("network", "inspect").length).toBeGreaterThanOrEqual(2)
    expect(fixture.engine.all("container", "create")).toEqual([])
  })

  test("keeps exact-name discovery alive after an engine-side create rejection precedes network visibility", async () => {
    await using fixture = await setup({ engineTimeoutMs: 120, cleanupTimeoutMs: 20 })
    fixture.engine.networkVisible = false
    fixture.engine.onNetworkCreate = async () => {
      throw new Docker.Cancelled("engine rejected before the network became inspectable")
    }

    await expect(fixture.service.start(fixture.startInput())).rejects.toThrow()
    await waitUntil(() => fixture.engine.all("network", "inspect").length >= 1, 500)
    expect(fixture.engine.all("network", "rm")).toEqual([])
    await Bun.sleep(35)

    fixture.engine.networkVisible = true
    await waitUntil(() => fixture.engine.all("network", "rm").length === 1, 1_000)

    expect(fixture.engine.all("network", "inspect").length).toBeGreaterThanOrEqual(2)
    expect(fixture.engine.all("container", "create")).toEqual([])
  })

  test("authenticates and removes a container whose create promise returns its ID after caller rejection", async () => {
    await using fixture = await setup()
    const creation = deferred<void>()
    fixture.engine.onContainerCreate = () => creation.promise
    const startedAt = Date.now()
    const start = fixture.service.start({ ...fixture.startInput(), deadline: startedAt + 40 })

    const observed = await Promise.race([
      start.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 250)),
    ])
    creation.resolve()
    await start.catch(() => undefined)
    await waitUntil(() => fixture.engine.all("container", "rm").length === 1, 1_000)
    await waitUntil(() => fixture.engine.all("network", "rm").length === 1, 1_000)

    expect(observed).toBe("rejected")
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
  })

  test("rediscovers a late container by deterministic name when abort rejection loses its ID", async () => {
    await using fixture = await setup()
    fixture.engine.onContainerCreate = rejectAfterAbort
    const startedAt = Date.now()

    await expect(fixture.service.start({ ...fixture.startInput(), deadline: startedAt + 40 })).rejects.toBeInstanceOf(
      Docker.Timeout,
    )
    await waitUntil(() => fixture.engine.all("container", "rm").length === 1, 1_000)
    await waitUntil(() => fixture.engine.all("network", "rm").length === 1, 1_000)

    expect(fixture.engine.all("container", "inspect").some((call) => call.argv[2]?.startsWith("ocp-"))).toBe(true)
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
  })

  test("does not remove the network before a rejected container create becomes visible and authenticated", async () => {
    await using fixture = await setup({ engineTimeoutMs: 120, cleanupTimeoutMs: 20 })
    const invocationRejected = deferred<void>()
    fixture.engine.containerVisible = false
    fixture.engine.onContainerCreate = (signal) => rejectAfterAbort(signal, () => invocationRejected.resolve())
    const startedAt = Date.now()

    await expect(fixture.service.start({ ...fixture.startInput(), deadline: startedAt + 40 })).rejects.toBeInstanceOf(
      Docker.Timeout,
    )
    await invocationRejected.promise
    await waitUntil(() => fixture.engine.all("container", "inspect").length >= 1, 500)
    expect(fixture.engine.all("network", "rm")).toEqual([])
    await Bun.sleep(35)

    fixture.engine.containerVisible = true
    await waitUntil(
      () => fixture.engine.all("container", "rm").length === 1 && fixture.engine.all("network", "rm").length === 1,
      1_000,
    )

    expect(fixture.engine.all("container", "inspect").length).toBeGreaterThanOrEqual(2)
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
  })

  test("keeps the network until a container delayed after an engine-side create rejection is authenticated", async () => {
    await using fixture = await setup({ engineTimeoutMs: 120, cleanupTimeoutMs: 20 })
    fixture.engine.containerVisible = false
    fixture.engine.onContainerCreate = async () => {
      throw new Docker.Cancelled("engine rejected before the container became inspectable")
    }

    await expect(fixture.service.start(fixture.startInput())).rejects.toThrow()
    await waitUntil(() => fixture.engine.all("container", "inspect").length >= 1, 500)
    expect(fixture.engine.all("network", "rm")).toEqual([])
    await Bun.sleep(35)

    fixture.engine.containerVisible = true
    await waitUntil(() => fixture.engine.all("container", "rm").length === 1, 1_000)

    expect(fixture.engine.all("container", "inspect").length).toBeGreaterThanOrEqual(2)
    expect(fixture.engine.all("container", "start")).toEqual([])
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
  })

  test("bounds detached discovery when create never settles and never exposes an authentic network", async () => {
    await using fixture = await setup({ engineTimeoutMs: 20, cleanupTimeoutMs: 20 })
    fixture.engine.networkVisible = false
    fixture.engine.onNetworkCreate = () => new Promise(() => undefined)
    const startedAt = Date.now()

    await expect(fixture.service.start({ ...fixture.startInput(), deadline: startedAt + 30 })).rejects.toBeInstanceOf(
      Docker.Timeout,
    )
    const callerElapsed = Date.now() - startedAt
    await waitUntil(() => fixture.engine.all("network", "inspect").length >= 1, 200)
    await Bun.sleep(120)
    const inspectionsAfterBudget = fixture.engine.all("network", "inspect").length
    await Bun.sleep(80)

    expect(callerElapsed).toBeLessThan(150)
    expect(inspectionsAfterBudget).toBeGreaterThan(0)
    expect(fixture.engine.all("network", "inspect")).toHaveLength(inspectionsAfterBudget)
    expect(fixture.engine.all("network", "rm")).toEqual([])
  })

  test("bounds every start ownership inspection by the same absolute deadline", async () => {
    const clock = { now: 1_000 }
    await using fixture = await setup({ now: () => clock.now })
    fixture.engine.onNetworkCreate = async () => {
      clock.now = 1_090
    }

    const owned = await fixture.service.start({ ...fixture.startInput(), deadline: 1_100 })

    const inspectionTimeouts = fixture.engine.invocations
      .filter((invocation) => invocation.argv[1] === "inspect")
      .map((invocation) => invocation.timeoutMs)
    expect(inspectionTimeouts.slice(0, 3)).toEqual([10, 10, 10])
    await fixture.service.stop({ identity: fixture.identity, process: owned })
  })

  test("rejects a label-owned internal network whose Docker driver is not bridge", async () => {
    await using fixture = await setup({ networkDriver: "overlay" })
    let process: ProcessOwnership.OwnedProcess | undefined
    let cause: unknown

    try {
      process = await fixture.service.start(fixture.startInput())
    } catch (error) {
      cause = error
    }
    if (process !== undefined) await fixture.service.stop({ identity: fixture.identity, process })

    expect(cause).toMatchObject({
      _tag: "Docker.Unavailable",
      message: "Preview Docker network ownership verification failed",
    })
    expect(fixture.engine.all("container", "create")).toEqual([])
  })

  test("bounds stdout and stderr independently even when a fake engine violates its advertised output bound", async () => {
    await using fixture = await setup({ oversizedLogs: true })

    const owned = await fixture.service.start(fixture.startInput())

    expect(new TextEncoder().encode(await readText(owned.stdout)).byteLength).toBe(fixture.config.limits.maxOutputBytes)
    expect(new TextEncoder().encode(await readText(owned.stderr)).byteLength).toBe(fixture.config.limits.maxOutputBytes)
    await fixture.service.stop({ identity: fixture.identity, process: owned })
  })

  test.each(["kill", "rm", "network-rm"] as const)(
    "attempts container and network cleanup after %s failure",
    async (cleanupFailure) => {
      await using fixture = await setup({ cleanupFailure, holdRunning: cleanupFailure === "kill" })
      const owned = await fixture.service.start(fixture.startInput())

      await expect(fixture.service.stop({ identity: fixture.identity, process: owned })).rejects.toThrow()

      expect(fixture.engine.all("container", "kill")).toHaveLength(cleanupFailure === "kill" ? 1 : 0)
      expect(fixture.engine.all("container", "rm")).toHaveLength(1)
      expect(fixture.engine.all("network", "rm")).toHaveLength(1)
    },
  )

  test("skips kill for an already-exited owned container and still removes its resources", async () => {
    await using fixture = await setup({ exitedKillFailure: true })
    const owned = await fixture.service.start(fixture.startInput())

    await expect(fixture.service.stop({ identity: fixture.identity, process: owned })).resolves.toBeUndefined()

    expect(fixture.engine.all("container", "kill")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
  })

  test("accepts a not-running kill result when exact reinspection proves the container exited after the first check", async () => {
    await using fixture = await setup({ exitBeforeKill: true, holdRunning: true })
    const owned = await fixture.service.start(fixture.startInput())

    await expect(fixture.service.stop({ identity: fixture.identity, process: owned })).resolves.toBeUndefined()

    expect(fixture.engine.all("container", "kill")).toHaveLength(1)
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
  })

  test("recovery filters by every exact label and removes only exact container and network identities", async () => {
    await using fixture = await setup()
    const owned = await fixture.service.start(fixture.startInput())
    await owned.exited
    fixture.engine.invocations.splice(0)
    fixture.engine.recovery = true

    await fixture.service.recover(fixture.identity)

    expect(valuesAfter(fixture.engine.one("container", "ls").argv, "--filter")).toHaveLength(5)
    expect(valuesAfter(fixture.engine.one("network", "ls").argv, "--filter")).toHaveLength(5)
    expect(fixture.engine.all("container", "kill")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toHaveLength(1)
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
  })

  test("recovery never acts when exact labels do not survive inspection", async () => {
    await using fixture = await setup()
    const owned = await fixture.service.start(fixture.startInput())
    await owned.exited
    fixture.engine.invocations.splice(0)
    fixture.engine.recovery = true
    fixture.engine.labelFailure = "wrong"

    await expect(fixture.service.recover(fixture.identity)).rejects.toThrow()

    expect(fixture.engine.all("container", "kill")).toEqual([])
    expect(fixture.engine.all("container", "rm")).toEqual([])
    expect(fixture.engine.all("network", "rm")).toEqual([])
  })
})

class FakeEngine implements Docker.Engine {
  readonly containerID = "c".repeat(64)
  readonly networkID = "b".repeat(64)
  readonly invocations: Docker.Invocation[] = []
  networkName = ""
  containerName = ""
  networkLabels: Record<string, string> = {}
  containerLabels: Record<string, string> = {}
  networkVisible = true
  containerVisible = true
  containerRunning = false
  recovery = false
  labelFailure?: "missing" | "wrong"
  onNetworkCreate?: (signal: AbortSignal | undefined) => Promise<void>
  onContainerCreate?: (signal: AbortSignal | undefined) => Promise<void>
  stallFirstNetworkInspect?: Promise<void>
  private networkInspections = 0

  constructor(
    private readonly options: {
      readonly labelFailure?: "missing" | "wrong"
      readonly oversizedLogs?: boolean
      readonly cleanupFailure?: "kill" | "rm" | "network-rm"
      readonly networkDriver?: string
      readonly exitedKillFailure?: boolean
      readonly exitBeforeKill?: boolean
      readonly holdRunning?: boolean
    },
  ) {
    this.labelFailure = options.labelFailure
  }

  execute = async (input: Docker.Invocation): Promise<Docker.Result> => {
    this.invocations.push(input)
    const [scope, action] = input.argv
    if (scope === "network" && action === "create") {
      this.networkName = input.argv.at(-1) ?? ""
      this.networkLabels = labels(input.argv)
      await this.onNetworkCreate?.(input.signal)
      return result({ stdout: `${this.networkID}\n` })
    }
    if (scope === "network" && action === "inspect") {
      this.networkInspections++
      if (this.networkInspections === 1) await this.stallFirstNetworkInspect
      if (!this.networkVisible) return result({ exit: 1, stderr: "network is not visible" })
      return result({
        stdout: JSON.stringify([
          {
            Id: this.networkID,
            Name: this.networkName,
            Internal: true,
            Driver: this.options.networkDriver ?? "bridge",
            Labels: inspectedLabels(this.networkLabels, this.labelFailure),
          },
        ]),
      })
    }
    if (scope === "network" && action === "ls") {
      return result({ stdout: this.recovery ? `${this.networkID}\n` : "" })
    }
    if (scope === "container" && action === "create") {
      this.containerName = valueAfter(input.argv, "--name")
      this.containerLabels = labels(input.argv)
      await this.onContainerCreate?.(input.signal)
      return result({ stdout: `${this.containerID}\n` })
    }
    if (scope === "container" && action === "start") {
      this.containerRunning = true
      return result()
    }
    if (scope === "container" && action === "inspect") {
      if (!this.containerVisible) return result({ exit: 1, stderr: "container is not visible" })
      return result({
        stdout: JSON.stringify([
          {
            Id: this.containerID,
            Name: `/${this.containerName}`,
            Config: { Labels: inspectedLabels(this.containerLabels, this.labelFailure) },
            State: { Running: this.containerRunning, ExitCode: this.containerRunning ? 0 : 23 },
          },
        ]),
      })
    }
    if (scope === "container" && action === "ls") {
      return result({ stdout: this.recovery ? `${this.containerID}\n` : "" })
    }
    if (scope === "container" && action === "wait") {
      if (this.options.holdRunning) return new Promise(() => undefined)
      this.containerRunning = false
      return result({ stdout: "23\n" })
    }
    if (scope === "container" && action === "logs") {
      const value = this.options.oversizedLogs ? "x".repeat(1_024) : "preview stdout"
      return result({ stdout: value, stderr: this.options.oversizedLogs ? value : "preview stderr", truncated: true })
    }
    if (scope === "container" && action === "kill" && this.options.cleanupFailure === "kill") {
      throw new Error("kill failed")
    }
    if (scope === "container" && action === "kill" && this.options.exitedKillFailure) {
      return result({ exit: 1, stderr: "container is not running" })
    }
    if (scope === "container" && action === "kill" && this.options.exitBeforeKill) {
      this.containerRunning = false
      return result({ exit: 1, stderr: "container is not running" })
    }
    if (scope === "container" && action === "kill") this.containerRunning = false
    if (scope === "container" && action === "rm" && this.options.cleanupFailure === "rm") {
      throw new Error("rm failed")
    }
    if (scope === "network" && action === "rm" && this.options.cleanupFailure === "network-rm") {
      throw new Error("network rm failed")
    }
    return result()
  }

  one(...prefix: string[]) {
    const found = this.all(...prefix)
    expect(found).toHaveLength(1)
    return found[0]
  }

  all(...prefix: string[]) {
    return this.invocations.filter((input) => prefix.every((value, index) => input.argv[index] === value))
  }
}

async function setup(
  options: {
    readonly labelFailure?: "missing" | "wrong"
    readonly oversizedLogs?: boolean
    readonly cleanupFailure?: "kill" | "rm" | "network-rm"
    readonly networkDriver?: string
    readonly exitedKillFailure?: boolean
    readonly exitBeforeKill?: boolean
    readonly holdRunning?: boolean
    readonly engineTimeoutMs?: number
    readonly cleanupTimeoutMs?: number
    readonly beforePreflight?: (signal: AbortSignal) => Promise<void>
    readonly now?: () => number
  } = {},
) {
  await fs.mkdir(root, { recursive: true })
  const caseRoot = await fs.realpath(await fs.mkdtemp(path.join(root, "case-")))
  const hostRoot = path.join(caseRoot, "host")
  const workspace = path.join(caseRoot, "workspace")
  const dockerConfig = path.join(caseRoot, "docker-config")
  const dockerTemp = path.join(caseRoot, "docker-temp")
  const enginePath = path.join(caseRoot, "engine", "docker.exe")
  const identity: ProcessOwnership.Identity = {
    hostID: WorkflowVisualHost.HostID.make("d".repeat(64)),
    nonce: "e".repeat(64),
  }
  const capabilityTemp = path.join(hostRoot, identity.hostID, ".tmp")
  await Promise.all(
    [hostRoot, workspace, dockerConfig, dockerTemp, capabilityTemp, path.dirname(enginePath)].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  )
  await fs.writeFile(enginePath, "fake docker test executable")
  await fs.writeFile(path.join(workspace, "server.mjs"), "setInterval(() => undefined, 60_000)\n")
  const port = 4317
  const plan = PreviewPlan.freeze({
    authority: "admission",
    location: Location.Ref.make({ directory: AbsolutePath.make(workspace) }),
    preview: { kind: "script", argv: ["node.exe", "server.mjs"], env: { APP_MODE: "preview" } },
    envAllowlist: ["APP_MODE"],
    allowedOrigins: [`http://127.0.0.1:${port}`],
  })
  const config: DockerConfig.Config = {
    enginePath,
    image,
    dockerConfig,
    temp: dockerTemp,
    limits: {
      timeoutMs: 10_000,
      engineTimeoutMs: options.engineTimeoutMs ?? 5_000,
      cleanupTimeoutMs: options.cleanupTimeoutMs ?? 2_000,
      maxOutputBytes: 128,
      memoryBytes: 1_073_741_824,
      cpus: 1.5,
      pids: 64,
    },
  }
  const engine = new FakeEngine(options)
  const service = DockerProcessOwnership.make({
    engine,
    config,
    hostRoot,
    now: options.now,
    beforePreflight: options.beforePreflight,
  })
  const dockerEnv = { DOCKER_CONFIG: dockerConfig, TEMP: dockerTemp, TMP: dockerTemp }
  return {
    caseRoot,
    hostRoot,
    workspace,
    capabilityTemp,
    dockerConfig,
    dockerTemp,
    identity,
    port,
    plan,
    config,
    engine,
    service,
    dockerEnv,
    startInput: () => ({
      identity,
      plan,
      tempRoot: capabilityTemp,
      signal: new AbortController().signal,
      deadline: (options.now?.() ?? Date.now()) + 1_000,
    }),
    async [Symbol.asyncDispose]() {
      await fs.rm(caseRoot, { recursive: true, force: true })
    },
  }
}

function labels(argv: readonly string[]) {
  return Object.fromEntries(valuesAfter(argv, "--label").map((value) => value.split("=", 2)))
}

function inspectedLabels(values: Record<string, string>, failure: "missing" | "wrong" | undefined) {
  if (failure === "missing") return Object.fromEntries(Object.entries(values).slice(1))
  if (failure === "wrong") return { ...values, [Object.keys(values)[0]]: "f".repeat(64) }
  return values
}

function result(overrides: Partial<Docker.Result> = {}): Docker.Result {
  return { exit: 0, stdout: "", stderr: "", truncated: false, ...overrides }
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

async function readText(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text()
}

function deferred<A>() {
  let resolve!: (value: A) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitUntil(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await Bun.sleep(5)
  if (!check()) throw new Error("condition was not observed before timeout")
}

function rejectAfterAbort(signal: AbortSignal | undefined, onReject?: () => void) {
  return new Promise<void>((_resolve, reject) => {
    if (signal === undefined) {
      reject(new Error("expected an invocation abort signal"))
      return
    }
    const rejectLater = () =>
      setTimeout(() => {
        onReject?.()
        reject(new Docker.Cancelled("aborted without stdout"))
      }, 10)
    signal.addEventListener("abort", rejectLater, { once: true })
    if (signal.aborted) rejectLater()
  })
}
