import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import type { HostManifest } from "../../src/sandbox/contracts"
import { authorControllerInventory, verifyControllerIdentity } from "../../src/sandbox/controller-identity"
test(
  "authoring covers the verifier layout with the same role split",
  async () => {
    const root = path.resolve(import.meta.dir, "../..")
    const authored = await authorControllerInventory(root)
    expect(authored.inventory.root).toBe(root)
    expect(authored.inventory.schemaVersion).toBe(2)
    const files = new Map(authored.inventory.files.map((entry) => [entry.file.path, entry]))
    const packageJson = path.join(root, "package.json")
    const identitySource = path.join(root, "src", "sandbox", "controller-identity.ts")
    const hostTest = path.join(root, "test", "linux-host", "accept-manifest.test.ts")
    const lock = path.join(root, "..", "..", "bun.lock")
    expect(files.get(packageJson)?.role).toBe("source")
    expect(files.get(identitySource)?.role).toBe("policy")
    expect(files.get(hostTest)?.role).toBe("test")
    expect(files.has(lock)).toBe(true)
    expect(authored.sourceSha256).toBe(
      sha256Text(
        canonicalJson(authored.inventory.files.filter((entry) => entry.role === "source").sort((a, b) => a.file.path.localeCompare(b.file.path))),
      ),
    )
    expect(authored.testSha256).toBe(
      sha256Text(
        canonicalJson(authored.inventory.files.filter((entry) => entry.role === "test").sort((a, b) => a.file.path.localeCompare(b.file.path))),
      ),
    )
    expect(authored.policySha256).toBe(
      sha256Text(
        canonicalJson(authored.inventory.files.filter((entry) => entry.role === "policy").sort((a, b) => a.file.path.localeCompare(b.file.path))),
      ),
    )
    const again = await authorControllerInventory(root)
    expect(again).toEqual(authored)
    const temporary = await fs.mkdtemp(path.join("D:\\OpenCode-Audit", ".verify-tmp-controller-"))
    try {
      const file = path.join(temporary, "controller-inventory.json")
      const bytes = new TextEncoder().encode(canonicalJson(authored.inventory))
      await fs.writeFile(file, bytes)
      await verifyControllerIdentity({
        artifacts: [{ id: "controller-inventory", kind: "worker", sha256: sha256Text(canonicalJson(authored.inventory)), path: file }],
        sourceSha256: authored.sourceSha256,
        testSha256: authored.testSha256,
        policySha256: authored.policySha256,
      } as HostManifest)
    } finally {
      await fs.rm(temporary, { recursive: true, force: true })
    }
  },
  120_000,
)
