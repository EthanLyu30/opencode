import fs from "node:fs/promises"
import path from "node:path"

export async function prepareBuildOutput(requested: string, workspace: string): Promise<string> {
  if (!path.isAbsolute(requested)) throw new Error("Build output must be absolute")
  const target = path.resolve(requested)
  if (
    target === path.parse(target).root ||
    path.parse(target).root.toLowerCase() !== path.parse(path.resolve(workspace)).root.toLowerCase()
  )
    throw new Error("Build output must be a non-root path on the workspace drive")
  let ancestor = path.dirname(target)
  while (true) {
    const stat = await fs.lstat(ancestor)
    const real = await fs.realpath(ancestor)
    const canonical = process.platform === "win32" && /^[a-z]:$/i.test(real) ? real + "\\" : real
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      canonical.toLowerCase() !== path.resolve(ancestor).toLowerCase()
    )
      throw new Error("Build output ancestry must be canonical and unlinked")
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  // Exclusive creation: an existing directory, even empty, is never cleaned or overwritten.
  await fs.mkdir(target)
  return target
}
