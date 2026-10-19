import fs from "node:fs/promises"
import path from "node:path"
import type { BigIntStats } from "node:fs"
import { sha256Bytes } from "../../hash"
import { canonicalDesktopPath } from "./compatibility"

/** Deliberately versioned: legacy Number-based identities must never consume these strings. */
export function desktopIdentityV2(stat: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">) {
  if ([stat.dev, stat.ino, stat.birthtimeNs].some((v) => typeof v !== "bigint" || v < 0n))
    throw new TypeError("TASK24_DESKTOP_V2_IDENTITY")
  return `v2:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

export async function readDesktopDirectoryV2(directory: string) {
  // Metadata-only drive-root observation, never a publication/write scope.
  if (!/^[dD]:\\$/.test(directory)) canonicalDesktopPath(directory)
  const ids: Record<string, string> = {}
  let current = path.parse(directory).root
  const drive = await fs.lstat(current, { bigint: true })
  const driveReal = (await fs.realpath(current)).toLowerCase()
  // Bun on Windows reports realpath("D:\\") as "D:"; only this drive-root spelling is equivalent.
  if (
    !drive.isDirectory() ||
    drive.isSymbolicLink() ||
    (driveReal !== current.toLowerCase() && driveReal !== current.slice(0, -1).toLowerCase())
  )
    throw new TypeError("TASK24_DESKTOP_V2_DIRECTORY")
  ids[current] = desktopIdentityV2(drive)
  for (const part of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stat = await fs.lstat(current, { bigint: true })
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(current)).toLowerCase() !== current.toLowerCase()
    )
      throw new TypeError("TASK24_DESKTOP_V2_DIRECTORY")
    ids[current] = desktopIdentityV2(stat)
  }
  const stat = await fs.lstat(directory, { bigint: true })
  if (ids[directory] !== desktopIdentityV2(stat)) throw new TypeError("TASK24_DESKTOP_V2_DIRECTORY_DRIFT")
  return Object.freeze({
    path: directory,
    fileID: ids[directory]!,
    volumeID: String(stat.dev),
    parents: Object.freeze(ids),
  })
}

export async function readDesktopFileV2(file: string, maxBytes = 1048576) {
  canonicalDesktopPath(file)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("TASK24_DESKTOP_V2_LIMIT")
  const parent = await readDesktopDirectoryV2(path.dirname(file))
  const before = await fs.lstat(file, { bigint: true })
  const valid = (s: BigIntStats) => s.isFile() && !s.isSymbolicLink() && s.nlink === 1n && s.size <= BigInt(maxBytes)
  if (!valid(before) || (await fs.realpath(file)).toLowerCase() !== file.toLowerCase())
    throw new TypeError("TASK24_DESKTOP_V2_FILE")
  const handle = await fs.open(file, "r")
  try {
    const opened = await handle.stat({ bigint: true })
    if (!valid(opened) || desktopIdentityV2(opened) !== desktopIdentityV2(before))
      throw new TypeError("TASK24_DESKTOP_V2_FILE_DRIFT")
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const named = await fs.lstat(file, { bigint: true })
    const stamp = (s: BigIntStats) => `${desktopIdentityV2(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.nlink}`
    if (
      !valid(after) ||
      stamp(before) !== stamp(after) ||
      stamp(after) !== stamp(named) ||
      bytes.length > maxBytes ||
      JSON.stringify(parent) !== JSON.stringify(await readDesktopDirectoryV2(path.dirname(file)))
    )
      throw new TypeError("TASK24_DESKTOP_V2_FILE_DRIFT")
    return Object.freeze({
      identity: Object.freeze({ path: file, fileID: desktopIdentityV2(after), sha256: sha256Bytes(bytes) }),
      bytes,
    })
  } finally {
    await handle.close()
  }
}
