import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { directRoot } from "../corpus/evaluation-bundle"
import { freeze } from "../corpus/evaluation-profile"
import { requireDPath, StorageRecord, type Gate, type StorageProof, type FileIdentity } from "./contracts"
import { sha256Bytes } from "../hash"

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
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new TypeError("TASK24_LINUX_FILE_IDENTITY")
  return freeze({
    path: file,
    fileID: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
    sha256: sha256Bytes(await fs.readFile(file)),
  })
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
