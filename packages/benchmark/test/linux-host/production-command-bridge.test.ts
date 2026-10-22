import { expect, test, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { makeProductionCommandEngine, startProductionCommandBridge } from "../../src/sandbox/production-command-bridge"
import { sessionFixture } from "./fixture"
import type { DockerInvocation } from "../../src/sandbox/contracts"

const image = "example.invalid/task24@sha256:" + "a".repeat(64)
const name = "ocw-" + "c".repeat(48)
const id = "b".repeat(64)
const labels = Object.fromEntries(
  ["workflow", "stage", "call", "role", "policy", "session", "agent", "lease"].map((k) => [
    "io.opencode.workflow." + k,
    "d".repeat(64),
  ]),
)

// These are the existing production command adapter's flags, independently
// spelled out here; a drift to host networking/writable root must fail.
function create(workspace: string) {
  return [
    "container",
    "create",
    "--name",
    name,
    ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
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
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777",
    "--tmpfs",
    "/home/sandbox:rw,nosuid,nodev,noexec,size=16777216,mode=700,uid=65532,gid=65532",
    "--env",
    "HOME=/home/sandbox",
    "--env",
    "LANG=C.UTF-8",
    "--mount",
    `type=bind,src=${workspace},dst=/workspace,readonly`,
    "--workdir",
    "/workspace",
    image,
    "/bin/bash",
    "-se",
  ]
}

async function fixture(options: { createExit?: number; uncertainStart?: boolean } = {}) {
  const f = await sessionFixture(true)
  const workspace = path.join(f.request.roots.work, "candidate")
  await fs.mkdir(workspace)
  const invocations: DockerInvocation[] = []
  const events: { kind: string }[] = []
  const state = { running: false, removed: false, network: "none", foreign: false }
  const inspection = () => ({
    Id: id,
    Name: `/${name}`,
    Config: {
      Labels: state.foreign ? { ...labels, "io.opencode.workflow.lease": "e".repeat(64) } : labels,
      User: "65532:65532",
      Image: image,
    },
    HostConfig: {
      NetworkMode: state.network,
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: null,
      SecurityOpt: ["no-new-privileges=true"],
      PidsLimit: 64,
      Memory: 1073741824,
      NanoCpus: 1500000000,
      Devices: [],
      PortBindings: {},
      Tmpfs: {
        "/tmp": "rw,nosuid,nodev,noexec,size=67108864,mode=1777",
        "/home/sandbox": "rw,nosuid,nodev,noexec,size=16777216,mode=700,uid=65532,gid=65532",
      },
    },
    Mounts: [
      {
        Type: "bind",
        Source: "/mnt/d/" + workspace.slice(3).replaceAll("\\", "/"),
        Destination: "/workspace",
        RW: false,
      },
    ],
    State: { Running: state.running, ExitCode: 0 },
  })
  const runner = {
    async execute(call: DockerInvocation) {
      invocations.push(call)
      const args = call.argv.slice(2)
      const output =
        args[1] === "create"
          ? id + "\n"
          : args[1] === "inspect"
            ? JSON.stringify([inspection()])
            : args[1] === "start"
              ? "production check✓\n"
              : ""
      if (args[1] === "rm") state.removed = true
      return {
        started: true,
        exitCode: args[1] === "create" ? (options.createExit ?? 0) : 0,
        cleanupUncertain: args[1] === "start" && options.uncertainStart,
        stdout: Buffer.from(output),
        stderr: new Uint8Array(),
        truncated: false,
      }
    },
  }
  const engine = await makeProductionCommandEngine({
    session: f.session,
    runner,
    guard: async () => {},
    record: async (event) => {
      events.push(event)
    },
    commands: [
      {
        argv: ["/bin/bash", "-se"],
        stdin: Buffer.from("node --test\n"),
        workdir: "/workspace",
        workspace: { source: workspace, readonly: true },
        image,
      },
    ],
  })
  const invoke = (argv: readonly string[], stdin?: string) =>
    engine.execute({
      argv,
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: argv[1] === "rm" || argv[1] === "kill" ? 5000 : 15000,
      maxOutputBytes: 1048576,
      signal: new AbortController().signal,
    })
  return { f, workspace, engine, invoke, invocations, state, events }
}

test("a dispatched nonzero create remains uncertain and cannot retire or be reused", async () => {
  const f = await fixture({ createExit: 1 })
  const { startProductionCommandEndpoint } = await import("../../src/sandbox/production-command-http")
  const endpoint = await startProductionCommandEndpoint(f.engine)
  try {
    expect((await f.invoke(create(f.workspace))).exit).toBe(1)
    expect(f.engine.outstanding()).toEqual({ containers: [], uncertainNames: [name] })
    expect(f.events.map((event) => event.kind)).toEqual(["intent", "uncertain"])
    await expect(f.invoke(create(f.workspace))).rejects.toThrow("NAME")
    expect(f.invocations.filter((call) => call.argv.includes("create"))).toHaveLength(1)
    await expect(f.engine.retire()).rejects.toThrow("CLEANUP_UNCERTAIN")
    await expect(endpoint.close()).rejects.toThrow("CLEANUP_UNCERTAIN")
  } finally {
    await endpoint.close().catch(() => {})
    await f.f.dispose()
  }
})

test("a dispatched uncertain start is consumed once but exact owned cleanup remains available", async () => {
  const f = await fixture({ uncertainStart: true })
  try {
    await f.invoke(create(f.workspace))
    await expect(f.invoke(["container", "start", "--attach", "--interactive", id], "node --test\n")).rejects.toThrow(
      "UNSETTLED",
    )
    await expect(f.invoke(["container", "start", "--attach", "--interactive", id], "node --test\n")).rejects.toThrow(
      "START",
    )
    expect(f.invocations.filter((call) => call.argv.includes("start"))).toHaveLength(1)
    await f.invoke(["container", "rm", "--force", id])
    expect(f.engine.outstanding().containers).toEqual([])
  } finally {
    await f.f.dispose()
  }
})

async function sealedCommand() {
  const { WorkflowWorkspaceMaterialization } = await import("../../../core/src/workflow/workspace-materialization")
  const { sha256Text, sha256Bytes } = await import("../../src/hash")
  const text = "owned"
  const archive = await WorkflowWorkspaceMaterialization.seal(
    ["first.txt", "second.txt"].map((path) => ({ path, type: "file" as const, size: 5, sha256: sha256Text(text) })),
    async () => Buffer.from(text),
  )
  return {
    image,
    argv: ["node"],
    workdir: "/workspace",
    sealedArchive: archive,
    archiveSha256: sha256Bytes(WorkflowWorkspaceMaterialization.tarBytes(archive)),
  }
}

test("invalid sibling plans do not leave or asynchronously write sealed stages", async () => {
  const f = await sessionFixture(true)
  try {
    await expect(
      makeProductionCommandEngine({
        session: f.session,
        runner: f.runner,
        guard: async () => {},
        commands: [await sealedCommand(), { image, argv: [], workdir: "/" }],
      }),
    ).rejects.toThrow("PLAN")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await fs.readdir(f.request.roots.work)).toEqual([])
  } finally {
    await f.dispose()
  }
})

