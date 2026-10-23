import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { sha256Bytes, sha256Text } from "../hash"
import {
  decodeEvaluationOracle,
  decodeTaskExecutionProfile,
  freeze,
  safePath,
  type EvaluationOracle,
  type TaskExecutionProfile,
} from "./evaluation-profile"
import { decodeTaskManifest, type FileEntry } from "./manifest"
import sharp from "sharp"
import { directRoot } from "./direct-root"
export { directRoot } from "./direct-root"

export type ValidatedEvaluationBundle = Readonly<{
  root: string
  profile: TaskExecutionProfile
  oracle: EvaluationOracle
  profileSha256: string
  oracleSha256: string
  seedSha256: string
  publicFixtureSha256: string
  bundleSha256: string
}>
export type PublicEvaluationTask = Readonly<{
  profile: TaskExecutionProfile
  files: readonly Readonly<{ path: string; base64: string; sha256: string }>[]
}>
const publicBytes = new WeakMap<ValidatedEvaluationBundle, PublicEvaluationTask["files"]>()

export async function ordinaryFiles(root: string, maxFiles = 20000): Promise<readonly FileEntry[]> {
  await directRoot(root)
  const files: FileEntry[] = []
  const keys = new Set<string>()
  async function walk(relative: string): Promise<void> {
    for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
      const rel = relative ? `${relative}/${name}` : name
      safePath(rel)
      const key = rel.toLowerCase()
      if (keys.has(key)) throw new TypeError("TASK24_PATH_COLLISION")
      keys.add(key)
      const full = path.join(root, rel)
      const stat = await fs.lstat(full)
      if (stat.isSymbolicLink() || (await fs.realpath(full)).toLowerCase() !== full.toLowerCase())
        throw new TypeError("TASK24_FILE_LINK")
      if (stat.isDirectory()) {
        await walk(rel)
        continue
      }
      if (!stat.isFile() || stat.nlink !== 1) throw new TypeError("TASK24_FILE_LINK")
      if (stat.size > 8 * 1024 * 1024 || files.length >= maxFiles) throw new TypeError("TASK24_FILE_LIMIT")
      const bytes = await fs.readFile(full)
      if (bytes.length !== stat.size) throw new TypeError("TASK24_FILE_DRIFT")
      files.push({ path: rel, size: bytes.length, sha256: sha256Bytes(bytes) })
    }
  }
  await walk("")
  if (files.reduce((sum, f) => sum + f.size, 0) > 64 * 1024 * 1024) throw new TypeError("TASK24_TOTAL_LIMIT")
  return freeze(files)
}
export async function loadEvaluationBundle(root: string): Promise<ValidatedEvaluationBundle> {
  root = await directRoot(root)
  const actual = await ordinaryFiles(root)
  const profile = decodeTaskExecutionProfile(JSON.parse(await fs.readFile(path.join(root, "profile.json"), "utf8")))
  const oracle = decodeEvaluationOracle(JSON.parse(await fs.readFile(path.join(root, "oracle.json"), "utf8")))
  if (
    profile.taskID !== oracle.taskID ||
    profile.kind !== oracle.kind ||
    oracle.cases.some((c) => !profile.probeModules.includes(c.module))
  )
    throw new TypeError("TASK24_BUNDLE_IDENTITY")
  const declared = [...profile.publicInputs, ...oracle.privateFiles]
  for (const f of actual)
    if (!["profile.json", "oracle.json"].includes(f.path) && !declared.some((v) => v.path === f.path))
      throw new TypeError("TASK24_UNDECLARED_FILE")
  for (const f of declared)
    if (!actual.some((a) => a.path === f.path && a.sha256 === f.sha256 && a.size === f.size))
      throw new TypeError("TASK24_BUNDLE_HASH")
  const files = []
  let authorizedReferences: readonly FileEntry[] = [],
    authorizedSeed: readonly FileEntry[] = []
  if (oracle.publicReferenceManifest) {
    const declaration = oracle.publicReferenceManifest
    if (!oracle.privateFiles.some((f) => canonicalJson(f) === canonicalJson(declaration)))
      throw new TypeError("TASK24_PUBLIC_SOURCE_UNDECLARED")
    const bytes = await fs.readFile(path.join(root, declaration.path))
    if (sha256Bytes(bytes) !== declaration.sha256) throw new TypeError("TASK24_PUBLIC_SOURCE_DRIFT")
    const source = decodeTaskManifest(JSON.parse(bytes.toString("utf8")))
    if (source.id !== profile.taskID) throw new TypeError("TASK24_PUBLIC_SOURCE_IDENTITY")
    authorizedReferences = source.publicAssets
    authorizedSeed = source.workspaceFiles
  }
  for (const f of profile.publicInputs) {
    if (f.purpose === "reference") {
      if (
        !/^public\/assets\/[A-Za-z0-9._/-]+\.(png|jpe?g|webp)$/i.test(f.path) ||
        !authorizedReferences.some(
          (a) => `public/assets/${a.path}` === f.path && a.sha256 === f.sha256 && a.size === f.size,
        )
      )
        throw new TypeError("TASK24_PUBLIC_REFERENCE_UNAUTHORIZED")
      const meta = await sharp(path.join(root, f.path)).metadata()
      if (!["png", "jpeg", "webp"].includes(meta.format ?? "") || !meta.width || !meta.height)
        throw new TypeError("TASK24_PUBLIC_REFERENCE_INVALID")
    }
    if (
      f.purpose !== "reference" &&
      oracle.privateFiles.some((v) => v.sha256 === f.sha256) &&
      !authorizedSeed.some((s) => `public/${s.path}` === f.path && s.sha256 === f.sha256 && s.size === f.size)
    )
      throw new TypeError("TASK24_PUBLIC_LEAK")
    const bytes = await fs.readFile(path.join(root, f.path))
    if (sha256Bytes(bytes) !== f.sha256) throw new TypeError("TASK24_BUNDLE_DRIFT")
    files.push({ path: f.path.slice(7), base64: bytes.toString("base64"), sha256: f.sha256 })
  }
  const profileSha256 = sha256Text(canonicalJson(profile)),
    oracleSha256 = sha256Text(canonicalJson(oracle))
  const publicFixtureSha256 = sha256Text(canonicalJson(profile.publicInputs)),
    seedSha256 = profile.seedSha256
  const bundle = freeze({
    root,
    profile,
    oracle,
    profileSha256,
    oracleSha256,
    seedSha256,
    publicFixtureSha256,
    bundleSha256: sha256Text(canonicalJson({ profileSha256, oracleSha256, publicFixtureSha256, seedSha256 })),
  })
  publicBytes.set(bundle, freeze(files))
  return bundle
}
export function exportPublicTask(bundle: ValidatedEvaluationBundle): PublicEvaluationTask {
  const files = publicBytes.get(bundle)
  if (!files) throw new TypeError("TASK24_UNVALIDATED_BUNDLE")
  return freeze({ profile: bundle.profile, files })
}
