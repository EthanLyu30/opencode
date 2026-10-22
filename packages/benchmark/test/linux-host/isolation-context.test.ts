import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { hostFixture } from "./fixture"
import { createHostIsolationContext, loadHostIsolationAdapter } from "../../src/sandbox/capability"
import { inspectLinuxHost, openLinuxSession } from "../../src/sandbox/preflight"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"

test("adapter context binds the actual session and frozen artifact; context is not an engine attestation", async () => {
  const f = await hostFixture()
  try {
    const manifest = {
      ...f.manifest,
      artifacts: [
        ...f.manifest.artifacts,
        { id: "host-isolation", kind: "worker", path: f.cli.path, sha256: f.cli.sha256 },
      ],
    }
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
        scope: "prepare",
        contextFingerprint: inventory.contextFingerprint,
        artifactManifestSha256: manifest.artifactManifestSha256,
        manifestSha256: sha256Text(canonicalJson(manifest)),
        allowedOperations: [],
        storageRoots: Object.values(manifest.roots),
        maxDiskBytes: 1048576,
        expiresAt: Date.now() + 60000,
      },
    })
    if (opened.kind !== "ready") throw Error("fixture session")
    const context = await createHostIsolationContext({ session: opened.value, file: f.cli })
    expect(context.schemaVersion).toBe(2)
    expect(context.session).toBe(opened.value)
    expect(context.manifest.roots).toEqual(manifest.roots)
    expect(context.artifact).toEqual(f.cli)
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.manifest.roots)).toBe(true)
    await context.guard()
    // Issuing a context never admits the fixture as a production adapter.
    await expect(loadHostIsolationAdapter({ session: opened.value, file: f.cli })).rejects.toThrow(
      "TASK24_LINUX_FIXTURE_TRANSPORT",
    )
    await expect(createHostIsolationContext({ session: { ...opened.value }, file: f.cli })).rejects.toThrow(
      "TASK24_LINUX_SESSION_AUTHORITY",
    )
    await expect(
      createHostIsolationContext({ session: opened.value, file: { ...f.cli, sha256: "0".repeat(64) } }),
    ).rejects.toThrow("TASK24_ISOLATION_ARTIFACT")
    await fs.appendFile(f.cli.path, "changed")
    await expect(context.guard()).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})