test("mid-stage write failure cleans completed owned files with no late sibling writes", async () => {
  const f = await sessionFixture(true)
  const original = fs.writeFile
  const write = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (String(args[0]).includes("production-sealed-") && String(args[0]).endsWith("second.txt"))
      throw Error("own write failure")
    return original(...args)
  })
  try {
    await expect(
      makeProductionCommandEngine({
        session: f.session,
        runner: f.runner,
        guard: async () => {},
        commands: [await sealedCommand(), await sealedCommand()],
      }),
    ).rejects.toThrow("own write failure")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await fs.readdir(f.request.roots.work)).toEqual([])
  } finally {
    write.mockRestore()
    await f.dispose()
  }
})

test("partial failed writes report exact owned stage residuals instead of deleting unknown bytes", async () => {
  const f = await sessionFixture(true)
  const original = fs.writeFile
  const write = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (String(args[0]).includes("production-sealed-") && String(args[0]).endsWith("second.txt")) {
      await original(args[0], "partial", { flag: "wx" })
      throw Error("own partial write")
    }
    return original(...args)
  })
  try {
    const cause = await makeProductionCommandEngine({
      session: f.session,
      runner: f.runner,
      guard: async () => {},
      commands: [await sealedCommand()],
    }).catch((cause: unknown) => cause)
    expect(cause).toMatchObject({ message: "TASK24_PRODUCTION_INITIALIZATION_RESIDUAL" })
    const residuals = (cause as { residualArtifacts: { path: string; identity: string }[] }).residualArtifacts
    expect(residuals).toHaveLength(1)
    expect(path.dirname(residuals[0]!.path)).toBe(f.request.roots.work)
    expect(await fs.readFile(path.join(residuals[0]!.path, "second.txt"), "utf8")).toBe("partial")
    expect(await fs.readdir(f.request.roots.work)).toEqual([path.basename(residuals[0]!.path)])
  } finally {
    write.mockRestore()
    await f.dispose()
  }
})

