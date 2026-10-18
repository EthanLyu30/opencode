import path from "node:path"
import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createHash } from "node:crypto"
import { fileIdentity } from "../storage"
import { canonicalDesktopPath } from "./compatibility"
import type { FileIdentity } from "../contracts"

export const desktopProbeSupervisor = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const systemImages = new Set([
  desktopProbeSupervisor,
  "C:\\Windows\\System32\\wsl.exe",
  "C:\\Program Files\\Git\\cmd\\git.exe",
])
/** Data only; execution still needs the worker's non-write/delete-sharing handles and post-pin comparison. */
export async function readDesktopProbeImage(exe: string): Promise<FileIdentity> {
  if (!/^[cC]:/.test(exe)) return fileIdentity(canonicalDesktopPath(exe))
  if (!systemImages.has(exe)) throw new TypeError("TASK24_DESKTOP_PROBE_IMAGE_SCOPE")
  canonicalDesktopPath(exe, "C")
  let current = path.parse(exe).root
  for (const part of path.relative(current, path.dirname(exe)).split(path.sep)) {
    current = path.join(current, part)
    const s = await fs.lstat(current)
    if (!s.isDirectory() || s.isSymbolicLink() || (await fs.realpath(current)).toLowerCase() !== current.toLowerCase())
      throw new TypeError("TASK24_DESKTOP_PROBE_IMAGE_SCOPE")
  }
  const before = await fs.lstat(exe)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > 33554432 ||
    (await fs.realpath(exe)).toLowerCase() !== exe.toLowerCase()
  )
    throw new TypeError("TASK24_DESKTOP_PROBE_IMAGE_SCOPE")
  const hash = createHash("sha256")
  for await (const part of createReadStream(exe)) hash.update(part)
  const after = await fs.lstat(exe)
  const key = (s: typeof before) => `${s.dev}:${s.ino}:${s.birthtimeMs}:${s.size}:${s.mtimeMs}:${s.nlink}`
  if (key(before) !== key(after)) throw new TypeError("TASK24_DESKTOP_PROBE_IMAGE_DRIFT")
  return { path: exe, fileID: `${before.dev}:${before.ino}:${before.birthtimeMs}`, sha256: hash.digest("hex") }
}
