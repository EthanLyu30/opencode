import fs from "node:fs/promises"
import path from "node:path"
import { sha256Text } from "../../src/hash"
import type { DockerInvocation, HostManifest, HostRequest, StorageProof } from "../../src/sandbox/contracts"
import { decodeHostManifest } from "../../src/sandbox/contracts"
import { inspectLinuxHost, openLinuxSession } from "../../src/sandbox/preflight"
import { canonicalJson } from "../../src/campaign/canonical"

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

export async function sessionFixture() {
  const f = await hostFixture()
  const image = "example.invalid/task24@sha256:" + "a".repeat(64)
  const manifest = decodeHostManifest({
    ...f.manifest,
    phase: "accept",
    artifacts: [
      ...["modified", "upstream", "browser", "fonts"].map((id) => ({
        id,
        kind: id === "fonts" ? "font" : id === "browser" ? "browser" : "binary",
        path: f.cli.path,
        sha256: f.cli.sha256,
      })),
      { id: "linux-runtime", kind: "image", sha256: "a".repeat(64), image },
    ],
  })
  const inventory = await inspectLinuxHost({
    request: f.request,
    runner: f.runner,
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
      allowedOperations: [
        "container-create",
        "container-start",
        "container-exec",
        "container-stop",
        "container-remove",
      ],
      storageRoots: Object.values(manifest.roots),
      maxDiskBytes: 67108864,
      expiresAt: Date.now() + 60000,
    },
  })
  if (opened.kind !== "ready") throw Error("FIXTURE_SESSION")
  const calls: DockerInvocation[] = []
  const state = { running: false, removed: false, foreign: false, readOnly: true }
  const labels: Record<string, string> = {}
  const mounts: { Type: string; Source: string; Destination: string; RW: boolean; Name?: string }[] = []
  const id = "b".repeat(64)
  const inspect = () => ({
    Id: id,
    Config: {
      Labels: state.foreign ? { ...labels, "opencode.task24.nonce": "other" } : labels,
      User: "65532:65532",
      Image: image,
    },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: state.readOnly,
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges=true"],
      PidsLimit: 64,
      Memory: 1073741824,
      NanoCpus: 1500000000,
      Tmpfs: {
        "/tmp": "rw,nosuid,nodev,noexec,size=67108864,mode=1777",
        "/home/sandbox": "rw,nosuid,nodev,noexec,size=16777216,mode=700,uid=65532,gid=65532",
      },
    },
    Mounts: mounts,
    State: { Running: state.running },
  })
  const runner = {
    async execute(input: DockerInvocation) {
      calls.push(input)
      const argv = input.argv
      if (argv.includes("create")) {
        mounts.length = 0
        argv.forEach((v, i) => {
          if (v === "--mount") {
            const flags = argv[i + 1]!.split(","),
              map = Object.fromEntries(flags.filter((f) => f.includes("=")).map((f) => f.split("=")))
            mounts.push({
              Type: map.type!,
              Source: map.type === "volume" ? "/var/lib/docker/volumes/" + map.src! : map.src!,
              Destination: map.dst!,
              RW: !flags.includes("readonly"),
              ...(map.type === "volume" ? { Name: map.src } : {}),
            })
          }
          if (v === "--label") {
            const s = argv[i + 1]!.indexOf("=")
            labels[argv[i + 1]!.slice(0, s)] = argv[i + 1]!.slice(s + 1)
          }
        })
        return { started: true, exitCode: 0, stdout: Buffer.from(id), stderr: new Uint8Array(), truncated: false }
      }
      if (argv.includes("start")) state.running = true
      if (argv.includes("stop") || argv.includes("kill")) state.running = false
      if (argv.includes("rm")) state.removed = true
      return {
        started: true,
        exitCode: 0,
        stdout: Buffer.from(argv.includes("inspect") ? JSON.stringify([inspect()]) : ""),
        stderr: new Uint8Array(),
        truncated: false,
      }
    },
  }
  const owner = {
    acceptanceID: manifest.acceptanceID,
    runID: "fixture-run",
    attemptID: "fixture-attempt",
    leaseGeneration: 1,
    operationID: "fixture-operation",
    nonce: "c".repeat(32),
    daemonFingerprint: inventory.contextFingerprint,
  }
  return { ...f, manifest, session: opened.value, image, owner, runner, calls, state, inspect, id }
}
