import fs from "node:fs/promises"
import path from "node:path"

/** Refuse aliases on every ancestor, not merely the final leaf. */
export async function directRoot(root: string): Promise<string> {
  const absolute = path.resolve(root)
  if (!/^d:\\/i.test(absolute) && process.platform === "win32") throw new TypeError("TASK24_ROOT_VOLUME")
  let current = path.parse(absolute).root
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (await fs.realpath(current)).toLowerCase() !== current.toLowerCase()
    )
      throw new TypeError("TASK24_ROOT_LINK")
  }
  return absolute
}
