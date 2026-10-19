import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Text } from "../../hash"
import { directoryIdentity, fileIdentity } from "../storage"
import { canonicalDesktopPath } from "./compatibility"
import { runDesktopProbe } from "./native-process"
import { readDesktopDirectoryV2, readDesktopFileV2 } from "./identity-v2"

const documents = {
  specs: [
    "docs/superpowers/specs/2026-10-18-task24b-d-drive-docker-launch-design.md",
    "docs/superpowers/specs/2026-10-18-task24b-dl6-native-cli-confirmation-design.md",
  ],
  plans: [
    "docs/superpowers/plans/2026-10-18-task24b-d-drive-docker-launch.md",
    "docs/superpowers/plans/2026-10-18-task24b-dl6-native-cli-confirmation.md",
  ],
}

export function desktopDocumentDigest(entries: readonly { path: string; sha256: string }[]) {
  if (
    entries.length !== 2 ||
    new Set(entries.map((e) => e.path.toLowerCase())).size !== entries.length ||
    entries.some(
      (e) =>
        !/^[a-zA-Z0-9_./-]+$/.test(e.path) ||
        path.posix.normalize(e.path) !== e.path ||
        e.path.startsWith("/") ||
        e.path.split("/").some((p) => p === ".." || !p) ||
        !/^[a-f0-9]{64}$/.test(e.sha256),
    )
  )
    throw new TypeError("TASK24_DESKTOP_DOCUMENT_BINDING")
  return sha256Text(canonicalJson([...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))))
}

async function gitText(root: string, args: string[], signal?: AbortSignal) {
  const result = await runDesktopProbe({
    exe: "C:\\Program Files\\Git\\cmd\\git.exe",
    argv: ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", root, ...args],
    signal,
    timeoutMs: 5000,
    stdoutLimit: 65536,
    stderrLimit: 65536,
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", GIT_TERMINAL_PROMPT: "0" },
  })
  if (result.exitCode || result.stderr.length) throw new TypeError("TASK24_DESKTOP_GIT_QUERY")
  return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim()
}

export async function readDesktopBindings(repoRoot: string, signal?: AbortSignal) {
  const root = canonicalDesktopPath(repoRoot),
    rootID = await directoryIdentity(root)
  const status = () => gitText(root, ["status", "--porcelain=v1", "--untracked-files=normal"], signal)
  const tree = await gitText(root, ["rev-parse", "HEAD^{tree}"], signal)
  if (!/^[a-f0-9]{40}$/.test(tree) || (await status())) throw new TypeError("TASK24_DESKTOP_SOURCE_DIRTY")
  const read = async (relative: string) => {
    const file = path.join(root, relative)
    const before = await fs.lstat(file)
    if (before.size > 1048576) throw new TypeError("TASK24_DESKTOP_DOCUMENT_LIMIT")
    const identity = await fileIdentity(file),
      after = await fs.lstat(file)
    if (
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size ||
      before.ino !== after.ino ||
      before.birthtimeMs !== after.birthtimeMs
    )
      throw new TypeError("TASK24_DESKTOP_DOCUMENT_DRIFT")
    return { relative, identity, mtimeMs: after.mtimeMs, size: after.size }
  }
  const first = await Promise.all([...documents.specs, ...documents.plans].map(read))
  const after = await Promise.all(first.map((f) => read(f.relative)))
  if (
    canonicalJson(first) !== canonicalJson(after) ||
    (await status()) ||
    tree !== (await gitText(root, ["rev-parse", "HEAD^{tree}"], signal)) ||
    rootID !== (await directoryIdentity(root))
  )
    throw new TypeError("TASK24_DESKTOP_DOCUMENT_DRIFT")
  if (signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
  const digest = (files: readonly string[]) =>
    desktopDocumentDigest(
      first.filter((f) => files.includes(f.relative)).map((f) => ({ path: f.relative, sha256: f.identity.sha256 })),
    )
  return Object.freeze({
    sourceSha256: sha256Text("git-tree:" + tree),
    specSha256: digest(documents.specs),
    planSha256: digest(documents.plans),
  })
}

const documentsV2 = Object.freeze({
  specs: [...documents.specs, "docs/superpowers/specs/2026-10-19-task24b-settings-workload-boundary-design.md"],
  plans: [...documents.plans, "docs/superpowers/plans/2026-10-19-task24b-settings-workload-boundary.md"],
})
export function desktopDocumentDigestV2(kind: "specs" | "plans", entries: readonly { path: string; sha256: string }[]) {
  const expected = documentsV2[kind]
  if (
    entries.length !== 3 ||
    new Set(entries.map((e) => e.path)).size !== 3 ||
    entries.some(
      (e) =>
        !expected.includes(e.path) ||
        !/[a-f0-9]{64}/.test(e.sha256) ||
        e.sha256.length !== 64 ||
        /^0{64}$/.test(e.sha256),
    )
  )
    throw new TypeError("TASK24_DESKTOP_V2_DOCUMENT_BINDING")
  return sha256Text(canonicalJson([...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))))
}
export async function readDesktopBindingsV2(repoRoot: string, signal?: AbortSignal) {
  const root = canonicalDesktopPath(repoRoot),
    identity = await readDesktopDirectoryV2(root)
  const status = () => gitText(root, ["status", "--porcelain=v1", "--untracked-files=normal"], signal)
  const tree = await gitText(root, ["rev-parse", "HEAD^{tree}"], signal)
  if (!/^[a-f0-9]{40}$/.test(tree) || (await status())) throw new TypeError("TASK24_DESKTOP_SOURCE_DIRTY")
  const read = async (relative: string) => ({
    path: relative,
    identity: (await readDesktopFileV2(path.join(root, relative))).identity,
  })
  const first = await Promise.all([...documentsV2.specs, ...documentsV2.plans].map(read))
  if (
    canonicalJson(first) !== canonicalJson(await Promise.all(first.map((f) => read(f.path)))) ||
    (await status()) ||
    tree !== (await gitText(root, ["rev-parse", "HEAD^{tree}"], signal)) ||
    canonicalJson(identity) !== canonicalJson(await readDesktopDirectoryV2(root))
  )
    throw new TypeError("TASK24_DESKTOP_DOCUMENT_DRIFT")
  if (signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
  const digest = (kind: "specs" | "plans") =>
    desktopDocumentDigestV2(
      kind,
      first.filter((f) => documentsV2[kind].includes(f.path)).map((f) => ({ path: f.path, sha256: f.identity.sha256 })),
    )
  return Object.freeze({
    sourceSha256: sha256Text("git-tree:" + tree),
    specSha256: digest("specs"),
    planSha256: digest("plans"),
  })
}
