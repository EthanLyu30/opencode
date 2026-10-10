import fs from "node:fs/promises"
import path from "node:path"
import { sha256Bytes, sha256Text } from "../hash"
import { task24CrashCheckpoint } from "../run/crash-hook"

const stagingPattern = /^(?<target>.+)\.task24-(?<sha>[a-f0-9]{64})-(?<nonce>[0-9a-f-]{36})\.tmp$/

export async function publishImmutable(file: string, body: string | Uint8Array): Promise<void> {
  const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body)
  const expectedSha = typeof body === "string" ? sha256Text(body) : sha256Bytes(bytes)
  await fs.mkdir(path.dirname(file), { recursive: true })
  if (await exists(file)) return verifyExisting(file, bytes)
  const staging = `${file}.task24-${expectedSha}-${crypto.randomUUID()}.tmp`
  const handle = await fs.open(staging, "wx")
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (path.basename(file) === "evaluation.json") await task24CrashCheckpoint("during_evaluation_publication")
  if (path.basename(file) === "report.json") await task24CrashCheckpoint("during_report_write")
  try {
    await fs.link(staging, file)
    await fs.rm(staging, { force: true })
  } catch (cause) {
    if (await exists(file)) {
      await verifyExisting(file, bytes)
      await fs.rm(staging, { force: true })
      return
    }
    throw cause
  }
}

export async function recoverAtomicDirectory(root: string): Promise<Readonly<{ promoted: number; discarded: number }>> {
  const resolvedRoot = path.resolve(root)
  const stat = await fs.lstat(resolvedRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("TASK24_ATOMIC_ROOT_UNSAFE")
  let promoted = 0
  let discarded = 0
  for (const entry of await fs.readdir(resolvedRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const match = stagingPattern.exec(entry.name)
    if (!match?.groups) continue
    const staging = path.join(resolvedRoot, entry.name)
    const target = path.join(resolvedRoot, match.groups.target!)
    if (path.dirname(target) !== resolvedRoot) throw new TypeError("TASK24_ATOMIC_STAGING_UNSAFE")
    const bytes = await fs.readFile(staging)
    if (sha256Bytes(bytes) !== match.groups.sha) {
      await fs.rm(staging, { force: true })
      discarded++
      continue
    }
    if (await exists(target)) {
      const targetBytes = await fs.readFile(target)
      if (!targetBytes.equals(bytes)) throw new TypeError("TASK24_ATOMIC_TARGET_CONFLICT")
      await fs.rm(staging, { force: true })
      discarded++
      continue
    }
    try {
      await fs.link(staging, target)
      await fs.rm(staging, { force: true })
      promoted++
    } catch (cause) {
      if (!(await exists(target))) throw cause
      const targetBytes = await fs.readFile(target)
      if (!targetBytes.equals(bytes)) throw new TypeError("TASK24_ATOMIC_TARGET_CONFLICT", { cause })
      await fs.rm(staging, { force: true })
      discarded++
    }
  }
  return Object.freeze({ promoted, discarded })
}

export async function recoverAtomicTree(root: string): Promise<Readonly<{ promoted: number; discarded: number }>> {
  let promoted = 0
  let discarded = 0
  const walk = async (directory: string): Promise<void> => {
    const result = await recoverAtomicDirectory(directory)
    promoted += result.promoted
    discarded += result.discarded
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new TypeError("TASK24_ATOMIC_ROOT_UNSAFE")
      if (entry.isDirectory()) await walk(path.join(directory, entry.name))
    }
  }
  await walk(path.resolve(root))
  return Object.freeze({ promoted, discarded })
}

async function verifyExisting(file: string, expected: Buffer): Promise<void> {
  const actual = await fs.readFile(file)
  if (!actual.equals(expected)) throw new TypeError("TASK24_ATOMIC_TARGET_CONFLICT")
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false
    throw cause
  }
}
