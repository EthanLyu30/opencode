import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { verifyStorageProof, inspectStorage } from "../../src/sandbox/storage"
import { hostFixture } from "./fixture"

test("storage evidence requires real D disk identity, verified swap and no path aliases", async () => {
  const f = await hostFixture()
  try {
    expect((await inspectStorage(f.storage)).kind).toBe("ready")
    for (const changed of [
      { disk: { ...f.storage.disk, path: "C:\\docker.vhdx" } },
      { swap: { kind: "unknown" } },
      { disk: { ...f.storage.disk, fileID: "replaced" } },
    ])
      expect((await inspectStorage({ ...f.storage, ...changed })).kind).toBe("blocked")
    expect(() => verifyStorageProof({ ...f.storage, extra: true })).toThrow()
    const link = path.join(f.root, "linked")
    await fs.symlink(f.root, link, "junction")
    expect((await inspectStorage({ ...f.storage, dataRoot: link })).kind).toBe("blocked")
  } finally {
    await f.dispose()
  }
})
