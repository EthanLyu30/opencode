import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { sessionFixture } from "./fixture"
import { orchestratorFixture } from "../independent/fixture"
import { fileIdentity } from "../../src/sandbox/storage"
import { inspectLinuxHost, openLinuxSession } from "../../src/sandbox/preflight"
import { createHostIsolationContext, configurePublicMcp } from "../../src/sandbox/capability"
import { createIsolationAdapter } from "../../src/sandbox/host-isolation/production"
import { buildPublicMcpExecutable } from "../../src/sandbox/public-mcp-build"
import { makePublicToolHost } from "../../src/sandbox/public-tools"
import { startPublicToolLoopback } from "../../src/sandbox/mcp-server"
import { startFixtureCapabilityProvider } from "../../src/sandbox/fixture-provider"
import { prepareDirectArm } from "../../src/arms/direct"
import { sha256Text } from "../../src/hash"
import { canonicalJson } from "../../src/campaign/canonical"
import { runWindowsSandbox } from "../../src/sandbox/host-isolation/windows"

test.skipIf(process.platform !== "win32" || process.env.TASK24_WINDOWS_ADAPTER_CLI_LIVE !== "1")(
  "compiled capture module imports without access to source-tree Playwright assets",
  async () => {
    const parent = process.env.TMPDIR!
    const root = await fs.mkdtemp(path.join(parent, "capture-startup-"))
    let safe = true
    try {
      for (const dir of ["work", "control", "bin"]) await fs.mkdir(path.join(root, dir))
      await fs.writeFile(path.join(root, "bunfig.toml"), "# empty trusted compiler configuration\n")
      const source = fileURLToPath(new URL("../../../server/src/workflow/playwright.ts", import.meta.url))
      await fs.writeFile(
        path.join(root, "entry.ts"),
        `import { PlaywrightCapture } from ${JSON.stringify(source)};console.log(typeof PlaywrightCapture.productionRuntime)`,
      )
      await fs.writeFile(
        path.join(root, "build.ts"),
        `const result=await Bun.build({entrypoints:[${JSON.stringify(path.join(root, "entry.ts"))}],target:'bun',minify:true,compile:{outfile:${JSON.stringify(path.join(root, "bin", "startup.exe"))},autoloadDotenv:false,autoloadBunfig:false,autoloadPackageJson:false,autoloadTsconfig:false}});if(!result.success){console.error(result.logs);process.exit(1)}`,
      )
      const compiler = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--no-install",
          "--config=" + path.join(root, "bunfig.toml"),
          path.join(root, "build.ts"),
        ],
        {
          cwd: root,
          env: { SystemRoot: "C:\\Windows", TEMP: root, TMP: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      )
      const timer = setTimeout(() => compiler.kill(), 30000)
      const [exit, stderr] = await Promise.all([compiler.exited, new Response(compiler.stderr).text()]).finally(() =>
        clearTimeout(timer),
      )
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
      const result = await runWindowsSandbox({
        executable: await fileIdentity(path.join(root, "bin", "startup.exe")),
        argv: [],
        cwd: path.join(root, "work"),
        readonly: [],
        writable: [path.join(root, "work")],
        ports: [],
        root: path.join(root, "control"),
        timeoutMs: 15000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 16384,
        signal: new AbortController().signal,
      })
      expect({
        exit: result.execution.exitCode,
        stderr: Buffer.from(result.execution.stderr).toString("utf8"),
      }).toEqual({ exit: 0, stderr: "" })
      expect(Buffer.from(result.execution.stdout).toString("utf8").trim()).toBe("function")
      expect(result.containment).toMatchObject({
        processTreeEnded: true,
        cleanupCompleted: true,
        persistentPolicyRetired: true,
      })
      expect(await fs.readdir(path.join(root, "control"))).toEqual([])
    } catch (error) {
      if (error && typeof error === "object" && Reflect.get(error, "cleanupUncertain") === true) safe = false
      throw error
    } finally {
      if (safe && (await fs.realpath(root)) === root && root.startsWith(parent + path.sep))
        await fs.rm(root, { recursive: true })
    }
  },
  60000,
)

