import { createHash } from "node:crypto"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { Task24Root } from "../root"
import { MAX_SCREENSHOT_BYTES } from "./browser-protocol"

const pngSignature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
const removableMetadataChunks = new Set(["tEXt", "zTXt", "iTXt", "tIME", "eXIf"])
const evidenceFile = "evidence.json"
const screenshotFile = "screenshot.png"

export interface CaptureEvidence {
  readonly schemaVersion: 1
  readonly requestID: string
  readonly runID: string
  readonly previewID: string
  readonly viewportID: string
  readonly screenshotSha256: string
  readonly dom: readonly unknown[]
  readonly consoleErrors: readonly string[]
  readonly pageErrors: readonly string[]
  readonly accessibility: unknown
  readonly axe: unknown
}

export interface PublishedEvidence {
  readonly root: string
  readonly screenshot: string
  readonly evidence: string
  readonly screenshotSha256: string
  readonly evidenceSha256: string
  readonly screenshotBytes: number
}

export function validateCaptureOutputRoot(value: string): string {
  const layout = Task24Root.ensure()
  if (!path.isAbsolute(value) || path.normalize(value) !== value)
    throw new TypeError("TASK24_BROWSER_OUTPUT_ROOT_INVALID")
  const resolved = path.resolve(value)
  if (!strictlyContains(layout.runs, resolved) && !strictlyContains(layout.reports, resolved)) {
    throw new TypeError("TASK24_BROWSER_OUTPUT_ROOT_INVALID")
  }
  requireDirectDirectory(resolved, "TASK24_BROWSER_OUTPUT_ROOT_INVALID")
  return resolved
}

export function captureTarget(outputRoot: string, relative: string): string {
  const root = validateCaptureOutputRoot(outputRoot)
  if (!/^[a-z0-9._/-]{1,512}$/.test(relative) || relative.includes("//") || relative.split("/").includes("..")) {
    throw new TypeError("TASK24_BROWSER_OUTPUT_INVALID")
  }
  const target = path.resolve(root, ...relative.split("/"))
  if (!strictlyContains(root, target)) throw new TypeError("TASK24_BROWSER_OUTPUT_INVALID")
  return target
}

export async function publishCapture(input: {
  readonly outputRoot: string
  readonly relative: string
  readonly screenshot: Uint8Array
  readonly evidence: Omit<CaptureEvidence, "screenshotSha256">
}): Promise<PublishedEvidence> {
  const root = validateCaptureOutputRoot(input.outputRoot)
  const target = captureTarget(root, input.relative)
  const normalized = normalizePngMetadata(input.screenshot)
  if (normalized.byteLength === 0 || normalized.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new TypeError("TASK24_BROWSER_SCREENSHOT_SIZE_INVALID")
  }
  if (fsSync.existsSync(target)) throw new TypeError("TASK24_BROWSER_EVIDENCE_ALREADY_PUBLISHED")
  await ensureDirectParents(root, path.dirname(target))
  const staging = path.join(root, `.capture-${input.evidence.requestID}`)
  if (fsSync.existsSync(staging)) throw new TypeError("TASK24_BROWSER_STAGING_CONFLICT")
  await fs.mkdir(staging)
  try {
    const screenshotSha256 = sha256(normalized)
    const evidenceValue: CaptureEvidence = Object.freeze({ ...input.evidence, screenshotSha256 })
    const evidenceBytes = Buffer.from(canonicalJson(jsonValue(evidenceValue)) + "\n")
    const evidenceSha256 = sha256(evidenceBytes)
    await fs.writeFile(path.join(staging, screenshotFile), normalized, { flag: "wx" })
    await fs.writeFile(path.join(staging, evidenceFile), evidenceBytes, { flag: "wx" })
    await fs.rename(staging, target)
    return Object.freeze({
      root: target,
      screenshot: path.join(target, screenshotFile),
      evidence: path.join(target, evidenceFile),
      screenshotSha256,
      evidenceSha256,
      screenshotBytes: normalized.byteLength,
    })
  } catch (cause) {
    await fs.rm(staging, { recursive: true, force: true })
    throw cause
  }
}

