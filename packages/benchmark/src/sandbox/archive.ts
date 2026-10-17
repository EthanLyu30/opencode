import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { freeze, safePath, type TaskExecutionProfile } from "../corpus/evaluation-profile"
import { directRoot } from "../corpus/evaluation-bundle"
import { validateCandidateEntries } from "../evaluator/independent/snapshot"
import type { CandidateReference } from "../evaluator/independent/host"
import { sha256Bytes, sha256Text } from "../hash"
import { fileIdentity } from "./storage"
import type { FileEntry } from "../corpus/manifest"

const Archive = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, size: Schema.Int, sha256: Schema.String, base64: Schema.String }),
  ),
})
export type ArchiveFile = (typeof Archive.Type.files)[number]
export function decodeCandidateArchive(bytes: Uint8Array, expectedSha256: string): readonly ArchiveFile[] {
  if (bytes.byteLength > 96 * 1024 * 1024 || sha256Bytes(bytes) !== expectedSha256)
    throw new TypeError("TASK24_ARCHIVE_HASH")
  const value = Schema.decodeUnknownSync(Archive)(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), {
    onExcessProperty: "error",
  })
  validateCandidateEntries(value.files)
  for (const file of value.files) {
    const data = Buffer.from(file.base64, "base64")
    if (data.toString("base64") !== file.base64 || data.length !== file.size || sha256Bytes(data) !== file.sha256)
      throw new TypeError("TASK24_ARCHIVE_CONTENT")
  }
  const names = value.files.map((f) => f.path.toLowerCase())
  if (names.some((a) => names.some((b) => b.startsWith(a + "/")))) throw new TypeError("TASK24_ARCHIVE_COLLISION")
  return freeze(value.files)
}
export async function readCandidateArchive(candidate: CandidateReference, profile: TaskExecutionProfile) {
  if (!/^d:\\opencode-benchmark\\task24\\(?:tmp|workspaces)\\.+\\candidate\.json$/i.test(candidate.archiveFile))
    throw new TypeError("TASK24_ARCHIVE_LOCATION")
  const identity = await fileIdentity(candidate.archiveFile)
  if (identity.sha256 !== candidate.archiveSha256) throw new TypeError("TASK24_ARCHIVE_HASH")
  const files = decodeCandidateArchive(await fs.readFile(candidate.archiveFile), candidate.archiveSha256)
  const entries = files.map(({ base64, ...entry }) => entry)
  const config = sha256Text(
    canonicalJson({
      profile,
      files: entries.filter(
        (f) =>
          profile.protectedPaths.includes(f.path) || /(?:^|\/)(?:package\.json|.*lock.*|.*config\..*)$/i.test(f.path),
      ),
    }),
  )
  if (
    sha256Text(canonicalJson(entries)) !== candidate.candidateSha256 ||
    config !== candidate.configSha256 ||
    !files.some((f) => f.path === profile.sourceEntry) ||
    profile.protectedPaths.some((p) => !files.some((f) => f.path === p))
  )
    throw new TypeError("TASK24_ARCHIVE_BINDING")
  if (canonicalJson(await fileIdentity(candidate.archiveFile)) !== canonicalJson(identity))
    throw new TypeError("TASK24_ARCHIVE_DRIFT")
  return files
}
export function assertSourceUnchanged(before: readonly FileEntry[], after: readonly FileEntry[]) {
  if (before.some((file) => !after.some((entry) => canonicalJson(entry) === canonicalJson(file))))
    throw new TypeError("TASK24_LINUX_SOURCE_DRIFT")
}
export function outputPolicy(profile: TaskExecutionProfile, outputs: readonly string[]) {
  for (const output of outputs) {
    safePath(output)
    if (
      [profile.sourceEntry, ...profile.probeModules, ...profile.protectedPaths, ...profile.mutablePaths].some(
        (p) => p === output || p.startsWith(output + "/"),
      )
    )
      throw new TypeError("TASK24_OUTPUT_SOURCE_OVERLAP")
    if (/(?:^|\/)(?:node_modules|private|gold|oracle|\.git|\.env)(?:[/.]|$)/i.test(output))
      throw new TypeError("TASK24_OUTPUT_PRIVATE")
  }
  if (new Set(outputs.map((p) => p.toLowerCase())).size !== outputs.length)
    throw new TypeError("TASK24_OUTPUT_DUPLICATE")
}
export async function materializeCandidate(
  files: readonly ArchiveFile[],
  workRoot: string,
  outputs: readonly string[],
) {
  await directRoot(path.dirname(workRoot))
  await fs.mkdir(workRoot)
  for (const file of files) {
    if (outputs.some((p) => file.path === p || file.path.startsWith(p + "/"))) continue
    const target = path.join(workRoot, safePath(file.path))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, Buffer.from(file.base64, "base64"), { flag: "wx" })
  }
  return workRoot
}
