import { afterAll, describe, expect, test } from "bun:test"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkflowSchema } from "@opencode-ai/core/workflow"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { PlaywrightCapture } from "../src/workflow/playwright"
import { WorkflowVisualHostServer } from "../src/workflow/visual-host"

const workflowID = WorkflowSchema.ID.make("wfl_server_visual_host")
const fixtureRoot = path.join(import.meta.dir, "fixtures", "workflow-visual")
const testRoot = "D:\\OpenCode-Local\\tmp\\workflow-host-tests"

afterAll(async () => {
  await fs.rm(testRoot, { recursive: true, force: true })
})

describe("WorkflowVisualHostServer", () => {
  test("materializes strict reference files behind a fresh loopback capability and removes them with the scope", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const runtime = browserRuntime()
    let url = ""
    let capabilityDirectory = ""

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: reference }],
            },
          })
          url = preview.url
          capabilityDirectory = path.join(temp.path, preview.hostID)
          const parsed = new URL(preview.url)

          expect(parsed.hostname).toBe("127.0.0.1")
          expect(Number(parsed.port)).toBeGreaterThan(0)
          expect(parsed.pathname).toBe(`/${preview.hostID}/`)
          expect(preview.hostID).toMatch(/^[a-f0-9]{64}$/)
          expect(yield* Effect.promise(() => fs.realpath(capabilityDirectory))).toBe(capabilityDirectory)
          expect(yield* Effect.promise(() => fs.readFile(path.join(capabilityDirectory, "index.html"), "utf8"))).toBe(
            reference,
          )
          expect(yield* Effect.promise(() => fetch(preview.url).then((response) => response.text()))).toBe(reference)
          expect(
            yield* Effect.promise(() => fetch(`${preview.origin}/${preview.hostID}/../package.json`)),
          ).toMatchObject({ status: 404 })
        }),
      ).pipe(Effect.provide(WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: runtime.runtime }))),
    )

    expect(await fs.exists(capabilityDirectory)).toBe(false)
    await expect(fetch(url)).rejects.toThrow()
  })

  test("rejects reference traversal before writing outside the fresh capability directory", async () => {
    await using temp = await taskTemp()
    const outside = path.join(temp.path, "outside.txt")
    const malformed = {
      entrypoint: "../outside.txt",
      readySelector: "#ready",
      projectStack: ["HTML"],
      files: [{ path: "../outside.txt", content: "escape" }],
    }
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.materializeReference({
            workflowID,
            referenceApp: malformed as WorkflowVisualHost.MaterializeReferenceInput["referenceApp"],
          })
        }),
      ).pipe(
        Effect.provide(WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: browserRuntime().runtime })),
        Effect.flip,
      ),
    )

    expect(failure).toMatchObject({ operation: "materialize_reference", code: "invalid_reference_app" })
    expect(await fs.exists(outside)).toBe(false)
    expect((await fs.readdir(temp.path)).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([])
  })

  test("rejects accessor-backed reference data without invoking model-controlled getters", async () => {
    await using temp = await taskTemp()
    let getterCalled = false
    const reference: WorkflowVisualHost.MaterializeReferenceInput["referenceApp"] = {
      entrypoint: "index.html",
      readySelector: "#ready",
      projectStack: ["HTML"],
      files: [{ path: "index.html", content: "<!doctype html>" }],
    }
    Object.defineProperty(reference, "entrypoint", {
      enumerable: true,
      get() {
        getterCalled = true
        return "index.html"
      },
    })
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.materializeReference({
            workflowID,
            referenceApp: reference,
          })
        }),
      ).pipe(
        Effect.provide(WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: browserRuntime().runtime })),
        Effect.flip,
      ),
    )

    expect(failure).toMatchObject({ operation: "materialize_reference", code: "invalid_reference_app" })
    expect(getterCalled).toBe(false)
  })

  test("uses a fresh locked-down browser context, denies non-admitted requests, waits for readiness, and returns exact PNG", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const runtime = browserRuntime()
    const images = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: reference }],
            },
          })
          runtime.requestURLs.push(
            preview.url,
            `${preview.origin}/${preview.hostID}/app.js`,
            "https://example.com/tracker.js",
            "file:///D:/secret.txt",
            `http://user:pass@127.0.0.1:${new URL(preview.url).port}/${preview.hostID}/private`,
          )
          const first = yield* host.capture({
            preview,
            readySelector: "#ready",
            viewport: { name: "desktop", width: 1440, height: 900 },
          })
          const second = yield* host.capture({
            preview,
            readySelector: "#ready",
            viewport: { name: "mobile", width: 390, height: 844 },
          })
          return { first, second }
        }),
      ).pipe(Effect.provide(WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: runtime.runtime }))),
    )

    expect(runtime.contextOptions).toEqual([
      {
        viewport: { width: 1440, height: 900 },
        colorScheme: "light",
        reducedMotion: "reduce",
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
      },
      {
        viewport: { width: 390, height: 844 },
        colorScheme: "light",
        reducedMotion: "reduce",
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
      },
    ])
    expect(runtime.continued).toEqual([
      runtime.requestURLs[0],
      runtime.requestURLs[1],
      runtime.requestURLs[0],
      runtime.requestURLs[1],
    ])
    expect(runtime.aborted).toEqual([
      runtime.requestURLs[2],
      runtime.requestURLs[3],
      runtime.requestURLs[4],
      runtime.requestURLs[2],
      runtime.requestURLs[3],
      runtime.requestURLs[4],
    ])
    expect(runtime.selectors).toEqual(["#ready", "#ready"])
    expect(runtime.evaluateSources.filter((source) => source.includes("document.fonts.ready"))).toHaveLength(2)
    expect(
      runtime.evaluateSources.filter((source) => source.match(/requestAnimationFrame/g)?.length === 2),
    ).toHaveLength(2)
    expect(runtime.screenshotOptions).toEqual([
      { type: "png", fullPage: false, animations: "disabled", caret: "hide", scale: "css" },
      { type: "png", fullPage: false, animations: "disabled", caret: "hide", scale: "css" },
    ])
    expect(runtime.contextsClosed).toBe(2)
    expect(runtime.closed).toBe(1)
    expect(images.first.width).toBe(1440)
    expect(images.first.height).toBe(900)
    expect(images.first.sha256).toBe(createHash("sha256").update(images.first.bytes).digest("hex"))
    expect(images.second.width).toBe(390)
    expect(images.second.height).toBe(844)
  })

  test("spawns only the frozen argv for a script preview and tears down its process tree on scope close", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    using authorityDecoy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("escaped-authority"),
    })
    const workspace = workspaceTemp.path
    const port = await unusedPort()
    await fs.writeFile(
      path.join(workspace, "child.mjs"),
      `import http from "node:http"\nhttp.createServer((_, response) => response.end("script-ready")).listen(${port}, "127.0.0.1")\n`,
    )
    await fs.writeFile(
      path.join(workspace, "server.mjs"),
      [
        'import { spawn } from "node:child_process"',
        'import fs from "node:fs"',
        'import path from "node:path"',
        'fs.mkdtempSync(path.join(process.env.TEMP, "preview-"))',
        'spawn(process.execPath, ["child.mjs"], { stdio: "ignore" })',
        'process.stdout.write("o".repeat(2 * 1024 * 1024))',
        'process.stderr.write("e".repeat(2 * 1024 * 1024))',
        "setInterval(() => undefined, 60_000)",
      ].join("\n"),
    )
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspace) }),
      preview: { kind: "script", argv: ["node", "server.mjs"] },
      allowedOrigins: [`http://127.0.0.1:${port}`],
    })
    const observed: string[][] = []
    let previewURL = ""

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.prepareImplementation({ workflowID, revision: 1, plan })
          previewURL = preview.url
          expect(yield* Effect.promise(() => fetch(preview.url).then((response) => response.text()))).toBe(
            "script-ready",
          )
          expect(
            yield* Effect.promise(() => fetch(`${preview.url}@vite/client`).then((response) => response.text())),
          ).toBe("script-ready")
          expect(
            yield* Effect.promise(() =>
              fetch(`${preview.url}/127.0.0.1:${authorityDecoy.port}/leak`).then((response) => response.text()),
            ),
          ).toBe("script-ready")
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            onSpawnArgv: (argv) => observed.push([...argv]),
          }),
        ),
      ),
    )

    expect(observed).toEqual([["node", "server.mjs"]])
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow()
    await expect(fetch(previewURL)).rejects.toThrow()
  })

  test("serves a frozen static implementation and admits only its frozen local dependency origin", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    const implementation = await fs.readFile(path.join(fixtureRoot, "implementation", "index.html"), "utf8")
    await fs.writeFile(path.join(workspaceTemp.path, "index.html"), implementation)
    const dependencyOrigin = "http://127.0.0.1:4317"
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "static", entrypoint: "index.html" },
      allowedOrigins: [dependencyOrigin],
    })
    const runtime = browserRuntime()
    runtime.requestURLs.push(`${dependencyOrigin}/asset.js`, "https://example.com/tracker.js")

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.prepareImplementation({ workflowID, revision: 2, plan })
          const html = yield* Effect.promise(() => fetch(preview.url).then((response) => response.text()))
          const image = yield* host.capture({
            preview,
            readySelector: "#ready",
            viewport: { name: "desktop", width: 1440, height: 900 },
          })
          return { preview, html, image }
        }),
      ).pipe(Effect.provide(WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: runtime.runtime }))),
    )

    expect(result.html).toBe(implementation)
    expect(result.preview.revision).toBe(2)
    expect(result.preview.configSha256).toBe(plan.configSha256)
    expect(result.image.width).toBe(1440)
    expect(runtime.continued).toEqual([`${dependencyOrigin}/asset.js`])
    expect(runtime.aborted).toEqual(["https://example.com/tracker.js"])
  })

  test("re-verifies the frozen implementation plan before creating a capability", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    await fs.writeFile(path.join(workspaceTemp.path, "index.html"), "<!doctype html><main id=ready></main>")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "static", entrypoint: "index.html" },
    })
    await fs.rm(path.join(workspaceTemp.path, "index.html"))

    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.prepareImplementation({ workflowID, revision: 0, plan })
        }),
      ).pipe(
        Effect.provide(WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: browserRuntime().runtime })),
        Effect.flip,
      ),
    )

    expect(failure).toMatchObject({ operation: "prepare_implementation", code: "invalid_preview_plan" })
    expect((await fs.readdir(temp.path)).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([])
  })

  test("fails typed before accepting a PNG above the per-image evidence cap", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const runtime = browserRuntime(() => new Uint8Array(WorkflowVisualHost.MAX_IMAGE_BYTES + 1))
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: reference }],
            },
          })
          return yield* host.capture({
            preview,
            readySelector: "#ready",
            viewport: { name: "desktop", width: 1440, height: 900 },
          })
        }),
      ).pipe(
        Effect.provide(WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: runtime.runtime })),
        Effect.flip,
      ),
    )

    expect(failure).toMatchObject({ operation: "capture", code: "image_evidence_limit_exceeded" })
  })

  test("serializes concurrent captures so the exact workflow evidence cap cannot be raced", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const viewport = { name: "mobile", width: 390, height: 844 } as const
    const pngBytes = WorkflowVisualHost.deterministicPng(viewport)
    const runtime = browserRuntime(() => pngBytes)
    const outcomes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: reference }],
            },
          })
          const capture = host.capture({ preview, readySelector: "#ready", viewport }).pipe(
            Effect.match({
              onFailure: (error) => ({ error }),
              onSuccess: (image) => ({ image }),
            }),
          )
          return yield* Effect.all([capture, capture], { concurrency: "unbounded" })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: runtime.runtime,
            initialEvidenceBytes: {
              [workflowID]: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES - pngBytes.byteLength,
            },
          }),
        ),
      ),
    )

    expect(outcomes.filter((outcome) => "image" in outcome)).toHaveLength(1)
    expect(outcomes.filter((outcome) => "error" in outcome)).toMatchObject([
      { error: { operation: "capture", code: "workflow_evidence_limit_exceeded" } },
    ])
  })

  test("recovers only expired host-owned capabilities that are not fenced by an active lease", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const leased = yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: reference }],
            },
          })
          const expired = yield* host.materializeReference({
            workflowID: WorkflowSchema.ID.make("wfl_server_visual_expired"),
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: reference }],
            },
          })
          yield* host.recoverExpired({ activeHostIDs: new Set([leased.hostID]), expiredBefore: 11 })
          expect(leased.hostID).not.toBe(expired.hostID)
          expect(yield* Effect.promise(() => fs.exists(path.join(temp.path, leased.hostID)))).toBe(true)
          expect(yield* Effect.promise(() => fs.exists(path.join(temp.path, expired.hostID)))).toBe(false)
          return { leased, expired }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            now: () => 10,
          }),
        ),
      ),
    )

    expect(await fs.exists(path.join(temp.path, result.leased.hostID))).toBe(false)
    expect(await fs.exists(path.join(temp.path, result.expired.hostID))).toBe(false)
    expect(await fs.exists(temp.path)).toBe(true)
  })

  test("bounds layer finalization when a runtime adapter does not finish closing", async () => {
    await using temp = await taskTemp()
    const stalled: PlaywrightCapture.Runtime = {
      capture: async () => {
        throw new Error("unused")
      },
      close: () => new Promise(() => undefined),
    }
    const closed = Effect.runPromise(
      Effect.scoped(Effect.void).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: stalled,
            finalizerTimeoutMs: 20,
          }),
        ),
      ),
    ).then(() => "closed")

    expect(await Promise.race([closed, Bun.sleep(200).then(() => "timeout")])).toBe("closed")
  })
})