export async function verifyPublishedCapture(input: {
  readonly outputRoot: string
  readonly relative: string
  readonly screenshotSha256: string
  readonly evidenceSha256: string
  readonly screenshotBytes: number
}): Promise<PublishedEvidence> {
  const target = captureTarget(input.outputRoot, input.relative)
  requireDirectDirectory(target, "TASK24_BROWSER_EVIDENCE_INVALID")
  const screenshot = path.join(target, screenshotFile)
  const evidence = path.join(target, evidenceFile)
  const [png, json] = await Promise.all([readExactFile(screenshot), readExactFile(evidence)])
  if (
    png.byteLength !== input.screenshotBytes ||
    png.byteLength > MAX_SCREENSHOT_BYTES ||
    sha256(png) !== input.screenshotSha256 ||
    sha256(json) !== input.evidenceSha256
  ) {
    throw new TypeError("TASK24_BROWSER_EVIDENCE_INVALID")
  }
  return Object.freeze({
    root: target,
    screenshot,
    evidence,
    screenshotSha256: input.screenshotSha256,
    evidenceSha256: input.evidenceSha256,
    screenshotBytes: input.screenshotBytes,
  })
}

export function normalizePngMetadata(value: Uint8Array): Uint8Array {
  if (value.byteLength < pngSignature.byteLength || !pngSignature.every((byte, index) => value[index] === byte)) {
    throw new TypeError("TASK24_BROWSER_SCREENSHOT_INVALID")
  }
  const chunks: Uint8Array[] = [pngSignature]
  let offset = pngSignature.byteLength
  let sawIHDR = false
  let sawIDAT = false
  let sawIEND = false
  while (offset < value.byteLength) {
    if (offset + 12 > value.byteLength) throw new TypeError("TASK24_BROWSER_SCREENSHOT_INVALID")
    const length = readUint32(value, offset)
    const end = offset + 12 + length
    if (end > value.byteLength) throw new TypeError("TASK24_BROWSER_SCREENSHOT_INVALID")
    const type = String.fromCharCode(...value.subarray(offset + 4, offset + 8))
    if (!/^[A-Za-z]{4}$/.test(type)) throw new TypeError("TASK24_BROWSER_SCREENSHOT_INVALID")
    if (type === "IHDR") sawIHDR = true
    if (type === "IDAT") sawIDAT = true
    if (type === "IEND") sawIEND = true
    if (!removableMetadataChunks.has(type)) chunks.push(value.subarray(offset, end))
    offset = end
    if (type === "IEND") break
  }
  if (!sawIHDR || !sawIDAT || !sawIEND || offset !== value.byteLength) {
    throw new TypeError("TASK24_BROWSER_SCREENSHOT_INVALID")
  }
  return Buffer.concat(chunks)
}

function readUint32(value: Uint8Array, offset: number): number {
  return (
    ((value[offset] ?? 0) * 0x1000000 +
      (value[offset + 1] ?? 0) * 0x10000 +
      (value[offset + 2] ?? 0) * 0x100 +
      (value[offset + 3] ?? 0)) >>>
    0
  )
}

async function ensureDirectParents(root: string, parent: string): Promise<void> {
  const relative = path.relative(root, parent)
  if (relative === "" || relative === ".") return
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    try {
      await fs.mkdir(current)
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause
    }
    requireDirectDirectory(current, "TASK24_BROWSER_OUTPUT_INVALID")
  }
}

function requireDirectDirectory(value: string, code: string): void {
  const lexical = path.resolve(value)
  let stat: fsSync.Stats
  try {
    stat = fsSync.lstatSync(lexical)
  } catch {
    throw new TypeError(code)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fsSync.realpathSync.native(lexical) !== lexical) {
    throw new TypeError(code)
  }
}

async function readExactFile(value: string): Promise<Uint8Array> {
  const stat = await fs.lstat(value)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new TypeError("TASK24_BROWSER_EVIDENCE_INVALID")
  return fs.readFile(value)
}

function strictlyContains(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function isAlreadyExists(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST"
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function jsonValue(value: unknown): unknown {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError("TASK24_BROWSER_EVIDENCE_INVALID")
  return JSON.parse(encoded)
}
