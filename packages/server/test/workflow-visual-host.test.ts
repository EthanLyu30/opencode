import { afterAll, describe, expect, test } from "bun:test"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkflowSchema } from "@opencode-ai/core/workflow"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { Effect, Fiber } from "effect"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { PlaywrightCapture } from "../src/workflow/playwright"
import { ProcessOwnership } from "../src/workflow/process-ownership"
import { EvidenceLedger } from "../src/workflow/evidence-ledger"
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

  test("registers reference cleanup before an interruptible acquisition step can be cancelled", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    let createdDirectory = ""

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const acquisition = yield* host
            .materializeReference({
              workflowID,
              referenceApp: {
                entrypoint: "index.html",
                readySelector: "#ready",
                projectStack: ["HTML"],
                files: [{ path: "index.html", content: reference }],
              },
            })
            .pipe(Effect.forkChild)
          const reached = yield* Effect.promise(() =>
            waitUntil(() => createdDirectory !== "", 200).then(
              () => true,
              () => false,
            ),
          )
          expect(reached).toBe(true)
          yield* Fiber.interrupt(acquisition).pipe(Effect.timeout("200 millis"))
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            onRecordCreated: async (directory, signal) => {
              createdDirectory = directory
              await new Promise<void>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true })
              })
            },
          }),
        ),
      ),
    )

    expect(createdDirectory).not.toBe("")
    expect(await fs.exists(createdDirectory)).toBe(false)
    expect((await fs.readdir(temp.path)).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([])
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
    expect(runtime.fetches).toEqual([
      { url: runtime.requestURLs[0], maxRedirects: 0 },
      { url: runtime.requestURLs[1], maxRedirects: 0 },
      { url: runtime.requestURLs[0], maxRedirects: 0 },
      { url: runtime.requestURLs[1], maxRedirects: 0 },
    ])
    expect(runtime.fulfilled).toEqual([
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

  test("fetches admitted HTTP without following redirects and rejects external redirects and WebSockets", async () => {
    const runtime = browserRuntime()
    const admitted = "http://127.0.0.1:4317/"
    const external = "https://example.com/escape"
    const userinfo = "http://user:pass@127.0.0.1:4317/private"
    runtime.requestURLs.push(admitted, external, userinfo)
    runtime.responses.set(admitted, { status: 302, headers: { location: external } })
    runtime.webSocketURLs.push("ws://127.0.0.1:4317/hmr", "ws://example.com/socket", "wss://example.com/socket")

    await runtime.runtime.capture({
      url: admitted,
      viewport: { width: 390, height: 844 },
      readySelector: "#ready",
      allowedOrigins: [],
      signal: new AbortController().signal,
    })

    expect(runtime.fetches).toEqual([{ url: admitted, maxRedirects: 0 }])
    expect(runtime.fulfilled).toEqual([])
    expect(runtime.aborted).toEqual([admitted, external, userinfo])
    expect(runtime.webSocketsConnected).toEqual(["ws://127.0.0.1:4317/hmr"])
    expect(runtime.webSocketsClosed).toEqual(["ws://example.com/socket", "wss://example.com/socket"])
    expect(runtime.launchOptions[0]?.args).toEqual([
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-features=AutofillServerCommunication,CertificateTransparencyComponentUpdater,MediaRouter,OptimizationHints",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-default-browser-check",
      "--no-first-run",
      "--safebrowsing-disable-auto-update",
    ])
  })

  test("cancels a stalled capture, closes its context once, and releases the workflow capture lock", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const runtime = browserRuntime()
    runtime.stallNextGoto = true

    const image = await Effect.runPromise(
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
          const first = yield* host
            .capture({
              preview,
              readySelector: "#ready",
              viewport: { name: "mobile", width: 390, height: 844 },
            })
            .pipe(Effect.forkChild)
          yield* Effect.promise(() => waitUntil(() => runtime.gotoStarted === 1))
          yield* Fiber.interrupt(first).pipe(Effect.timeout("200 millis"))
          yield* Effect.promise(() => waitUntil(() => runtime.contextsClosed === 1, 200))
          expect(runtime.contextsClosed).toBe(1)
          return yield* host
            .capture({
              preview,
              readySelector: "#ready",
              viewport: { name: "mobile", width: 390, height: 844 },
            })
            .pipe(Effect.timeout("500 millis"))
        }),
      ).pipe(Effect.provide(WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: runtime.runtime }))),
    )

    expect(image.width).toBe(390)
    expect(runtime.contextsClosed).toBe(2)
  })

  test("cancels stalled authenticated process acquisition through its bounded start contract", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    const port = await unusedPort()
    await fs.writeFile(path.join(workspaceTemp.path, "server.mjs"), "setInterval(() => undefined, 60_000)\n")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "script", argv: ["node", "server.mjs"] },
      allowedOrigins: [`http://127.0.0.1:${port}`],
    })
    let entered = false
    let contractValid = false
    let abortObserved = false
    const ownership: ProcessOwnership.Service = {
      available: true,
      start: async (input) => {
        entered = true
        const signal = Reflect.get(input, "signal")
        const deadline = Reflect.get(input, "deadline")
        contractValid =
          signal instanceof AbortSignal &&
          typeof deadline === "number" &&
          Number.isFinite(deadline) &&
          deadline > Date.now()
        if (!contractValid) throw new Error("bounded process start contract missing")
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              abortObserved = true
              reject(signal.reason)
            },
            { once: true },
          )
        })
      },
      stop: async () => undefined,
      recover: async () => undefined,
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const acquisition = yield* host
            .prepareImplementation({ workflowID, revision: 1, plan })
            .pipe(Effect.forkChild)
          yield* Effect.promise(() => waitUntil(() => entered, 200))
          yield* Fiber.interrupt(acquisition).pipe(Effect.timeout("200 millis"))
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            processOwnership: ownership,
          }),
        ),
      ),
    )

    expect(contractValid).toBe(true)
    expect(abortObserved).toBe(true)
    expect((await fs.readdir(temp.path)).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([])
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
    const ownership = processOwnership()
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
            processOwnership: ownership.service,
            onSpawnArgv: (argv) => observed.push([...argv]),
          }),
        ),
      ),
    )

    expect(observed).toEqual([["node", "server.mjs"]])
    expect(ownership.started).toEqual([{ argv: ["node", "server.mjs"], hostID: expect.any(String) }])
    expect(ownership.stopped).toHaveLength(1)
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow()
    await expect(fetch(previewURL)).rejects.toThrow()
  })

  test("retains the capability for authenticated recovery when process shutdown is not confirmed", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    const port = await unusedPort()
    await fs.writeFile(
      path.join(workspaceTemp.path, "server.mjs"),
      `import http from "node:http"\nhttp.createServer((_, response) => response.end("still-owned")).listen(${port}, "127.0.0.1")\n`,
    )
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "script", argv: ["node", "server.mjs"] },
      allowedOrigins: [`http://127.0.0.1:${port}`],
    })
    const ownership = processOwnership()
    const refusingStop: ProcessOwnership.Service = {
      ...ownership.service,
      stop: async () => {
        throw new Error("shutdown was not confirmed")
      },
    }
    let directory = ""
    let identity: ProcessOwnership.Identity | undefined

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* WorkflowVisualHost.Service
            const preview = yield* host.prepareImplementation({ workflowID, revision: 1, plan })
            directory = path.join(temp.path, preview.hostID)
            const manifest = JSON.parse(
              yield* Effect.promise(() => fs.readFile(path.join(directory, ".host.json"), "utf8")),
            )
            identity = { hostID: preview.hostID, nonce: manifest.processNonce }
          }),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime().runtime,
              processOwnership: refusingStop,
              finalizerTimeoutMs: 50,
            }),
          ),
        ),
      )

      expect(await fs.exists(directory)).toBe(true)
      expect(await fetch(`http://127.0.0.1:${port}`).then((response) => response.text())).toBe("still-owned")
    } finally {
      if (identity !== undefined) await ownership.service.recover(identity).catch(() => undefined)
      if (directory !== "") await fs.rm(directory, { recursive: true, force: true })
    }
  }, 10_000)

  test("fails closed before launching a script when no authenticated process ownership backend is installed", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    const marker = path.join(workspaceTemp.path, "launched.txt")
    const port = await unusedPort()
    await fs.writeFile(
      path.join(workspaceTemp.path, "server.mjs"),
      [
        'import fs from "node:fs"',
        'import http from "node:http"',
        `fs.writeFileSync(${JSON.stringify(marker)}, "launched")`,
        `http.createServer((_, response) => response.end("ready")).listen(${port}, "127.0.0.1")`,
      ].join("\n"),
    )
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "script", argv: ["node", "server.mjs"] },
      allowedOrigins: [`http://127.0.0.1:${port}`],
    })

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.prepareImplementation({ workflowID, revision: 1, plan })
        }),
      ).pipe(
        Effect.provide(WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: browserRuntime().runtime })),
        Effect.match({
          onFailure: (left) => ({ _tag: "Left" as const, left }),
          onSuccess: (right) => ({ _tag: "Right" as const, right }),
        }),
      ),
    )

    expect(outcome).toMatchObject({
      _tag: "Left",
      left: { operation: "prepare_implementation", code: "visual_host_unavailable" },
    })
    expect(await fs.exists(marker)).toBe(false)
  })

  test("captures a script at its private frozen origin so root redirects and absolute assets remain functional", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    const port = await unusedPort()
    await fs.writeFile(
      path.join(workspaceTemp.path, "server.mjs"),
      [
        'import http from "node:http"',
        `http.createServer((request, response) => {`,
        '  if (request.url === "/") { response.writeHead(302, { location: "/app" }); response.end(); return }',
        '  if (request.url === "/app") { response.end(\'<!doctype html><main id="ready"></main><script src="/@vite/client"></script><script src="/_next/static/app.js"></script>\'); return }',
        '  if (request.url === "/@vite/client") { response.end("vite-client-ready"); return }',
        '  if (request.url === "/_next/static/app.js") { response.end("next-client-ready"); return }',
        '  response.writeHead(404); response.end("missing")',
        `}).listen(${port}, "127.0.0.1")`,
      ].join("\n"),
    )
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "script", argv: ["node", "server.mjs"] },
      allowedOrigins: [`http://127.0.0.1:${port}`],
    })
    const capturedURLs: string[] = []
    const ownership = processOwnership()
    const runtime: PlaywrightCapture.Runtime = {
      capture: async (input) => {
        capturedURLs.push(input.url)
        const page = await fetch(input.url)
        const html = await page.text()
        if (!html.includes('src="/@vite/client"')) throw new Error("redirected HTML did not load")
        const asset = await fetch(new URL("/@vite/client", page.url))
        if ((await asset.text()) !== "vite-client-ready") throw new Error("root asset did not load")
        const nextAsset = await fetch(new URL("/_next/static/app.js", page.url))
        if ((await nextAsset.text()) !== "next-client-ready") throw new Error("Next root asset did not load")
        return WorkflowVisualHost.deterministicPng({ name: "capture", width: 390, height: 844 })
      },
      close: async () => undefined,
    }
    let publicURL = ""

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.prepareImplementation({ workflowID, revision: 1, plan })
          publicURL = preview.url
          expect(preview.url).not.toBe(`http://127.0.0.1:${port}/`)
          expect(Object.keys(preview)).toEqual(["hostID", "url", "origin", "revision", "configSha256", "scope"])
          yield* host.capture({
            preview,
            readySelector: "#ready",
            viewport: { name: "mobile", width: 390, height: 844 },
          })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: runtime,
            processOwnership: ownership.service,
          }),
        ),
      ),
    )

    expect(capturedURLs).toEqual([`http://127.0.0.1:${port}`])
    await expect(fetch(publicURL)).rejects.toThrow()
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
    expect(runtime.fetches).toEqual([{ url: `${dependencyOrigin}/asset.js`, maxRedirects: 0 }])
    expect(runtime.fulfilled).toEqual([`${dependencyOrigin}/asset.js`])
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
    const ledger = EvidenceLedger.open(path.join(temp.path, ".evidence"))
    expect(
      await ledger.reserve(
        String(workflowID),
        WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES - pngBytes.byteLength,
        WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
      ),
    ).toBe(true)
    await ledger.close()
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
          }),
        ),
      ),
    )

    expect(outcomes.filter((outcome) => "image" in outcome)).toHaveLength(1)
    expect(outcomes.filter((outcome) => "error" in outcome)).toMatchObject([
      { error: { operation: "capture", code: "workflow_evidence_limit_exceeded" } },
    ])
  })

  test("enforces the durable workflow evidence total after the visual host layer restarts", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const viewport = { name: "mobile", width: 390, height: 844 } as const
    const pngBytes = WorkflowVisualHost.deterministicPng(viewport)
    const ledger = EvidenceLedger.open(path.join(temp.path, ".evidence"))
    expect(
      await ledger.reserve(
        String(workflowID),
        WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES - pngBytes.byteLength * 2 + 1,
        WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
      ),
    ).toBe(true)
    await ledger.close()

    const captureWithFreshLayer = () =>
      Effect.runPromise(
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
            return yield* host.capture({ preview, readySelector: "#ready", viewport })
          }),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime(() => pngBytes).runtime,
            }),
          ),
          Effect.match({
            onFailure: (error) => ({ error }),
            onSuccess: (image) => ({ image }),
          }),
        ),
      )

    expect(await captureWithFreshLayer()).toMatchObject({ image: { evidenceBytes: pngBytes.byteLength } })
    expect(await captureWithFreshLayer()).toMatchObject({
      error: { operation: "capture", code: "workflow_evidence_limit_exceeded" },
    })
  })

  test("rejects an aliased durable evidence root before writing outside host ownership", async () => {
    await using temp = await taskTemp()
    await using outside = await taskTemp()
    const alias = path.join(temp.path, ".evidence")
    await fs.symlink(outside.path, alias, process.platform === "win32" ? "junction" : "dir")

    let opened: EvidenceLedger.Service | undefined
    let cause: unknown
    try {
      opened = EvidenceLedger.open(alias)
    } catch (error) {
      cause = error
    } finally {
      await opened?.close()
    }

    expect(cause).toBeInstanceOf(TypeError)
    expect(await fs.exists(path.join(outside.path, "evidence.sqlite"))).toBe(false)
  })

  for (const name of ["evidence.sqlite", "evidence.sqlite-wal", "evidence.sqlite-shm"] as const) {
    test(`rejects a pre-existing ${name} file link without writing its outside target`, async () => {
      await using temp = await taskTemp()
      await using outside = await taskTemp()
      const ledgerRoot = path.join(temp.path, ".evidence")
      await fs.mkdir(ledgerRoot)
      if (name !== "evidence.sqlite") {
        const seeded = EvidenceLedger.open(ledgerRoot)
        expect(await seeded.reserve(String(workflowID), 1, WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES)).toBe(true)
        await seeded.close()
      }
      const outsideFile = path.join(outside.path, name)
      const outsideBytes = Buffer.from("outside-owned")
      await fs.writeFile(outsideFile, outsideBytes)
      await fs.symlink(outsideFile, path.join(ledgerRoot, name), "file")

      let opened: EvidenceLedger.Service | undefined
      let cause: unknown
      try {
        opened = EvidenceLedger.open(ledgerRoot)
      } catch (error) {
        cause = error
      } finally {
        await opened?.close()
      }

      expect(cause).toBeInstanceOf(TypeError)
      expect(await fs.readFile(outsideFile)).toEqual(outsideBytes)
    })
  }

  test("rejects a multiply-linked evidence database without modifying the other owner", async () => {
    await using temp = await taskTemp()
    await using outside = await taskTemp()
    const ledgerRoot = path.join(temp.path, ".evidence")
    await fs.mkdir(ledgerRoot)
    const outsideFile = path.join(outside.path, "outside.sqlite")
    const outsideBytes = Buffer.from("outside-owned")
    await fs.writeFile(outsideFile, outsideBytes)
    await fs.link(outsideFile, path.join(ledgerRoot, "evidence.sqlite"))

    let opened: EvidenceLedger.Service | undefined
    let cause: unknown
    try {
      opened = EvidenceLedger.open(ledgerRoot)
    } catch (error) {
      cause = error
    } finally {
      await opened?.close()
    }

    expect(cause).toBeInstanceOf(TypeError)
    expect(await fs.readFile(outsideFile)).toEqual(outsideBytes)
  })

  test("closes the database when an incompatible durable schema rejects statement preparation", async () => {
    await using temp = await taskTemp()
    const ledgerRoot = path.join(temp.path, ".evidence")
    await fs.mkdir(ledgerRoot)
    const databasePath = path.join(ledgerRoot, "evidence.sqlite")
    const incompatible = new Database(databasePath, { create: true, readwrite: true })
    incompatible.run("CREATE TABLE workflow_evidence (wrong_column TEXT) STRICT")
    incompatible.close()

    expect(() => EvidenceLedger.open(ledgerRoot)).toThrow()
    await expect(fs.rename(databasePath, `${databasePath}.released`)).resolves.toBeUndefined()
  })

  test("runs deployment root policy before creating durable ledger files", async () => {
    await using temp = await taskTemp()
    const ledgerRoot = path.join(temp.path, ".evidence")

    expect(() =>
      EvidenceLedger.open(ledgerRoot, {
        rootPolicy: () => {
          throw new TypeError("Host root must be ACL-owned and non-writable by workspace or model code")
        },
      }),
    ).toThrow(/ACL-owned/)
    expect(await fs.exists(path.join(ledgerRoot, "evidence.sqlite"))).toBe(false)
  })

  test("revalidates a database-path swap injected between exclusive creation and SQLite open", async () => {
    await using temp = await taskTemp()
    await using outside = await taskTemp()
    const ledgerRoot = path.join(temp.path, ".evidence")
    const outsideFile = path.join(outside.path, "outside.sqlite")
    const outsideBytes = Buffer.from("outside-owned")
    await fs.writeFile(outsideFile, outsideBytes)
    let swapped = false

    expect(() =>
      EvidenceLedger.open(ledgerRoot, {
        onBoundary: ({ operation, phase }) => {
          if (operation !== "open" || phase !== "before") return
          const databasePath = path.join(ledgerRoot, "evidence.sqlite")
          fsSync.renameSync(databasePath, path.join(ledgerRoot, "parked.sqlite"))
          fsSync.symlinkSync(outsideFile, databasePath, "file")
          swapped = true
        },
      }),
    ).toThrow(TypeError)
    expect(swapped).toBe(true)
    expect(await fs.readFile(outsideFile)).toEqual(outsideBytes)
  })

  test("fails closed when a runtime boundary hook adds another database owner before select", async () => {
    await using temp = await taskTemp()
    await using outside = await taskTemp()
    const ledgerRoot = path.join(temp.path, ".evidence")
    let inject = false
    const ledger = EvidenceLedger.open(ledgerRoot, {
      onBoundary: ({ operation, phase }) => {
        if (!inject || operation !== "select-get" || phase !== "before") return
        fsSync.linkSync(path.join(ledgerRoot, "evidence.sqlite"), path.join(outside.path, "other-owner.sqlite"))
      },
    })
    expect(await ledger.reserve(String(workflowID), 1, WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES)).toBe(true)
    inject = true

    await expect(ledger.used(String(workflowID))).rejects.toBeInstanceOf(TypeError)
    await expect(
      fs.rename(path.join(ledgerRoot, "evidence.sqlite"), path.join(ledgerRoot, "evidence.sqlite.released")),
    ).resolves.toBeUndefined()
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

  test("recovers an orphan process only through its persisted authenticated ownership identity", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    const port = await unusedPort()
    await fs.writeFile(
      path.join(workspaceTemp.path, "server.mjs"),
      `import http from "node:http"\nhttp.createServer((_, response) => response.end("orphan-ready")).listen(${port}, "127.0.0.1")\n`,
    )
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "script", argv: ["node", "server.mjs"] },
      allowedOrigins: [`http://127.0.0.1:${port}`],
    })
    const identity: ProcessOwnership.Identity = {
      hostID: WorkflowVisualHost.HostID.make("a".repeat(64)),
      nonce: "b".repeat(64),
    }
    const directory = path.join(temp.path, identity.hostID)
    const runtimeTemp = path.join(directory, ".tmp")
    await fs.mkdir(runtimeTemp, { recursive: true })
    await fs.writeFile(
      path.join(directory, ".host.json"),
      JSON.stringify({ hostID: identity.hostID, createdAt: 10, processNonce: identity.nonce }),
    )
    const ownership = processOwnership()
    await ownership.service.start({
      identity,
      plan,
      tempRoot: runtimeTemp,
      signal: new AbortController().signal,
      deadline: Date.now() + 1_000,
    })
    await waitUntil(async () =>
      fetch(`http://127.0.0.1:${port}`).then(
        () => true,
        () => false,
      ),
    )

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          yield* host.recoverExpired({ activeHostIDs: new Set(), expiredBefore: 11 })
        }).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime().runtime,
              processOwnership: ownership.service,
            }),
          ),
          Effect.scoped,
        ),
      )

      expect(ownership.recovered).toEqual([identity])
      expect(await fs.exists(directory)).toBe(false)
      await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow()
    } finally {
      await ownership.service.recover(identity).catch(() => undefined)
    }
  })

  test("retains an orphan and never terminates a process when its persisted ownership nonce is forged", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    const port = await unusedPort()
    await fs.writeFile(
      path.join(workspaceTemp.path, "server.mjs"),
      `import http from "node:http"\nhttp.createServer((_, response) => response.end("owned-ready")).listen(${port}, "127.0.0.1")\n`,
    )
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "script", argv: ["node", "server.mjs"] },
      allowedOrigins: [`http://127.0.0.1:${port}`],
    })
    const identity: ProcessOwnership.Identity = {
      hostID: WorkflowVisualHost.HostID.make("c".repeat(64)),
      nonce: "d".repeat(64),
    }
    const directory = path.join(temp.path, identity.hostID)
    const runtimeTemp = path.join(directory, ".tmp")
    await fs.mkdir(runtimeTemp, { recursive: true })
    await fs.writeFile(
      path.join(directory, ".host.json"),
      JSON.stringify({ hostID: identity.hostID, createdAt: 10, processNonce: "e".repeat(64) }),
    )
    const ownership = processOwnership()
    await ownership.service.start({
      identity,
      plan,
      tempRoot: runtimeTemp,
      signal: new AbortController().signal,
      deadline: Date.now() + 1_000,
    })
    await waitUntil(async () =>
      fetch(`http://127.0.0.1:${port}`).then(
        () => true,
        () => false,
      ),
    )

    try {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.recoverExpired({ activeHostIDs: new Set(), expiredBefore: 11 })
        }).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime().runtime,
              processOwnership: ownership.service,
            }),
          ),
          Effect.scoped,
          Effect.match({
            onFailure: (error) => ({ error }),
            onSuccess: () => ({ success: true as const }),
          }),
        ),
      )

      expect(outcome).toMatchObject({ error: { operation: "recover_expired", code: "cleanup_target_rejected" } })
      expect(ownership.recovered).toEqual([])
      expect(await fs.exists(directory)).toBe(true)
      expect(await fetch(`http://127.0.0.1:${port}`).then((response) => response.text())).toBe("owned-ready")
    } finally {
      await ownership.service.recover(identity).catch(() => undefined)
      await fs.rm(directory, { recursive: true, force: true })
    }
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
    responses: new Map<string, { readonly status: number; readonly headers: Readonly<Record<string, string>> }>(),
    fetches: [] as { readonly url: string; readonly maxRedirects: number }[],
    fulfilled: [] as string[],
    aborted: [] as string[],
    webSocketURLs: [] as string[],
    webSocketsConnected: [] as string[],
    webSocketsClosed: [] as string[],
    contextOptions: [] as PlaywrightCapture.ContextOptions[],
    selectors: [] as string[],
    evaluateSources: [] as string[],
    screenshotOptions: [] as PlaywrightCapture.ScreenshotOptions[],
    launchOptions: [] as PlaywrightCapture.LaunchOptions[],
    contextsClosed: 0,
    closed: 0,
    stallNextGoto: false,
    gotoStarted: 0,
  }
  const browserType: PlaywrightCapture.BrowserType = {
    async launch(options) {
      state.launchOptions.push(options)
      return {
        async newContext(options) {
          state.contextOptions.push(options)
          let handler: PlaywrightCapture.RouteHandler | undefined
          let webSocketHandler: ((route: PlaywrightCapture.WebSocketRoute) => Promise<void>) | undefined
          return {
            async route(_pattern, value) {
              handler = value
            },
            async routeWebSocket(_pattern, value) {
              webSocketHandler = value
            },
            async newPage() {
              return {
                async goto() {
                  state.gotoStarted++
                  if (handler === undefined) throw new Error("route policy missing")
                  for (const url of state.requestURLs) {
                    const configured = state.responses.get(url) ?? { status: 200, headers: {} }
                    const route: PlaywrightCapture.Route = {
                      request: () => ({ url: () => url }),
                      fetch: async (options) => {
                        state.fetches.push({ url, maxRedirects: options.maxRedirects })
                        return {
                          status: () => configured.status,
                          headers: () => configured.headers,
                          fulfill: async () => {
                            state.fulfilled.push(url)
                          },
                          dispose: async () => undefined,
                        }
                      },
                      abort: async () => {
                        state.aborted.push(url)
                      },
                    }
                    await handler(route)
                  }
                  if (state.webSocketURLs.length > 0 && webSocketHandler === undefined) {
                    throw new Error("websocket route policy missing")
                  }
                  for (const url of state.webSocketURLs) {
                    await webSocketHandler?.({
                      url: () => url,
                      connectToServer: () => {
                        state.webSocketsConnected.push(url)
                      },
                      close: async () => {
                        state.webSocketsClosed.push(url)
                      },
                    })
                  }
                  if (state.stallNextGoto) {
                    state.stallNextGoto = false
                    await new Promise(() => undefined)
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

function processOwnership() {
  const processes = new Map<
    string,
    { readonly identity: ProcessOwnership.Identity; readonly subprocess: ReturnType<typeof Bun.spawn> }
  >()
  const state = {
    started: [] as { readonly argv: readonly string[]; readonly hostID: string }[],
    stopped: [] as ProcessOwnership.Identity[],
    recovered: [] as ProcessOwnership.Identity[],
  }
  const key = (identity: ProcessOwnership.Identity) => `${identity.hostID}:${identity.nonce}`
  const service: ProcessOwnership.Service = {
    available: true,
    async start(input) {
      const subprocess = Bun.spawn([...input.plan.argv!], {
        cwd: input.plan.cwd,
        env: {
          ...input.plan.env,
          CI: "1",
          NO_COLOR: "1",
          TEMP: input.tempRoot,
          TMP: input.tempRoot,
          ...(process.env.SYSTEMROOT === undefined ? {} : { SYSTEMROOT: process.env.SYSTEMROOT }),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        detached: process.platform !== "win32",
      })
      processes.set(key(input.identity), { identity: input.identity, subprocess })
      state.started.push({ argv: [...input.plan.argv!], hostID: input.identity.hostID })
      return { exited: subprocess.exited, stdout: subprocess.stdout, stderr: subprocess.stderr }
    },
    async stop(input) {
      const owned = processes.get(key(input.identity))
      if (owned === undefined || owned.identity.nonce !== input.identity.nonce) throw new Error("unowned process")
      await stopTestProcess(owned.subprocess)
      processes.delete(key(input.identity))
      state.stopped.push(input.identity)
    },
    async recover(identity) {
      const owned = processes.get(key(identity))
      if (owned === undefined || owned.identity.nonce !== identity.nonce) throw new Error("unowned process")
      await stopTestProcess(owned.subprocess)
      processes.delete(key(identity))
      state.recovered.push(identity)
    },
  }
  return Object.assign(state, { service })
}

async function stopTestProcess(subprocess: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (process.platform === "win32") {
    const taskkill = Bun.spawn(["taskkill.exe", "/PID", String(subprocess.pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
    await taskkill.exited
    return
  } else {
    process.kill(-subprocess.pid, "SIGTERM")
  }
  await Promise.race([subprocess.exited, Bun.sleep(5_000)])
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("test condition did not become true")
    await Bun.sleep(5)
  }
}
