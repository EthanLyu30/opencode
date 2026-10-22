import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import fs from "node:fs/promises"
import { runWindowsBrowserSmoke } from "./fixtures/windows-browser-worker"

const live = process.platform === "win32" && process.env.TASK24_WINDOWS_BROWSER_LIVE === "1"

test.skipIf(!live)(
  "real Windows Chromium preserves its renderer sandbox, blocks non-preview networking, and reclaims owned metadata",
  async () => {
    const release = process.env.TASK24_WINDOWS_BROWSER_RELEASE
    if (!release) throw Error("explicit frozen Windows browser release is required")
    const result = await runWindowsBrowserSmoke({ root: tmpdir(), release })
    expect(result.nativeExit).toBe(0)
    expect(result.observed.execution).toMatchObject({ started: true, exitCode: 0, truncated: false })
    expect(JSON.parse(Buffer.from(result.observed.execution.stdout).toString("utf8"))).toEqual({
      buttonText: "clicked",
      denied: [true, true],
      screenshotBytes: result.screenshot.length,
    })
    expect(result.screenshot.length).toBeGreaterThan(100)
    expect([...result.screenshot.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(result.previewHits).toBeGreaterThan(0)
    expect(result.canaryHits).toBe(0)
    expect(result.observed.containment.renderers.length).toBeGreaterThan(0)
    expect(result.observed.containment.metadataRegistrations).toHaveLength(6)
    expect(result.observed.containment.processTreeEnded).toBe(true)
    expect(result.observed.containment.cleanupCompleted).toBe(true)
    expect(result.modelApiCalls).toBe(0)
    expect(result.deploymentReplaced).toBe(false)
    await expect(fs.stat(result.root)).rejects.toMatchObject({ code: "ENOENT" })
  },
  120000,
)
