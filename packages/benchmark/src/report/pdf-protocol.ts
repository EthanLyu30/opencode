import { timingSafeEqual } from "node:crypto"
import { BROWSER_PROTOCOL_VERSION, validateGrant } from "../evaluator/browser-protocol"

export const MAX_PDF_PROTOCOL_BYTES = 256 * 1024

export interface BrowserPdfRequest {
  readonly protocolVersion: 1
  readonly operation: "report-pdf"
  readonly authorization: string
  readonly requestID: string
  readonly reportID: string
  readonly reportURL: string
  readonly outputRelativePath: string
  readonly evidenceHashes: readonly string[]
  readonly timeoutMs: number
}

export type BrowserPdfResponse =
  | {
      readonly protocolVersion: 1
      readonly requestID: string
      readonly disposition: "published"
      readonly ok: true
      readonly evidence: {
        readonly pdfRootRelativePath: string
        readonly pdfSha256: string
        readonly evidenceSha256: string
        readonly pdfBytes: number
      }
    }
  | {
      readonly protocolVersion: 1
      readonly requestID: string
      readonly disposition: "unstarted" | "uncertain"
      readonly ok: false
      readonly error: { readonly code: string; readonly message: string }
    }

const shaPattern = /^[a-f0-9]{64}$/
const idPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/
const requestPattern = /^[a-f0-9]{32}$/
const errorPattern = /^TASK24_[A-Z0-9_]{1,96}$/

export function decodeBrowserPdfRequestLine(line: string, expectedGrant: string): BrowserPdfRequest {
  size(line)
  validateGrant(expectedGrant)
  const value = parse(line)
  exact(
    value,
    [
      "protocolVersion",
      "operation",
      "authorization",
      "requestID",
      "reportID",
      "reportURL",
      "outputRelativePath",
      "evidenceHashes",
      "timeoutMs",
    ],
    "TASK24_PDF_REQUEST_INVALID",
  )
  if (
    value.protocolVersion !== BROWSER_PROTOCOL_VERSION ||
    value.operation !== "report-pdf" ||
    typeof value.authorization !== "string" ||
    !same(value.authorization, `Bearer ${expectedGrant}`) ||
    typeof value.requestID !== "string" ||
    !requestPattern.test(value.requestID) ||
    typeof value.reportID !== "string" ||
    !idPattern.test(value.reportID) ||
    typeof value.reportURL !== "string" ||
    !exactReportURL(value.reportURL, value.reportID) ||
    value.outputRelativePath !== value.reportID ||
    !Array.isArray(value.evidenceHashes) ||
    value.evidenceHashes.length === 0 ||
    value.evidenceHashes.length > 10_000 ||
    !value.evidenceHashes.every((item) => typeof item === "string" && shaPattern.test(item)) ||
    !integer(value.timeoutMs, 1, 120_000)
  ) {
    throw new TypeError("TASK24_PDF_REQUEST_INVALID")
  }
  return deepFreeze({
    protocolVersion: 1,
    operation: "report-pdf",
    authorization: value.authorization,
    requestID: value.requestID,
    reportID: value.reportID,
    reportURL: value.reportURL,
    outputRelativePath: value.outputRelativePath,
    evidenceHashes: [...new Set(value.evidenceHashes)].toSorted((left, right) => left.localeCompare(right)),
    timeoutMs: value.timeoutMs,
  })
}

export function decodeBrowserPdfResponseLine(line: string, requestID: string): BrowserPdfResponse {
  size(line)
  const value = parse(line)
  if (value.protocolVersion !== 1 || value.requestID !== requestID) throw new TypeError("TASK24_PDF_RESPONSE_INVALID")
  if (value.ok === true) {
    exact(value, ["protocolVersion", "requestID", "disposition", "ok", "evidence"])
    if (value.disposition !== "published" || !record(value.evidence)) invalidResponse()
    exact(value.evidence, ["pdfRootRelativePath", "pdfSha256", "evidenceSha256", "pdfBytes"])
    if (
      typeof value.evidence.pdfRootRelativePath !== "string" ||
      typeof value.evidence.pdfSha256 !== "string" ||
      !shaPattern.test(value.evidence.pdfSha256) ||
      typeof value.evidence.evidenceSha256 !== "string" ||
      !shaPattern.test(value.evidence.evidenceSha256) ||
      !integer(value.evidence.pdfBytes, 16, 64 * 1024 * 1024)
    ) {
      invalidResponse()
    }
    return deepFreeze({
      protocolVersion: 1,
      requestID,
      disposition: "published",
      ok: true,
      evidence: {
        pdfRootRelativePath: value.evidence.pdfRootRelativePath,
        pdfSha256: value.evidence.pdfSha256,
        evidenceSha256: value.evidence.evidenceSha256,
        pdfBytes: value.evidence.pdfBytes,
      },
    })
  }
  exact(value, ["protocolVersion", "requestID", "disposition", "ok", "error"])
  if (
    value.ok !== false ||
    (value.disposition !== "unstarted" && value.disposition !== "uncertain") ||
    !record(value.error)
  ) {
    invalidResponse()
  }
  exact(value.error, ["code", "message"])
  if (
    typeof value.error.code !== "string" ||
    !errorPattern.test(value.error.code) ||
    typeof value.error.message !== "string" ||
    value.error.message.length < 1 ||
    value.error.message.length > 2_048
  ) {
    invalidResponse()
  }
  return deepFreeze({
    protocolVersion: 1,
    requestID,
    disposition: value.disposition,
    ok: false,
    error: { code: value.error.code, message: value.error.message },
  })
}

export function isPdfRequestLine(line: string): boolean {
  try {
    const value: unknown = JSON.parse(line)
    return record(value) && value.operation === "report-pdf"
  } catch {
    return false
  }
}

function exactReportURL(value: string, reportID: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/([a-z0-9][a-z0-9._-]{0,127})\/$/.exec(value)
  if (!match || match[2] !== reportID || Number(match[1]) > 65_535) return false
  try {
    return new URL(value).href === value
  } catch {
    return false
  }
}

function parse(value: string): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(value)
    if (record(result)) return result
  } catch {
    // Fall through to the typed protocol error.
  }
  throw new TypeError("TASK24_PDF_PROTOCOL_INVALID")
}

function size(value: string): void {
  if (Buffer.byteLength(value) === 0 || Buffer.byteLength(value) > MAX_PDF_PROTOCOL_BYTES) {
    throw new TypeError("TASK24_PDF_PROTOCOL_SIZE_INVALID")
  }
}

function exact(value: Record<string, unknown>, keys: readonly string[], code = "TASK24_PDF_RESPONSE_INVALID"): void {
  if (JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify([...keys].toSorted())) {
    throw new TypeError(code)
  }
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function invalidResponse(): never {
  throw new TypeError("TASK24_PDF_RESPONSE_INVALID")
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
