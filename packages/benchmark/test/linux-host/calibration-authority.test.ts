import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import type { HostManifest } from "../../src/sandbox/contracts"
import { decodeHostManifest } from "../../src/sandbox/contracts"
import { issueCalibrationAuthority } from "../../src/sandbox/calibration-authority"
import { linuxAuthorityScope, requireLinuxAuthority } from "../../src/sandbox/evaluation-host"
const task24 = "D:\\OpenCode-Benchmark\\Task24"
const root = (name: string) => path.join(task24, name)
function manifest(images = 16): HostManifest {
  const endpoints = "npipe:////./pipe/docker_engine"
  const artifacts: HostManifest["artifacts"] = [
    { id: "controller-inventory", kind: "worker", sha256: sha256Text("inventory"), path: path.join(task24, "inventory.json") },
    { id: "dependencies", kind: "dependency", sha256: sha256Text("dependencies"), path: path.join(task24, "dependencies.json") },
    { id: "browser", kind: "browser", sha256: sha256Text("browser"), path: path.join(task24, "browser") },
    { id: "fonts", kind: "font", sha256: sha256Text("fonts"), path: path.join(task24, "fonts") },
    { id: "modified", kind: "binary", sha256: sha256Text("modified"), path: path.join(task24, "modified") },
    { id: "upstream", kind: "binary", sha256: sha256Text("upstream"), path: path.join(task24, "upstream") },
    ...Array.from({ length: images }, (_, i) => ({
      id: i === 0 ? "linux-runtime" : "task-" + i,
      kind: "image" as const,
      sha256: sha256Text("image-" + i),
      image: "example.invalid/task-" + i + "@sha256:" + sha256Text("digest-" + i),
    })),
  ]
  return decodeHostManifest({
    schemaVersion: 2,
    acceptanceID: "task24-calibration-authority-test",
    sourceSha256: sha256Text("source"),
    planSha256: sha256Text("plan"),
    cli: { path: path.join(task24, "toolchain", "wsl.exe"), fileID: "1:2:3", sha256: sha256Text("cli") },
    context: "default",
    endpoint: endpoints,
    architecture: "amd64",
    roots: { work: root("workspaces/t"), temp: root("tmp/t"), config: root("tmp/c"), evidence: root("reports/e") },
    engine: {
      serverID: "fixture-engine",
      version: "29.9.2",
      os: "linux",
      architecture: "amd64",
      endpoint: endpoints,
      defaultEndpoint: endpoints,
    },
    storage: {
      backend: "wsl2",
      disk: { path: path.join(task24, "toolchain", "disk.vhdx"), fileID: "4:5:6", volumeID: "7" },
      dataRoot: root("tmp/data"),
      swap: { kind: "disabled" },
      settingsSha256: sha256Text("settings"),
      observedAt: 1_760_000_000_000,
    },
    policySha256: sha256Text("policy"),
    testSha256: sha256Text("test"),
    artifactManifestSha256: sha256Text(canonicalJson(artifacts)),
    phase: "accept",
    artifacts,
  })
}
test("calibration authority records its omitted checks and stays out of the readiness path", async () => {
  const temporary = await fs.mkdtemp(path.join("D:\\OpenCode-Audit", ".verify-tmp-calibration-authority-"))
  try {
    const authority = await issueCalibrationAuthority({
      manifest: manifest(),
      evidenceRoot: temporary,
      issuedAt: 1_760_000_000_000,
    })
    expect(linuxAuthorityScope(authority)).toBe("calibration")
    const state = requireLinuxAuthority(authority)
    expect(state.manifest.phase).toBe("accept")
    const file = path.join(temporary, `calibration-authority-${authority.engineReceiptSha256}.json`)
    const statement = JSON.parse(await fs.readFile(file, "utf8"))
    expect(statement.readinessEligible).toBe(false)
    expect(statement.kind).toBe("calibration-only")
    expect(statement.omitted).toEqual(["engine-acceptance", "capability-micro-tests"])
    await fs.writeFile(file, canonicalJson({ ...statement, readinessEligible: true }))
    expect(() => requireLinuxAuthority(authority)).toThrow("TASK24_CALIBRATION_AUTHORITY_STATEMENT")
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
})
test("calibration authority refuses a manifest without sixteen verified images", async () => {
  const temporary = await fs.mkdtemp(path.join("D:\\OpenCode-Audit", ".verify-tmp-calibration-authority-"))
  try {
    await expect(issueCalibrationAuthority({ manifest: manifest(15), evidenceRoot: temporary })).rejects.toThrow(
      "TASK24_CALIBRATION_AUTHORITY_ARTIFACTS",
    )
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
})
