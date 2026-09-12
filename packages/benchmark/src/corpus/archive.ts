import { cp, lstat, mkdir, readlink, readdir, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { sha256File } from "../hash"

const MAX_ARCHIVE_ENTRIES = 200_000
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

export function validateArchiveEntries(entries: readonly string[]): readonly string[] {
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new TypeError("TASK24_ARCHIVE_ENTRY_COUNT_INVALID")
  }
  const normalized: string[] = []
  for (const raw of entries) {
    const value = raw.endsWith("/") ? raw.slice(0, -1) : raw
    if (
      value.length === 0 ||
      value.includes("\0") ||
      value.includes("\\") ||
      value.startsWith("/") ||
      value.includes(":")
    ) {
      throw new TypeError("TASK24_ARCHIVE_PATH_UNSAFE")
    }
    const segments = value.split("/")
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw new TypeError("TASK24_ARCHIVE_PATH_UNSAFE")
    }
    normalized.push(value)
  }
  return Object.freeze(normalized)
}

export async function safeExtractTar(input: {
  readonly archive: string
  readonly destination: string
  readonly expectedSha256: string
  readonly allowSafeInternalSymlinks?: boolean
}): Promise<{ readonly root: string; readonly entries: readonly string[] }> {
  const file = Bun.file(input.archive)
  if (!(await file.exists()) || file.size <= 0 || file.size > MAX_ARCHIVE_BYTES) {
    throw new TypeError("TASK24_ARCHIVE_SIZE_INVALID")
  }
  if ((await sha256File(input.archive)) !== input.expectedSha256) throw new TypeError("TASK24_ARCHIVE_HASH_MISMATCH")

  const listed = await tar(["-tzf", input.archive])
  const entries = validateArchiveEntries(listed.stdout.split(/\r?\n/).filter(Boolean))
  const verbose = await tar(["-tvzf", input.archive])
  for (const line of verbose.stdout.split(/\r?\n/).filter(Boolean)) {
    const type = line[0]
    if (type === "h" || (type === "l" && input.allowSafeInternalSymlinks !== true)) {
      throw new TypeError("TASK24_ARCHIVE_LINK_UNSAFE")
    }
  }

  await mkdir(input.destination, { recursive: false })
  await tar(["-xzf", input.archive, "-C", input.destination, "--no-same-owner", "--no-same-permissions"])
  await assertExtractedTreeDirect(input.destination, input.allowSafeInternalSymlinks === true)
  const top = new Set(entries.map((entry) => entry.split("/", 1)[0]))
  if (top.size !== 1) throw new TypeError("TASK24_ARCHIVE_ROOT_INVALID")
  const name = [...top][0]
  if (name === undefined) throw new TypeError("TASK24_ARCHIVE_ROOT_INVALID")
  const root = path.join(input.destination, name)
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("TASK24_ARCHIVE_ROOT_INVALID")
  return Object.freeze({ root, entries })
}

async function tar(argv: readonly string[]): Promise<{ readonly stdout: string }> {
  const child = Bun.spawn(["tar", ...argv], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new TypeError(`TASK24_ARCHIVE_TAR_FAILED:${stderr.trim()}`)
  return { stdout }
}

async function assertExtractedTreeDirect(root: string, allowSafeInternalSymlinks: boolean): Promise<void> {
  const canonicalRoot = await realpath(root)
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      const resolved = path.resolve(candidate)
      if (resolved !== canonicalRoot && !resolved.startsWith(canonicalRoot + path.sep)) {
        throw new TypeError("TASK24_ARCHIVE_PATH_UNSAFE")
      }
      if (entry.isSymbolicLink()) {
        if (!allowSafeInternalSymlinks) throw new TypeError("TASK24_ARCHIVE_LINK_UNSAFE")
        const target = await readlink(candidate)
        if (path.isAbsolute(target) || path.win32.isAbsolute(target) || target.includes(":")) {
          throw new TypeError("TASK24_ARCHIVE_LINK_UNSAFE")
        }
        const lexicalTarget = path.resolve(path.dirname(candidate), target)
        if (lexicalTarget === canonicalRoot || !lexicalTarget.startsWith(canonicalRoot + path.sep)) {
          throw new TypeError("TASK24_ARCHIVE_LINK_UNSAFE")
        }
        let actualTarget: string
        try {
          actualTarget = await realpath(lexicalTarget)
        } catch {
          throw new TypeError("TASK24_ARCHIVE_LINK_UNSAFE")
        }
        if (actualTarget === canonicalRoot || !actualTarget.startsWith(canonicalRoot + path.sep)) {
          throw new TypeError("TASK24_ARCHIVE_LINK_UNSAFE")
        }
        const targetStat = await lstat(lexicalTarget)
        if ((!targetStat.isFile() && !targetStat.isDirectory()) || targetStat.isSymbolicLink()) {
          throw new TypeError("TASK24_ARCHIVE_LINK_UNSAFE")
        }
        await rm(candidate, { force: true })
        await cp(lexicalTarget, candidate, { recursive: targetStat.isDirectory(), dereference: true })
        if (targetStat.isDirectory()) await walk(candidate)
        continue
      }
      if (entry.isDirectory()) await walk(candidate)
      else if (!entry.isFile()) throw new TypeError("TASK24_ARCHIVE_ENTRY_TYPE_UNSAFE")
    }
  }
  await walk(root)
}
