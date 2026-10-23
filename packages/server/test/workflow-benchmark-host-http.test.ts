import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { BenchmarkHostRuntime } from "../src/workflow/benchmark-host-runtime"
import { ProductionHostRuntime } from "../src/workflow/production-host-runtime"
import { Docker } from "../src/workflow/docker"
import { WorkflowVisualHostServer } from "../src/workflow/visual-host"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { WorkflowSchema } from "@opencode-ai/core/workflow"
import { Effect } from "effect"

async function fixture(port: number) {
  const parent = "D:\\OpenCode-Benchmark\\Task24\\runs"
  await fs.mkdir(parent, { recursive: true })
  await fs.mkdir("D:\\OpenCode-Benchmark\\Task24\\workspaces", { recursive: true })
  const root = await fs.mkdtemp(path.join(parent, "host-http-"))
  const runID = "host-" + randomUUID()
  const expiresAt = Date.now() + 60000
  const environment = {
    OPENCODE_BENCHMARK_TRANSPORT_FILE: path.join(root, "benchmark-transport.json"),
    OPENCODE_BENCHMARK_RUN_DATA_ROOT: root,
    OPENCODE_BENCHMARK_CAMPAIGN_ID: "own-host-test",
    OPENCODE_BENCHMARK_RUN_ID: runID,
    OPENCODE_BENCHMARK_HOST_FILE: path.join(root, "benchmark-host.json"),
    OPENCODE_WORKFLOW_SANDBOX_ENGINE: path.join(root, "engine.exe"),
  }
  await fs.writeFile(environment.OPENCODE_WORKFLOW_SANDBOX_ENGINE, "non-executable fixture")
  await fs.writeFile(
    environment.OPENCODE_BENCHMARK_TRANSPORT_FILE,
    JSON.stringify({
      schemaVersion: 1,
      campaignID: "own-host-test",
      runID,
      brokerOrigin: "http://127.0.0.1:23456",
      providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
      evidenceMode: "production",
      expiresAt,
      grant: "own-test-grant-".repeat(4),
    }),
  )
  const binding = ProductionHostRuntime.loadBenchmarkTransport(environment)!
  const config = {
    schemaVersion: 1,
    campaignID: binding.campaignID,
    runID,
    bindingSha256: binding.bindingSha256,
    host: "127.0.0.1",
    port,
    capability: "a".repeat(64),
    expiresAt,
    enginePath: environment.OPENCODE_WORKFLOW_SANDBOX_ENGINE,
  }
  await fs.writeFile(environment.OPENCODE_BENCHMARK_HOST_FILE, JSON.stringify(config))
  return {
    root,
    environment,
    config,
    async dispose() {
      if (
        path.dirname(root) !== parent ||
        !path.basename(root).startsWith("host-http-") ||
        (await fs.realpath(root)) !== root
      )
        throw Error("own fixture identity")
      await fs.rm(root, { recursive: true })
    },
  }
}

