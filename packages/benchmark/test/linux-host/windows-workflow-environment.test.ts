import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkflowBenchmarkTransport } from "../../../core/src/workflow/benchmark-transport"
import { fileIdentity } from "../../src/sandbox/storage"
import { WindowsWorkflowEnvironment } from "../../src/sandbox/host-isolation/windows-workflow-environment"

async function fixture() {
  const parent = "D:\\OpenCode-Benchmark\\Task24\\workspaces"
  const root = await fs.mkdtemp(path.join(parent, "workflow-environment-"))
  const id = await fs.lstat(root, { bigint: true })
  const work = path.join(root, "work"),
    bin = path.join(root, "bin")
  await fs.mkdir(work)
  await fs.mkdir(bin)
  for (const name of ["data", "runtime", "cache", "preview", "config", "temp"]) await fs.mkdir(path.join(work, name))
  const engine = path.join(bin, "docker.exe")
  await fs.writeFile(engine, "non-executable own finite bridge fixture", { flag: "wx" })
  const profile = {
    schemaVersion: 1,
    campaignID: "own-campaign",
    runID: "own-run",
    brokerOrigin: "http://127.0.0.1:12499",
    providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
    expiresAt: Date.now() + 60000,
    evidenceMode: "production",
    grant: "OWN_FAKE_PROVIDER_GRANT_".repeat(3),
  }
  const binding = WorkflowBenchmarkTransport.freezeProfile({
    authority: "server",
    profile,
    expectedCampaignID: profile.campaignID,
    expectedRunID: profile.runID,
  })
  const transport = path.join(work, "benchmark-transport.json"),
    connection = path.join(work, "benchmark-host.json")
  await fs.writeFile(transport, JSON.stringify(profile), { flag: "wx" })
  await fs.writeFile(
    connection,
    JSON.stringify({
      schemaVersion: 1,
      campaignID: binding.campaignID,
      runID: binding.runID,
      bindingSha256: binding.bindingSha256,
      host: "127.0.0.1",
      port: 12501,
      capability: "b".repeat(64),
      expiresAt: binding.expiresAt,
      enginePath: engine,
    }),
    { flag: "wx" },
  )
  const image = "opencode/runtime@sha256:" + "a".repeat(64)
  const environment = {
    OPENCODE_BENCHMARK_CAMPAIGN_ID: binding.campaignID,
    OPENCODE_BENCHMARK_RUN_ID: binding.runID,
    OPENCODE_BENCHMARK_RUN_DATA_ROOT: work,
    OPENCODE_BENCHMARK_TRANSPORT_FILE: transport,
    OPENCODE_BENCHMARK_HOST_FILE: connection,
    OPENCODE_WORKFLOW_HOST_ROOT: work,
    OPENCODE_WORKFLOW_HOST_DATA: path.join(work, "data"),
    OPENCODE_WORKFLOW_EVIDENCE_ROOT: path.join(work, "data"),
    OPENCODE_WORKFLOW_HOST_RUNTIME: path.join(work, "runtime"),
    PLAYWRIGHT_BROWSERS_PATH: path.join(work, "runtime"),
    OPENCODE_WORKFLOW_HOST_CACHE: path.join(work, "cache"),
    OPENCODE_WORKFLOW_HOST_TEMP: path.join(work, "preview"),
    OPENCODE_WORKFLOW_SANDBOX_CONFIG: path.join(work, "config"),
    OPENCODE_WORKFLOW_SANDBOX_TEMP: path.join(work, "temp"),
    OPENCODE_WORKFLOW_SANDBOX_ENGINE: engine,
    OPENCODE_WORKFLOW_SANDBOX_IMAGE: image,
  }
  const input = {
    environment,
    readonly: [bin],
    writable: [work],
    ports: [12499, 12501],
    authority: {
      campaignID: binding.campaignID,
      runID: binding.runID,
      bindingSha256: binding.bindingSha256,
      expiresAt: binding.expiresAt,
    },
    host: {
      armID: "A" as const,
      transport: await fileIdentity(transport),
      connection: await fileIdentity(connection),
      engine: await fileIdentity(engine),
      image,
    },
  }
  return {
    root,
    work,
    input,
    async [Symbol.asyncDispose]() {
      const current = await fs.lstat(root, { bigint: true })
      if (
        (await fs.realpath(root)) !== root ||
        path.dirname(root) !== parent ||
        current.dev !== id.dev ||
        current.ino !== id.ino ||
        current.birthtimeNs !== id.birthtimeNs
      )
        throw Error("own workflow environment fixture changed")
      await fs.rm(root, { recursive: true })
    },
  }
}

