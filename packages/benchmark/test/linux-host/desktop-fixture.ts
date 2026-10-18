import fs from "node:fs/promises"
import path from "node:path"
import { fileIdentity } from "../../src/sandbox/storage"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import type {
  DesktopLaunchSpec,
  DesktopPlatform,
  DesktopCompatibilityReport,
} from "../../src/sandbox/desktop/contracts"

export async function desktopFixture() {
  const parent = process.env.TMPDIR!
  const owner = JSON.parse(await fs.readFile(path.join(parent, "owner.json"), "utf8"))
  if (owner.runOwner !== "desktop-launch-20261018-1f72a9e4") throw Error("DESKTOP_FIXTURE_OWNER")
  const root = await fs.mkdtemp(path.join(parent, "desktop-"))
  await fs.mkdir(path.join(root, "install"))
  const files = await Promise.all(
    ["desktop", "frontend", "backend", "asar", "cli"].map(async (key) => {
      const file = path.join(root, "install", key)
      await fs.writeFile(file, `non-executable fixture ${key}`)
      return [key, await fileIdentity(file)] as const
    }),
  )
  const dataRoot = path.join(root, "data")
  await fs.mkdir(path.join(dataRoot, "main"), { recursive: true })
  await fs.mkdir(path.join(dataRoot, "disk"))
  const disks = await Promise.all(
    ["main/ext4.vhdx", "disk/docker_data.vhdx"].map(async (rel) => {
      const file = path.join(dataRoot, rel)
      await fs.writeFile(file, "synthetic VHD, never mount")
      const stat = await fs.stat(file)
      return { path: file, fileID: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, volumeID: String(stat.dev) }
    }),
  )
  const windowsProfile = path.join(root, "windows-user")
  await fs.mkdir(windowsProfile)
  await fs.writeFile(path.join(windowsProfile, ".wslconfig"), "[wsl2]\nswap=0\n")
  const spec: DesktopLaunchSpec = {
    schemaVersion: 1,
    profileID: "oc-task24-dd479",
    sourceSha256: sha256Text("source"),
    specSha256: sha256Text("spec"),
    planSha256: sha256Text("implementation-plan"),
    version: "4.79.0.230596",
    cliVersion: "29.5.3",
    settingsVersion: 44,
    windowsProfile,
    profileRoot: path.join(root, "profile"),
    dataRoot,
    install: Object.fromEntries(files) as DesktopLaunchSpec["install"],
    wslConfig: await fileIdentity(path.join(windowsProfile, ".wslconfig")),
    registration: {
      distributionName: "docker-desktop",
      basePath: path.join(dataRoot, "main"),
      fileID: "fixture-registry-id",
    },
    disks: { runtime: disks[0]!, data: disks[1]! },
  }
  const calls = { start: 0, stop: 0, execute: 0 }
  const checks = (
    ["path_routing", "backend_environment", "registration_reuse", "stop_owned", "cli_default"] as const
  ).map((id) => ({
    id,
    source: spec.install.asar.path,
    sourceSha256: spec.install.asar.sha256,
    location: "synthetic behavior observation",
    conclusion: "proved" as "proved" | "unproved",
  }))
  let observation: Record<string, unknown> = {
    phase: "idle",
    sid: "S-1-5-21-fixture",
    runningDocker: false,
    runningWsl: false,
  }
  const platform: DesktopPlatform = {
    async audit() {
      return {
        assurance: "fixture",
        specSha256: sha256Text(canonicalJson(spec)),
        checks,
        missing: [],
      } as DesktopCompatibilityReport
    },
    async observe() {
      return observation
    },
    async start(plan) {
      calls.start++
      const process = {
        pid: 1234,
        createdAt: Date.now(),
        ownerSID: "S-1-5-21-fixture",
        image: spec.install.backend,
        parentPID: 1000,
      }
      observation = {
        phase: "running",
        sid: process.ownerSID,
        runningDocker: true,
        runningWsl: true,
        process,
        pipe: { endpoint: plan.endpoint, owner: process },
        related: [process],
      }
      return process
    },
    async stop() {
      calls.stop++
      observation = { phase: "stopped", sid: "S-1-5-21-fixture", runningDocker: false, runningWsl: false }
      return "stopped"
    },
  }
  return {
    root,
    spec,
    platform,
    checks,
    calls,
    setObservation(value: Record<string, unknown>) {
      observation = value
    },
    getObservation() {
      return observation
    },
    async close() {
      if (!root.startsWith(parent + path.sep)) throw Error("CLEANUP_SCOPE")
      await fs.rm(root, { recursive: true })
    },
  }
}
