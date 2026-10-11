import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { prepareBuildOutput } from "../../script/output-directory"

test("fresh build output creates only a new canonical same-drive directory", async () => {
  await using temporary = await tmpdir()
  const target = path.join(temporary.path, "new-build")
  expect(await prepareBuildOutput(target, temporary.path)).toBe(target)
  expect(await fs.readdir(target)).toEqual([])
})

test("fresh build output refuses existing directories without deleting their inputs", async () => {
  await using temporary = await tmpdir()
  const sentinel = path.join(temporary.path, "user-input.txt")
  await fs.writeFile(sentinel, "keep")
  await expect(prepareBuildOutput(temporary.path, temporary.path)).rejects.toThrow()
  expect(await fs.readFile(sentinel, "utf8")).toBe("keep")
})

test("fresh build output refuses relative paths and filesystem roots", async () => {
  await using temporary = await tmpdir()
  await expect(prepareBuildOutput("relative-build", temporary.path)).rejects.toThrow()
  await expect(prepareBuildOutput(path.parse(temporary.path).root, temporary.path)).rejects.toThrow()
})

test("fresh build output refuses a missing parent without creating a broader tree", async () => {
  await using temporary = await tmpdir()
  const parent = path.join(temporary.path, "missing-parent")
  await expect(prepareBuildOutput(path.join(parent, "build"), temporary.path)).rejects.toThrow()
  expect(await fs.exists(parent)).toBe(false)
})

test("fresh build output refuses linked ancestry without writing into its target", async () => {
  await using temporary = await tmpdir()
  const foreign = path.join(temporary.path, "foreign")
  const link = path.join(temporary.path, "linked")
  await fs.mkdir(foreign)
  await fs.symlink(foreign, link, process.platform === "win32" ? "junction" : "dir")
  await expect(prepareBuildOutput(path.join(link, "build"), temporary.path)).rejects.toThrow()
  expect(await fs.readdir(foreign)).toEqual([])
})

test.skipIf(process.platform !== "win32")(
  "fresh build output refuses a different drive before filesystem access",
  async () => {
    await using temporary = await tmpdir()
    const other = path.parse(temporary.path).root.toLowerCase() === "d:\\" ? "C:\\" : "D:\\"
    await expect(prepareBuildOutput(path.join(other, "not-created-build"), temporary.path)).rejects.toThrow()
  },
)
