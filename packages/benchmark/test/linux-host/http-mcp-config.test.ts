import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sessionFixture } from "./fixture"
import { prepareDirectArm } from "../../src/arms/direct"
import { configurePublicMcp, publicMcpArguments } from "../../src/sandbox/capability"
import { inspectLinuxHost, openLinuxSession } from "../../src/sandbox/preflight"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"

test("controller config opts into HTTP with exact authority; legacy stdio and artifact pins remain enforced", async () => {
  const f = await sessionFixture()
  try {
    const manifest = {
      ...f.manifest,
      artifacts: [
        ...f.manifest.artifacts,
        ...["controller-bun", "public-mcp"].map((id) => ({
          id,
          kind: "worker" as const,
          path: f.cli.path,
          sha256: f.cli.sha256,
        })),
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
        maxDiskBytes: 67108864,
        expiresAt: Date.now() + 60000,
      },
    })
    if (opened.kind !== "ready") throw Error("fixture session, not an engine receipt")
    const runRoot = path.join(f.root, "config-run")
    const roots = {
      runRoot,
      ...Object.fromEntries(
        ["repo", "data", "config", "cache", "temp", "output"].map((key) => [key, path.join(runRoot, key)]),
      ),
    } as Parameters<typeof prepareDirectArm>[0]["roots"]
    for (const root of Object.values(roots)) await fs.mkdir(root, { recursive: true })
    const launch = await prepareDirectArm({
      armID: "C",
      campaignID: "http",
      runID: "config",
      binary: { runtime: "modified", executable: f.cli.path, sha256: f.cli.sha256, version: "fixture" },
      roots,
      prompt: "own",
      referenceFiles: [],
      brokerOrigin: "http://127.0.0.1:12345",
      brokerGrant: "own-".repeat(10),
      grantExpiresAt: Date.now() + 60000,
      budget: {
        aggregateInputTokens: 100,
        aggregateOutputTokens: 100,
        maxToolCalls: 10,
        maxRetries: 1,
        maxDurationMs: 10000,
      },
    })
    const connection = { host: "127.0.0.1" as const, port: 23456, capability: "a".repeat(64), bun: f.cli, entry: f.cli }
    await configurePublicMcp(launch, { ...connection, transport: "http" }, opened.value)
    expect((await Bun.file(launch.configFile).json()).mcp.task24).toEqual({
      type: "remote",
      url: "http://127.0.0.1:23456/task24/mcp",
      headers: { Authorization: "Bearer " + "a".repeat(64) },
      oauth: false,
      enabled: true,
    })
    await configurePublicMcp(launch, connection, opened.value)
    expect((await Bun.file(launch.configFile).json()).mcp.task24).toEqual({
      type: "local",
      command: [f.cli.path, "--loopback", "23456"],
      environment: { TASK24_PUBLIC_TOOL_CAPABILITY: "a".repeat(64) },
      enabled: true,
    })
    const before = await fs.readFile(launch.configFile, "utf8")
    await expect(
      configurePublicMcp(
        launch,
        { ...connection, transport: "http", entry: { ...f.cli, sha256: "f".repeat(64) } },
        opened.value,
      ),
    ).rejects.toThrow("TASK24_PUBLIC_MCP_ARTIFACT")
    for (const override of [
      { host: "localhost" },
      { port: 0 },
      { pipe: "\\\\.\\pipe\\opencode-task24-" + "b".repeat(64) },
      { transport: "other" },
    ])
      expect(() => publicMcpArguments({ ...connection, transport: "http", ...override } as never)).toThrow(
        "TASK24_PUBLIC_MCP_CONFIG",
      )
    expect(await fs.readFile(launch.configFile, "utf8")).toBe(before)
  } finally {
    await f.dispose()
  }
})
