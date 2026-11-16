import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { verifyStorageProof, inspectStorage, fileIdentity } from "../../src/sandbox/storage"
import { createHash } from "node:crypto"
import { hostFixture } from "./fixture"

test("file identity hashes every byte across bounded stream chunks and still refuses hardlinks", async () => {
  const f = await hostFixture()
  try {
    const bytes = Buffer.alloc(3 * 1048576 + 17)
    for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = (offset * 31 + 17) % 251
    const file = path.join(f.root, "chunk-boundaries.bin")
    await fs.writeFile(file, bytes, { flag: "wx" })
    const expected = createHash("sha256").update(bytes).digest("hex")
    expect((await fileIdentity(file)).sha256).toBe(expected)
    bytes[1048576] = bytes[1048576]! ^ 1
    await fs.writeFile(file, bytes)
    expect((await fileIdentity(file)).sha256).not.toBe(expected)
    await fs.link(file, path.join(f.root, "hardlink.bin"))
    await expect(fileIdentity(file)).rejects.toThrow("TASK24_LINUX_FILE_IDENTITY")
  } finally {
    await f.dispose()
  }
})

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
