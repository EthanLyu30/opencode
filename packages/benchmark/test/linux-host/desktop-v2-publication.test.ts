import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { desktopV2Fixture } from "./desktop-v2-fixture"
import { readDesktopDirectoryV2 } from "../../src/sandbox/desktop/identity-v2"

const api = await import("../../src/sandbox/desktop/publication-v2").catch(() => undefined)

test("v2 held parent/file handles bind exact identities and prohibit write/delete until release", async () => {
  expect(api).toBeDefined()
  const f = await desktopV2Fixture()
  try {
    const proof = await readDesktopDirectoryV2(f.root)
    const file = f.spec.disks.data.path,
      relative = path.relative(f.root, file)
    await api!.withDesktopPublicationV2(
      { root: f.root, mode: "read", parents: proof.parents, signal: AbortSignal.timeout(10000) },
      async (io) => {
        await io.acquire([relative])
        expect(new TextDecoder().decode((await io.read(relative)).bytes)).toBe("synthetic VHD, never mount")
        expect((await io.read(relative)).identity.fileID).toBe(f.spec.disks.data.fileID)
        await expect(fs.writeFile(file, "bad")).rejects.toThrow()
        await expect(fs.rename(file, file + ".moved")).rejects.toThrow()
        await expect(fs.rename(path.dirname(file), path.dirname(file) + ".moved")).rejects.toThrow()
        await io.release()
        await fs.appendFile(file, " released")
        await fs.rename(file, file + ".moved")
        await fs.rename(file + ".moved", file)
      },
    )
  } finally {
    await f.close()
  }
})

test("v2 partial group failure releases prior files and never permits path escape", async () => {
  expect(api).toBeDefined()
  const f = await desktopV2Fixture()
  try {
    const proof = await readDesktopDirectoryV2(f.root),
      file = f.spec.disks.data.path,
      relative = path.relative(f.root, file)
    await api!.withDesktopPublicationV2(
      { root: f.root, mode: "read", parents: proof.parents, signal: AbortSignal.timeout(10000) },
      async (io) => {
        await expect(io.acquire([relative, "missing.json"])).rejects.toThrow()
        await fs.appendFile(file, " after partial failure")
        await expect(io.acquire(["..\\owner.json"])).rejects.toThrow()
        await expect(io.write("anything", "unapproved")).rejects.toThrow()
        await io.acquire([relative])
        await io.release()
      },
    )
  } finally {
    await f.close()
  }
})