for (const armID of ["B", "C", "D", "E"] as const)
  test.skipIf(process.env.TASK24_WINDOWS_ADAPTER_CLI_LIVE !== "1")(
    `exact ${armID} CLI runs inside native adapter; model claims cannot manufacture tool observations`,
    async () => {
      const f = await sessionFixture()
      let bridge: Awaited<ReturnType<typeof startPublicToolLoopback>> | undefined
      let provider: ReturnType<typeof startFixtureCapabilityProvider> | undefined
      let fixture: Awaited<ReturnType<typeof orchestratorFixture>> | undefined
      let safe = true
      try {
        const upstream = armID === "D" || armID === "E"
        const binaryPath = upstream
          ? process.env.TASK24_WINDOWS_ADAPTER_UPSTREAM_EXE
          : process.env.TASK24_WINDOWS_ADAPTER_CLI_EXE
        const expectedHash = upstream
          ? process.env.TASK24_WINDOWS_ADAPTER_UPSTREAM_SHA256
          : process.env.TASK24_WINDOWS_ADAPTER_CLI_SHA256
        if (
          !binaryPath ||
          !(upstream
            ? binaryPath === "D:\\OpenCode-Benchmark\\Task24\\toolchain\\upstream\\opencode.exe"
            : /^D:\\OpenCode-Benchmark\\Task24\\toolchain\\modified\\[a-f0-9]{64}\\opencode\.exe$/.test(binaryPath)) ||
          !expectedHash ||
          !/^[a-f0-9]{64}$/.test(expectedHash)
        )
          throw Error("TASK24_FIXTURE_CLI_IDENTITY_REQUIRED")
        const binary = await fileIdentity(binaryPath)
        expect(binary.sha256).toBe(expectedHash)
        const mcp = await buildPublicMcpExecutable({ outputRoot: path.join(f.root, "mcp") })
        const bun = await fileIdentity(process.execPath)
        const factory = await fileIdentity(fileURLToPath(new URL("../../script/host-isolation.ts", import.meta.url)))
        const manifest = {
          ...f.manifest,
          artifacts: [
            ...f.manifest.artifacts.filter((v) => v.id !== (upstream ? "upstream" : "modified")),
            {
              id: upstream ? "upstream" : "modified",
              kind: "binary" as const,
              path: binary.path,
              sha256: binary.sha256,
            },
            { id: "controller-bun", kind: "worker" as const, path: bun.path, sha256: bun.sha256 },
            { id: "public-mcp", kind: "worker" as const, path: mcp.executable.path, sha256: mcp.executable.sha256 },
            { id: "host-isolation", kind: "worker" as const, path: factory.path, sha256: factory.sha256 },
          ],
        }
        const inventory = await inspectLinuxHost({
          request: f.request,
          runner: f.inventoryRunner,
          storageProbe: async () => f.storage,
        })
        const opened = openLinuxSession({
          manifest,
          inventory,
          approval: {
            schemaVersion: 2,
            acceptanceID: manifest.acceptanceID,
            planSha256: manifest.planSha256,
            scope: "accept",
            contextFingerprint: inventory.contextFingerprint,
            artifactManifestSha256: manifest.artifactManifestSha256,
            manifestSha256: sha256Text(canonicalJson(manifest)),
            allowedOperations: [],
            storageRoots: Object.values(manifest.roots),
            maxDiskBytes: 1073741824,
            expiresAt: Date.now() + 300000,
          },
        })
        if (opened.kind !== "ready") throw Error("fixture engine context, not Linux attestation")
        const runRoot = path.join(f.root, "run")
        const roots = {
          runRoot,
          ...Object.fromEntries(
            ["repo", "data", "config", "cache", "temp", "output"].map((k) => [k, path.join(runRoot, k)]),
          ),
        } as Parameters<typeof prepareDirectArm>[0]["roots"]
        for (const dir of Object.values(roots)) await fs.mkdir(dir, { recursive: true })
        await fs.mkdir(path.join(roots.repo, "src"))
        await fs.writeFile(path.join(roots.repo, "src/math.js"), "before")
        fixture = await orchestratorFixture()
        const host = makePublicToolHost({
          workspace: roots.repo,
          profile: fixture.input.bundle.profile,
          maxCalls: 20,
          guard: async () => {},
          backend: {
            check: async () => {
              throw Error("no check requested")
            },
            preview: async () => {
              throw Error("no preview requested")
            },
            capture: async () => {
              throw Error("no capture requested")
            },
          },
        })
        bridge = await startPublicToolLoopback({ host, mcpHttp: true })
        provider = startFixtureCapabilityProvider([
          fixtureReply(armID, [], '{"changed":true,"checkExit":0,"preview":true,"capture":true}'),
          fixtureReply(armID, [
            { name: "task24_read", arguments: { path: "src/math.js", offset: 0, length: 64 } },
            {
              name: "task24_write",
              arguments: { path: "src/math.js", baseSha256: sha256Text("before"), content: "after" },
            },
          ]),
          fixtureReply(armID),
          fixtureReply(armID, [
            {
              name: "task24_write",
              arguments: { path: "src/math.js", baseSha256: sha256Text("after"), content: "forbidden" },
            },
          ]),
          fixtureReply(armID),
        ])
        const launch = await prepareDirectArm({
          armID,
          campaignID: "adapter-cli",
          runID: "adapter-cli",
          binary: {
            runtime: upstream ? "upstream" : "modified",
            executable: binary.path,
            sha256: binary.sha256,
            version: "frozen-test",
          },
          roots,
          prompt: "Return fixture completion",
          referenceFiles: [],
          brokerOrigin: provider.origin,
          brokerGrant: provider.grant,
          grantExpiresAt: Date.now() + 180000,
          budget: {
            aggregateInputTokens: 2000,
            aggregateOutputTokens: 2000,
            maxToolCalls: 20,
            maxRetries: 1,
            maxDurationMs: 60000,
          },
        })
        const connection = {
          transport: "http" as const,
          host: bridge.host,
          port: bridge.port,
          capability: bridge.capability,
          bun,
          entry: mcp.executable,
        }
        await configurePublicMcp(launch, connection, opened.value)
        expect((await Bun.file(launch.configFile).json()).mcp.task24).toEqual({
          type: "remote",
          url: `http://127.0.0.1:${bridge.port}/task24/mcp`,
          headers: { Authorization: `Bearer ${bridge.capability}` },
          oauth: false,
          enabled: true,
        })
        const adapter = await createIsolationAdapter(
          await createHostIsolationContext({ session: opened.value, file: factory }),
        )
        const result = await adapter.launch({
          launch,
          kind: "coding",
          readonly: false,
          signal: new AbortController().signal,
          tools: { connection, observation: host.observation },
        })
        expect(result.ended).toBe(true)
        expect(provider.observation()).toEqual({ calls: 1, rejected: 0, complete: false })
        expect(result).toMatchObject({
          changed: false,
          checkExit: 1,
          preview: false,
          capture: false,
          canaryReads: 0,
          externalNetworkHits: 0,
          deniedCanaryReads: 1,
        })
        expect(await fs.readFile(path.join(roots.repo, "src/math.js"), "utf8")).toBe("before")
        const changed = await adapter.launch({
          launch,
          kind: "coding",
          readonly: false,
          signal: new AbortController().signal,
          tools: { connection, observation: host.observation },
        })
        expect(changed).toMatchObject({ ended: true, changed: true, checkExit: 1, preview: false, capture: false })
        expect(await fs.readFile(path.join(roots.repo, "src/math.js"), "utf8")).toBe("after")
        expect(host.observation().writes).toHaveLength(1)
        await host.setReadonly()
        const readonly = await adapter.launch({
          launch,
          kind: "coding",
          readonly: true,
          signal: new AbortController().signal,
          tools: { connection, observation: host.observation },
        })
        expect(readonly).toMatchObject({ ended: true, changed: false, readonlyDenied: true })
        expect(await fs.readFile(path.join(roots.repo, "src/math.js"), "utf8")).toBe("after")
        expect(host.observation().writes).toHaveLength(1)
        expect(provider.observation()).toEqual({ calls: 5, rejected: 0, complete: true })
      } catch (error) {
        if (provider) console.error("TASK24_FIXTURE_PROVIDER_OBSERVATION:" + JSON.stringify(provider.observation()))
        if (error && typeof error === "object" && "cleanupUncertain" in error && error.cleanupUncertain === true) {
          safe = false
          console.error("TASK24_OWN_NATIVE_FIXTURE_RETAINED:" + f.root)
        }
        throw error
      } finally {
        await bridge?.close()
        await provider?.stop()
        await fixture?.dispose()
        if (safe) await f.dispose()
      }
    },
    180000,
  )

