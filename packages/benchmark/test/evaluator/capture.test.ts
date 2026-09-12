import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Task24Root } from "../../src/root"
import { MAX_SCREENSHOT_BYTES } from "../../src/evaluator/browser-protocol"
import {
  captureTarget,
  normalizePngMetadata,
  publishCapture,
  validateCaptureOutputRoot,
  verifyPublishedCapture,
} from "../../src/evaluator/capture"

const cleanup: string[] = []
afterEach(async () => {
  Bun.gc(true)
  while (cleanup.length > 0) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

describe("Task24 capture evidence", () => {
  test("confines output to a direct D-hosted Task24 run or report root", async () => {
    const root = path.join(Task24Root.ensure().runs, `browser-test-${crypto.randomUUID()}`)
    await fs.mkdir(root)
    cleanup.push(root)
    expect(validateCaptureOutputRoot(root)).toBe(root)
    expect(captureTarget(root, "captures/run-a/preview/mobile")).toBe(
      path.join(root, "captures", "run-a", "preview", "mobile"),
    )
    expect(() => validateCaptureOutputRoot("C:\\browser-output")).toThrow(/OUTPUT_ROOT/)
    expect(() => captureTarget(root, "../escape")).toThrow(/OUTPUT/)
  })

  test("normalizes ancillary PNG metadata without changing critical image chunks", () => {
    const first = pngWithText("created-at=one")
    const second = pngWithText("created-at=two")
    expect(hash(normalizePngMetadata(first))).toBe(hash(normalizePngMetadata(second)))
    expect(normalizePngMetadata(first)).toEqual(basePng())
  })

  test("publishes screenshot and evidence atomically and never overwrites it", async () => {
    const root = path.join(Task24Root.ensure().runs, `browser-test-${crypto.randomUUID()}`)
    await fs.mkdir(root)
    cleanup.push(root)
    const relative = "captures/run-a/preview/mobile"
    const input = {
      outputRoot: root,
      relative,
      screenshot: pngWithText("variable"),
      evidence: {
        schemaVersion: 1 as const,
        requestID: "a".repeat(32),
        runID: "run-a",
        previewID: "b".repeat(64),
        viewportID: "mobile",
        dom: [],
        consoleErrors: [],
        pageErrors: [],
        accessibility: {},
        axe: {},
      },
    }
    const published = await publishCapture(input)
    expect(await verifyPublishedCapture({ outputRoot: root, relative, ...published })).toMatchObject({
      screenshotSha256: published.screenshotSha256,
      evidenceSha256: published.evidenceSha256,
    })
    await expect(publishCapture(input)).rejects.toThrow(/ALREADY_PUBLISHED/)
  })

  test("rejects an oversized screenshot before publishing evidence", async () => {
    const root = path.join(Task24Root.ensure().runs, `browser-test-${crypto.randomUUID()}`)
    await fs.mkdir(root)
    cleanup.push(root)
    await expect(
      publishCapture({
        outputRoot: root,
        relative: "captures/run-a/preview/mobile",
        screenshot: oversizedPng(),
        evidence: {
          schemaVersion: 1,
          requestID: "a".repeat(32),
          runID: "run-a",
          previewID: "b".repeat(64),
          viewportID: "mobile",
          dom: [],
          consoleErrors: [],
          pageErrors: [],
          accessibility: {},
          axe: {},
        },
      }),
    ).rejects.toThrow(/SCREENSHOT_SIZE/)
  })
})

function basePng(): Uint8Array {
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196,
    137, 0, 0, 0, 13, 73, 68, 65, 84, 8, 215, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0,
    73, 69, 78, 68, 174, 66, 96, 130,
  ])
}

function pngWithText(text: string): Uint8Array {
  const png = basePng()
  const iend = png.subarray(png.byteLength - 12)
  const body = png.subarray(0, png.byteLength - 12)
  const data = Buffer.from(text)
  const chunk = Buffer.alloc(12 + data.byteLength)
  chunk.writeUInt32BE(data.byteLength, 0)
  chunk.write("tEXt", 4, "ascii")
  data.copy(chunk, 8)
  return Buffer.concat([body, chunk, iend])
}

function oversizedPng(): Uint8Array {
  const base = basePng()
  const signatureAndHeader = base.subarray(0, 33)
  const iend = base.subarray(base.byteLength - 12)
  const chunk = Buffer.alloc(12 + MAX_SCREENSHOT_BYTES)
  chunk.writeUInt32BE(MAX_SCREENSHOT_BYTES, 0)
  chunk.write("IDAT", 4, "ascii")
  return Buffer.concat([signatureAndHeader, chunk, iend])
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
