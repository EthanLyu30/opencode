import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../src/campaign/canonical"
import { Task24Root } from "../../src/root"
import {
  BrowserCaptureFailure,
  browserBuildSha256,
  loadBrowserRelease,
  makeBrowserRuntime,
  type BrowserInvocation,
  type BrowserProcessRunner,
  type BrowserReleaseFile,
} from "../../src/evaluator/browser-runtime"
import { decodeBrowserRequestLine } from "../../src/evaluator/browser-protocol"
import { publishCapture } from "../../src/evaluator/capture"

const cleanup: string[] = []
afterEach(async () => {
  Bun.gc(true)
  while (cleanup.length > 0) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

describe("Task24 authenticated browser runtime", () => {
  test("loads a content-addressed release and invokes Node with only D-scoped evaluator authority", async () => {
    const fixture = await runtimeFixture("authenticated")
    let invocation: BrowserInvocation | undefined
    const runtime = makeBrowserRuntime({
      release: fixture.release,
      outputRoot: fixture.output,
      tempRoot: fixture.temp,
      grant: () => "g".repeat(43),
      requestID: () => "a".repeat(32),
      runner: {
        execute: async (input) => {
          invocation = input
          return publishSuccess(input)
        },
      },
    })

    const result = await runtime.capture(captureInput())

    expect(result.screenshotBytes).toBeGreaterThan(0)
    expect(invocation?.executable).toBe(fixture.release.nodeExecutable)
    expect(invocation?.argv).toEqual([fixture.release.helper])
    expect(invocation?.env.TASK24_BROWSER_OUTPUT_ROOT).toBe(fixture.output)
    expect(invocation?.env.TEMP).toBe(fixture.temp)
    expect(Object.keys(invocation?.env ?? {}).some((key) => /api.*key|deepseek|kimi/i.test(key))).toBe(false)
    const request = decodeBrowserRequestLine(invocation?.stdin.trim() ?? "", "g".repeat(43))
    expect(request.requestID).toBe("a".repeat(32))
  })

  test("refuses a release changed after integrity verification before starting a helper", async () => {
    const fixture = await runtimeFixture("tamper")
    let calls = 0
    const runtime = makeBrowserRuntime({
      release: fixture.release,
      outputRoot: fixture.output,
      tempRoot: fixture.temp,
      runner: { execute: async () => (calls++, Promise.reject(new Error("must not start"))) },
    })
    await fs.writeFile(fixture.release.helper, "tampered-helper")

    await expect(runtime.capture(captureInput())).rejects.toThrow(/identity|disposition/i)
    expect(calls).toBe(0)
  })

  test("restarts once only when the helper proves capture was unstarted", async () => {
    const fixture = await runtimeFixture("retry")
    let calls = 0
    const runner: BrowserProcessRunner = {
      execute: async (input) => {
        calls++
        if (calls === 1) {
          const request = decodeBrowserRequestLine(input.stdin.trim(), input.env.TASK24_BROWSER_GRANT ?? "")
          return {
            started: true,
            exit: 1,
            stdout: JSON.stringify({
              protocolVersion: 1,
              requestID: request.requestID,
              disposition: "unstarted",
              ok: false,
              error: { code: "TASK24_BROWSER_LAUNCH_FAILED", message: "browser was not started" },
            }),
            stderr: "",
            truncated: false,
          }
        }
        return publishSuccess(input)
      },
    }
    const runtime = makeBrowserRuntime({
      release: fixture.release,
      outputRoot: fixture.output,
      tempRoot: fixture.temp,
      runner,
    })

    await expect(runtime.capture(captureInput())).resolves.toMatchObject({ screenshotBytes: expect.any(Number) })
    expect(calls).toBe(2)
  })

  test.each([
    ["uncertain failure", "{response}"],
    ["malformed helper response", "not-json"],
  ])("does not repeat an interaction after %s", async (_name, mode) => {
    const fixture = await runtimeFixture(`no-retry-${mode === "not-json" ? "json" : "uncertain"}`)
    let calls = 0
    const runtime = makeBrowserRuntime({
      release: fixture.release,
      outputRoot: fixture.output,
      tempRoot: fixture.temp,
      runner: {
        execute: async (input) => {
          calls++
          const request = decodeBrowserRequestLine(input.stdin.trim(), input.env.TASK24_BROWSER_GRANT ?? "")
          return {
            started: true,
            exit: 1,
            stdout:
              mode === "not-json"
                ? mode
                : JSON.stringify({
                    protocolVersion: 1,
                    requestID: request.requestID,
                    disposition: "uncertain",
                    ok: false,
                    error: { code: "TASK24_BROWSER_PROCESS_CRASH", message: "capture may have started" },
                  }),
            stderr: "helper crashed",
            truncated: false,
          }
        },
      },
    })

    const failure = runtime.capture(captureInput())
    await expect(failure).rejects.toBeInstanceOf(BrowserCaptureFailure)
    await expect(failure).rejects.toMatchObject({ disposition: "uncertain" })
    expect(calls).toBe(1)
  })
})

async function runtimeFixture(label: string) {
  const layout = Task24Root.ensure()
  const base = path.join(layout.toolchain, "browser")
  await fs.mkdir(base, { recursive: true })
  const staging = path.join(base, `.fixture-${label}-${crypto.randomUUID()}`)
  await fs.mkdir(path.join(staging, "chromium"), { recursive: true })
  await fs.writeFile(path.join(staging, "node.exe"), `node-${label}-${crypto.randomUUID()}`)
  await fs.writeFile(path.join(staging, "helper.mjs"), `helper-${label}-${crypto.randomUUID()}`)
  await fs.writeFile(path.join(staging, "chromium", "chrome.exe"), `chrome-${label}-${crypto.randomUUID()}`)
  const files = await releaseFiles(staging)
  const unsigned = {
    schemaVersion: 1 as const,
    protocolVersion: 1 as const,
    nodeFile: "node.exe",
    helperFile: "helper.mjs",
    browserExecutableFile: "chromium/chrome.exe",
    files,
  }
  const buildSha256 = browserBuildSha256(unsigned)
  await fs.writeFile(
    path.join(staging, "task24-browser-runtime.manifest.json"),
    canonicalJson({ ...unsigned, buildSha256 }) + "\n",
  )
  const root = path.join(base, buildSha256)
  await fs.rename(staging, root)
  cleanup.push(root)
  const output = path.join(layout.runs, `browser-runtime-test-${crypto.randomUUID()}`)
  const temp = path.join(layout.tmp, `browser-runtime-test-${crypto.randomUUID()}`)
  await fs.mkdir(output)
  await fs.mkdir(temp)
  cleanup.push(output, temp)
  return { release: loadBrowserRelease(root), output, temp }
}

async function releaseFiles(root: string): Promise<BrowserReleaseFile[]> {
  const result: BrowserReleaseFile[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolute)
        continue
      }
      const bytes = await fs.readFile(absolute)
      result.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      })
    }
  }
  await visit(root)
  return result.toSorted((a, b) => a.path.localeCompare(b.path))
}

