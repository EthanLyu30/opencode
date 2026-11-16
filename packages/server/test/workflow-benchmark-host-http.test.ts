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
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"

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
    OPENCODE_WORKFLOW_SANDBOX_ENGINE: path.join(root, "docker.exe"),
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
  "static transport sends only an exact descriptor, rejects foreign replies and stale files, and releases once",
  async () => {
    const hostID = "b".repeat(64)
    const sha256 = createHash("sha256")
      .update(JSON.stringify(["index.html", "", [["index.html", createHash("sha256").update("own").digest("hex")]]]))
      .digest("hex")
    const calls: unknown[] = []
    let wrongPort = false
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, bound) {
        calls.push({ path: new URL(request.url).pathname, body: await request.json() })
        return Response.json({ port: bound.port! + (wrongPort ? 1 : 0), hostID, sha256 })
      },
    })
    const f = await fixture(server.port!)
    const input = {
      hostID,
      entrypoint: "index.html",
      root: "",
      files: [{ path: "index.html", bytes: Buffer.from("own") }],
    }
    try {
      const runtime = BenchmarkHostRuntime.load(f.environment)!
      const preview = await runtime.staticPreview(input)
      expect(preview.port).toBe(server.port!)
      await Promise.all([preview.stop(true), preview.stop(true)])
      expect(calls).toEqual(
        ["open", "close"].map((operation) => ({
          path: "/task24/production-preview",
          body: { capability: "a".repeat(64), operation, hostID, sha256 },
        })),
      )
      wrongPort = true
      await expect(runtime.staticPreview(input)).rejects.toThrow("TASK24_BENCHMARK_HOST_PREVIEW")
      await expect(runtime.staticPreview({ ...input, hostID: "../elsewhere" })).rejects.toThrow()
      expect(calls).toHaveLength(3)
      await fs.writeFile(f.environment.OPENCODE_BENCHMARK_HOST_FILE, JSON.stringify({ ...f.config, runID: "other" }))
      await expect(runtime.staticPreview(input)).rejects.toThrow("TASK24_BENCHMARK_HOST_STALE")
      expect(calls).toHaveLength(3)
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
    const start = peer.startProductionCommandEndpoint as (
      engine: { execute(): Promise<Docker.Result>; outstanding(): { containers: string[]; uncertainNames: string[] } },
      options: {
        previews: { entrypoint: string; root: string; files: { path: string; bytes: Uint8Array }[] }[]
        capture: {
          admit(input: { url: string }): Promise<void>
          capture(input: { url: string }): Promise<Uint8Array>
          close(): Promise<void>
        }
      },
    ) => Promise<{
      port: number
      capability: string
      admitStaticPreview(url: string): void
      previewObservation(): readonly { active: boolean }[]
      close(): Promise<void>
    }>
    const server = await start(
      {
        execute: async () => ({ exit: 0, stdout: "", stderr: "", truncated: false }),
        outstanding: () => ({ containers: [], uncertainNames: [] }),
      },
      {
        previews: [
          {
            entrypoint: "index.html",
            root: "",
            files: [{ path: "index.html", bytes: Buffer.from('<div id="ready">own</div>') }],
          },
          {
            entrypoint: "web/index.html",
            root: "web",
            files: [
              { path: "web/index.html", bytes: Buffer.from('<div id="ready">own</div>') },
              { path: "web/asset.js", bytes: Buffer.from("export const sealed = true\n") },
            ],
          },
        ],
        capture: {
          async admit(input) {
            server.admitStaticPreview(input.url)
          },
          async capture(input) {
            expect(new URL(input.url).port).toBe(String(server.port))
            const response = await fetch(input.url, { proxy: "" })
            expect(response.status).toBe(200)
            expect(await response.text()).toBe('<div id="ready">own</div>')
            captures++
            return png
          },
          async close() {},
        },
      },
    )
    const f = await fixture(server.port!)
    try {
      await fs.writeFile(
        f.environment.OPENCODE_BENCHMARK_HOST_FILE,
        JSON.stringify({ ...f.config, capability: server.capability }),
      )
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
      const workspace = path.join(f.root, "workspace")
      await fs.mkdir(path.join(workspace, "web"), { recursive: true })
      const sources = [
        { path: "web/index.html", text: '<div id="ready">own</div>' },
        { path: "web/asset.js", text: "export const sealed = true\n" },
      ]
      for (const file of sources) await fs.writeFile(path.join(workspace, file.path), file.text)
      const location = Location.Ref.make({ directory: AbsolutePath.make(workspace) })
      const plan = PreviewPlan.freeze({
        authority: "admission",
        location,
        preview: { kind: "static", cwd: "web", entrypoint: "index.html" },
      })
      const entries = sources.map((file) => ({
        path: RelativePath.make(file.path),
        type: "file" as const,
        size: Buffer.byteLength(file.text),
        sha256: createHash("sha256").update(file.text).digest("hex"),
      }))
      const archive = await WorkflowWorkspaceMaterialization.seal(entries, async (file) =>
        Buffer.from(sources.find((s) => s.path === file)!.text),
      )
      const sealedSnapshot = WorkflowWorkspaceMaterialization.bind({
        workflowID,
        stageID,
        revision: 0,
        location,
        snapshotRef: Snapshot.ID.make("own-host-http-snapshot"),
        manifestSha256: "c".repeat(64),
        workspaceSha256: Snapshot.workspaceSha256(entries),
        archive,
      })
      const lease = {
        workflowID,
        stageID,
        attempt: 1,
        leaseOwner: "own-http-fixture",
        leaseExpiresAt: Date.now() + 60000,
      }
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
            const reference = yield* host.capture({ preview, stageID, viewport })
            const implementation = yield* host.prepareImplementation({ workflowID, revision: 0, plan })
            yield* Effect.promise(async () => {
              expect(new URL(implementation.url).port).toBe(String(server.port))
              expect(await (await fetch(implementation.url + "asset.js", { proxy: "" })).text()).toBe(
                "export const sealed = true\n",
              )
              expect(await fs.readFile(path.join(workspace, "web", "index.html"), "utf8")).toBe(
                "live source changed after sealing",
              )
            })
            const captured = yield* host.capture({ preview: implementation, stageID, viewport })
            expect(captured.sha256).toBe(reference.sha256)
            return captured
          }),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServer.productionLayer({
              environment,
              aclProbe,
              browserRuntimeFactory: () => {
                throw Error("local browser must not be selected")
              },
              resolvePreviewLease: async () => lease,
              resolveImplementationContract: async () => {
                await fs.writeFile(path.join(workspace, "web", "index.html"), "live source changed after sealing")
                return {
                  implementationSha256: "c".repeat(64),
                  readySelector: "#ready",
                  previewLease: lease,
                  sealedSnapshot,
                }
              },
              isPreviewLeaseLive: async () => true,
            }),
          ),
        ),
      )
      expect(image.sha256).toBe(createHash("sha256").update(png).digest("hex"))
      expect(captures).toBe(2)
      expect(server.previewObservation().map((lease) => lease.active)).toEqual([false, false])
    } finally {
      await server.close()
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
