import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import { inspectLinuxHost, openLinuxSession, sessionState, revalidateSession } from "../../src/sandbox/preflight"
import { sha256Text } from "../../src/hash"
import { canonicalJson } from "../../src/campaign/canonical"
import { hostFixture } from "./fixture"

test("cold inspection never creates containers and sessions bind observed identities and approval", async () => {
  const f = await hostFixture()
  try {
    let ticks = 0
    const inventory = await inspectLinuxHost({
      request: f.request,
      runner: f.runner,
      storageProbe: async () => ({ ...f.storage, observedAt: f.storage.observedAt + ticks++ }),
    })
    expect(inventory.missing).toEqual([])
    const approval = {
      schemaVersion: 2,
      acceptanceID: f.request.acceptanceID,
      planSha256: f.request.planSha256,
      scope: "prepare" as const,
      contextFingerprint: inventory.contextFingerprint,
      artifactManifestSha256: f.manifest.artifactManifestSha256,
      manifestSha256: sha256Text(canonicalJson(f.manifest)),
      allowedOperations: ["image-pull"],
      storageRoots: Object.values(f.request.roots),
      maxDiskBytes: 1024,
      expiresAt: Date.now() + 60000,
    }
    const opened = openLinuxSession({ manifest: f.manifest, approval, inventory })
    expect(opened.kind).toBe("ready")
    if (opened.kind !== "ready") throw Error("SESSION")
    expect(sessionState(opened.value).manifest.phase).toBe("prepare")
    await expect(revalidateSession(opened.value)).resolves.toBeDefined()
    expect(() => sessionState({ ...opened.value })).toThrow()
    expect(openLinuxSession({ manifest: f.manifest, approval: { ...approval, expiresAt: 0 }, inventory }).kind).toBe(
      "blocked",
    )
    expect(openLinuxSession({ manifest: f.manifest, approval, inventory: structuredClone(inventory) }).kind).toBe(
      "blocked",
    )
    expect(
      openLinuxSession({
        manifest: { ...f.manifest, engine: { ...f.manifest.engine, serverID: "other" } },
        approval,
        inventory,
      }).kind,
    ).toBe("blocked")
    expect(f.invocations.every((x) => !x.argv.includes("create") && !x.argv.includes("start"))).toBe(true)
    const noStorage = await inspectLinuxHost({ request: f.request, runner: f.runner, storageProbe: async () => null })
    expect(noStorage.missing).toContain("engine_storage_not_verified")
    await fs.writeFile(f.cli.path, "changed executable")
    const changed = await inspectLinuxHost({
      request: f.request,
      runner: f.runner,
      storageProbe: async () => f.storage,
    })
    expect(changed.missing).toContain("engine_cli_changed")
    await expect(revalidateSession(opened.value)).rejects.toThrow("TASK24_LINUX_SESSION_STALE")
  } finally {
    await f.dispose()
  }
})
