import { describe, expect, test } from "bun:test"
import {
  captureRelativePath,
  decodeBrowserRequestLine,
  decodeBrowserResponseLine,
  FIXED_VIEWPORTS,
  MAX_BROWSER_REQUEST_BYTES,
} from "../../src/evaluator/browser-protocol"

const grant = "a".repeat(43)
const previewID = "b".repeat(64)
const request = () => ({
  protocolVersion: 1,
  authorization: `Bearer ${grant}`,
  requestID: "c".repeat(32),
  runID: "run-a",
  previewID,
  previewURL: `http://127.0.0.1:3210/${previewID}/`,
  viewportID: "mobile",
  viewport: FIXED_VIEWPORTS.mobile,
  wait: { kind: "selector", selector: "#app", frames: 2 },
  interactionScriptID: "none",
  outputRelativePath: captureRelativePath("run-a", previewID, "mobile"),
  timeoutMs: 15_000,
})

describe("Task24 browser protocol", () => {
  test("accepts only an authenticated, identity-bound fixed capture request", () => {
    expect(decodeBrowserRequestLine(JSON.stringify(request()), grant)).toMatchObject({
      runID: "run-a",
      previewID,
      viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
    })
  })

  test.each([
    ["wrong bearer", { authorization: `Bearer ${"x".repeat(43)}` }],
    ["unsafe run ID", { runID: "../run" }],
    ["invalid preview ID", { previewID: "short" }],
    ["external URL", { previewURL: `https://example.com/${previewID}/` }],
    ["mismatched preview", { previewURL: `http://127.0.0.1:3210/${"d".repeat(64)}/` }],
    ["forged viewport", { viewport: { width: 391, height: 844, deviceScaleFactor: 1 } }],
    ["unknown viewport", { viewportID: "watch" }],
    ["arbitrary interaction", { interactionScriptID: "eval-js" }],
    ["output traversal", { outputRelativePath: "../escape" }],
    ["unbounded timeout", { timeoutMs: 120_001 }],
  ])("rejects %s", (_name, change) => {
    expect(() => decodeBrowserRequestLine(JSON.stringify({ ...request(), ...change }), grant)).toThrow(/TASK24_BROWSER/)
  })

  test("rejects excess fields and oversized JSON lines", () => {
    expect(() => decodeBrowserRequestLine(JSON.stringify({ ...request(), javascript: "alert(1)" }), grant)).toThrow()
    expect(() => decodeBrowserRequestLine("x".repeat(MAX_BROWSER_REQUEST_BYTES + 1), grant)).toThrow(/SIZE/)
  })

  test("validates published and failed responses against the request ID", () => {
    const success = {
      protocolVersion: 1,
      requestID: "c".repeat(32),
      disposition: "published",
      ok: true,
      evidence: {
        captureRootRelativePath: captureRelativePath("run-a", previewID, "mobile"),
        screenshotSha256: "d".repeat(64),
        evidenceSha256: "e".repeat(64),
        screenshotBytes: 1024,
      },
    }
    expect(decodeBrowserResponseLine(JSON.stringify(success), success.requestID).disposition).toBe("published")
    expect(() => decodeBrowserResponseLine(JSON.stringify(success), "f".repeat(32))).toThrow(/IDENTITY/)

    const failure = {
      protocolVersion: 1,
      requestID: success.requestID,
      disposition: "uncertain",
      ok: false,
      error: { code: "TASK24_BROWSER_PROCESS_CRASH", message: "helper exited" },
    }
    expect(decodeBrowserResponseLine(JSON.stringify(failure), success.requestID).disposition).toBe("uncertain")
  })
})
