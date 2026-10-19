import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const api = await import("../../src/sandbox/desktop/identity-v2").catch(() => undefined)

test("v2 identities distinguish adjacent integers beyond Number precision", () => {
  expect(api).toBeDefined()
  const base = { dev: 17n, ino: 17169973579407207n, birthtimeNs: 1234567890123456789n }
  expect(api!.desktopIdentityV2(base)).toBe("v2:17:17169973579407207:1234567890123456789")
  expect(api!.desktopIdentityV2({ ...base, ino: 17169973579407208n })).not.toBe(api!.desktopIdentityV2(base))
})

test("v2 ancestor identity includes the physical D drive without authorizing root writes", async () => {
  expect(api).toBeDefined()
  const stat = await fs.lstat("D:\\", { bigint: true })
  expect((await api!.readDesktopDirectoryV2("D:\\")).fileID).toBe(`v2:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`)
  expect((await api!.readDesktopDirectoryV2(process.env.TMPDIR!)).parents["D:\\"]).toBe(
    `v2:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,
  )
})

test("v2 reads exact physical D identities and rejects hardlinks and C paths", async () => {
  expect(api).toBeDefined()
  const parent = process.env.TMPDIR!
  const root = await fs.mkdtemp(path.join(parent, "v2-identity-"))
  const actual = await fs.lstat(root, { bigint: true })
  try {
    const dir = await api!.readDesktopDirectoryV2(root)
    expect(dir.fileID).toBe(`v2:${actual.dev}:${actual.ino}:${actual.birthtimeNs}`)
    await fs.writeFile(path.join(root, "one"), "safe")
    const first = await api!.readDesktopFileV2(path.join(root, "one"))
    expect(new TextDecoder().decode(first.bytes)).toBe("safe")
    expect(first.identity.sha256).toBe("8b3369944dd2a3fab39e32d1aeb1f763946a458ae3e6368a46432adc8f3a0860")
    await fs.link(path.join(root, "one"), path.join(root, "two"))
    await expect(api!.readDesktopFileV2(path.join(root, "one"))).rejects.toThrow()
    await expect(api!.readDesktopDirectoryV2("C:\\Windows")).rejects.toThrow()
    await expect(api!.readDesktopFileV2(path.join(root, "two"), 3)).rejects.toThrow()
  } finally {
    if (!root.startsWith(parent + path.sep) || (await fs.lstat(root, { bigint: true })).ino !== actual.ino)
      throw Error("CLEANUP_SCOPE")
    await fs.rm(root, { recursive: true })
  }
})