async function publishSuccess(input: BrowserInvocation) {
  const grant = input.env.TASK24_BROWSER_GRANT ?? ""
  const request = decodeBrowserRequestLine(input.stdin.trim(), grant)
  const published = await publishCapture({
    outputRoot: input.env.TASK24_BROWSER_OUTPUT_ROOT ?? "",
    relative: request.outputRelativePath,
    screenshot: basePng(),
    evidence: {
      schemaVersion: 1,
      requestID: request.requestID,
      runID: request.runID,
      previewID: request.previewID,
      viewportID: request.viewportID,
      dom: [],
      consoleErrors: [],
      pageErrors: [],
      accessibility: {},
      axe: {},
    },
  })
  return {
    started: true,
    exit: 0,
    stdout: JSON.stringify({
      protocolVersion: 1,
      requestID: request.requestID,
      disposition: "published",
      ok: true,
      evidence: {
        captureRootRelativePath: request.outputRelativePath,
        screenshotSha256: published.screenshotSha256,
        evidenceSha256: published.evidenceSha256,
        screenshotBytes: published.screenshotBytes,
      },
    }),
    stderr: "",
    truncated: false,
  } as const
}

function captureInput() {
  const previewID = "b".repeat(64)
  return {
    runID: "run-a",
    previewID,
    previewURL: `http://127.0.0.1:3210/${previewID}/`,
    viewportID: "mobile" as const,
    readySelector: "#app",
    interactionScriptID: "none" as const,
    timeoutMs: 15_000,
    signal: new AbortController().signal,
  }
}

function basePng(): Uint8Array {
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196,
    137, 0, 0, 0, 13, 73, 68, 65, 84, 8, 215, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0,
    73, 69, 78, 68, 174, 66, 96, 130,
  ])
}
