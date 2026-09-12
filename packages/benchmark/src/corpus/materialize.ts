import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { sha256Bytes, sha256Text } from "../hash"
import { Task24Root, type Task24Layout } from "../root"
import { validateTaskBundle } from "./validate"

const identityPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/

export interface MaterializedRoots {
  readonly repo: string
  readonly data: string
  readonly config: string
  readonly cache: string
  readonly temp: string
  readonly output: string
}

export interface MaterializedTask {
  readonly runRoot: string
  readonly roots: MaterializedRoots
  readonly taskID: string
  readonly bundleSha256: string
  readonly goldSha256: string
  readonly preRunTreeSha256: string
}

export async function materializeTask(input: {
  readonly layout: Task24Layout
  readonly bundleRoot: string
  readonly campaignID: string
  readonly runID: string
}): Promise<MaterializedTask> {
  const layout = verifiedLayout(input.layout)
  assertIdentity(input.campaignID, "campaign")
  assertIdentity(input.runID, "run")
  const bundle = await validateTaskBundle(input.bundleRoot)
  const campaignRoot = path.join(layout.workspaces, input.campaignID)
  const destination = path.join(campaignRoot, input.runID)
  await assertFresh(destination)
  await mkdir(campaignRoot, { recursive: true })
  const staging = await mkdtemp(path.join(layout.tmp, `materialize-${input.campaignID}-${input.runID}-`))
  const roots: MaterializedRoots = Object.freeze({
    repo: path.join(staging, "repo"),
    data: path.join(staging, "data"),
    config: path.join(staging, "config"),
    cache: path.join(staging, "cache"),
    temp: path.join(staging, "temp"),
    output: path.join(staging, "output"),
  })
  try {
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: false })))
    for (const entry of bundle.manifest.workspaceFiles) {
      await copyDeclared(input.bundleRoot, "starter", entry.path, roots.repo, entry.path)
    }
    for (const entry of bundle.manifest.publicAssets) {
      await copyDeclared(input.bundleRoot, "assets", entry.path, roots.repo, `assets/${entry.path}`)
    }
    const preRunTreeSha256 = await treeHash(roots.repo)
    const expectedTreeSha256 = sha256Text(
      canonicalJson(
        [
          ...bundle.manifest.workspaceFiles,
          ...bundle.manifest.publicAssets.map((entry) => ({ ...entry, path: `assets/${entry.path}` })),
        ].toSorted((left, right) => compareText(left.path, right.path)),
      ),
    )
    if (preRunTreeSha256 !== expectedTreeSha256) throw new TypeError("TASK24_MATERIALIZED_TREE_MISMATCH")
    const record = {
      schemaVersion: 1,
      taskID: bundle.manifest.id,
      bundleSha256: bundle.bundleSha256,
      goldSha256: bundle.goldSha256,
      preRunTreeSha256,
    }
    await writeFile(path.join(roots.output, "materialization.json"), canonicalJson(record) + "\n", {
      encoding: "utf8",
      flag: "wx",
    })
    await setWritable(staging)
    await assertFresh(destination)
    await rename(staging, destination)
    return deepFreeze({
      runRoot: destination,
      roots: {
        repo: path.join(destination, "repo"),
        data: path.join(destination, "data"),
        config: path.join(destination, "config"),
        cache: path.join(destination, "cache"),
        temp: path.join(destination, "temp"),
        output: path.join(destination, "output"),
      },
      taskID: bundle.manifest.id,
      bundleSha256: bundle.bundleSha256,
      goldSha256: bundle.goldSha256,
      preRunTreeSha256,
    })
  } catch (cause) {
    await rm(staging, { recursive: true, force: true })
    throw cause
  }
}

export async function treeHash(root: string): Promise<string> {
  const resolved = path.resolve(root)
  const stat = await lstat(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("TASK24_TREE_ROOT_UNSAFE")
  const files: Array<{ path: string; sha256: string; size: number }> = []
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      compareText(a.name, b.name),
    )) {
      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new TypeError("TASK24_TREE_LINK_UNSAFE")
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(candidate, relative)
      else if (entry.isFile()) {
        const bytes = await readFile(candidate)
        files.push({ path: relative, sha256: sha256Bytes(bytes), size: bytes.byteLength })
      } else throw new TypeError("TASK24_TREE_ENTRY_UNSAFE")
    }
  }
  await walk(resolved, "")
  return sha256Text(canonicalJson(files))
}

async function copyDeclared(
  bundle: string,
  sourceDirectory: string,
  sourceRelative: string,
  repo: string,
  targetRelative: string,
): Promise<void> {
  const source = path.join(bundle, sourceDirectory, ...sourceRelative.split("/"))
  const target = path.join(repo, ...targetRelative.split("/"))
  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(source, target, constants.COPYFILE_EXCL)
}

async function assertFresh(destination: string): Promise<void> {
  try {
    await lstat(destination)
    throw new TypeError("Task24 run workspace must be fresh; dirty reuse is forbidden")
  } catch (cause) {
    const code = cause !== null && typeof cause === "object" ? Reflect.get(cause, "code") : undefined
    if (code === "ENOENT") return
    throw cause
  }
}

async function setWritable(root: string): Promise<void> {
  await chmod(root, 0o700)
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await chmod(candidate, 0o700)
        await walk(candidate)
      } else if (entry.isFile()) await chmod(candidate, 0o600)
    }
  }
  await walk(root)
}

function assertIdentity(value: string, label: string): void {
  if (!identityPattern.test(value)) throw new TypeError(`TASK24_${label.toUpperCase()}_ID_INVALID`)
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
