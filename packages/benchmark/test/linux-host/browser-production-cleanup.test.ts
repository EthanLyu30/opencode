import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createWindowsBrowserRoot } from "../../src/sandbox/host-isolation/windows-browser"

test("browser cleanup requires exact ownership and reports retained roots on drift", async () => {
  const create = createWindowsBrowserRoot
  expect(typeof create).toBe("function")
  const parent = await fs.mkdtemp(path.join(process.env.TMPDIR!, "browser-cleanup-"))
  try {
    const scope = await create(parent)
    const nested = path.join(scope.root, "nested")
    await fs.mkdir(nested)
    await fs.writeFile(path.join(nested, "own"), "own")
    await scope.dispose()
    expect(await fs.lstat(scope.root).catch((e) => e.code)).toBe("ENOENT")
    const drift = await create(parent)
    const original = await fs.readFile(path.join(drift.root, "owner.json"))
    await fs.writeFile(path.join(drift.root, "owner.json"), "changed")
    await expect(drift.dispose()).rejects.toMatchObject({ root: drift.root, cleanupUncertain: true })
    expect((await fs.stat(drift.root)).isDirectory()).toBe(true)
    // Only the test's original marker is restored, after verifying the exact path.
    await fs.writeFile(path.join(drift.root, "owner.json"), original)
    await drift.dispose()
  } finally {
    await fs.rm(parent, { recursive: true })
  }
})

test("browser cleanup refuses shared files and keeps the owned root intact", async () => {
  const create = createWindowsBrowserRoot
  expect(typeof create).toBe("function")
  const parent = await fs.mkdtemp(path.join(process.env.TMPDIR!, "browser-cleanup-"))
  try {
    const scope = await create(parent)
    const original = path.join(parent, "shared"),
      link = path.join(scope.root, "link")
    await fs.writeFile(original, "own fixture")
    await fs.link(original, link)
    await expect(scope.dispose()).rejects.toMatchObject({ root: scope.root, cleanupUncertain: true })
    expect(await fs.readFile(original, "utf8")).toBe("own fixture")
    await fs.unlink(link)
    await scope.dispose()
  } finally {
    await fs.rm(parent, { recursive: true })
  }
})
