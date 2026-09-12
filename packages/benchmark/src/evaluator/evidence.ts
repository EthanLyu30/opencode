import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const shaPattern = /^[a-f0-9]{64}$/
const relativePattern = /^[A-Za-z0-9._/-]{1,512}$/
const kindPattern = /^[a-z][a-z0-9-]{0,63}$/

export interface EvidenceReference {
  readonly kind: string
  readonly relativePath: string
  readonly sha256: string
  readonly bytes: number
}

export interface BlindedAuditInput {
  readonly runID: string
  readonly taskLabel: string
  readonly visualComposite: number
  readonly referenceSha256: string
  readonly candidateSha256: string
  readonly armID?: string
}

export interface BlindedAuditPackage {
  readonly schemaVersion: 1
  readonly cases: readonly {
    readonly label: string
    readonly taskLabel: string
    readonly leftSha256: string
    readonly rightSha256: string
  }[]
}

export function evidenceReference(input: EvidenceReference): EvidenceReference {
  if (
    !kindPattern.test(input.kind) ||
    !safeRelative(input.relativePath) ||
    !shaPattern.test(input.sha256) ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1
  ) {
    throw new TypeError("TASK24_EVIDENCE_REFERENCE_INVALID")
  }
  return Object.freeze({ ...input })
}

export function evidenceReferenceForBytes(kind: string, relativePath: string, bytes: Uint8Array): EvidenceReference {
  if (bytes.byteLength < 1) throw new TypeError("TASK24_EVIDENCE_REFERENCE_INVALID")
  return evidenceReference({ kind, relativePath, sha256: sha256(bytes), bytes: bytes.byteLength })
}

export function bindEvidenceFile(root: string, candidate: string, kind: string): EvidenceReference {
  const resolvedRoot = directDirectory(root)
  const absolute = path.resolve(candidate)
  const relative = path.relative(resolvedRoot, absolute).split(path.sep).join("/")
  if (!strictlyContains(resolvedRoot, absolute) || !safeRelative(relative)) {
    throw new TypeError("TASK24_EVIDENCE_FILE_INVALID")
  }
  const stat = fs.lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync.native(absolute) !== absolute) {
    throw new TypeError("TASK24_EVIDENCE_FILE_INVALID")
  }
  return evidenceReferenceForBytes(kind, relative, fs.readFileSync(absolute))
}

export function verifyEvidenceFile(root: string, reference: EvidenceReference): EvidenceReference {
  const expected = evidenceReference(reference)
  const actual = bindEvidenceFile(root, path.join(root, ...expected.relativePath.split("/")), expected.kind)
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    throw new TypeError("TASK24_EVIDENCE_IDENTITY_CHANGED")
  }
  return actual
}

export function validateEvidenceReferences(values: readonly EvidenceReference[]): readonly EvidenceReference[] {
  if (values.length === 0 || values.length > 10_000) throw new TypeError("TASK24_EVIDENCE_REQUIRED")
  const result = values.map(evidenceReference)
  const identities = new Set(result.map((value) => `${value.kind}\0${value.relativePath}\0${value.sha256}`))
  if (identities.size !== result.length) throw new TypeError("TASK24_EVIDENCE_DUPLICATE")
  return Object.freeze(result)
}

export function evidenceHashes(groups: readonly (readonly EvidenceReference[])[]): readonly string[] {
  const hashes = new Set(groups.flatMap((group) => validateEvidenceReferences(group).map((item) => item.sha256)))
  return Object.freeze([...hashes].toSorted())
}

export function makeBlindedAuditPackage(values: readonly BlindedAuditInput[], sealedSeed: string): BlindedAuditPackage {
  if (sealedSeed.length < 8 || sealedSeed.length > 512) throw new TypeError("TASK24_AUDIT_SEED_INVALID")
  const cases = values
    .filter((value) => value.visualComposite >= 70 && value.visualComposite <= 79)
    .map((value) => {
      if (
        value.runID.length === 0 ||
        value.taskLabel.length === 0 ||
        !shaPattern.test(value.referenceSha256) ||
        !shaPattern.test(value.candidateSha256)
      ) {
        throw new TypeError("TASK24_AUDIT_CASE_INVALID")
      }
      const identity = sha256(Buffer.from(`${sealedSeed}\0${value.runID}`))
      const flipped = Number.parseInt(identity.slice(0, 2), 16) % 2 === 1
      return {
        order: sha256(Buffer.from(`${sealedSeed}\0order\0${value.runID}`)),
        label: `case-${identity.slice(0, 12)}`,
        taskLabel: value.taskLabel,
        leftSha256: flipped ? value.candidateSha256 : value.referenceSha256,
        rightSha256: flipped ? value.referenceSha256 : value.candidateSha256,
      }
    })
    .toSorted((left, right) => left.order.localeCompare(right.order))
    .map(({ order: _order, ...value }) => Object.freeze(value))
  return Object.freeze({ schemaVersion: 1, cases: Object.freeze(cases) })
}

function directDirectory(value: string): string {
  const absolute = path.resolve(value)
  const stat = fs.lstatSync(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(absolute) !== absolute) {
    throw new TypeError("TASK24_EVIDENCE_ROOT_INVALID")
  }
  return absolute
}

function safeRelative(value: string): boolean {
  return (
    relativePattern.test(value) && !value.includes("//") && !value.split("/").includes("..") && !path.isAbsolute(value)
  )
}

function strictlyContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
