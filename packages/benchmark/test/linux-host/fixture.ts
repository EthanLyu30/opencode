import fs from "node:fs/promises"
import path from "node:path"
import { sha256Text } from "../../src/hash"
import type { DockerInvocation, HostManifest, HostRequest, StorageProof } from "../../src/sandbox/contracts"

export async function hostFixture() {
  const parent = process.env.TMPDIR!
  const owner = JSON.parse(await fs.readFile(path.join(parent, "owner.json"), "utf8"))
  if (owner.nonce !== "bprep2-0786b1f11abc") throw Error("FIXTURE_OWNER")
  const root = await fs.mkdtemp(path.join(parent, "linux-host-"))
  const cliPath = path.join(root, "docker.exe")
  await fs.writeFile(cliPath, "known non-executable Docker fixture")
  const disk = path.join(root, "disk.vhdx")
  await fs.writeFile(disk, "known synthetic disk fixture")
  const roots = Object.fromEntries(
    ["work", "temp", "config", "evidence"].map((key) => [key, path.join(root, key)]),
  ) as HostRequest["roots"]
  for (const directory of Object.values(roots)) await fs.mkdir(directory)
  const fileID = (s: Awaited<ReturnType<typeof fs.stat>>) => `${s.dev}:${s.ino}:${s.birthtimeMs}`
  const cli = {
    path: cliPath,
    sha256: sha256Text("known non-executable Docker fixture"),
    fileID: fileID(await fs.stat(cliPath)),
  }
  const request: HostRequest = {
    schemaVersion: 2,
    acceptanceID: "fixture-linux",
    sourceSha256: sha256Text("source"),
    planSha256: sha256Text("plan"),
    cli,
    context: "default",
    endpoint: "npipe:////./pipe/docker_engine",
    architecture: "amd64",
    roots,
  }
  const stat = await fs.stat(disk)
  const storage: StorageProof = {
    backend: "wsl2",
    disk: { path: disk, fileID: fileID(stat), volumeID: String(stat.dev) },
    dataRoot: root,
    swap: { kind: "disabled" },
    settingsSha256: sha256Text("settings"),
    observedAt: Date.now(),
  }
  const manifest: HostManifest = {
    ...request,
    phase: "prepare",
    engine: {
      serverID: "fixture-engine",
      version: "28.0.0",
      os: "linux",
      architecture: "amd64",
      endpoint: request.endpoint,
      defaultEndpoint: request.endpoint,
    },
    storage,
    policySha256: sha256Text("policy"),
    testSha256: sha256Text("tests"),
    artifactManifestSha256: sha256Text("artifacts"),
    artifacts: [{ id: "runtime", kind: "pending", recipeSha256: sha256Text("runtime-recipe") }],
  }
  const invocations: DockerInvocation[] = []
  const runner = {
    async execute(input: DockerInvocation) {
      invocations.push(input)
      const value = input.argv.includes("context")
        ? { Endpoints: { docker: { Host: request.endpoint } } }
        : input.argv.includes("version")
          ? { Os: "linux", Arch: "amd64", Version: "28.0.0" }
          : { ID: "fixture-engine", OSType: "linux", Architecture: "amd64" }
      return {
        started: true,
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify(value)),
        stderr: new Uint8Array(),
        truncated: false,
      }
    },
  }
  return {
    root,
    request,
    manifest,
    storage,
    cli,
    invocations,
    runner,
    async dispose() {
      if (!root.startsWith(parent + path.sep)) throw Error("FIXTURE_CLEANUP")
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
