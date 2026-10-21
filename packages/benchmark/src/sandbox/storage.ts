import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { Schema } from "effect"
import { directRoot } from "../corpus/evaluation-bundle"
import { freeze } from "../corpus/evaluation-profile"
import {
  requireDPath,
  StorageRecord,
  type Gate,
  type StorageProof,
  type FileIdentity,
  type HostRequest,
} from "./contracts"

export function verifyStorageProof(input: unknown): StorageProof {
  const value = Schema.decodeUnknownSync(StorageRecord)(input, { onExcessProperty: "error" })
  requireDPath(value.disk.path)
  requireDPath(value.dataRoot)
  if (value.swap.kind === "file") requireDPath(value.swap.file.path)
  return freeze(value)
}
export function storageIdentity(value: StorageProof | null) {
  if (value === null) return null
  const { observedAt, ...identity } = value
  return identity
}
export async function fileIdentity(file: string): Promise<FileIdentity> {
  requireDPath(file)
  await directRoot(path.dirname(file))
  return readFileIdentity(file)
}
async function readFileIdentity(file: string): Promise<FileIdentity> {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new TypeError("TASK24_LINUX_FILE_IDENTITY")
  const hasher = createHash("sha256")
  for await (const chunk of createReadStream(file)) hasher.update(chunk)
  const after = await fs.lstat(file)
  if (
    `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.size}:${stat.mtimeMs}` !==
    `${after.dev}:${after.ino}:${after.birthtimeMs}:${after.size}:${after.mtimeMs}`
  )
    throw new TypeError("TASK24_LINUX_FILE_DRIFT")
  return freeze({
    path: file,
    fileID: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
    sha256: hasher.digest("hex"),
  })
}
/** Only the system WSL launcher is an allowed C-drive executable; ordinary files remain D-only. */
export async function hostCliIdentity(request: HostRequest) {
  if (!request.wsl2 || request.cli.path !== "C:\\Windows\\System32\\wsl.exe") return fileIdentity(request.cli.path)
  if ((await fs.realpath(request.cli.path)).toLowerCase() !== request.cli.path.toLowerCase())
    throw new TypeError("TASK24_WSL2_LAUNCHER")
  return readFileIdentity(request.cli.path)
}
export async function directoryIdentity(directory: string): Promise<string> {
  requireDPath(directory)
  await directRoot(directory)
  const stat = await fs.stat(directory)
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
}
export async function inspectStorage(input: unknown): Promise<Gate<StorageProof>> {
  try {
    const value = verifyStorageProof(input)
    await directRoot(value.dataRoot)
    const base = await fs.stat(value.dataRoot)
    for (const file of [value.disk, ...(value.swap.kind === "file" ? [value.swap.file] : [])]) {
      await directRoot(path.dirname(file.path))
      if (file.fileID.startsWith("wsl2:")) {
        const stat = await fs.lstat(file.path, { bigint: true })
        const root = await fs.stat(value.dataRoot, { bigint: true })
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1n ||
          `wsl2:${stat.dev}:${stat.ino}:${stat.birthtimeNs}` !== file.fileID ||
          String(stat.dev) !== file.volumeID ||
          stat.dev !== root.dev
        )
          throw new TypeError("TASK24_LINUX_STORAGE_IDENTITY")
        continue
      }
      const stat = await fs.lstat(file.path)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== file.fileID ||
        String(stat.dev) !== file.volumeID ||
        stat.dev !== base.dev
      )
        throw new TypeError("TASK24_LINUX_STORAGE_IDENTITY")
    }
    return { kind: "ready", value }
  } catch {
    return { kind: "blocked", code: "engine_storage_not_verified", missing: ["engine_storage_not_verified"] }
  }
}
