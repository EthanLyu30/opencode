import { createHash } from "node:crypto"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { Task24Root } from "../root"

const MAX_PDF_BYTES = 64 * 1024 * 1024

export interface PublishedPdfReport {
  readonly root: string
  readonly pdf: string
  readonly evidence: string
  readonly sha256: string
  readonly evidenceSha256: string
  readonly bytes: number
}

export async function publishPdfReport(input: {
  readonly outputRoot: string
  readonly reportID: string
  readonly pdf: Uint8Array
  readonly evidenceHashes: readonly string[]
}): Promise<PublishedPdfReport> {
  const outputRoot = validateOutputRoot(input.outputRoot)
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.reportID)) throw new TypeError("TASK24_PDF_REPORT_ID_INVALID")
  const evidenceHashes = [...new Set(input.evidenceHashes)].toSorted()
  if (evidenceHashes.length === 0 || !evidenceHashes.every((value) => /^[a-f0-9]{64}$/.test(value))) {
    throw new TypeError("TASK24_PDF_EVIDENCE_INVALID")
  }
  const normalized = normalizePdfMetadata(input.pdf)
  const target = path.join(outputRoot, input.reportID)
  if (fsSync.existsSync(target)) throw new TypeError("TASK24_PDF_ALREADY_PUBLISHED")
  const staging = path.join(outputRoot, `.pdf-${input.reportID}-${crypto.randomUUID()}`)
  await fs.mkdir(staging)
  try {
    const sha256 = hash(normalized)
    const evidence = Buffer.from(
      canonicalJson({ schemaVersion: 1, reportID: input.reportID, pdfSha256: sha256, evidenceHashes }) + "\n",
    )
    await fs.writeFile(path.join(staging, "report.pdf"), normalized, { flag: "wx" })
    await fs.writeFile(path.join(staging, "evidence.json"), evidence, { flag: "wx" })
    await fs.rename(staging, target)
    const evidenceSha256 = hash(evidence)
    return Object.freeze({
      root: target,
      pdf: path.join(target, "report.pdf"),
      evidence: path.join(target, "evidence.json"),
      sha256,
      evidenceSha256,
      bytes: normalized.byteLength,
    })
  } catch (cause) {
    await fs.rm(staging, { recursive: true, force: true })
    throw cause
  }
}

export async function verifyPublishedPdfReport(input: {
  readonly outputRoot: string
  readonly reportID: string
  readonly pdfSha256: string
  readonly evidenceSha256: string
  readonly pdfBytes: number
}): Promise<PublishedPdfReport> {
  const outputRoot = validateOutputRoot(input.outputRoot)
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.reportID)) throw new TypeError("TASK24_PDF_REPORT_ID_INVALID")
  const target = path.join(outputRoot, input.reportID)
  const stat = await fs.lstat(target)
  if (!stat.isDirectory() || stat.isSymbolicLink() || fsSync.realpathSync.native(target) !== target) {
    throw new TypeError("TASK24_PDF_EVIDENCE_INVALID")
  }
  const pdf = path.join(target, "report.pdf")
  const evidence = path.join(target, "evidence.json")
  const [pdfBytes, evidenceBytes] = await Promise.all([exactFile(pdf), exactFile(evidence)])
  if (
    pdfBytes.byteLength !== input.pdfBytes ||
    hash(pdfBytes) !== input.pdfSha256 ||
    hash(evidenceBytes) !== input.evidenceSha256
  ) {
    throw new TypeError("TASK24_PDF_EVIDENCE_INVALID")
  }
  return Object.freeze({
    root: target,
    pdf,
    evidence,
    sha256: input.pdfSha256,
    evidenceSha256: input.evidenceSha256,
    bytes: input.pdfBytes,
  })
}

export function normalizePdfMetadata(value: Uint8Array): Uint8Array {
  if (value.byteLength < 16 || value.byteLength > MAX_PDF_BYTES) throw new TypeError("TASK24_PDF_INVALID")
  let text = Buffer.from(value).toString("latin1")
  if (!text.startsWith("%PDF-") || !/%%EOF\s*$/.test(text)) throw new TypeError("TASK24_PDF_INVALID")
  text = text.replace(/(\/(?:CreationDate|ModDate)\s*\()(D:[^)]+)(\))/g, (_match, prefix, _date, suffix) => {
    const originalLength = String(_date).length
    const fixed = "D:20000101000000Z".padEnd(originalLength, " ").slice(0, originalLength)
    return `${prefix}${fixed}${suffix}`
  })
  text = text.replace(
    /(\/ID\s*\[\s*<)([0-9A-Fa-f]+)(>\s*<)([0-9A-Fa-f]+)(>\s*\])/g,
    (_match, prefix, left, middle, right, suffix) =>
      `${prefix}${"0".repeat(String(left).length)}${middle}${"0".repeat(String(right).length)}${suffix}`,
  )
  return Buffer.from(text, "latin1")
}

function validateOutputRoot(value: string): string {
  const reports = Task24Root.ensure().reports
  const resolved = path.resolve(value)
  const relative = path.relative(reports, resolved)
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new TypeError("TASK24_PDF_OUTPUT_ROOT_INVALID")
  }
  const stat = fsSync.lstatSync(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink() || fsSync.realpathSync.native(resolved) !== resolved) {
    throw new TypeError("TASK24_PDF_OUTPUT_ROOT_INVALID")
  }
  return resolved
}

async function exactFile(value: string): Promise<Uint8Array> {
  const stat = await fs.lstat(value)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new TypeError("TASK24_PDF_EVIDENCE_INVALID")
  return fs.readFile(value)
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
