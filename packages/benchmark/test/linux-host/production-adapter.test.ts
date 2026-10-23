import { expect, test, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { prepareDirectArm } from "../../src/arms/direct"
import { fileIdentity } from "../../src/sandbox/storage"
import { makePublicToolHost } from "../../src/sandbox/public-tools"
import { createIsolationAdapter, planWindowsAgentLaunch } from "../../src/sandbox/host-isolation/production"
import { createHostIsolationContext } from "../../src/sandbox/capability"
import { sessionFixture } from "./fixture"
import { inspectLinuxHost, openLinuxSession } from "../../src/sandbox/preflight"
import { canonicalJson } from "../../src/campaign/canonical"
import { fileURLToPath } from "node:url"
import { orchestratorFixture } from "../independent/fixture"
import { sha256Text } from "../../src/hash"

test("failed scope initialization reports its exact residual and permanently blocks queued work", async () => {
  const f = await sessionFixture()
  const original = fs.writeFile
  let retained: string | undefined
  let identity: string | undefined
  const write = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (
      typeof args[0] === "string" &&
      path.basename(args[0]) === "owner.json" &&
      path.basename(path.dirname(args[0])).startsWith("production-agent-")
    ) {
      retained = path.dirname(args[0])
      const stat = await fs.lstat(retained, { bigint: true })
      identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
      throw Object.assign(Error("own injected owner write failure"), { code: "EIO" })
    }
    return original(...args)
  })
  try {
    const context = {
      schemaVersion: 2 as const,
      session: f.session,
      manifest: f.manifest,
      artifact: f.cli,
      guard: async () => {},
    }
    if (process.platform !== "win32" || process.arch !== "x64") {
      await expect(createIsolationAdapter(context)).rejects.toThrow("TASK24_PRODUCTION_ADAPTER_PLATFORM")
      return
    }
    const adapter = await createIsolationAdapter(context)
    await expect(adapter.verify()).rejects.toMatchObject({ cleanupUncertain: true, root: expect.any(String) })
    expect(retained && path.dirname(retained)).toBe(f.manifest.roots.temp)
    await expect(adapter.verify()).rejects.toThrow("TASK24_PRODUCTION_ADAPTER_CLEANUP_BLOCKED")
    expect(await fs.readdir(f.manifest.roots.temp)).toEqual([path.basename(retained!)])
  } finally {
    write.mockRestore()
    if (retained && path.dirname(retained) === f.manifest.roots.temp && (await fs.realpath(retained)) === retained) {
      const stat = await fs.lstat(retained, { bigint: true })
      expect(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`).toBe(identity)
      expect(await fs.readdir(retained)).toEqual([])
      await fs.rmdir(retained)
    }
    await f.dispose()
  }
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "production-adapter-"))
  const runRoot = path.join(root, "run")
  const roots = {
    runRoot,
    ...Object.fromEntries(
      ["repo", "data", "config", "cache", "temp", "output"].map((key) => [key, path.join(runRoot, key)]),
    ),
  } as Parameters<typeof prepareDirectArm>[0]["roots"]
  for (const dir of Object.values(roots)) await fs.mkdir(dir, { recursive: true })
  const control = path.join(root, "control")
  await fs.mkdir(control)
  await fs.mkdir(path.join(roots.repo, "src"))
  await fs.writeFile(path.join(roots.repo, "src/math.js"), "before")
  const binaryPath = path.join(root, "opencode.exe")
  await fs.mkdir(path.join(root, "tools"))
  const mcpPath = path.join(root, "tools", "public-mcp.exe")
  await fs.writeFile(binaryPath, "non executable test binary")
  await fs.writeFile(mcpPath, "non executable test MCP")
  const binary = await fileIdentity(binaryPath)
  const launch = await prepareDirectArm({
    armID: "B",
    campaignID: "adapter-test",
    runID: "adapter-test",
    binary: { runtime: "modified", executable: binary.path, sha256: binary.sha256, version: "test" },
    roots,
    prompt: "Own public task",
    referenceFiles: [],
    brokerOrigin: "http://127.0.0.1:23456",
    brokerGrant: "fixture-not-a-real-credential-".repeat(2),
    grantExpiresAt: Date.now() + 60000,
    budget: {
      aggregateInputTokens: 1000,
      aggregateOutputTokens: 1000,
      maxToolCalls: 20,
      maxRetries: 1,
      maxDurationMs: 30000,
    },
  })
  const f = await orchestratorFixture()
  const host = makePublicToolHost({
    workspace: roots.repo,
    profile: f.input.bundle.profile,
    maxCalls: 20,
    guard: async () => {},
    backend: {
      check: async () => ({
        status: "ok",
        candidateSha256: sha256Text("after"),
        commands: [{ id: "test", exitCode: 0 }],
      }),
      preview: async () => {
        throw Error("unused")
      },
      capture: async () => {
        throw Error("unused")
      },
    },
  })
  const tools = {
    connection: {
      host: "127.0.0.1" as const,
      port: 23457,
      capability: "a".repeat(64),
      bun: await fileIdentity(process.execPath),
      entry: await fileIdentity(mcpPath),
    },
    observation: host.observation,
  }
  return {
    root,
    roots,
    control,
    binary,
    launch,
    tools,
    host,
    async dispose() {
      await f.dispose()
      await fs.rm(root, { recursive: true })
    },
  }
}

test("production direct launch mediates candidate access and grants only isolated state, never the run root", async () => {
  const f = await fixture()
  try {
    const plan = await planWindowsAgentLaunch({
      launch: f.launch,
      binary: f.binary,
      tools: f.tools,
      readonly: false,
      root: f.control,
    })
    expect(plan.mediated).toEqual([f.roots.repo])
    expect(plan.writable).toEqual([f.roots.data, f.roots.config, f.roots.cache, f.roots.temp, f.roots.output])
    expect(plan.ports).toEqual([23456, 23457])
    expect(plan.writable).not.toContain(f.roots.runRoot)
    expect(plan.writable).not.toContain(f.roots.repo)
    expect(plan.environment.TASK24_PUBLIC_TOOL_CAPABILITY).toBe("a".repeat(64))
    expect(plan.environment).not.toHaveProperty("PATH")
    expect(plan.environment).not.toHaveProperty("HOME")
  } finally {
    await f.dispose()
  }
})

test("production adapter rejects substituted binary, forged tool authority and unapproved environment", async () => {
  const f = await fixture()
  try {
    const base = { launch: f.launch, binary: f.binary, tools: f.tools, readonly: false, root: f.control }
    await expect(planWindowsAgentLaunch({ ...base, binary: { ...f.binary, sha256: "f".repeat(64) } })).rejects.toThrow(
      "TASK24_PRODUCTION_ADAPTER_BINARY",
    )
    await expect(
      planWindowsAgentLaunch({ ...base, tools: { ...f.tools, observation: () => ({ ...f.tools.observation() }) } }),
    ).rejects.toThrow("TASK24_PUBLIC_OBSERVATION_AUTHORITY")
    await expect(
      planWindowsAgentLaunch({
        ...base,
        launch: { ...f.launch, environment: { ...f.launch.environment, GITHUB_TOKEN: "own-test-not-a-secret" } },
      }),
    ).rejects.toThrow("TASK24_PRODUCTION_ADAPTER_ENVIRONMENT")
    await expect(planWindowsAgentLaunch({ ...base, root: f.roots.data })).rejects.toThrow(
      "TASK24_PRODUCTION_ADAPTER_ROOTS",
    )
  } finally {
    await f.dispose()
  }
})

test("readonly launch requires the controller host to have settled its readonly transition", async () => {
  const f = await fixture()
  try {
    const base = { launch: f.launch, binary: f.binary, tools: f.tools, readonly: true, root: f.control }
    await expect(planWindowsAgentLaunch(base)).rejects.toThrow("TASK24_PRODUCTION_ADAPTER_READONLY")
    await f.host.setReadonly()
    const plan = await planWindowsAgentLaunch(base)
    expect(plan.writable).not.toContain(f.roots.repo)
    expect(plan.mediated).toEqual([f.roots.repo])
  } finally {
    await f.dispose()
  }
})

test.skipIf(process.env.TASK24_WINDOWS_ISOLATION_LIVE !== "1")(
  "native factory admission proves real file/network denial and publishes diagnostics, not Linux readiness",
  async () => {
    const f = await sessionFixture()
    let safe = true
    try {
      const factory = await fileIdentity(
        fileURLToPath(new URL("../../src/sandbox/host-isolation/production.ts", import.meta.url)),
      )
      const bun = await fileIdentity(process.execPath)
      const manifest = {
        ...f.manifest,
        artifacts: [
          ...f.manifest.artifacts,
          { id: "controller-bun", kind: "worker" as const, path: bun.path, sha256: bun.sha256 },
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
          maxDiskBytes: 268435456,
          expiresAt: Date.now() + 120000,
        },
      })
      if (opened.kind !== "ready") throw Error("fixture context session")
      const context = await createHostIsolationContext({ session: opened.value, file: factory })
      const adapter = await createIsolationAdapter(context)
      const proof = await adapter.verify()
      expect(proof.kind).toBe("ready")
      if (proof.kind !== "ready") throw Error("native blocked")
      expect(proof.value.evidence).toHaveLength(1)
      expect(await fs.readdir(manifest.roots.temp)).toEqual([])
      const published = JSON.parse(
        await fs.readFile(path.join(manifest.roots.evidence, proof.value.evidence[0]!.relativePath), "utf8"),
      )
      expect(published.kind).toBe("admission")
      expect(published.body).toMatchObject({ deniedCanaryReads: 1, canaryReads: 0, canaryHealthy: true, canaryHits: 0 })
      let finished = false
      const counts: number[] = []
      const pending = Promise.all([adapter.verify(), adapter.verify()]).finally(() => {
        finished = true
      })
      const monitor = (async () => {
        while (!finished) {
          counts.push(
            (await fs.readdir(manifest.roots.temp)).filter((name) => name.startsWith("production-agent-")).length,
          )
          await Bun.sleep(5)
        }
      })()
      await pending
      await monitor
      expect(Math.max(...counts)).toBe(1)
      expect(await fs.readdir(manifest.roots.temp)).toEqual([])
    } catch (error) {
      if (error && typeof error === "object" && "cleanupUncertain" in error && error.cleanupUncertain === true) {
        safe = false
        console.error("TASK24_OWN_NATIVE_FIXTURE_RETAINED:" + f.root)
      }
      throw error
    } finally {
      if (safe) await f.dispose()
    }
  },
  90000,
)
