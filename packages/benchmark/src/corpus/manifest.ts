import { Schema } from "effect"
import { CampaignID, HttpsUrl, Sha256, TaskID } from "../schema"

const exact = { onExcessProperty: "error" as const }

export const FileEntry = Schema.Struct({
  path: Schema.NonEmptyString,
  sha256: Sha256,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

export const Provenance = Schema.Struct({
  id: CampaignID,
  url: HttpsUrl,
  revision: Schema.NonEmptyString,
  license: Schema.NonEmptyString,
})

export const TaskManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: TaskID,
  kind: Schema.Literals(["primary", "guardrail"]),
  stratum: Schema.Literals(["private", "design2code", "swebench-multimodal", "guardrail"]),
  family: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  normalizationVersion: Schema.NonEmptyString,
  source: Provenance,
  workspaceFiles: Schema.Array(FileEntry),
  publicAssets: Schema.Array(FileEntry),
  goldFiles: Schema.Array(FileEntry),
  licensesSha256: Sha256,
})

export const LicenseEntry = Schema.Struct({
  name: Schema.NonEmptyString,
  license: Schema.NonEmptyString,
  sourceUrl: HttpsUrl,
  revision: Schema.NonEmptyString,
})

export const Licenses = Schema.Array(LicenseEntry)

export type FileEntry = typeof FileEntry.Type
export type TaskManifest = typeof TaskManifest.Type
export type LicenseEntry = typeof LicenseEntry.Type

export function decodeTaskManifest(input: unknown): TaskManifest {
  return Schema.decodeUnknownSync(TaskManifest)(input, exact)
}

export function decodeLicenses(input: unknown): readonly LicenseEntry[] {
  return Schema.decodeUnknownSync(Licenses)(input, exact)
}

export function assertSafeRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes(":") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//")
  ) {
    throw new TypeError("TASK24_PATH_UNSAFE")
  }
  const segments = value.split("/")
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError("TASK24_PATH_UNSAFE")
  }
  return value
}

export function assertUniqueFiles(entries: readonly FileEntry[], label: string): void {
  const paths = new Set<string>()
  for (const entry of entries) {
    assertSafeRelativePath(entry.path)
    const key = entry.path.toLowerCase()
    if (paths.has(key)) throw new TypeError(`${label}_DUPLICATE_PATH`)
    paths.add(key)
  }
}
