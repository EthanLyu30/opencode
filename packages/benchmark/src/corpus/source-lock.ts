import { Schema } from "effect"
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { sha256Bytes, sha256Text } from "../hash"
import { Task24Root, type Task24Layout } from "../root"
import { CampaignID, HttpsUrl, IsoDateTime, Sha256 } from "../schema"
import { safeExtractTar } from "./archive"
import { assertSafeRelativePath, FileEntry } from "./manifest"

const exact = { onExcessProperty: "error" as const }
const commitPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const stableTagPattern = /^v?\d+\.\d+\.\d+$/

const UpstreamSource = Schema.Struct({
  id: CampaignID,
  kind: Schema.Literal("git"),
  repositoryUrl: HttpsUrl,
  tag: Schema.NonEmptyString,
  revision: Schema.NonEmptyString,
  archiveSha256: Sha256,
  lockedAt: IsoDateTime,
  license: Schema.NonEmptyString,
})

const DatasetSource = Schema.Struct({
  id: CampaignID,
  kind: Schema.Literal("dataset"),
  repositoryUrl: HttpsUrl,
  revision: Schema.NonEmptyString,
  subset: Schema.NonEmptyString,
  itemIDs: Schema.NonEmptyArray(Schema.NonEmptyString),
  assets: Schema.Array(FileEntry),
  normalizationVersion: Schema.NonEmptyString,
  license: Schema.NonEmptyString,
})

const SourceLockInput = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  upstream: UpstreamSource,
  datasets: Schema.Array(DatasetSource),
})

const SealedSourceLock = Schema.Struct({ ...SourceLockInput.fields, sha256: Sha256 })

export type UpstreamSource = typeof UpstreamSource.Type
export type DatasetSource = typeof DatasetSource.Type
export type SourceLockInput = typeof SourceLockInput.Type
export type SealedSourceLock = typeof SealedSourceLock.Type

export function assertImmutableRevision(revision: string): string {
  if (!commitPattern.test(revision)) throw new TypeError("Source revision must be an immutable commit hash")
  return revision
}

export function parseStableRelease(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Official release response is not a stable release")
  }
  const tag = Reflect.get(input, "tag_name")
  if (
    typeof tag !== "string" ||
    !stableTagPattern.test(tag) ||
    Reflect.get(input, "draft") !== false ||
    Reflect.get(input, "prerelease") !== false
  ) {
    throw new TypeError("Official release response is not a stable release")
  }
  return tag
}

export function lockDatasetSource(input: Omit<DatasetSource, "kind">): DatasetSource {
  const decoded = Schema.decodeUnknownSync(DatasetSource)({ ...input, kind: "dataset" }, exact)
  validateRepositoryUrl(decoded.repositoryUrl)
  assertImmutableRevision(decoded.revision)
  const items = new Set(decoded.itemIDs)
  if (items.size !== decoded.itemIDs.length) throw new TypeError("Dataset lock contains duplicate item IDs")
  const paths = new Set<string>()
  for (const asset of decoded.assets) {
    assertSafeRelativePath(asset.path)
    const key = asset.path.toLowerCase()
    if (paths.has(key)) throw new TypeError("Dataset lock contains duplicate asset paths")
    paths.add(key)
  }
  return deepFreeze({
    ...decoded,
    itemIDs: [...decoded.itemIDs],
    assets: decoded.assets.map((asset) => ({ ...asset })),
  })
}

export function decodeDatasetSource(input: unknown): DatasetSource {
  const decoded = Schema.decodeUnknownSync(DatasetSource)(input, exact)
  return lockDatasetSource({
    id: decoded.id,
    repositoryUrl: decoded.repositoryUrl,
    revision: decoded.revision,
    subset: decoded.subset,
    itemIDs: [...decoded.itemIDs],
    assets: decoded.assets.map((asset) => ({ ...asset })),
    normalizationVersion: decoded.normalizationVersion,
    license: decoded.license,
  })
}

