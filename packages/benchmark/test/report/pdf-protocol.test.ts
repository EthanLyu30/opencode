import { describe, expect, test } from "bun:test"
import { decodeBrowserPdfRequestLine, decodeBrowserPdfResponseLine } from "../../src/report/pdf-protocol"

const grant = "g".repeat(43)
const requestID = "a".repeat(32)

describe("Task24 authenticated PDF protocol", () => {
  test("accepts a bounded loopback report request and its identity-bound response", () => {
    const request = decodeBrowserPdfRequestLine(JSON.stringify(validRequest()), grant)
    expect(request.reportID).toBe("campaign-fixture")
    expect(
      decodeBrowserPdfResponseLine(
        JSON.stringify({
          protocolVersion: 1,
          requestID,
          disposition: "published",
          ok: true,
          evidence: {
            pdfRootRelativePath: "campaign-fixture",
            pdfSha256: "2".repeat(64),
            evidenceSha256: "3".repeat(64),
            pdfBytes: 1_024,
          },
        }),
        requestID,
      ),
    ).toMatchObject({ ok: true, disposition: "published" })
  })

  test.each([
    { authorization: `Bearer ${"x".repeat(43)}` },
    { reportURL: "https://example.com/campaign-fixture/" },
    { reportURL: "http://127.0.0.1:3210/another/" },
    { outputRelativePath: "../campaign-fixture" },
    { evidenceHashes: [] },
    { timeoutMs: 0 },
  ])("rejects a forged PDF request", (patch) => {
    expect(() => decodeBrowserPdfRequestLine(JSON.stringify({ ...validRequest(), ...patch }), grant)).toThrow()
  })
})

function validRequest() {
  return {
    protocolVersion: 1,
    operation: "report-pdf",
    authorization: `Bearer ${grant}`,
    requestID,
    reportID: "campaign-fixture",
    reportURL: "http://127.0.0.1:3210/campaign-fixture/",
    outputRelativePath: "campaign-fixture",
    evidenceHashes: ["1".repeat(64)],
    timeoutMs: 30_000,
  }
}