test("a fresh stage whose identity cannot be read is reported, never silently forgotten", async () => {
  const f = await sessionFixture(true)
  const command = await sealedCommand()
  const original = fs.stat
  const stat = spyOn(fs, "stat").mockImplementation(async (...args) => {
    if (path.basename(String(args[0])).startsWith("production-sealed-")) throw Error("own metadata failure")
    return original(...args)
  })
  try {
    const cause = await makeProductionCommandEngine({
      session: f.session,
      runner: f.runner,
      guard: async () => {},
      commands: [command],
    }).catch((cause: unknown) => cause)
    expect(cause).toMatchObject({ message: "TASK24_PRODUCTION_INITIALIZATION_RESIDUAL" })
    const residual = (cause as { residualArtifacts: { path: string; identity: string }[] }).residualArtifacts
    expect(residual).toHaveLength(1)
    expect(path.dirname(residual[0]!.path)).toBe(f.request.roots.work)
    expect(residual[0]!.identity).toBe("unverified")
    expect(await fs.readdir(f.request.roots.work)).toEqual([path.basename(residual[0]!.path)])
  } finally {
    stat.mockRestore()
    await f.dispose()
  }
})

test("endpoint initialization failure retires its completed sealed stages", async () => {
  const f = await sessionFixture(true)
  const { startProductionCommandEndpoint } = await import("../../src/sandbox/production-command-http")
  const engine = await makeProductionCommandEngine({
    session: f.session,
    runner: f.runner,
    guard: async () => {},
    commands: [await sealedCommand()],
  })
  const serve = spyOn(Bun, "serve").mockImplementation(() => {
    throw Error("own endpoint failure")
  })
  try {
    await expect(startProductionCommandEndpoint(engine)).rejects.toThrow("own endpoint failure")
    expect(await fs.readdir(f.request.roots.work)).toEqual([])
  } finally {
    serve.mockRestore()
    await engine.retire()
    await f.dispose()
  }
})

test("unsafe endpoint rollback propagates exact residual ownership to its caller", async () => {
  const f = await sessionFixture(true)
  const { startProductionCommandEndpoint } = await import("../../src/sandbox/production-command-http")
  const engine = await makeProductionCommandEngine({
    session: f.session,
    runner: f.runner,
    guard: async () => {},
    commands: [await sealedCommand()],
  })
  const source = path.join(f.request.roots.work, (await fs.readdir(f.request.roots.work))[0]!)
  const unexpected = path.join(source, "unexpected.txt")
  await fs.writeFile(unexpected, "owned fault injection", { flag: "wx" })
  const serve = spyOn(Bun, "serve").mockImplementation(() => {
    throw Error("own endpoint failure")
  })
  try {
    const cause = await startProductionCommandEndpoint(engine).catch((cause: unknown) => cause)
    expect(cause).toMatchObject({ message: "TASK24_PRODUCTION_ENDPOINT_RESIDUAL" })
    const residuals = (cause as { residualArtifacts: { path: string; identity: string }[] }).residualArtifacts
    expect(residuals).toHaveLength(1)
    expect(residuals[0]!.path).toBe(source)
    expect(residuals[0]!.identity).not.toBe("unverified")
    expect(await fs.readFile(unexpected, "utf8")).toBe("owned fault injection")
  } finally {
    serve.mockRestore()
    await fs.unlink(unexpected)
    await engine.retire()
    await f.dispose()
  }
})