test.skipIf(process.platform !== "win32")(
  "benchmark host HTTP is absent by default and refuses incomplete or cross-run authority",
  async () => {
    expect(BenchmarkHostRuntime.load({})).toBeUndefined()
    expect(() => BenchmarkHostRuntime.load({ OPENCODE_BENCHMARK_HOST_FILE: "C:\\unreadable" })).toThrow()
    const f = await fixture(23457)
    try {
      for (const change of [
        { host: "localhost" },
        { port: 0 },
        { runID: "other" },
        { bindingSha256: "0".repeat(64) },
        { expiresAt: 1 },
        { enginePath: "C:\\docker.exe" },
      ]) {
        await fs.writeFile(f.environment.OPENCODE_BENCHMARK_HOST_FILE, JSON.stringify({ ...f.config, ...change }))
        expect(() => BenchmarkHostRuntime.load(f.environment)).toThrow()
      }
    } finally {
      await f.dispose()
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "benchmark engine uses only its frozen HTTP endpoint and binary stdin; never spawns",
  async () => {
    const calls: unknown[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        calls.push({ path: new URL(request.url).pathname, body: await request.json() })
        return Response.json({ exit: 7, stdout: "own output", stderr: "", truncated: false })
      },
    })
    const f = await fixture(server.port!)
    try {
      const runtime = BenchmarkHostRuntime.load(f.environment)!
      const result = await runtime.engine.execute({
        executable: f.config.enginePath,
        argv: ["container", "inspect", "own"],
        env: {},
        stdin: new Uint8Array([0, 255, 1]),
        timeoutMs: 1000,
        maxOutputBytes: 1024,
      })
      expect(result).toEqual({ exit: 7, stdout: "own output", stderr: "", truncated: false })
      expect(calls).toEqual([
        {
          path: "/task24/production-command",
          body: { capability: "a".repeat(64), argv: ["container", "inspect", "own"], stdin: "AP8B" },
        },
      ])
      await expect(
        runtime.engine.execute({
          executable: "C:\\other.exe",
          argv: [],
          env: {},
          timeoutMs: 1000,
          maxOutputBytes: 1024,
        }),
      ).rejects.toThrow()
      await fs.writeFile(
        f.environment.OPENCODE_BENCHMARK_HOST_FILE,
        JSON.stringify({ ...f.config, port: server.port! + 1 }),
      )
      await expect(
        runtime.engine.execute({
          executable: f.config.enginePath,
          argv: [],
          env: {},
          timeoutMs: 1000,
          maxOutputBytes: 1024,
        }),
      ).rejects.toThrow()
      expect(calls).toHaveLength(1)
    } finally {
      await server.stop(true)
      await f.dispose()
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "benchmark browser verifies bounded PNG replies and revokes capture authority on close",
  async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex")
    const calls: unknown[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        calls.push({ path: new URL(request.url).pathname, body: await request.json() })
        return Response.json({
          mimeType: "image/png",
          data: png.toString("base64"),
          bytes: 8,
          sha256: createHash("sha256").update(png).digest("hex"),
        })
      },
    })
    const f = await fixture(server.port!)
    try {
      const runtime = BenchmarkHostRuntime.load(f.environment)!
      const input = {
        url: "http://127.0.0.1:23458/own/index.html",
        viewport: { width: 390, height: 844 },
        readySelector: "#ready",
        allowedOrigins: ["http://127.0.0.1:23458"],
        signal: new AbortController().signal,
      }
      expect(Buffer.from(await runtime.browser.capture(input))).toEqual(png)
      expect(calls).toEqual([
        {
          path: "/task24/production-capture",
          body: {
            capability: "a".repeat(64),
            url: input.url,
            viewport: input.viewport,
            readySelector: "#ready",
            allowedOrigins: input.allowedOrigins,
          },
        },
      ])
      await expect(
        runtime.browser.capture({ ...input, url: "http://localhost:23458/own/index.html" }),
      ).rejects.toThrow()
      await expect(
        runtime.browser.capture({ ...input, allowedOrigins: [...input.allowedOrigins, "https://outside.invalid"] }),
      ).rejects.toThrow()
      await runtime.browser.close()
      await expect(runtime.browser.capture(input)).rejects.toThrow()
      expect(calls).toHaveLength(1)
    } finally {
      await server.stop(true)
      await f.dispose()
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "the original production Docker entry selects finite HTTP only with explicit benchmark authority",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ exit: 0, stdout: "http-selected", stderr: "", truncated: false })
      },
    })
    const f = await fixture(server.port!)
    let spawns = 0
    try {
      const engine = Docker.makeProduction(() => {
        spawns++
        throw Error("stdio must not be selected")
      }, f.environment)
      expect(
        await engine.execute({
          executable: f.config.enginePath,
          argv: ["container", "inspect", "own"],
          env: {},
          timeoutMs: 1000,
          maxOutputBytes: 1024,
        }),
      ).toEqual({ exit: 0, stdout: "http-selected", stderr: "", truncated: false })
      expect(spawns).toBe(0)
    } finally {
      await server.stop(true)
      await f.dispose()
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "benchmark host rejects malformed frames without leaking their contents through error causes",
  async () => {
    const secret = "OWN_CAPABILITY_NOT_FOR_ERROR_LOGS"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ exit: 0, stdout: { secret }, stderr: "", truncated: false })
      },
    })
    const f = await fixture(server.port!)
    const messages = (error: unknown): string =>
      error instanceof Error ? error.message + messages(error.cause) : String(error)
    try {
      const runtime = BenchmarkHostRuntime.load(f.environment)!
      const failure = await runtime.engine
        .execute({ executable: f.config.enginePath, argv: [], env: {}, timeoutMs: 1000, maxOutputBytes: 1024 })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      expect(failure).toBeInstanceOf(Docker.Unavailable)
      expect(messages(failure)).not.toContain(secret)
      await fs.writeFile(
        f.environment.OPENCODE_BENCHMARK_HOST_FILE,
        JSON.stringify({ ...f.config, capability: secret }),
      )
      const malformed = (() => {
        try {
          BenchmarkHostRuntime.load(f.environment)
        } catch (error) {
          return error
        }
      })()
      expect(malformed).toBeInstanceOf(TypeError)
      expect(messages(malformed)).not.toContain(secret)
    } finally {
      await server.stop(true)
      await f.dispose()
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "benchmark engine preserves caller timeout and cancellation without falling back to local execution",
  async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        entered.resolve()
        await release.promise
        return Response.json({ exit: 0, stdout: "late", stderr: "", truncated: false })
      },
    })
    const f = await fixture(server.port!)
    try {
      const runtime = BenchmarkHostRuntime.load(f.environment)!
      const invocation = { executable: f.config.enginePath, argv: [], env: {}, timeoutMs: 50, maxOutputBytes: 1024 }
      const result = runtime.engine.execute(invocation).then(
        () => undefined,
        (error: unknown) => error,
      )
      await entered.promise
      expect(await result).toBeInstanceOf(Docker.Timeout)
      await expect(runtime.engine.execute({ ...invocation, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
        Docker.Cancelled,
      )
    } finally {
      release.resolve()
      await server.stop(false)
      await f.dispose()
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "the original visual production layer captures over benchmark HTTP without launching a local browser",
  async () => {
    const viewport = { name: "mobile", width: 390, height: 844 } as const
    const png = Buffer.from(WorkflowVisualHost.deterministicPng(viewport))
    let captures = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== "/task24/production-capture") return new Response(null, { status: 403 })
        captures++
        return Response.json({
          mimeType: "image/png",
          data: png.toString("base64"),
          bytes: png.length,
          sha256: createHash("sha256").update(png).digest("hex"),
        })
      },
    })
    const f = await fixture(server.port!)
    try {
      const deployment = path.join(f.root, "deployment")
      const dirs = {
        data: path.join(deployment, "data"),
        runtime: path.join(deployment, "runtime"),
        cache: path.join(deployment, "cache"),
        preview: path.join(deployment, "preview"),
        config: path.join(deployment, "config"),
        temp: path.join(deployment, "temp"),
      }
      for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true })
      const environment = {
        ...f.environment,
        OPENCODE_WORKFLOW_HOST_ROOT: deployment,
        OPENCODE_WORKFLOW_HOST_DATA: dirs.data,
        OPENCODE_WORKFLOW_HOST_RUNTIME: dirs.runtime,
        OPENCODE_WORKFLOW_HOST_CACHE: dirs.cache,
        OPENCODE_WORKFLOW_HOST_TEMP: dirs.preview,
        OPENCODE_WORKFLOW_EVIDENCE_ROOT: dirs.data,
        PLAYWRIGHT_BROWSERS_PATH: dirs.runtime,
        OPENCODE_WORKFLOW_SANDBOX_IMAGE: "opencode/workflow-sandbox@sha256:" + "a".repeat(64),
        OPENCODE_WORKFLOW_SANDBOX_CONFIG: dirs.config,
        OPENCODE_WORKFLOW_SANDBOX_TEMP: dirs.temp,
      }
      const sid = "S-1-5-21-1000-1000-1000-1001"
      const aclProbe = () => ({
        currentUserSid: sid,
        currentIdentitySids: [sid],
        ownerSid: sid,
        protected: true,
        reparsePoint: false,
        descriptorSddl: `O:${sid}G:${sid}D:P(A;;FA;;;${sid})(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)`,
        aces: [sid, "S-1-5-18", "S-1-5-32-544"].map((sid) => ({
          sid,
          allow: true,
          inherited: false,
          mask: 0x001f01ff,
        })),
      })
      const workflowID = WorkflowSchema.ID.make("wfl_host_http")
      const stageID = WorkflowSchema.StageID.make("wfs_host_http")
      const image = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* WorkflowVisualHost.Service
            const preview = yield* host.materializeReference({
              workflowID,
              referenceApp: {
                entrypoint: "index.html",
                readySelector: "#ready",
                projectStack: ["HTML"],
                files: [{ path: "index.html", content: '<div id="ready">own</div>' }],
              },
            })
            return yield* host.capture({ preview, stageID, viewport })
          }),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServer.productionLayer({
              environment,
              aclProbe,
              browserRuntimeFactory: () => {
                throw Error("local browser must not be selected")
              },
              resolvePreviewLease: async () => ({
                workflowID,
                stageID,
                attempt: 1,
                leaseOwner: "own-http-fixture",
                leaseExpiresAt: Date.now() + 60000,
              }),
              isPreviewLeaseLive: async () => true,
            }),
          ),
        ),
      )
      expect(image.sha256).toBe(createHash("sha256").update(png).digest("hex"))
      expect(captures).toBe(1)
    } finally {
      await server.stop(true)
      await f.dispose()
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "the Server client interoperates with the real bounded command endpoint and propagates cancellation",
  async () => {
    // Runtime-only package boundary: Server has no runtime dependency on the benchmark package.
    const peer: unknown = await import(
      new URL("../../benchmark/src/sandbox/production-command-http.ts", import.meta.url).href
    )
    if (
      !peer ||
      typeof peer !== "object" ||
      !("startProductionCommandEndpoint" in peer) ||
      typeof peer.startProductionCommandEndpoint !== "function"
    )
      throw Error("real endpoint export missing")
    const start = peer.startProductionCommandEndpoint as (engine: {
      execute(input: { argv: readonly string[]; stdin?: Uint8Array; signal?: AbortSignal }): Promise<Docker.Result>
      outstanding(): { containers: string[]; uncertainNames: string[] }
    }) => Promise<{ port: number; capability: string; close(): Promise<void> }>
    const entered = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    const bridge = await start({
      async execute(input) {
        calls++
        if (input.argv[0] === "framing")
          return { exit: 7, stdout: Buffer.from(input.stdin ?? []).toString("hex"), stderr: "own ✓", truncated: false }
        entered.resolve()
        const abort = () => {
          cancelled.resolve()
          release.resolve()
        }
        input.signal?.addEventListener("abort", abort, { once: true })
        if (input.signal?.aborted) abort()
        try {
          await release.promise
          input.signal?.throwIfAborted()
          return { exit: 0, stdout: "late", stderr: "", truncated: false }
        } finally {
          input.signal?.removeEventListener("abort", abort)
        }
      },
      outstanding: () => ({ containers: [], uncertainNames: [] }),
    })
    const f = await fixture(bridge.port)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await fs.writeFile(
        f.environment.OPENCODE_BENCHMARK_HOST_FILE,
        JSON.stringify({ ...f.config, capability: bridge.capability }),
      )
      const runtime = BenchmarkHostRuntime.load(f.environment)!
      const invocation = {
        executable: f.config.enginePath,
        argv: ["framing"],
        env: {},
        timeoutMs: 1000,
        maxOutputBytes: 1024,
        stdin: new Uint8Array([0, 255, 1]),
      }
      expect(await runtime.engine.execute(invocation)).toEqual({
        exit: 7,
        stdout: "00ff01",
        stderr: "own ✓",
        truncated: false,
      })
      const controller = new AbortController()
      const pending = runtime.engine.execute({ ...invocation, argv: ["cancel"], signal: controller.signal }).then(
        () => undefined,
        (error: unknown) => error,
      )
      await entered.promise
      controller.abort()
      expect(await pending).toBeInstanceOf(Docker.Cancelled)
      timer = setTimeout(() => release.resolve(), 2000)
      expect(await Promise.race([cancelled.promise.then(() => true), release.promise.then(() => false)])).toBe(true)
      expect(calls).toBe(2)
    } finally {
      clearTimeout(timer)
      release.resolve()
      await bridge.close()
      await f.dispose()
    }
  },
)