test("A workflow environment admits only complete pinned files, current authority and its existing two loopback ports", async () => {
  await using f = await fixture()
  const files = await WindowsWorkflowEnvironment.verify(f.input)
  expect(files.map((file) => file.path).toSorted()).toEqual(
    [
      path.join(f.work, "benchmark-transport.json"),
      path.join(f.work, "benchmark-host.json"),
      path.join(f.root, "bin", "docker.exe"),
    ].toSorted(),
  )
  expect(files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)
})

test("A environment rejects missing fields, aliases, C paths and a host path outside existing writable roots", async () => {
  await using f = await fixture()
  for (const value of [undefined, "C:\\forbidden", f.root, f.work + "\\..\\work\\data"]) {
    const environment: Record<string, string | undefined> = {
      ...f.input.environment,
      OPENCODE_WORKFLOW_HOST_DATA: value,
      OPENCODE_WORKFLOW_EVIDENCE_ROOT: value,
    }
    await expect(WindowsWorkflowEnvironment.verify({ ...f.input, environment })).rejects.toThrow()
  }
})

test("A environment rejects missing or cross-run authority, expired bindings and additional ports", async () => {
  await using f = await fixture()
  for (const input of [
    { ...f.input, authority: undefined },
    { ...f.input, authority: { ...f.input.authority, runID: "another-run" } },
    { ...f.input, authority: { ...f.input.authority, bindingSha256: "c".repeat(64) } },
    { ...f.input, authority: { ...f.input.authority, expiresAt: Date.now() - 1 } },
    { ...f.input, ports: [12499, 12501, 12502] },
  ])
    await expect(WindowsWorkflowEnvironment.verify(input)).rejects.toThrow()
})

test("A environment rejects substituted files, a changed image and a writable finite bridge executable", async () => {
  await using f = await fixture()
  for (const input of [
    { ...f.input, host: { ...f.input.host, engine: { ...f.input.host.engine, sha256: "d".repeat(64) } } },
    {
      ...f.input,
      environment: {
        ...f.input.environment,
        OPENCODE_WORKFLOW_SANDBOX_IMAGE: "opencode/other@sha256:" + "b".repeat(64),
      },
    },
    { ...f.input, readonly: [], writable: [f.work, path.join(f.root, "bin")] },
  ])
    await expect(WindowsWorkflowEnvironment.verify(input)).rejects.toThrow()
  await fs.appendFile(f.input.host.connection.path, " ")
  await expect(WindowsWorkflowEnvironment.verify(f.input)).rejects.toThrow()
})

test("A environment rejects connection bytes substituted only during the parse read", async () => {
  await using f = await fixture()
  const file = f.input.host.connection.path
  const original = await fs.readFile(file)
  const changed = JSON.parse(original.toString("utf8"))
  changed.port = 12502
  await expect(
    WindowsWorkflowEnvironment.verify({ ...f.input, ports: [12499, 12502] }, async (target) => {
      if (target !== file) return fs.readFile(target)
      try {
        await fs.writeFile(file, JSON.stringify(changed))
        return await fs.readFile(file)
      } finally {
        await fs.writeFile(file, original)
      }
    }),
  ).rejects.toThrow("TASK24_WORKFLOW_HOST_ARTIFACT")
})

test("A environment bounds the exact bytes read, not only the preceding file metadata", async () => {
  await using f = await fixture()
  const file = f.input.host.connection.path
  const original = await fs.readFile(file)
  await expect(
    WindowsWorkflowEnvironment.verify(f.input, async (target) => {
      if (target !== file) return fs.readFile(target)
      try {
        await fs.writeFile(file, Buffer.concat([original, Buffer.alloc(16385, " ")]))
        return await fs.readFile(file)
      } finally {
        await fs.writeFile(file, original)
      }
    }),
  ).rejects.toThrow("TASK24_WORKFLOW_HOST_LIMIT")
})
