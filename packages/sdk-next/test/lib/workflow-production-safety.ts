import { createHash } from "node:crypto"
import { Database as BunDatabase } from "bun:sqlite"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"

const sensitiveSurfaceKey =
  /^(authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|set-cookie|provider[-_]?response[-_]?body)$/i
const sensitiveSurfaceValue = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/i

export function assertProductionAcceptanceSafeSurface(value: unknown): void {
  assertSafeValue(value, "$focusedSurface", new Set())
}

export function assertProductionAcceptanceDatabaseSafeSurface(file: string): void {
  scanDatabase(file, "$focusedDatabase", new Set())
}

export function scanDatabase(file: string, label: string, forbidden: ReadonlySet<string>): void {
  const database = new BunDatabase(file, { readonly: true })
  try {
    const tables = database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
    for (const { name } of tables) {
      if (!/^[a-z0-9_]+$/i.test(name)) throw new Error("Unexpected SQLite table name")
      const rows = database.query<Record<string, unknown>, []>(`SELECT * FROM ${name}`).all()
      for (const [rowIndex, row] of rows.entries()) {
        const decoded = Object.fromEntries(
          Object.entries(row).map(([column, value]) => [
            column,
            typeof value === "string" ? (parseJson(value) ?? value) : value,
          ]),
        )
        assertSafeValue(decoded, `${label}.${name}[${rowIndex}]`, forbidden)
      }
    }
  } finally {
    database.close()
  }
}

export function assertSafeValue(
  value: unknown,
  pathLabel: string,
  forbidden: ReadonlySet<string>,
  screenshotPayloads = new WeakSet<object>(),
  visited = new WeakSet<object>(),
): void {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return
  if (typeof value === "string") {
    for (const sentinel of forbidden) {
      if (sentinel.length > 0 && value.includes(sentinel)) throw new Error(`Forbidden sentinel reached ${pathLabel}`)
    }
    if (sensitiveSurfaceValue.test(value)) throw new Error(`Credential value reached ${pathLabel}`)
    if (/\bdata:/i.test(value)) throw new Error(`Data URL reached ${pathLabel}`)
    if (isCanonicalLongBase64(value)) throw new Error(`Ordinary long base64 reached ${pathLabel}`)
    return
  }
  if (typeof value !== "object") throw new Error(`Unsupported scanned value at ${pathLabel}`)
  if (ArrayBuffer.isView(value)) {
    assertSafeBinary(Buffer.from(value.buffer, value.byteOffset, value.byteLength), pathLabel, forbidden)
    return
  }
  if (value instanceof ArrayBuffer) {
    assertSafeBinary(Buffer.from(value), pathLabel, forbidden)
    return
  }
  if (visited.has(value)) return
  visited.add(value)
  const screenshotPayload = validatedScreenshotPayload(value)
  const alreadyAllowed = screenshotPayload === undefined ? false : screenshotPayloads.has(screenshotPayload)
  if (screenshotPayload !== undefined && !alreadyAllowed) screenshotPayloads.add(screenshotPayload)
  try {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        assertSafeValue(item, `${pathLabel}[${index}]`, forbidden, screenshotPayloads, visited)
      }
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (/^data[-_]?base64$/i.test(key)) {
        if (screenshotPayloads.has(value) && key === "dataBase64") continue
        throw new Error(`dataBase64 reached ordinary surface ${pathLabel}`)
      }
      if (sensitiveSurfaceKey.test(key)) throw new Error(`Credential-like key ${key} reached ${pathLabel}`)
      assertSafeValue(item, `${pathLabel}.${key}`, forbidden, screenshotPayloads, visited)
    }
  } finally {
    if (screenshotPayload !== undefined && !alreadyAllowed) screenshotPayloads.delete(screenshotPayload)
    visited.delete(value)
  }
}

