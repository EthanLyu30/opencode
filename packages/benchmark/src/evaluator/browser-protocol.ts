import { timingSafeEqual } from "node:crypto"

export const BROWSER_PROTOCOL_VERSION = 1 as const
export const MAX_BROWSER_REQUEST_BYTES = 64 * 1024
export const MAX_BROWSER_RESPONSE_BYTES = 256 * 1024
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024

export const FIXED_VIEWPORTS = Object.freeze({
  mobile: Object.freeze({ width: 390, height: 844, deviceScaleFactor: 1 }),
  tablet: Object.freeze({ width: 768, height: 1024, deviceScaleFactor: 1 }),
  desktop: Object.freeze({ width: 1440, height: 900, deviceScaleFactor: 1 }),
})

export type ViewportID = keyof typeof FIXED_VIEWPORTS
export type InteractionScriptID = "none" | "primary-click" | "menu-toggle"
export type CaptureDisposition = "unstarted" | "uncertain" | "published"

export interface BrowserCaptureRequest {
  readonly protocolVersion: 1
  readonly authorization: string
  readonly requestID: string
  readonly runID: string
  readonly previewID: string
  readonly previewURL: string
  readonly viewportID: ViewportID
  readonly viewport: (typeof FIXED_VIEWPORTS)[ViewportID]
  readonly wait: Readonly<{ kind: "selector"; selector: string; frames: 2 }>
  readonly interactionScriptID: InteractionScriptID
  readonly outputRelativePath: string
  readonly timeoutMs: number
}

export interface PublishedCapture {
  readonly protocolVersion: 1
  readonly requestID: string
  readonly disposition: "published"
  readonly ok: true
  readonly evidence: Readonly<{
    captureRootRelativePath: string
    screenshotSha256: string
    evidenceSha256: string
    screenshotBytes: number
  }>
}

export interface FailedCapture {
  readonly protocolVersion: 1
  readonly requestID: string
  readonly disposition: "unstarted" | "uncertain"
  readonly ok: false
  readonly error: Readonly<{ code: string; message: string }>
}

export type BrowserCaptureResponse = PublishedCapture | FailedCapture

const runIDPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/
const requestIDPattern = /^[a-f0-9]{32}$/
const previewIDPattern = /^[a-f0-9]{64}$/
const shaPattern = /^[a-f0-9]{64}$/
const errorCodePattern = /^TASK24_BROWSER_[A-Z0-9_]{1,96}$/
const grantPattern = /^[A-Za-z0-9_-]{43}$/

export function decodeBrowserRequestLine(line: string, expectedGrant: string): BrowserCaptureRequest {
  if (Buffer.byteLength(line) === 0 || Buffer.byteLength(line) > MAX_BROWSER_REQUEST_BYTES) {
    throw new TypeError("TASK24_BROWSER_REQUEST_SIZE_INVALID")
  }
  validateGrant(expectedGrant)
  const value = parseRecord(line, "TASK24_BROWSER_REQUEST_JSON_INVALID")
  exactKeys(value, [
    "protocolVersion",
    "authorization",
    "requestID",
    "runID",
    "previewID",
    "previewURL",
    "viewportID",
    "viewport",
    "wait",
    "interactionScriptID",
    "outputRelativePath",
    "timeoutMs",
  ])
  if (value.protocolVersion !== BROWSER_PROTOCOL_VERSION) invalidRequest()
  if (typeof value.authorization !== "string" || !sameSecret(value.authorization, `Bearer ${expectedGrant}`)) {
    throw new TypeError("TASK24_BROWSER_AUTH_INVALID")
  }
  if (typeof value.requestID !== "string" || !requestIDPattern.test(value.requestID)) invalidRequest()
  if (typeof value.runID !== "string" || !runIDPattern.test(value.runID)) invalidRequest()
  if (typeof value.previewID !== "string" || !previewIDPattern.test(value.previewID)) invalidRequest()
  if (typeof value.previewURL !== "string" || !isPreviewCapability(value.previewURL, value.previewID)) {
    throw new TypeError("TASK24_BROWSER_PREVIEW_INVALID")
  }
  if (value.viewportID !== "mobile" && value.viewportID !== "tablet" && value.viewportID !== "desktop") {
    throw new TypeError("TASK24_BROWSER_VIEWPORT_INVALID")
  }
  if (!sameViewport(value.viewport, FIXED_VIEWPORTS[value.viewportID])) {
    throw new TypeError("TASK24_BROWSER_VIEWPORT_INVALID")
  }
  if (!isRecord(value.wait)) invalidRequest()
  exactKeys(value.wait, ["kind", "selector", "frames"])
  if (value.wait.kind !== "selector" || !boundedText(value.wait.selector, 1, 512) || value.wait.frames !== 2) {
    throw new TypeError("TASK24_BROWSER_WAIT_INVALID")
  }
  if (!isInteractionScriptID(value.interactionScriptID)) {
    throw new TypeError("TASK24_BROWSER_INTERACTION_INVALID")
  }
  const expectedOutput = captureRelativePath(value.runID, value.previewID, value.viewportID)
  if (value.outputRelativePath !== expectedOutput) throw new TypeError("TASK24_BROWSER_OUTPUT_INVALID")
  if (!safeInteger(value.timeoutMs, 1, 120_000)) {
    throw new TypeError("TASK24_BROWSER_TIMEOUT_INVALID")
  }
  return deepFreeze({
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    authorization: value.authorization,
    requestID: value.requestID,
    runID: value.runID,
    previewID: value.previewID,
    previewURL: value.previewURL,
    viewportID: value.viewportID,
    viewport: { ...FIXED_VIEWPORTS[value.viewportID] },
    wait: { kind: "selector", selector: value.wait.selector, frames: 2 },
    interactionScriptID: value.interactionScriptID,
    outputRelativePath: value.outputRelativePath,
    timeoutMs: value.timeoutMs,
  })
}

