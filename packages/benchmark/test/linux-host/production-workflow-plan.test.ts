import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { prepareWorkflowArm } from "../../src/arms/workflow"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import { fileIdentity } from "../../src/sandbox/storage"
import { planWindowsWorkflowLaunch } from "../../src/sandbox/host-isolation/production"

async function fixture() {
  const root = await fs.mkdtemp(path.join("D:\\OpenCode-Benchmark\\Task24\\workspaces", "workflow-plan-"))
  const runRoot = path.join(root, "run")
  const roots = {
    runRoot,
    ...Object.fromEntries(
      ["repo", "data", "config", "cache", "temp", "output"].map((name) => [name, path.join(runRoot, name)]),
    ),
  } as Parameters<typeof prepareWorkflowArm>[0]["roots"]
  for (const directory of Object.values(roots)) await fs.mkdir(directory, { recursive: true })
  const bin = path.join(root, "bin")
  const control = path.join(root, "control")
  await fs.mkdir(bin)
  await fs.mkdir(control)
  await fs.writeFile(path.join(bin, "opencode.exe"), "nonexecutable fixture")
  await fs.writeFile(path.join(bin, "docker.exe"), "nonexecutable finite bridge fixture")
  const binary = await fileIdentity(path.join(bin, "opencode.exe"))
  const launch = await prepareWorkflowArm({
    armID: "A",
    campaignID: "own-plan",
    runID: "own-plan",
    roots,
    binary: { runtime: "modified", executable: binary.path, sha256: binary.sha256, version: "test" },
    prompt: "Repair the public fixture",
    referenceFiles: [],
    brokerOrigin: "http://127.0.0.1:23456",
    brokerGrant: "own-closed-fixture-grant-".repeat(2),
    grantExpiresAt: Date.now() + 60000,
    budget: {
      aggregateInputTokens: 1000,
      aggregateOutputTokens: 1000,
      maxToolCalls: 20,
      maxRetries: 1,
      maxDurationMs: 30000,
    },
  })
  const hostRoot = path.join(roots.data, "host")
  const dirs = [
    hostRoot,
    ...["data", "runtime", "cache", "preview", "config", "temp"].map((name) => path.join(hostRoot, name)),
  ]
  for (const directory of dirs) await fs.mkdir(directory)
  const profile = JSON.parse(await fs.readFile(launch.transportFile, "utf8"))
  const base = {
    kind: "workflow.benchmark-transport.v1",
    campaignID: profile.campaignID,
    runID: profile.runID,
    brokerOrigin: profile.brokerOrigin,
    providerPaths: profile.providerPaths,
    evidenceMode: profile.evidenceMode,
    expiresAt: profile.expiresAt,
    grantSha256: sha256Text(profile.grant),
  }
  const authority = {
    campaignID: profile.campaignID,
    runID: profile.runID,
    expiresAt: profile.expiresAt,
    bindingSha256: sha256Text(canonicalJson(base)),
  }
  const connection = path.join(roots.data, "benchmark-host.json")
  const engine = await fileIdentity(path.join(bin, "docker.exe"))
  await fs.writeFile(
    connection,
    canonicalJson({
      schemaVersion: 1,
      ...authority,
      host: "127.0.0.1",
      port: 23457,
      capability: "a".repeat(64),
      enginePath: engine.path,
    }),
  )
  const environment = {
    ...launch.environment,
    OPENCODE_WORKFLOW_HOST_ROOT: dirs[0]!,
    OPENCODE_WORKFLOW_HOST_DATA: dirs[1]!,
    OPENCODE_WORKFLOW_EVIDENCE_ROOT: dirs[1]!,
    OPENCODE_WORKFLOW_HOST_RUNTIME: dirs[2]!,
    PLAYWRIGHT_BROWSERS_PATH: dirs[2]!,
    OPENCODE_WORKFLOW_HOST_CACHE: dirs[3]!,
    OPENCODE_WORKFLOW_HOST_TEMP: dirs[4]!,
    OPENCODE_WORKFLOW_SANDBOX_CONFIG: dirs[5]!,
    OPENCODE_WORKFLOW_SANDBOX_TEMP: dirs[6]!,
    OPENCODE_WORKFLOW_SANDBOX_ENGINE: engine.path,
    OPENCODE_WORKFLOW_SANDBOX_IMAGE: "own/runtime@sha256:" + "b".repeat(64),
    OPENCODE_BENCHMARK_HOST_FILE: connection,
  }
  return {
    root,
    roots,
    bin,
    control,
    binary,
    launch: { ...launch, environment },
    dirs,
    authority,
    host: {
      armID: "A" as const,
      transport: await fileIdentity(launch.transportFile),
      connection: await fileIdentity(connection),
      engine,
      image: environment.OPENCODE_WORKFLOW_SANDBOX_IMAGE,
    },
    async dispose() {
      await fs.rm(root, { recursive: true })
    },
  }
}

