import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import type { HostInventory, HostRequest } from "../../src/sandbox/contracts"
import { authorControllerInventory, verifyControllerIdentity } from "../../src/sandbox/controller-identity"
import { authorPrepareManifest } from "../../src/sandbox/prepare-manifest"
test(
  "prepare manifest binds the observed inventory and a real controller inventory",
  async () => {
    const controller = await authorControllerInventory()
    const task24 = "D:\\OpenCode-Benchmark\\Task24"
    const request: HostRequest = {
      schemaVersion: 2,
      acceptanceID: "task24-prepare-author",
      sourceSha256: controller.sourceSha256,
      planSha256: sha256Text("plan"),
      cli: { path: path.join(task24, "toolchain", "cli", "wsl.exe"), fileID: "1:2:3", sha256: sha256Text("cli") },
      context: "default",
      endpoint: "npipe:////./pipe/docker_engine",
      architecture: "amd64",
      roots: {
        work: path.join(task24, "workspaces", "prepare-author"),
        temp: path.join(task24, "tmp", "prepare-author"),
        config: path.join(task24, "tmp", "prepare-author-config"),
        evidence: path.join(task24, "reports", "prepare-author"),
      },
    }
    const inventory: HostInventory = {
      requestSha256: sha256Text(canonicalJson(request)),
      cli: request.cli,
      engine: {
        serverID: "fixture-engine",
        version: "28.0.0",
        os: "linux",
        architecture: "amd64",
        endpoint: request.endpoint,
        defaultEndpoint: request.endpoint,
      },
      storage: {
        backend: "wsl2",
        disk: { path: path.join(task24, "toolchain", "disk.vhdx"), fileID: "4:5:6", volumeID: "7" },
        dataRoot: path.join(task24, "tmp", "data"),
        swap: { kind: "disabled" },
        settingsSha256: sha256Text("settings"),
        observedAt: Date.now(),
      },
      rootIdentities: {},
      contextFingerprint: sha256Text("context"),
      missing: [],
    }
    const temporary = await fs.mkdtemp(path.join("D:\\OpenCode-Audit", ".verify-tmp-prepare-"))
    try {
      const config = path.join(temporary, "runtime-config.json")
      const configBody = canonicalJson({ schemaVersion: 2, test: "config" })
      await fs.writeFile(config, configBody)
      const manifest = await authorPrepareManifest({
        request,
        inventory,
        evidenceRoot: temporary,
        artifacts: [{ id: "runtime-config", kind: "worker", path: config, sha256: sha256Text(configBody) }],
        pending: [{ id: "modified", kind: "pending", recipeSha256: sha256Text("binary-recipe") }],
      })
      expect(manifest.phase).toBe("prepare")
      expect(manifest.sourceSha256).toBe(controller.sourceSha256)
      expect(manifest.artifactManifestSha256).toBe(sha256Text(canonicalJson(manifest.artifacts)))
      expect(manifest.artifacts.map((artifact) => artifact.id)).toEqual([
        "controller-inventory",
        "runtime-config",
        "modified",
      ])
      await verifyControllerIdentity(manifest)
    } finally {
      await fs.rm(temporary, { recursive: true, force: true })
    }
  },
  120_000,
)
