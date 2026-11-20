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
    await linkWithRetry(staging, file)
    await verifyExisting(file, bytes)
  } finally {
    await discardStaging(staging)
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
    const bytes = await readPublished(staging)
    if (sha256Bytes(bytes) !== match.groups.sha) {
      await fs.rm(staging, { force: true })
      discarded++
      continue
    }
    if (await exists(target)) {
      const targetBytes = await readPublished(target)
      if (!targetBytes.equals(bytes)) throw new TypeError("TASK24_ATOMIC_TARGET_CONFLICT")
      await discardStaging(staging)
      discarded++
      continue
    }
    const created = await linkWithRetry(staging, target)
    const targetBytes = await readPublished(target)
    if (!targetBytes.equals(bytes)) throw new TypeError("TASK24_ATOMIC_TARGET_CONFLICT")
    await discardStaging(staging)
    if (created) promoted++
    else discarded++
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
  const actual = await readPublished(file)
  if (!actual.equals(expected)) throw new TypeError("TASK24_ATOMIC_TARGET_CONFLICT")
}

async function exists(file: string): Promise<boolean> {
  const deadline = Date.now() + retryWindowMs
  for (;;) {
    try {
      await fs.access(file)
      return true
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false
      if (!retryableLink(cause) || Date.now() >= deadline) throw cause
      await pauseForRetry()
    }
  }
}

const retryableLinkCodes = new Set(["EBUSY", "EPERM", "EACCES", "EEXIST"])
const retryWindowMs = 10_000
const linkRetryWindowMs = 120_000

async function linkWithRetry(source: string, target: string): Promise<boolean> {
  const deadline = Date.now() + linkRetryWindowMs
  for (;;) {
    try {
      await fs.link(source, target)
      return true
    } catch (cause) {
      if (await exists(target)) return false
      if (!retryableLink(cause) || Date.now() >= deadline) throw cause
      await pauseForRetry()
    }
  }
}

async function readPublished(file: string): Promise<Buffer> {
  const deadline = Date.now() + retryWindowMs
  for (;;) {
    try {
      return await fs.readFile(file)
    } catch (cause) {
      if (!retryableLink(cause) || Date.now() >= deadline) throw cause
      await pauseForRetry()
    }
  }
}

async function discardStaging(file: string): Promise<void> {
  const deadline = Date.now() + 2_000
  for (;;) {
    try {
      await fs.rm(file, { force: true })
      return
    } catch (cause) {
      if (!retryableLink(cause) || Date.now() >= deadline) return
      await pauseForRetry()
    }
  }
}

function retryableLink(cause: unknown): boolean {
  if (!(cause instanceof Error) || !("code" in cause)) return false
  return typeof cause.code === "string" && retryableLinkCodes.has(cause.code)
}

async function pauseForRetry(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 75)))
}