test("dedicated admission refuses replacement of a non-workspace root before native transport", async () => {
  const f = await sessionFixture(true)
  const { makeProductionCommandDockerRunner } = await import("../../src/sandbox/docker")
  try {
    const runner = await makeProductionCommandDockerRunner({ session: f.session, guard: async () => {} })
    await fs.rename(f.request.roots.config, f.request.roots.config + "-old")
    await fs.mkdir(f.request.roots.config)
    await expect(
      runner.execute({
        argv: ["container", "inspect", id],
        timeoutMs: 1000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("SESSION_STALE")
  } finally {
    await f.dispose()
  }
})

test("production command bridge maps only its frozen workspace and preserves real output and owned cleanup", async () => {
  const f = await fixture()
  try {
    expect(await f.invoke(create(f.workspace))).toMatchObject({ exit: 0, stdout: id + "\n" })
    expect(f.invocations[0]!.argv).toContain(
      `type=bind,src=/mnt/d/${f.workspace.slice(3).replaceAll("\\", "/")},dst=/workspace,readonly`,
    )
    expect(await f.invoke(["container", "start", "--attach", "--interactive", id], "node --test\n")).toEqual({
      exit: 0,
      stdout: "production check✓\n",
      stderr: "",
      truncated: false,
    })
    expect(await f.invoke(["container", "inspect", id])).toMatchObject({ exit: 0 })
    await f.invoke(["container", "rm", "--force", id])
    expect(f.state.removed).toBe(true)
    await expect(f.invoke(["container", "start", "--attach", "--interactive", id], "node --test\n")).rejects.toThrow()
  } finally {
    await f.f.dispose()
  }
})

test("production command bridge refuses arbitrary Docker, mounts, policy changes and nonfrozen commands before transport", async () => {
  const f = await fixture()
  try {
    const valid = create(f.workspace)
    for (const argv of [
      ["run", "--privileged", "alpine"],
      ["image", "pull", image],
      ["container", "exec", id, "sh"],
      ["container", "rm", "--force", "e".repeat(64)],
      ["container", "inspect", "docker-desktop"],
      valid.map((v) => (v === "none" ? "host" : v)),
      valid.map((v) => (v.startsWith("type=bind") ? "type=bind,src=/var/run/docker.sock,dst=/socket" : v)),
      valid.map((v) => (v === "-se" ? "-c" : v)),
      [...valid, "injected"],
    ])
      await expect(f.invoke(argv)).rejects.toThrow()
    expect(f.invocations).toHaveLength(0)
    await f.invoke(valid)
    const count = f.invocations.length
    await expect(
      f.invoke(["container", "start", "--attach", "--interactive", id], "curl https://example.com\n"),
    ).rejects.toThrow()
    expect(f.invocations).toHaveLength(count)
  } finally {
    await f.f.dispose()
  }
})

test("production command bridge rechecks ownership and actual policy before any destructive operation", async () => {
  for (const alteration of ["foreign", "network"] as const) {
    const f = await fixture()
    try {
      await f.invoke(create(f.workspace))
      if (alteration === "foreign") f.state.foreign = true
      if (alteration === "network") f.state.network = "host"
      await expect(f.invoke(["container", "rm", "--force", id])).rejects.toThrow()
      expect(f.state.removed).toBe(false)
    } finally {
      await f.f.dispose()
    }
  }
})

test("production command bridge snapshots the frozen policy and binds abort/size limits", async () => {
  const f = await fixture()
  try {
    const controller = new AbortController()
    controller.abort()
    await expect(
      f.engine.execute({
        argv: create(f.workspace),
        timeoutMs: 15000,
        maxOutputBytes: 1048576,
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    await expect(
      f.engine.execute({ argv: create(f.workspace), timeoutMs: 600001, maxOutputBytes: 1048576 }),
    ).rejects.toThrow()
    await expect(
      f.engine.execute({ argv: create(f.workspace), timeoutMs: 15000, maxOutputBytes: 1048577 }),
    ).rejects.toThrow()
    expect(f.invocations).toHaveLength(0)
  } finally {
    await f.f.dispose()
  }
})

test("production HTTP admission rejects fixture transport before opening an endpoint", async () => {
  const f = await sessionFixture(true)
  try {
    await expect(
      startProductionCommandBridge({
        session: f.session,
        runner: f.runner,
        guard: async () => {},
        commands: [{ image, argv: ["node", "--test"], workdir: "/" }],
      }),
    ).rejects.toThrow("FIXTURE_TRANSPORT")
  } finally {
    await f.dispose()
  }
})

test("production command bridge keeps the original frozen bytes and rejects workspace identity replacement", async () => {
  const f = await sessionFixture(true)
  const source = path.join(f.request.roots.work, "candidate")
  await fs.mkdir(source)
  const stdin = Buffer.from("node --test\n")
  const commands = [
    { image, argv: ["/bin/bash", "-se"], workdir: "/workspace", workspace: { source, readonly: true }, stdin },
  ]
  const engine = await makeProductionCommandEngine({
    session: f.session,
    runner: f.runner,
    guard: async () => {},
    commands,
  })
  try {
    stdin.fill(0)
    commands[0]!.workspace.readonly = false
    await fs.rename(source, source + "-old")
    await fs.mkdir(source)
    await expect(engine.execute({ argv: create(source), timeoutMs: 15000, maxOutputBytes: 1048576 })).rejects.toThrow(
      "WORKSPACE",
    )
  } finally {
    await f.dispose()
  }
})

test("production bridge maps a controller-frozen logical image to the same digest without changing production image admission", async () => {
  const f = await sessionFixture(true)
  const logical = "opencode/runtime@sha256:" + "a".repeat(64)
  try {
    await expect(
      makeProductionCommandEngine({
        session: f.session,
        runner: f.runner,
        guard: async () => {},
        commands: [{ image, publicImage: "opencode/runtime@sha256:" + "f".repeat(64), argv: ["node"], workdir: "/" }],
      }),
    ).rejects.toThrow("IMAGE")
    const workspace = f.request.roots.work + "\\candidate"
    await fs.mkdir(workspace)
    const calls: DockerInvocation[] = []
    const engine = await makeProductionCommandEngine({
      session: f.session,
      runner: {
        async execute(value) {
          calls.push(value)
          return {
            started: true,
            exitCode: 2,
            stdout: new Uint8Array(),
            stderr: Buffer.from("own diagnostic"),
            truncated: false,
          }
        },
      },
      guard: async () => {},
      commands: [
        {
          image,
          publicImage: logical,
          argv: ["/bin/bash", "-se"],
          workdir: "/workspace",
          workspace: { source: workspace, readonly: true },
        },
      ],
    })
    expect(
      await engine.execute({
        argv: create(workspace).map((s) => (s === image ? logical : s)),
        timeoutMs: 15000,
        maxOutputBytes: 1048576,
      }),
    ).toMatchObject({ exit: 2, stderr: "own diagnostic" })
    expect(calls[0]!.argv.at(-3)).toBe(image)
  } finally {
    await f.dispose()
  }
})

test("production ownership intent is persisted before create and exact IDs before any later operation", async () => {
  const f = await sessionFixture(true)
  const events: { kind: string; id?: string }[] = []
  const workspace = path.join(f.request.roots.work, "candidate")
  await fs.mkdir(workspace)
  const calls: DockerInvocation[] = []
  try {
    const engine = await makeProductionCommandEngine({
      session: f.session,
      guard: async () => {},
      record: async (event) => {
        events.push(event)
      },
      runner: {
        async execute(call) {
          calls.push(call)
          if (call.argv.includes("create")) {
            expect(events.map((e) => e.kind)).toEqual(["intent"])
            return { started: true, exitCode: 0, stdout: Buffer.from(id), stderr: new Uint8Array(), truncated: false }
          }
          expect(events).toContainEqual(expect.objectContaining({ kind: "created", id }))
          throw Error("own simulated inspection failure")
        },
      },
      commands: [
        { image, argv: ["/bin/bash", "-se"], workdir: "/workspace", workspace: { source: workspace, readonly: true } },
      ],
    })
    await expect(
      engine.execute({ argv: create(workspace), timeoutMs: 15000, maxOutputBytes: 1048576 }),
    ).rejects.toThrow("inspection")
    expect(events.map((e) => e.kind)).toEqual(["intent", "created"])
    expect(engine.outstanding().containers).toEqual([id])
  } finally {
    await f.dispose()
  }
})

test("sealed snapshot mapping refuses different archives behind the same create request", async () => {
  const f = await sessionFixture(true)
  const { WorkflowWorkspaceMaterialization } = await import("../../../core/src/workflow/workspace-materialization")
  const { sha256Text, sha256Bytes } = await import("../../src/hash")
  const archives = await Promise.all(
    ["one", "two"].map(async (text) => {
      const archive = await WorkflowWorkspaceMaterialization.seal(
        [{ path: "value.txt", type: "file", size: 3, sha256: sha256Text(text) }],
        async () => Buffer.from(text),
      )
      return {
        image,
        argv: ["/bin/bash", "-se"],
        workdir: "/workspace",
        archiveSha256: sha256Bytes(WorkflowWorkspaceMaterialization.tarBytes(archive)),
        sealedArchive: archive,
      }
    }),
  )
  try {
    const engine = await makeProductionCommandEngine({
      session: f.session,
      runner: f.runner,
      guard: async () => {},
      commands: archives,
    })
    const args = create("unused")
    args.splice(args.indexOf("--mount"), 2)
    await expect(engine.execute({ argv: args, timeoutMs: 15000, maxOutputBytes: 1048576 })).rejects.toThrow("AMBIGUOUS")
    expect(f.calls).toHaveLength(0)
    await engine.retire()
  } finally {
    await f.dispose()
  }
})