test("A launch preserves production argv and permits only the current repository and isolated state", async () => {
  const f = await fixture()
  try {
    const plan = await planWindowsWorkflowLaunch({
      launch: f.launch,
      binary: f.binary,
      root: f.control,
      readonly: false,
      authority: f.authority,
      host: f.host,
      port: 23457,
    })
    expect(plan.argv).toEqual(f.launch.args)
    expect(plan.cwd).toBe(f.roots.repo)
    expect(plan.ports).toEqual([23456, 23457])
    expect(plan.writable).toEqual([
      f.roots.repo,
      f.roots.data,
      f.roots.config,
      f.roots.cache,
      f.roots.temp,
      f.roots.output,
      ...f.dirs,
    ])
    expect(plan.writable).not.toContain(f.roots.runRoot)
    expect(plan.readonly).toEqual([f.bin])
    expect(plan.environment).not.toHaveProperty("PATH")
    expect(plan.environment).not.toHaveProperty("TASK24_PUBLIC_TOOL_CAPABILITY")
    expect(plan.benchmarkAcl).toEqual(f.authority)
  } finally {
    await f.dispose()
  }
})

test("A readonly role cannot write the repository but retains its separate production state", async () => {
  const f = await fixture()
  try {
    const plan = await planWindowsWorkflowLaunch({
      launch: f.launch,
      binary: f.binary,
      root: f.control,
      readonly: true,
      authority: f.authority,
      host: f.host,
      port: 23457,
    })
    expect(plan.readonly).toEqual([f.bin, f.roots.repo])
    expect(plan.writable).not.toContain(f.roots.repo)
    expect(plan.writable).toContain(f.dirs[0]!)
  } finally {
    await f.dispose()
  }
})

test("A refuses foreign grants, state outside its run, ambient credentials and substituted artifacts before launch", async () => {
  const f = await fixture()
  try {
    const base = {
      launch: f.launch,
      binary: f.binary,
      root: f.control,
      readonly: false,
      authority: f.authority,
      host: f.host,
      port: 23457,
    }
    for (const environment of [
      { ...f.launch.environment, DEEPSEEK_API_KEY: "foreign-credential" },
      { ...f.launch.environment, OPENCODE_WORKFLOW_HOST_ROOT: f.root },
      { ...f.launch.environment, GITHUB_TOKEN: "own-synthetic" },
      { ...f.launch.environment, OPENCODE_BENCHMARK_RUN_ID: "foreign-run" },
    ])
      await expect(planWindowsWorkflowLaunch({ ...base, launch: { ...f.launch, environment } })).rejects.toThrow(
        "TASK24_",
      )
    await expect(
      planWindowsWorkflowLaunch({ ...base, binary: { ...f.binary, sha256: "f".repeat(64) } }),
    ).rejects.toThrow("TASK24_PRODUCTION_ADAPTER_BINARY")
    await expect(
      planWindowsWorkflowLaunch({ ...base, authority: { ...f.authority, runID: "foreign-run" } }),
    ).rejects.toThrow("TASK24_WORKFLOW_HOST_BINDING")
    await expect(planWindowsWorkflowLaunch({ ...base, root: f.roots.output })).rejects.toThrow(
      "TASK24_PRODUCTION_ADAPTER_ROOTS",
    )
    await expect(planWindowsWorkflowLaunch({ ...base, port: 23458 })).rejects.toThrow("TASK24_WORKFLOW_HOST_PORTS")
    await fs.appendFile(f.host.engine.path, "substitution")
    await expect(planWindowsWorkflowLaunch(base)).rejects.toThrow("TASK24_WORKFLOW_HOST_ARTIFACT")
  } finally {
    await f.dispose()
  }
})