export function sealSourceLock(input: SourceLockInput): SealedSourceLock {
  const decoded = Schema.decodeUnknownSync(SourceLockInput)(input, exact)
  validateUpstream(decoded.upstream)
  const datasets = decoded.datasets.map((dataset) =>
    lockDatasetSource({
      id: dataset.id,
      repositoryUrl: dataset.repositoryUrl,
      revision: dataset.revision,
      subset: dataset.subset,
      itemIDs: [...dataset.itemIDs],
      assets: dataset.assets.map((asset) => ({ ...asset })),
      normalizationVersion: dataset.normalizationVersion,
      license: dataset.license,
    }),
  )
  if (new Set(datasets.map((dataset) => dataset.id)).size !== datasets.length) {
    throw new TypeError("Source lock contains duplicate dataset IDs")
  }
  const authority = deepFreeze({ schemaVersion: 1 as const, upstream: { ...decoded.upstream }, datasets })
  return deepFreeze({ ...authority, sha256: sha256Text(canonicalJson(authority)) })
}

export function verifySourceLock(
  input: unknown,
): { readonly ok: true; readonly lock: SealedSourceLock } | { readonly ok: false; readonly reason: string } {
  try {
    const decoded = Schema.decodeUnknownSync(SealedSourceLock)(input, exact)
    const sealed = sealSourceLock({
      schemaVersion: decoded.schemaVersion,
      upstream: decoded.upstream,
      datasets: [...decoded.datasets],
    })
    if (sealed.sha256 !== decoded.sha256) return { ok: false, reason: "SOURCE_LOCK_HASH_MISMATCH" }
    return { ok: true, lock: sealed }
  } catch {
    return { ok: false, reason: "SOURCE_LOCK_INVALID" }
  }
}

export async function resolveOfficialUpstream(
  input: {
    readonly fetch?: typeof fetch
    readonly resolveTag?: (repositoryUrl: string, tag: string) => Promise<string>
    readonly now?: () => Date
  } = {},
): Promise<UpstreamSource> {
  const request = input.fetch ?? fetch
  const repositoryUrl = "https://github.com/anomalyco/opencode"
  const response = await request("https://api.github.com/repos/anomalyco/opencode/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "opencode-task24-benchmark" },
  })
  const tag = response.ok
    ? parseStableRelease(await response.json())
    : response.status === 403 || response.status === 429
      ? await resolveLatestReleaseRedirect(request)
      : (() => {
          throw new TypeError(`Official OpenCode release lookup failed with HTTP ${response.status}`)
        })()
  const revision = assertImmutableRevision(await (input.resolveTag ?? resolveRemoteTag)(repositoryUrl, tag))
  const archive = await request(`https://github.com/anomalyco/opencode/archive/${revision}.tar.gz`, {
    headers: { "User-Agent": "opencode-task24-benchmark" },
  })
  if (!archive.ok) throw new TypeError(`Official OpenCode archive download failed with HTTP ${archive.status}`)
  return deepFreeze({
    id: "opencode-upstream",
    kind: "git",
    repositoryUrl,
    tag,
    revision,
    archiveSha256: sha256Bytes(new Uint8Array(await archive.arrayBuffer())),
    lockedAt: (input.now ?? (() => new Date()))().toISOString(),
    license: "MIT",
  })
}

async function resolveLatestReleaseRedirect(request: typeof fetch): Promise<string> {
  const response = await request("https://github.com/anomalyco/opencode/releases/latest", {
    redirect: "manual",
    headers: { "User-Agent": "opencode-task24-benchmark" },
  })
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    throw new TypeError(`Official OpenCode release redirect failed with HTTP ${response.status}`)
  }
  const location = response.headers.get("location")
  if (location === null) throw new TypeError("Official OpenCode release redirect is missing a location")
  const target = new URL(location, "https://github.com")
  const match = /^\/anomalyco\/opencode\/releases\/tag\/(v?\d+\.\d+\.\d+)$/.exec(target.pathname)
  if (target.origin !== "https://github.com" || target.search || target.hash || match === null) {
    throw new TypeError("Official OpenCode release redirect is invalid")
  }
  return parseStableRelease({ tag_name: match[1], draft: false, prerelease: false })
}