function fixtureReply(
  armID: "B" | "C" | "D" | "E",
  tools: readonly { name: string; arguments: unknown }[] = [],
  content = "Fixture complete",
) {
  if (armID === "B" || armID === "D") {
    const response = { id: "resp_fixture", model: "deepseek-v4-pro", created_at: 1 }
    const items = tools.length
      ? tools.map((tool, i) => ({
          type: "function_call",
          id: "fc_" + i,
          call_id: "call_" + i,
          name: tool.name,
          arguments: JSON.stringify(tool.arguments),
          status: "completed",
        }))
      : [
          {
            type: "message",
            id: "msg_fixture",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: content, annotations: [] }],
          },
        ]
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      ...items.flatMap((item, output_index) => [
        {
          type: "response.output_item.added",
          output_index,
          item: { ...item, ...(tools.length ? { arguments: "" } : { content: [] }), status: "in_progress" },
        },
        ...(tools.length
          ? [
              {
                type: "response.function_call_arguments.delta",
                item_id: item.id,
                output_index,
                delta: Reflect.get(item, "arguments"),
              },
            ]
          : [
              {
                type: "response.content_part.added",
                item_id: item.id,
                output_index,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              },
              { type: "response.output_text.delta", item_id: item.id, output_index, content_index: 0, delta: content },
            ]),
        { type: "response.output_item.done", output_index, item },
      ]),
      {
        type: "response.completed",
        response: {
          ...response,
          status: "completed",
          output: items,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ]
    return {
      protocol: "responses" as const,
      model: "deepseek-v4-pro" as const,
      events: events.map((data, sequence_number) => ({ event: data.type, data: { ...data, sequence_number } })),
    }
  }
  return {
    protocol: "chat_completions" as const,
    model: "kimi-k3" as const,
    events: [
      {
        data: {
          id: "fixture-http-tools",
          object: "chat.completion.chunk",
          created: 1,
          model: "kimi-k3",
          choices: [
            {
              index: 0,
              delta: tools.length
                ? {
                    role: "assistant",
                    tool_calls: tools.map((tool, index) => ({
                      index,
                      id: "call_" + index,
                      type: "function",
                      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
                    })),
                  }
                : { role: "assistant", content },
              finish_reason: tools.length ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      },
    ],
  }
}