export function decodeBrowserResponseLine(line: string, requestID: string): BrowserCaptureResponse {
  if (Buffer.byteLength(line) === 0 || Buffer.byteLength(line) > MAX_BROWSER_RESPONSE_BYTES) {
    throw new TypeError("TASK24_BROWSER_RESPONSE_SIZE_INVALID")
  }
  const value = parseRecord(line, "TASK24_BROWSER_RESPONSE_JSON_INVALID")
  if (value.protocolVersion !== BROWSER_PROTOCOL_VERSION || value.requestID !== requestID) {
    throw new TypeError("TASK24_BROWSER_RESPONSE_IDENTITY_INVALID")
  }
  if (value.ok === true) {
    exactKeys(value, ["protocolVersion", "requestID", "disposition", "ok", "evidence"], invalidResponse)
    if (value.disposition !== "published" || !isRecord(value.evidence)) invalidResponse()
    exactKeys(
      value.evidence,
      ["captureRootRelativePath", "screenshotSha256", "evidenceSha256", "screenshotBytes"],
      invalidResponse,
    )
    if (
      typeof value.evidence.captureRootRelativePath !== "string" ||
      typeof value.evidence.screenshotSha256 !== "string" ||
      !shaPattern.test(value.evidence.screenshotSha256) ||
      typeof value.evidence.evidenceSha256 !== "string" ||
      !shaPattern.test(value.evidence.evidenceSha256) ||
      !safeInteger(value.evidence.screenshotBytes, 1, MAX_SCREENSHOT_BYTES)
    ) {
      invalidResponse()
    }
    const response: PublishedCapture = {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      requestID: value.requestID,
      disposition: "published",
      ok: true,
      evidence: {
        captureRootRelativePath: value.evidence.captureRootRelativePath,
        screenshotSha256: value.evidence.screenshotSha256,
        evidenceSha256: value.evidence.evidenceSha256,
        screenshotBytes: value.evidence.screenshotBytes,
      },
    }
    return deepFreeze(response)
  }
  exactKeys(value, ["protocolVersion", "requestID", "disposition", "ok", "error"], invalidResponse)
  if (
    value.ok !== false ||
    (value.disposition !== "unstarted" && value.disposition !== "uncertain") ||
    !isRecord(value.error)
  ) {
    invalidResponse()
  }
  exactKeys(value.error, ["code", "message"], invalidResponse)
  if (
    typeof value.error.code !== "string" ||
    !errorCodePattern.test(value.error.code) ||
    !boundedText(value.error.message, 1, 2048)
  ) {
    invalidResponse()
  }
  const response: FailedCapture = {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    requestID: value.requestID,
    disposition: value.disposition,
    ok: false,
    error: { code: value.error.code, message: value.error.message },
  }
  return deepFreeze(response)
}

export function captureRelativePath(runID: string, previewID: string, viewportID: ViewportID): string {
  if (!runIDPattern.test(runID) || !previewIDPattern.test(previewID) || !(viewportID in FIXED_VIEWPORTS)) {
    throw new TypeError("TASK24_BROWSER_OUTPUT_INVALID")
  }
  return `captures/${runID}/${previewID}/${viewportID}`
}

export function validateGrant(value: string): string {
  if (!grantPattern.test(value)) throw new TypeError("TASK24_BROWSER_GRANT_INVALID")
  return value
}

export function isAdmittedPreviewRequest(candidate: string, previewURL: string): boolean {
  try {
    const target = new URL(candidate)
    const preview = new URL(previewURL)
    return (
      target.protocol === "http:" &&
      target.hostname === "127.0.0.1" &&
      target.port !== "" &&
      target.username === "" &&
      target.password === "" &&
      target.origin === preview.origin
    )
  } catch {
    return false
  }
}

function isPreviewCapability(value: string, previewID: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/([a-f0-9]{64})\/$/.exec(value)
  if (!match || match[2] !== previewID || Number(match[1]) > 65_535) return false
  try {
    return new URL(value).href === value
  } catch {
    return false
  }
}

function sameViewport(
  value: unknown,
  expected: Readonly<{ width: number; height: number; deviceScaleFactor: number }>,
) {
  if (!isRecord(value)) return false
  exactKeys(value, ["width", "height", "deviceScaleFactor"])
  return (
    value.width === expected.width &&
    value.height === expected.height &&
    value.deviceScaleFactor === expected.deviceScaleFactor
  )
}

function parseRecord(value: string, code: string): Record<string, unknown> {
  try {
    const decoded: unknown = JSON.parse(value)
    if (isRecord(decoded)) return decoded
  } catch {
    // Fall through to the typed protocol error.
  }
  throw new TypeError(code)
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  reject: () => never = invalidRequest,
): void {
  const actual = Object.keys(value).toSorted()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].toSorted())) reject()
}

function boundedText(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isInteractionScriptID(value: unknown): value is InteractionScriptID {
  return value === "none" || value === "primary-click" || value === "menu-toggle"
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function invalidRequest(): never {
  throw new TypeError("TASK24_BROWSER_REQUEST_INVALID")
}

function invalidResponse(): never {
  throw new TypeError("TASK24_BROWSER_RESPONSE_INVALID")
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