export async function stageOfficialUpstream(input: {
  readonly layout: Task24Layout
  readonly source: UpstreamSource
  readonly fetch?: typeof fetch
}): Promise<{ readonly checkout: string; readonly archive: string }> {
  const layout = verifiedLayout(input.layout)
  validateUpstream(input.source)
  const staging = path.join(layout.tmp, `upstream-${crypto.randomUUID()}`)
  const archive = path.join(staging, "opencode.tar.gz")
  const extraction = path.join(staging, "extracted")
  await mkdir(staging, { recursive: false })
  try {
    const request = input.fetch ?? fetch
    const response = await request(`https://github.com/anomalyco/opencode/archive/${input.source.revision}.tar.gz`, {
      headers: { "User-Agent": "opencode-task24-benchmark" },
    })
    if (!response.ok) throw new TypeError(`Official OpenCode archive download failed with HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (sha256Bytes(bytes) !== input.source.archiveSha256)
      throw new TypeError("Official OpenCode archive hash mismatch")
    await writeFile(archive, bytes, { flag: "wx" })
    const extracted = await safeExtractTar({
      archive,
      destination: extraction,
      expectedSha256: input.source.archiveSha256,
      allowSafeInternalSymlinks: true,
    })
    return { checkout: extracted.root, archive }
  } catch (cause) {
    await rm(staging, { recursive: true, force: true })
    throw cause
  }
}

export async function publishSourceLock(input: {
  readonly layout: Task24Layout
  readonly lock: SealedSourceLock
  readonly stagedCheckout: string
}): Promise<void> {
  const layout = verifiedLayout(input.layout)
  const destination = path.join(layout.toolchain, "upstream-src")
  const lockPath = path.join(layout.toolchain, "source-lock.json")
  const stagedInput = path.resolve(input.stagedCheckout)
  const stagedStat = await lstat(stagedInput)
  const stagedCheckout = await realpath(stagedInput)
  if (
    !stagedStat.isDirectory() ||
    stagedStat.isSymbolicLink() ||
    stagedCheckout.toLowerCase() !== stagedInput.toLowerCase() ||
    !strictDescendant(layout.tmp, stagedCheckout)
  ) {
    throw new TypeError("Official OpenCode checkout must be a direct Task24 staging directory")
  }
  try {
    const current = JSON.parse(await readFile(lockPath, "utf8"))
    const verified = verifySourceLock(current)
    if (verified.ok && verified.lock.sha256 === input.lock.sha256) return
    throw new TypeError("A different valid Task24 source lock is already published")
  } catch (cause) {
    const code = cause !== null && typeof cause === "object" ? Reflect.get(cause, "code") : undefined
    if (code !== "ENOENT") throw cause
  }
  await rename(stagedCheckout, destination)
  try {
    await writeFile(lockPath, canonicalJson(input.lock) + "\n", { encoding: "utf8", flag: "wx" })
  } catch (cause) {
    await rename(destination, stagedCheckout)
    throw cause
  }
}

async function resolveRemoteTag(repositoryUrl: string, tag: string): Promise<string> {
  validateRepositoryUrl(repositoryUrl)
  if (!stableTagPattern.test(tag)) throw new TypeError("Official tag is not stable")
  const child = Bun.spawn(["git", "ls-remote", repositoryUrl, `refs/tags/${tag}^{}`, `refs/tags/${tag}`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new TypeError(`Official tag resolution failed: ${stderr.trim()}`)
  const candidates = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [revision, reference] = line.split(/\s+/, 2)
      return { revision, reference }
    })
    .filter(
      (value): value is { readonly revision: string; readonly reference: string } =>
        value.revision !== undefined && value.reference !== undefined && commitPattern.test(value.revision),
    )
  const revision =
    candidates.find((candidate) => candidate.reference.endsWith("^{}"))?.revision ?? candidates[0]?.revision
  if (revision === undefined) throw new TypeError("Official tag did not resolve to an immutable commit")
  return revision
}

function validateUpstream(source: UpstreamSource): void {
  const decoded = Schema.decodeUnknownSync(UpstreamSource)(source, exact)
  validateRepositoryUrl(decoded.repositoryUrl)
  if (!stableTagPattern.test(decoded.tag)) throw new TypeError("Official OpenCode tag is not stable")
  assertImmutableRevision(decoded.revision)
}

function validateRepositoryUrl(value: string): void {
  const parsed = new URL(value)
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("Source repository URL must not contain mutable or credential authority")
  }
}

function strictDescendant(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative.length > 0 && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
}

function verifiedLayout(input: Task24Layout): Task24Layout {
  const expected = Task24Root.make(input.root)
  const keys = ["root", "assets", "cache", "toolchain", "workspaces", "runs", "reports", "tmp"] as const
  for (const key of keys) {
    if (expected[key] !== input[key]) throw new TypeError("TASK24_LAYOUT_FORGED")
  }
  return expected
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value)
    Object.freeze(input)
  }
  return input
}
