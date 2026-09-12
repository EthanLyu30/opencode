import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { sha256Bytes, sha256Text } from "../hash"
import {
  assertSafeRelativePath,
  assertUniqueFiles,
  decodeLicenses,
  decodeTaskManifest,
  type FileEntry,
  type TaskManifest,
} from "./manifest"

export interface BundleFile {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

export interface ValidatedBundle {
  readonly root: string
  readonly manifest: TaskManifest
  readonly files: readonly BundleFile[]
  readonly bundleSha256: string
  readonly goldSha256: string
}

export async function validateTaskBundle(bundleRoot: string): Promise<ValidatedBundle> {
  const root = await canonicalDirectory(bundleRoot)
  const [taskBytes, licenseBytes] = await Promise.all([
    readDirectFile(root, "task.json"),
    readDirectFile(root, "LICENSES.json"),
  ])
  const manifest = decodeTaskManifest(JSON.parse(taskBytes.toString("utf8")))
  decodeLicenses(JSON.parse(licenseBytes.toString("utf8")))
  if (sha256Bytes(licenseBytes) !== manifest.licensesSha256) throw new TypeError("TASK24_LICENSE_HASH_MISMATCH")
  assertUniqueFiles(manifest.workspaceFiles, "TASK24_STARTER")
  assertUniqueFiles(manifest.publicAssets, "TASK24_ASSETS")
  assertUniqueFiles(manifest.goldFiles, "TASK24_GOLD")

  const starter = await collectDeclaredTree(root, "starter", manifest.workspaceFiles)
  const assets = await collectDeclaredTree(root, "assets", manifest.publicAssets, true)
  const gold = await collectDeclaredTree(root, "gold", manifest.goldFiles)
  assertPromptSafe(
    manifest,
    gold,
    await Promise.all(gold.map((file) => readFile(path.join(root, "gold", ...file.path.split("/"))))),
  )

  const files = Object.freeze(
    [
      { path: "LICENSES.json", sha256: sha256Bytes(licenseBytes), size: licenseBytes.byteLength },
      ...assets.map((file) => ({ ...file, path: `assets/${file.path}` })),
      ...gold.map((file) => ({ ...file, path: `gold/${file.path}` })),
      ...starter.map((file) => ({ ...file, path: `starter/${file.path}` })),
      { path: "task.json", sha256: sha256Bytes(taskBytes), size: taskBytes.byteLength },
    ].toSorted((left, right) => compareText(left.path, right.path)),
  )
  const goldSha256 = sha256Text(canonicalJson(gold))
  const bundleSha256 = sha256Text(canonicalJson(files))
  return deepFreeze({ root, manifest, files, goldSha256, bundleSha256 })
}

async function canonicalDirectory(input: string): Promise<string> {
  const resolved = path.resolve(input)
  const stat = await lstat(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("TASK24_BUNDLE_ROOT_LINK_UNSAFE")
  const canonical = await realpath(resolved)
  if (canonical.toLowerCase() !== resolved.toLowerCase()) throw new TypeError("TASK24_BUNDLE_ROOT_REPARSE_UNSAFE")
  return canonical
}

async function readDirectFile(root: string, relative: string): Promise<Buffer> {
  const file = path.join(root, relative)
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("TASK24_BUNDLE_FILE_LINK_UNSAFE")
  if ((await realpath(file)).toLowerCase() !== file.toLowerCase())
    throw new TypeError("TASK24_BUNDLE_FILE_REPARSE_UNSAFE")
  return readFile(file)
}

async function collectDeclaredTree(
  root: string,
  name: "starter" | "assets" | "gold",
  declared: readonly FileEntry[],
  optional = false,
): Promise<readonly BundleFile[]> {
  const directory = path.join(root, name)
  try {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError(`TASK24_${name.toUpperCase()}_LINK_UNSAFE`)
    if ((await realpath(directory)).toLowerCase() !== directory.toLowerCase()) {
      throw new TypeError(`TASK24_${name.toUpperCase()}_REPARSE_UNSAFE`)
    }
  } catch (cause) {
    const code = cause !== null && typeof cause === "object" ? Reflect.get(cause, "code") : undefined
    if (optional && code === "ENOENT" && declared.length === 0) return []
    throw cause
  }

  const actual = await walkFiles(directory)
  const expected = new Map(declared.map((entry) => [entry.path.toLowerCase(), entry]))
  for (const file of actual) {
    const declaration = expected.get(file.path.toLowerCase())
    if (declaration === undefined) throw new TypeError(`TASK24_${name.toUpperCase()}_UNDECLARED_FILE`)
    if (declaration.path !== file.path || declaration.sha256 !== file.sha256 || declaration.size !== file.size) {
      throw new TypeError(`TASK24_${name.toUpperCase()}_HASH_OR_SIZE_MISMATCH`)
    }
    expected.delete(file.path.toLowerCase())
  }
  if (expected.size > 0) throw new TypeError(`TASK24_${name.toUpperCase()}_DECLARED_FILE_MISSING`)
  return Object.freeze(actual)
}

async function walkFiles(root: string): Promise<BundleFile[]> {
  const result: BundleFile[] = []
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.toSorted((left, right) => compareText(left.name, right.name))) {
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new TypeError("TASK24_BUNDLE_LINK_OR_REPARSE_UNSAFE")
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      assertSafeRelativePath(relative)
      if (entry.isDirectory()) {
        if ((await realpath(file)).toLowerCase() !== file.toLowerCase()) {
          throw new TypeError("TASK24_BUNDLE_LINK_OR_REPARSE_UNSAFE")
        }
        await walk(file, relative)
        continue
      }
      if (!entry.isFile()) throw new TypeError("TASK24_BUNDLE_ENTRY_TYPE_UNSAFE")
      const stat = await lstat(file)
      if (stat.isSymbolicLink() || (await realpath(file)).toLowerCase() !== file.toLowerCase()) {
        throw new TypeError("TASK24_BUNDLE_LINK_OR_REPARSE_UNSAFE")
      }
      const bytes = await readFile(file)
      if (bytes.byteLength !== stat.size) throw new TypeError("TASK24_BUNDLE_FILE_CHANGED")
      result.push({ path: relative, sha256: sha256Bytes(bytes), size: bytes.byteLength })
    }
  }
  await walk(root, "")
  return result.toSorted((left, right) => compareText(left.path, right.path))
}

function assertPromptSafe(manifest: TaskManifest, gold: readonly BundleFile[], bytes: readonly Buffer[]): void {
  const prompt = manifest.prompt
  const lower = prompt.toLowerCase()
  const forbidden = [
    /expected\s+dom\s+snapshot/i,
    /reference\s+image\s+bytes/i,
    /evaluator\s+command/i,
    /playwright\s+test\s+--update-snapshots/i,
    /(?:^|[\\/])gold(?:[\\/]|$)/i,
  ]
  if (forbidden.some((pattern) => pattern.test(prompt))) throw new TypeError("TASK24_PROMPT_GOLD_LEAK")
  for (let index = 0; index < gold.length; index++) {
    const file = gold[index]!
    const value = bytes[index]!
    if (lower.includes(file.sha256)) throw new TypeError("TASK24_PROMPT_GOLD_HASH_LEAK")
    if (value.byteLength > 0 && value.byteLength <= 64 * 1024 && prompt.includes(value.toString("base64"))) {
      throw new TypeError("TASK24_PROMPT_GOLD_BYTES_LEAK")
    }
  }
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value)
    Object.freeze(input)
  }
  return input
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
