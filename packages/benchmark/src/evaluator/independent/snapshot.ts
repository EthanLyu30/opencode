import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../campaign/canonical"
import { directRoot, ordinaryFiles } from "../../corpus/evaluation-bundle"
import { decodeTaskExecutionProfile, freeze, safePath, type TaskExecutionProfile } from "../../corpus/evaluation-profile"
import type { FileEntry } from "../../corpus/manifest"
import { sha256Bytes, sha256Text } from "../../hash"

export type CandidateSnapshot = Readonly<{ sourceRoot: string; workRoot: string; archiveFile: string; candidateSha256: string; configSha256: string; archiveSha256: string; entries: readonly FileEntry[] }>
const snapshots = new WeakMap<CandidateSnapshot, TaskExecutionProfile>()
export function validateCandidateEntries(entries: readonly FileEntry[]): void {
  if (!entries.length || entries.length > 20000 || entries.reduce((s, f) => s + f.size, 0) > 64 * 1024 * 1024) throw new TypeError("TASK24_CANDIDATE_LIMIT")
  const seen = new Set<string>()
  for (const f of entries) {
    safePath(f.path)
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new TypeError("TASK24_CANDIDATE_LIMIT")
    const key = f.path.toLowerCase()
    if (seen.has(key)) throw new TypeError("TASK24_PATH_COLLISION")
    seen.add(key)
    if (/(?:^|\/)(?:node_modules|private|gold|oracle|\.git)(?:\/|$)/i.test(key) || /(?:^|\/)\.env(?:\.|$)/i.test(key)) throw new TypeError("TASK24_CANDIDATE_PRIVATE")
  }
}
export function disjoint(a: string, b: string): boolean {
  const x = path.resolve(a).toLowerCase(), y = path.resolve(b).toLowerCase()
  return x !== y && !x.startsWith(y + path.sep) && !y.startsWith(x + path.sep)
}
function configHash(profile: TaskExecutionProfile, entries: readonly FileEntry[]) {
  return sha256Text(canonicalJson({ profile, files: entries.filter((f) => profile.protectedPaths.includes(f.path) || /(?:^|\/)(?:package\.json|.*lock.*|.*config\..*)$/i.test(f.path)) }))
}
export async function captureCandidate(input: { sourceRoot: string; workRoot: string; profile: TaskExecutionProfile }): Promise<CandidateSnapshot> {
  const sourceRoot = await directRoot(input.sourceRoot), workRoot = path.resolve(input.workRoot)
  const profile = decodeTaskExecutionProfile(input.profile)
  if (!disjoint(sourceRoot, workRoot) || path.parse(sourceRoot).root !== path.parse(workRoot).root) throw new TypeError("TASK24_ROOT_OVERLAP")
  await directRoot(path.dirname(workRoot))
  const entries = await ordinaryFiles(sourceRoot)
  validateCandidateEntries(entries)
  if (!entries.some((e) => e.path === profile.sourceEntry) || profile.protectedPaths.some((p) => !entries.some((e) => e.path === p))) throw new TypeError("TASK24_CANDIDATE_REQUIRED_FILE")
  // Exclusive creation makes stale workspaces ineligible, even after a failed capture.
  await fs.mkdir(workRoot)
  const files = []
  for (const entry of entries) {
    const bytes = await fs.readFile(path.join(sourceRoot, entry.path))
    if (sha256Bytes(bytes) !== entry.sha256 || bytes.length !== entry.size) throw new TypeError("TASK24_CANDIDATE_DRIFT")
    files.push({ ...entry, base64: bytes.toString("base64") })
    const target = path.join(workRoot, "source", entry.path)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, bytes, { flag: "wx" })
  }
  const body = canonicalJson({ schemaVersion: 2, files })
  if (Buffer.byteLength(body) > 96 * 1024 * 1024) throw new TypeError("TASK24_ARCHIVE_LIMIT")
  const archiveFile = path.join(workRoot, "candidate.json")
  await fs.writeFile(archiveFile, body, { flag: "wx" })
  const snapshot = freeze({ sourceRoot, workRoot, archiveFile, entries, candidateSha256: sha256Text(canonicalJson(entries)), configSha256: configHash(profile, entries), archiveSha256: sha256Text(body) })
  snapshots.set(snapshot, profile)
  await verifyCandidate(snapshot)
  return snapshot
}
export async function verifyCandidate(snapshot: CandidateSnapshot): Promise<void> {
  const profile = snapshots.get(snapshot)
  if (!profile) throw new TypeError("TASK24_UNVALIDATED_SNAPSHOT")
  try {
    const entries = await ordinaryFiles(snapshot.sourceRoot)
    validateCandidateEntries(entries)
    if (sha256Text(canonicalJson(entries)) !== snapshot.candidateSha256 || configHash(profile, entries) !== snapshot.configSha256) throw Error("drift")
    const work = await ordinaryFiles(snapshot.workRoot)
    const expected = [...entries.map((f) => ({ ...f, path: `source/${f.path}` })), { path: "candidate.json", sha256: snapshot.archiveSha256 }]
    if (work.length !== expected.length || expected.some((e) => !work.some((f) => f.path === e.path && f.sha256 === e.sha256))) throw Error("drift")
  } catch { throw new TypeError("TASK24_CANDIDATE_DRIFT") }
}
