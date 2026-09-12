import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Task24Root } from "../../src/root"
import { normalizePdfMetadata, publishPdfReport } from "../../src/report/pdf"

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length > 0) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

describe("Task24 deterministic PDF publication", () => {
  test("normalizes same-length Chromium creation metadata and document IDs", () => {
    const left = normalizePdfMetadata(fakePdf("20260912112233", "a"))
    const right = normalizePdfMetadata(fakePdf("20270102030405", "b"))
    expect(Buffer.from(left).equals(Buffer.from(right))).toBe(true)
    expect(Buffer.from(left).toString("latin1")).toContain("D:20000101000000Z")
  })

  test("publishes a report atomically under D and refuses overwrite", async () => {
    const outputRoot = path.join(Task24Root.ensure().reports, `pdf-${crypto.randomUUID()}`)
    cleanup.push(outputRoot)
    await fs.mkdir(outputRoot)
    const published = await publishPdfReport({
      outputRoot,
      reportID: "campaign-fixture",
      pdf: fakePdf("20260912112233", "a"),
      evidenceHashes: ["1".repeat(64)],
    })
    expect(published.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await fs.readFile(published.pdf, "latin1")).toContain("D:20000101000000Z")
    await expect(
      publishPdfReport({
        outputRoot,
        reportID: "campaign-fixture",
        pdf: fakePdf("20260912112233", "a"),
        evidenceHashes: ["1".repeat(64)],
      }),
    ).rejects.toThrow("TASK24_PDF_ALREADY_PUBLISHED")
  })
})

function fakePdf(date: string, identity: string): Uint8Array {
  return Buffer.from(
    `%PDF-1.7\n1 0 obj<</CreationDate(D:${date}Z)/ModDate(D:${date}Z)>>endobj\ntrailer<</ID[<${identity.repeat(32)}><${identity.repeat(32)}>]>>\n%%EOF\n`,
    "latin1",
  )
}