export function assertScannerRejectsDynamicProbes(): void {
  const nonce = crypto.randomUUID().replaceAll("-", "")
  const probes: unknown[] = [
    { authorization: `Bearer ${nonce}${nonce}` },
    { apiKey: `sk-${nonce}` },
    `data:image/png;base64,${Buffer.from(nonce).toString("base64")}`,
    Buffer.from(nonce.repeat(8)).toString("base64"),
    Buffer.from(`sk-${nonce}`),
  ]
  for (const [index, probe] of probes.entries()) {
    let rejected = false
    try {
      assertSafeValue(probe, `$scannerProbe[${index}]`, new Set())
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(`Secret scanner did not reject dynamic probe ${index}`)
  }
}

function validatedScreenshotPayload(value: object): object | undefined {
  const kind = Reflect.get(value, "kind")
  if (
    kind !== WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND &&
    kind !== WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND
  ) {
    return undefined
  }
  if (!Reflect.has(value, "metadata")) return undefined
  const metadata = Reflect.get(value, "metadata")
  if (metadata === null || typeof metadata !== "object") throw new Error("Screenshot artifact metadata is absent")
  const payload = Reflect.get(metadata, "payload")
  if (payload === null || typeof payload !== "object") throw new Error("Screenshot artifact payload is absent")
  const dataBase64 = Reflect.get(payload, "dataBase64")
  const imageValue = Reflect.get(payload, "image")
  const receiptValue = Reflect.get(payload, "evidenceReceipt")
  if (typeof dataBase64 !== "string" || imageValue === null || typeof imageValue !== "object") {
    throw new Error("Screenshot artifact bytes or identity are absent")
  }
  const workflowID = Reflect.get(imageValue, "workflowID")
  if (typeof workflowID !== "string") throw new Error("Screenshot artifact workflow owner is absent")
  const commit = {
    kind,
    uri: Reflect.get(value, "uri"),
    mime: Reflect.get(value, "mime"),
    sha256: Reflect.get(value, "sha256"),
    size: Reflect.get(value, "size"),
    metadata,
  }
  const image = WorkflowVisualReviewArtifact.decodeScreenshot(commit as never, workflowID as never)
  const bytes = Buffer.from(dataBase64, "base64")
  const pngSignature = "89504e470d0a1a0a"
  if (
    bytes.toString("base64") !== dataBase64 ||
    bytes.subarray(0, 8).toString("hex") !== pngSignature ||
    sha256(bytes) !== image.sha256 ||
    bytes.byteLength !== image.size ||
    image.evidenceReceipt === undefined ||
    JSON.stringify(receiptValue) !== JSON.stringify(image.evidenceReceipt) ||
    image.evidenceReceipt.pngSha256 !== image.sha256 ||
    image.evidenceReceipt.evidenceBytes !== image.size ||
    image.evidenceReceipt.coordinates.workflowID !== workflowID ||
    image.evidenceReceipt.coordinates.viewport.name !== image.viewport ||
    image.evidenceReceipt.coordinates.kind !== image.kind ||
    image.evidenceReceipt.coordinates.revision !== image.revision ||
    (Reflect.has(value, "workflowID") && Reflect.get(value, "workflowID") !== workflowID) ||
    (Reflect.has(value, "stageID") && Reflect.get(value, "stageID") !== image.evidenceReceipt.coordinates.stageID) ||
    (Reflect.has(value, "workflow_id") && Reflect.get(value, "workflow_id") !== workflowID) ||
    (Reflect.has(value, "stage_id") && Reflect.get(value, "stage_id") !== image.evidenceReceipt.coordinates.stageID)
  ) {
    throw new Error("Screenshot artifact base64 exception is not canonically bound")
  }
  return payload
}

function isCanonicalLongBase64(value: string): boolean {
  if (value.length < 128 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  try {
    return Buffer.from(value, "base64").toString("base64") === value
  } catch {
    return false
  }
}

function parseJson(value: string): unknown | undefined {
  const candidate = value.trimStart()
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return undefined
  try {
    return JSON.parse(candidate)
  } catch {
    return undefined
  }
}

function assertSafeBinary(value: Buffer, pathLabel: string, forbidden: ReadonlySet<string>): void {
  for (const sentinel of forbidden) {
    if (sentinel.length > 0 && value.indexOf(sentinel, 0, "utf8") !== -1) {
      throw new Error(`Forbidden sentinel reached ${pathLabel}`)
    }
  }
  if (sensitiveSurfaceValue.test(value.toString("latin1"))) {
    throw new Error(`Credential value reached ${pathLabel}`)
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
