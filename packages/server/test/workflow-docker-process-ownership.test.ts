import { afterAll, describe, expect, test } from "bun:test"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import fs from "node:fs/promises"
import path from "node:path"
import { Docker } from "../src/workflow/docker"
import { DockerConfig } from "../src/workflow/docker-config"
import { DockerProcessOwnership } from "../src/workflow/docker-process-ownership"
import { ProcessOwnership } from "../src/workflow/process-ownership"

const root = "D:\\OpenCode-Local\\tmp\\workflow-preview-docker-tests"
const image = `opencode/workflow-sandbox@sha256:${"a".repeat(64)}`
const enginePath = "D:\\Applications\\Docker\\resources\\bin\\docker.exe"

afterAll(async () => {
  if (path.resolve(root) !== root) throw new TypeError("Unexpected preview Docker test root")
  await fs.rm(root, { recursive: true, force: true })
})

describe("DockerProcessOwnership", () => {
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
    expect(create.executable).toBe(enginePath)
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

    expect(fixture.engine.all("container", "kill")).toHaveLength(1)
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
    expect(fixture.engine.all("network", "rm")).toHaveLength(1)
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
      await using fixture = await setup({ cleanupFailure })
      const owned = await fixture.service.start(fixture.startInput())

      await expect(fixture.service.stop({ identity: fixture.identity, process: owned })).rejects.toThrow()

      expect(fixture.engine.all("container", "kill")).toHaveLength(1)
      expect(fixture.engine.all("container", "rm")).toHaveLength(1)
      expect(fixture.engine.all("network", "rm")).toHaveLength(1)
    },
  )

  test("recovery filters by every exact label and removes only exact container and network identities", async () => {
    await using fixture = await setup()
    const owned = await fixture.service.start(fixture.startInput())
    await owned.exited
    fixture.engine.invocations.splice(0)
    fixture.engine.recovery = true

    await fixture.service.recover(fixture.identity)

    expect(valuesAfter(fixture.engine.one("container", "ls").argv, "--filter")).toHaveLength(5)
    expect(valuesAfter(fixture.engine.one("network", "ls").argv, "--filter")).toHaveLength(5)
    expect(fixture.engine.all("container", "kill")).toHaveLength(1)
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
  recovery = false
  labelFailure?: "missing" | "wrong"
  onNetworkCreate?: () => Promise<void>
  onContainerCreate?: () => Promise<void>

  constructor(
    private readonly options: {
      readonly labelFailure?: "missing" | "wrong"
      readonly oversizedLogs?: boolean
      readonly cleanupFailure?: "kill" | "rm" | "network-rm"
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
      await this.onNetworkCreate?.()
      return result({ stdout: `${this.networkID}\n` })
    }
    if (scope === "network" && action === "inspect") {
      return result({
        stdout: JSON.stringify([
          {
            Id: this.networkID,
            Name: this.networkName,
            Internal: true,
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
      await this.onContainerCreate?.()
      return result({ stdout: `${this.containerID}\n` })
    }
    if (scope === "container" && action === "inspect") {
      return result({
        stdout: JSON.stringify([
          {
            Id: this.containerID,
            Name: `/${this.containerName}`,
            Config: { Labels: inspectedLabels(this.containerLabels, this.labelFailure) },
            State: { Running: false, ExitCode: 23 },
          },
        ]),
      })
    }
    if (scope === "container" && action === "ls") {
      return result({ stdout: this.recovery ? `${this.containerID}\n` : "" })
    }
    if (scope === "container" && action === "wait") return result({ stdout: "23\n" })
    if (scope === "container" && action === "logs") {
      const value = this.options.oversizedLogs ? "x".repeat(1_024) : "preview stdout"
      return result({ stdout: value, stderr: this.options.oversizedLogs ? value : "preview stderr", truncated: true })
    }
    if (scope === "container" && action === "kill" && this.options.cleanupFailure === "kill") {
      throw new Error("kill failed")
    }
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
    readonly now?: () => number
  } = {},
) {
  await fs.mkdir(root, { recursive: true })
  const caseRoot = await fs.realpath(await fs.mkdtemp(path.join(root, "case-")))
  const hostRoot = path.join(caseRoot, "host")
  const workspace = path.join(caseRoot, "workspace")
  const dockerConfig = path.join(caseRoot, "docker-config")
  const dockerTemp = path.join(caseRoot, "docker-temp")
  const identity: ProcessOwnership.Identity = {
    hostID: WorkflowVisualHost.HostID.make("d".repeat(64)),
    nonce: "e".repeat(64),
  }
  const capabilityTemp = path.join(hostRoot, identity.hostID, ".tmp")
  await Promise.all(
    [hostRoot, workspace, dockerConfig, dockerTemp, capabilityTemp].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  )
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
      engineTimeoutMs: 5_000,
      cleanupTimeoutMs: 2_000,
      maxOutputBytes: 128,
      memoryBytes: 1_073_741_824,
      cpus: 1.5,
      pids: 64,
    },
  }
  const engine = new FakeEngine(options)
  const service = DockerProcessOwnership.make({ engine, config, hostRoot, now: options.now })
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
