import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { desktopFixture } from "./desktop-fixture"
import { directoryIdentity, fileIdentity } from "../../src/sandbox/storage"
import { withDesktopPublication, withDesktopRecordPublication } from "../../src/sandbox/desktop/publication"

test("parent and freshly created root cannot be exchanged between claim and file publication", async () => {
  const f = await desktopFixture()
  try {
    const outside = path.join(f.root, "outside")
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, "sentinel"), "user-owned")
    const parentID = await directoryIdentity(f.root)
    await withDesktopPublication(
      f.spec.profileRoot,
      "create",
      async (publication) => {
        await expect(fs.rename(f.root, f.root + "-displaced")).rejects.toThrow()
        await expect(fs.rename(f.spec.profileRoot, path.join(f.root, "replaced"))).rejects.toThrow()
        await publication.write("owner.json", "owned")
        await publication.directories()
        await expect(
          fs.rename(path.join(f.spec.profileRoot, "state"), path.join(f.root, "old-state")),
        ).rejects.toThrow()
        const lock = await publication.write("state\\active.json", "known-lock")
        await publication.remove(lock)
        expect(await fs.exists(lock.path)).toBe(false)
      },
      { parentIdentity: parentID },
    )
    expect(await fs.readFile(path.join(f.spec.profileRoot, "owner.json"), "utf8")).toBe("owned")
    expect(await fs.readdir(outside)).toEqual(["sentinel"])
    expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe("user-owned")
  } finally {
    await f.close()
  }
})

test("record layout holds report ancestors and only creates its exclusive inventory leaf", async () => {
  const f = await desktopFixture()
  try {
    const anchor = { path: f.root, identity: await directoryIdentity(f.root) }
    const root = path.join(f.root, "reports", "desktop-launch", "owned-record")
    await withDesktopRecordPublication(
      root,
      async (publication) => {
        await expect(fs.rename(f.root, f.root + "-displaced")).rejects.toThrow()
        await expect(fs.rename(path.dirname(root), path.join(f.root, "moved-reports"))).rejects.toThrow()
        await expect(publication.directories()).rejects.toThrow()
        await expect(publication.write("owner.json", "unexpected")).rejects.toThrow()
        const file = await publication.write("inventory.json", "historical-data-only")
        await expect(publication.remove(file)).rejects.toThrow()
      },
      anchor,
    )
    expect(await fs.readdir(root)).toEqual(["inventory.json"])
    expect(await fs.exists(path.join(root, "state"))).toBe(false)
    const refused = path.join(f.root, "reports", "desktop-launch", "wrong-ancestor")
    await expect(
      withDesktopRecordPublication(
        refused,
        async (p) => {
          await p.write("inventory.json", "must-not-write")
        },
        { ...anchor, identity: "wrong-identity" },
      ),
    ).rejects.toThrow()
    expect(await fs.exists(refused)).toBe(false)
  } finally {
    await f.close()
  }
})

test("atomic directory claim never adopts a foreign ordinary directory or a junction", async () => {
  for (const kind of ["ordinary", "junction"]) {
    const f = await desktopFixture()
    try {
      const outside = path.join(f.root, "outside")
      await fs.mkdir(outside)
      await fs.writeFile(path.join(outside, "sentinel"), "user-owned")
      if (kind === "ordinary") {
        await fs.mkdir(f.spec.profileRoot)
        await fs.writeFile(path.join(f.spec.profileRoot, "sentinel"), "foreign")
      } else await fs.symlink(outside, f.spec.profileRoot, "junction")
      await expect(
        withDesktopPublication(f.spec.profileRoot, "create", async (publication) => {
          await publication.write("owner.json", "must-not-write")
        }),
      ).rejects.toThrow()
      expect(await fs.exists(path.join(f.spec.profileRoot, "owner.json"))).toBe(false)
      expect(await fs.readdir(outside)).toEqual(["sentinel"])
    } finally {
      await f.close()
    }
  }
})

test("publication rejects path escape and cannot remove a substituted lock", async () => {
  const f = await desktopFixture()
  try {
    const outside = path.join(f.root, "sentinel")
    await fs.writeFile(outside, "user-owned")
    await withDesktopPublication(f.spec.profileRoot, "create", async (publication) => {
      for (const relative of ["..\\sentinel", outside, "state\\..\\owner.json", "owner.json:alternate"])
        await expect(publication.write(relative, "must-not-write")).rejects.toThrow()
      await publication.directories()
      const lock = await publication.write("state\\active.json", "known-lock")
      await expect(fs.rename(lock.path, path.join(f.root, "moved-lock"))).rejects.toThrow()
    })
    const lock = await fileIdentity(path.join(f.spec.profileRoot, "state", "active.json"))
    await fs.unlink(lock.path)
    await fs.writeFile(lock.path, "substituted")
    await withDesktopPublication(f.spec.profileRoot, "existing", async (publication) => {
      // Await IPC outside Bun's .rejects matcher: that matcher can starve an already-open Windows pipe.
      const refused = await publication.remove(lock).then(
        () => false,
        () => true,
      )
      expect(refused).toBe(true)
    })
    expect(await fs.readFile(lock.path, "utf8")).toBe("substituted")
    expect(await fs.readFile(outside, "utf8")).toBe("user-owned")
  } finally {
    await f.close()
  }
})