function browserRuntime(captureBytes?: () => Uint8Array) {
  const state = {
    requestURLs: [] as string[],
    continued: [] as string[],
    aborted: [] as string[],
    contextOptions: [] as PlaywrightCapture.ContextOptions[],
    selectors: [] as string[],
    evaluateSources: [] as string[],
    screenshotOptions: [] as PlaywrightCapture.ScreenshotOptions[],
    contextsClosed: 0,
    closed: 0,
  }
  const browserType: PlaywrightCapture.BrowserType = {
    async launch() {
      return {
        async newContext(options) {
          state.contextOptions.push(options)
          let handler: PlaywrightCapture.RouteHandler | undefined
          return {
            async route(_pattern, value) {
              handler = value
            },
            async newPage() {
              return {
                async goto() {
                  if (handler === undefined) throw new Error("route policy missing")
                  for (const url of state.requestURLs) {
                    await handler({
                      request: () => ({ url: () => url }),
                      continue: async () => {
                        state.continued.push(url)
                      },
                      abort: async () => {
                        state.aborted.push(url)
                      },
                    })
                  }
                },
                async waitForSelector(selector) {
                  state.selectors.push(selector)
                },
                async evaluate(callback) {
                  state.evaluateSources.push(String(callback))
                },
                async screenshot(options) {
                  state.screenshotOptions.push(options)
                  return (
                    captureBytes?.() ??
                    WorkflowVisualHost.deterministicPng({
                      name: "capture",
                      width: state.contextOptions.at(-1)?.viewport.width ?? 1,
                      height: state.contextOptions.at(-1)?.viewport.height ?? 1,
                    })
                  )
                },
              }
            },
            async close() {
              state.contextsClosed++
            },
          }
        },
        async close() {
          state.closed++
        },
      }
    },
  }
  return Object.assign(state, {
    runtime: PlaywrightCapture.makeRuntime({ browserType, tempRoot: testRoot }),
  })
}

async function taskTemp() {
  await fs.mkdir(testRoot, { recursive: true })
  const directory = await fs.realpath(await fs.mkdtemp(path.join(testRoot, "case-")))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

async function unusedPort(): Promise<number> {
  using server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  if (server.port === undefined) throw new Error("Bun did not assign a test port")
  return server.port
}
