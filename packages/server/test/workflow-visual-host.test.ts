import { afterAll, describe, expect, test } from "bun:test"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { WorkflowSchema } from "@opencode-ai/core/workflow"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"
import { Effect, Fiber } from "effect"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { PlaywrightCapture } from "../src/workflow/playwright"
import { ProcessOwnership } from "../src/workflow/process-ownership"
import { EvidenceLedger } from "../src/workflow/evidence-ledger"
import { WorkflowVisualHostServer as WorkflowVisualHostServerModule } from "../src/workflow/visual-host"
import { VisualHostClaim } from "../src/workflow/visual-host-claim"

const workflowID = WorkflowSchema.ID.make("wfl_server_visual_host")
const captureStageID = WorkflowSchema.StageID.make("wfs_server_visual_capture")
const implementationSha256 = "c".repeat(64)
const testPreviewLease = (id: WorkflowSchema.ID = workflowID): WorkflowVisualHost.PreviewLeaseAuthority => ({
  workflowID: id,
  stageID: captureStageID,
  attempt: 1,
  leaseOwner: "workflow-visual-host-test-owner",
  leaseExpiresAt: 2_000_000_000_000,
})
const resolveImplementationContract: WorkflowVisualHost.ResolveImplementationContract = async (input) => ({
  implementationSha256,
  readySelector: "#ready",
  previewLease: testPreviewLease(input.workflowID),
})
const WorkflowVisualHostServer = {
  ...WorkflowVisualHostServerModule,
  makeLayer: (options: WorkflowVisualHostServerModule.Options) =>
    WorkflowVisualHostServerModule.makeLayer({
      resolvePreviewLease: async (id) => testPreviewLease(id),
      isPreviewLeaseLive: async () => true,
      ...options,
    }),
}
const fixtureRoot = path.join(import.meta.dir, "fixtures", "workflow-visual")
const testRoot = "D:\\OpenCode-Local\\tmp\\workflow-host-tests"

afterAll(async () => {
  await fs.rm(testRoot, { recursive: true, force: true })
})

describe("WorkflowVisualHostServer", () => {
  test("checks a production host-root policy before creating a missing preview root", async () => {
    await using temp = await taskTemp()
    const hostRoot = path.join(temp.path, "missing-preview-root")
    const policyInputs: string[] = []

    const failure = await Effect.runPromise(
      Effect.scoped(WorkflowVisualHost.Service).pipe(
        Effect.provide(
          WorkflowVisualHostServerModule.makeLayer({
            hostRoot,
            evidenceRoot: path.join(temp.path, "evidence"),
            browser: browserRuntime().runtime,
            hostRootPolicy: (candidate) => {
              policyInputs.push(candidate)
              throw new TypeError("preview root is not deployment-owned")
            },
            resolvePreviewLease: async (id) => testPreviewLease(id),
            isPreviewLeaseLive: async () => true,
          }),
        ),
        Effect.flip,
      ),
    )

    expect(failure).toMatchObject({ code: "visual_host_unavailable" })
    expect(policyInputs).toEqual([hostRoot])
    expect(await fs.exists(hostRoot)).toBe(false)
  })

  test("revalidates a replaced preview root before writing a capability", async () => {
    await using temp = await taskTemp()
    const hostRoot = path.join(temp.path, "preview")
    const evidenceRoot = path.join(temp.path, "evidence")
    await fs.mkdir(hostRoot)
    const expected = rootIdentity(hostRoot)
    const parked = `${hostRoot}-parked`
    let result: { readonly _tag: "Success" | "Failure" } | undefined

    try {
      result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* WorkflowVisualHost.Service
            yield* Effect.promise(async () => {
              await fs.rename(hostRoot, parked)
              await fs.mkdir(hostRoot)
            })
            return yield* host
              .materializeReference({
                workflowID,
                referenceApp: {
                  entrypoint: "index.html",
                  readySelector: "#ready",
                  projectStack: ["HTML"],
                  files: [{ path: "index.html", content: '<!doctype html><div id="ready"></div>' }],
                },
              })
              .pipe(Effect.exit)
          }),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServerModule.makeLayer({
              hostRoot,
              evidenceRoot,
              browser: browserRuntime().runtime,
              hostRootPolicy: (candidate) => {
                if (candidate !== hostRoot || rootIdentity(candidate) !== expected) {
                  throw new TypeError("preview root identity changed")
                }
              },
              resolvePreviewLease: async (id) => testPreviewLease(id),
              isPreviewLeaseLive: async () => true,
            }),
          ),
        ),
      )

      expect(result._tag).toBe("Failure")
      expect(await fs.readdir(hostRoot)).toEqual([])
    } finally {
      if (await fs.exists(hostRoot)) await fs.rmdir(hostRoot)
      if (await fs.exists(parked)) await fs.rename(parked, hostRoot)
    }
  })

  test("revalidates an ancestor junction before writing a capability", async () => {
    await using temp = await taskTemp()
    const deployment = path.join(temp.path, "deployment")
    const hostRoot = path.join(deployment, "temp", "preview")
    const evidenceRoot = path.join(temp.path, "evidence")
    await fs.mkdir(hostRoot, { recursive: true })
    const parked = `${deployment}-parked`
    let beforeEntries: string[] = []

    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* WorkflowVisualHost.Service
            yield* Effect.promise(async () => {
              beforeEntries = await fs.readdir(hostRoot)
              await fs.rename(deployment, parked)
              await fs.symlink(parked, deployment, process.platform === "win32" ? "junction" : "dir")
            })
            return yield* host
              .materializeReference({
                workflowID,
                referenceApp: {
                  entrypoint: "index.html",
                  readySelector: "#ready",
                  projectStack: ["HTML"],
                  files: [{ path: "index.html", content: '<!doctype html><div id="ready"></div>' }],
                },
              })
              .pipe(Effect.exit)
          }),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServerModule.makeLayer({
              hostRoot,
              evidenceRoot,
              browser: browserRuntime().runtime,
              hostRootPolicy: () => undefined,
              resolvePreviewLease: async (id) => testPreviewLease(id),
              isPreviewLeaseLive: async () => true,
            }),
          ),
        ),
      )

      expect(result._tag).toBe("Failure")
      expect(await fs.readdir(path.join(parked, "temp", "preview"))).toEqual(beforeEntries)
    } finally {
      if (await fs.lstat(deployment).catch(() => undefined)) await fs.unlink(deployment)
      if (await fs.exists(parked)) await fs.rename(parked, deployment)
    }
  })

  test("validates paired lease options before opening the evidence ledger", async () => {
    await using temp = await taskTemp()
    const evidenceRoot = path.join(temp.path, "incomplete-lease-evidence")

    const failure = await Effect.runPromise(
      Effect.scoped(WorkflowVisualHost.Service).pipe(
        Effect.provide(
          WorkflowVisualHostServerModule.makeLayer({
            hostRoot: temp.path,
            evidenceRoot,
            browser: browserRuntime().runtime,
            resolvePreviewLease: async (id) => testPreviewLease(id),
          }),
        ),
        Effect.flip,
      ),
    )

    expect(failure).toMatchObject({ code: "visual_host_unavailable" })
    expect(await fs.exists(evidenceRoot)).toBe(false)
  })

  test("authorizes and re-verifies the exact preview descendant before recursive cleanup", async () => {
    await using temp = await taskTemp()
    const events: Array<{ readonly operation: "authorize" | "verify"; readonly target: string }> = []
    const authorities = new WeakSet<object>()
    const cleanupPolicy = {
      authorizeCleanupTarget: (input: { readonly target: string; readonly workspace?: string }) => {
        const authority = Object.freeze({
          target: input.target,
          previewCapabilityRoot: temp.path,
          identity: "test-cleanup-authority",
        })
        authorities.add(authority)
        events.push({ operation: "authorize", target: input.target })
        return authority
      },
      verifyCleanupTarget: (authority: { readonly target: string }) => {
        if (!authorities.has(authority)) throw new TypeError("cleanup authority was not minted")
        events.push({ operation: "verify", target: authority.target })
        return authority.target
      },
    }
    let hostID: WorkflowVisualHost.HostID | undefined

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          hostID = (yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: '<!doctype html><div id="ready"></div>' }],
            },
          })).hostID
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            cleanupPolicy,
          }),
        ),
      ),
    )

    if (hostID === undefined) throw new TypeError("preview host was not materialized")
    const target = path.join(temp.path, hostID)
    expect(events).toEqual([
      { operation: "authorize", target },
      { operation: "verify", target },
    ])
    expect(await fs.exists(target)).toBe(false)
  })

  test("derives production visual hosting, browser storage, Docker, and cleanup from one root contract", async () => {
    await using fixture = await productionHostFixture()
    const browserInputs: PlaywrightCapture.ProductionRuntimeOptions[] = []
    const browser = browserRuntime().runtime
    const browserRuntimeFactory = (input: PlaywrightCapture.ProductionRuntimeOptions) => {
      browserInputs.push(input)
      return browser
    }
    let previewDirectory: string | undefined
    let deploymentLocationResult: { readonly _tag: "Left" | "Right"; readonly value: unknown } | undefined

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
              files: [{ path: "index.html", content: '<!doctype html><div id="ready"></div>' }],
            },
          })
          previewDirectory = path.join(fixture.directories.preview, preview.hostID)
          expect(yield* Effect.promise(() => fs.exists(previewDirectory!))).toBe(true)
          expect(yield* Effect.promise(() => fs.exists(path.join(fixture.directories.data, "evidence.sqlite")))).toBe(
            true,
          )
          const forbiddenPlan = PreviewPlan.freeze({
            authority: "admission",
            location: Location.Ref.make({ directory: AbsolutePath.make(fixture.directories.deployment) }),
            preview: { kind: "static", entrypoint: "index.html" },
            allowedOrigins: [],
          })
          deploymentLocationResult = yield* host
            .prepareImplementation({ workflowID, revision: 1, plan: forbiddenPlan })
            .pipe(
              Effect.match({
                onFailure: (value) => ({ _tag: "Left" as const, value }),
                onSuccess: (value) => ({ _tag: "Right" as const, value }),
              }),
            )
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServerModule.productionLayer({
            environment: fixture.environment,
            aclProbe: fixture.probe,
            resolvePreviewLease: async (id) => testPreviewLease(id),
            isPreviewLeaseLive: async () => true,
            browserRuntimeFactory,
          }),
        ),
      ),
    )

    expect(browserInputs).toEqual([
      {
        browserRoot: fixture.directories.browserRuntime,
        tempRoot: fixture.directories.browserCache,
        browserRuntimePolicy: expect.any(Function),
        browserCachePolicy: expect.any(Function),
      },
    ])
    expect(deploymentLocationResult).toMatchObject({
      _tag: "Left",
      value: { code: "invalid_preview_plan" },
    })
    if (previewDirectory === undefined) throw new TypeError("production preview directory was not observed")
    expect(await fs.exists(previewDirectory)).toBe(false)
  })

  test("passes the production contract browser-runtime and cache verifiers into Playwright", async () => {
    await using fixture = await productionHostFixture()
    let browserInput: PlaywrightCapture.ProductionRuntimeOptions | undefined

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* WorkflowVisualHost.Service
          if (browserInput === undefined) throw new TypeError("browser runtime factory was not called")
          fixture.invalidateAcl()
          expect(() => browserInput!.browserRuntimePolicy(fixture.directories.browserRuntime)).toThrow(/ACL descriptor/)
          expect(() => browserInput!.browserCachePolicy(fixture.directories.browserCache)).toThrow(/ACL descriptor/)
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServerModule.productionLayer({
            environment: fixture.environment,
            aclProbe: fixture.probe,
            browserRuntimeFactory: (input) => {
              browserInput = input
              return browserRuntime().runtime
            },
          }),
        ),
      ),
    )
  })

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

  test("writes zero reference bytes after the capability directory is redirected by the acquisition hook", async () => {
    await using temp = await taskTemp()
    await using outside = await taskTemp()
    let redirected = ""
    let parked = ""

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [
                { path: "index.html", content: '<main id="ready"></main>' },
                { path: "assets/app.js", content: "globalThis.ready = true" },
              ],
            },
          })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            onRecordCreated: async (directory) => {
              redirected = directory
              parked = `${directory}-parked`
              await fs.rename(directory, parked)
              await fs.symlink(outside.path, directory, process.platform === "win32" ? "junction" : "dir")
            },
          }),
        ),
      ),
    ).then(
      (preview) => ({ preview }),
      (error) => ({ error }),
    )

    expect(result).toHaveProperty("error")
    expect(await fs.readdir(outside.path)).toEqual([])
    if (redirected !== "" && (await fs.exists(redirected))) await fs.unlink(redirected)
    if (parked !== "" && (await fs.exists(parked))) await fs.rm(parked, { recursive: true, force: true })
  })

  test("writes zero external bytes when a nested reference parent is a junction", async () => {
    await using temp = await taskTemp()
    await using outside = await taskTemp()

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "assets/deep/index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "assets/deep/index.html", content: '<main id="ready"></main>' }],
            },
          })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            onRecordCreated: async (directory) => {
              await fs.symlink(
                outside.path,
                path.join(directory, "assets"),
                process.platform === "win32" ? "junction" : "dir",
              )
            },
          }),
        ),
      ),
    ).then(
      (preview) => ({ preview }),
      (error) => ({ error }),
    )

    expect(result).toHaveProperty("error")
    expect(await fs.readdir(outside.path)).toEqual([])
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
            stageID: captureStageID,
            viewport: { name: "desktop", width: 1440, height: 900 },
          })
          const second = yield* host.capture({
            preview,
            stageID: captureStageID,
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

  test("single-flights one logical key and restores it across host IDs without another browser call or quota charge", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const viewport = { name: "desktop", width: 1440, height: 900 } as const
    const stageID = WorkflowSchema.StageID.make("wfs_server_visual_same_key")
    const firstRuntime = browserRuntime()
    const first = await Effect.runPromise(
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
          const one = host.capture({ preview, stageID, viewport })
          const images = yield* Effect.all([one, one], { concurrency: "unbounded" })
          return { hostID: preview.hostID, images }
        }),
      ).pipe(
        Effect.provide(WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: firstRuntime.runtime })),
      ),
    )
    const restoredRuntime = browserRuntime()
    const restored = await Effect.runPromise(
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
          const image = yield* host.capture({ preview, stageID, viewport })
          return { hostID: preview.hostID, image }
        }),
      ).pipe(
        Effect.provide(WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: restoredRuntime.runtime })),
      ),
    )
    const ledger = EvidenceLedger.open(path.join(temp.path, ".evidence"))
    const used = await ledger.used(String(workflowID))
    await ledger.close()

    expect(first.images[0]).toEqual(first.images[1])
    expect(first.images[0]?.evidenceID).toBe(restored.image.evidenceID)
    expect(first.hostID).not.toBe(restored.hostID)
    expect(firstRuntime.contextOptions).toHaveLength(1)
    expect(restoredRuntime.contextOptions).toHaveLength(0)
    expect(used).toBe(first.images[0]?.evidenceBytes)
  })

  test("fails into typed ambiguity without a browser call when a foreign durable capture intent exists", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const runtime = browserRuntime()
    const ledger = EvidenceLedger.open(path.join(temp.path, ".evidence"))
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
          const input = {
            preview,
            stageID: WorkflowSchema.StageID.make("wfs_server_visual_foreign_intent"),
            viewport: { name: "desktop", width: 1440, height: 900 } as const,
          }
          yield* Effect.promise(() =>
            ledger.beginCapture({
              coordinates: WorkflowVisualHost.evidenceCoordinates(input),
              ownerNonce: "7".repeat(64),
              now: 1,
            }),
          )
          return yield* host.capture(input)
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: runtime.runtime, evidenceLedger: ledger }),
        ),
        Effect.flip,
      ),
    )

    expect(failure).toMatchObject({ operation: "capture", code: "evidence_capture_ambiguous" })
    expect(runtime.contextOptions).toHaveLength(0)
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
              stageID: captureStageID,
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
              stageID: captureStageID,
              viewport: { name: "mobile", width: 390, height: 844 },
            })
            .pipe(Effect.timeout("500 millis"))
        }),
      ).pipe(Effect.provide(WorkflowVisualHostServer.makeLayer({ hostRoot: temp.path, browser: runtime.runtime }))),
    )

    expect(image.width).toBe(390)
    expect(runtime.contextsClosed).toBe(2)
  })

  test("clears its exact intent and stages no PNG when the live lease is lost after browser production", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const produced = browserRuntime()
    const ledger = EvidenceLedger.open(path.join(temp.path, ".evidence"))
    let live = true
    const runtime: PlaywrightCapture.Runtime = {
      capture: async (input) => {
        const bytes = await produced.runtime.capture(input)
        live = false
        return bytes
      },
      close: () => produced.runtime.close(),
    }
    const lease = testPreviewLease(workflowID)
    const result = await Effect.runPromise(
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
          const input = {
            preview,
            stageID: WorkflowSchema.StageID.make("wfs_server_visual_late_lease"),
            viewport: { name: "desktop", width: 1440, height: 900 } as const,
          }
          const coordinates = WorkflowVisualHost.evidenceCoordinates(input)
          const outcome = yield* host.capture(input).pipe(
            Effect.match({
              onFailure: (left) => ({ _tag: "Left" as const, left }),
              onSuccess: (right) => ({ _tag: "Right" as const, right }),
            }),
          )
          return {
            outcome,
            item: yield* Effect.promise(() => ledger.get(coordinates)),
            used: yield* Effect.promise(() => ledger.used(String(workflowID))),
          }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: runtime,
            evidenceLedger: ledger,
            resolvePreviewLease: async () => lease,
            isPreviewLeaseLive: async (candidate) => live && candidate.leaseOwner === lease.leaseOwner,
          }),
        ),
      ),
    )

    expect(result.outcome).toMatchObject({ _tag: "Left", left: { code: "capture_failed" } })
    expect(result.item).toBeUndefined()
    expect(result.used).toBe(0)
    expect(produced.contextOptions).toHaveLength(1)
    expect(await VisualHostClaim.list(temp.path)).toEqual([])
  })

  test("creates no intent and calls no browser when capture enters after lease loss", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const base = EvidenceLedger.open(path.join(temp.path, ".evidence"))
    let beginCalls = 0
    let browserCalls = 0
    let live = true
    const ledger: EvidenceLedger.Service = {
      ...base,
      beginCapture: async (input) => {
        beginCalls++
        return base.beginCapture(input)
      },
    }
    const runtime: PlaywrightCapture.Runtime = {
      capture: async () => {
        browserCalls++
        return WorkflowVisualHost.deterministicPng({ name: "entry-lost", width: 390, height: 844 })
      },
      close: async () => undefined,
    }
    const lease = testPreviewLease(workflowID)
    const result = await Effect.runPromise(
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
          live = false
          const outcome = yield* host
            .capture({
              preview,
              stageID: WorkflowSchema.StageID.make("wfs_server_visual_entry_lost"),
              viewport: { name: "mobile", width: 390, height: 844 },
            })
            .pipe(
              Effect.match({
                onFailure: (left) => ({ _tag: "Left" as const, left }),
                onSuccess: (right) => ({ _tag: "Right" as const, right }),
              }),
            )
          return { outcome, used: yield* Effect.promise(() => base.used(String(workflowID))) }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: runtime,
            evidenceLedger: ledger,
            resolvePreviewLease: async () => lease,
            isPreviewLeaseLive: async () => live,
          }),
        ),
      ),
    )

    expect(result.outcome).toMatchObject({ _tag: "Left", left: { code: "capture_failed" } })
    expect({ beginCalls, browserCalls, used: result.used }).toEqual({ beginCalls: 0, browserCalls: 0, used: 0 })
  })

  test("clears the exact intent before browser entry when lease loss follows intent creation", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const base = EvidenceLedger.open(path.join(temp.path, ".evidence"))
    let live = true
    let beginCalls = 0
    let usedCalls = 0
    let completeCalls = 0
    let clearCalls = 0
    let browserCalls = 0
    const ledger: EvidenceLedger.Service = {
      ...base,
      beginCapture: async (input) => {
        beginCalls++
        const result = await base.beginCapture(input)
        live = false
        return result
      },
      used: async (id) => {
        usedCalls++
        return base.used(id)
      },
      completeCapture: async (input) => {
        completeCalls++
        return base.completeCapture(input)
      },
      clearCapture: async (input) => {
        clearCalls++
        return base.clearCapture(input)
      },
    }
    const runtime: PlaywrightCapture.Runtime = {
      capture: async () => {
        browserCalls++
        return WorkflowVisualHost.deterministicPng({ name: "intent-lost", width: 390, height: 844 })
      },
      close: async () => undefined,
    }
    const lease = testPreviewLease(workflowID)
    const result = await Effect.runPromise(
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
          const input = {
            preview,
            stageID: WorkflowSchema.StageID.make("wfs_server_visual_intent_lost"),
            viewport: { name: "mobile", width: 390, height: 844 } as const,
          }
          const coordinates = WorkflowVisualHost.evidenceCoordinates(input)
          const outcome = yield* host.capture(input).pipe(
            Effect.match({
              onFailure: (left) => ({ _tag: "Left" as const, left }),
              onSuccess: (right) => ({ _tag: "Right" as const, right }),
            }),
          )
          return {
            outcome,
            item: yield* Effect.promise(() => base.get(coordinates)),
            charged: yield* Effect.promise(() => base.used(String(workflowID))),
          }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: runtime,
            evidenceLedger: ledger,
            resolvePreviewLease: async () => lease,
            isPreviewLeaseLive: async () => live,
          }),
        ),
      ),
    )

    expect(result.outcome).toMatchObject({ _tag: "Left", left: { code: "capture_failed" } })
    expect(result.item).toBeUndefined()
    expect(result.charged).toBe(0)
    expect({ beginCalls, usedCalls, browserCalls, completeCalls, clearCalls }).toEqual({
      beginCalls: 1,
      usedCalls: 0,
      browserCalls: 0,
      completeCalls: 0,
      clearCalls: 1,
    })
  })

  test("runs the final live gate after PNG validation and before durable completion", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const base = EvidenceLedger.open(path.join(temp.path, ".evidence"))
    let browserReturned = false
    let postBrowserProbes = 0
    let completeCalls = 0
    let clearCalls = 0
    const ledger: EvidenceLedger.Service = {
      ...base,
      completeCapture: async (input) => {
        completeCalls++
        return base.completeCapture(input)
      },
      clearCapture: async (input) => {
        clearCalls++
        return base.clearCapture(input)
      },
    }
    const runtime: PlaywrightCapture.Runtime = {
      capture: async () => {
        const bytes = WorkflowVisualHost.deterministicPng({ name: "final-gate", width: 390, height: 844 })
        browserReturned = true
        return bytes
      },
      close: async () => undefined,
    }
    const lease = testPreviewLease(workflowID)
    const result = await Effect.runPromise(
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
          const input = {
            preview,
            stageID: WorkflowSchema.StageID.make("wfs_server_visual_final_gate"),
            viewport: { name: "mobile", width: 390, height: 844 } as const,
          }
          const coordinates = WorkflowVisualHost.evidenceCoordinates(input)
          const outcome = yield* host.capture(input).pipe(
            Effect.match({
              onFailure: (left) => ({ _tag: "Left" as const, left }),
              onSuccess: (right) => ({ _tag: "Right" as const, right }),
            }),
          )
          return {
            outcome,
            item: yield* Effect.promise(() => base.get(coordinates)),
            charged: yield* Effect.promise(() => base.used(String(workflowID))),
          }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: runtime,
            evidenceLedger: ledger,
            resolvePreviewLease: async () => lease,
            isPreviewLeaseLive: async () => {
              if (!browserReturned) return true
              postBrowserProbes++
              return postBrowserProbes === 1
            },
          }),
        ),
      ),
    )

    expect(result.outcome).toMatchObject({ _tag: "Left", left: { code: "capture_failed" } })
    expect(result.item).toBeUndefined()
    expect(result.charged).toBe(0)
    expect({ postBrowserProbes, completeCalls, clearCalls }).toEqual({
      postBrowserProbes: 2,
      completeCalls: 0,
      clearCalls: 1,
    })
  })

  test("rolls back the exact staged capture when the lease is lost after durable completion", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const base = EvidenceLedger.open(path.join(temp.path, ".evidence"))
    let live = true
    let completeCalls = 0
    const ledger: EvidenceLedger.Service = {
      ...base,
      completeCapture: async (input) => {
        completeCalls++
        const item = await base.completeCapture(input)
        live = false
        return item
      },
    }
    const runtime: PlaywrightCapture.Runtime = {
      capture: async () => WorkflowVisualHost.deterministicPng({ name: "post-complete-loss", width: 390, height: 844 }),
      close: async () => undefined,
    }
    const lease = testPreviewLease(workflowID)
    const result = await Effect.runPromise(
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
          const input = {
            preview,
            stageID: WorkflowSchema.StageID.make("wfs_server_visual_post_complete_loss"),
            viewport: { name: "mobile", width: 390, height: 844 } as const,
          }
          const coordinates = WorkflowVisualHost.evidenceCoordinates(input)
          const outcome = yield* host.capture(input).pipe(
            Effect.match({
              onFailure: (left) => ({ _tag: "Left" as const, left }),
              onSuccess: (right) => ({ _tag: "Right" as const, right }),
            }),
          )
          return {
            outcome,
            item: yield* Effect.promise(() => base.get(coordinates)),
            charged: yield* Effect.promise(() => base.used(String(workflowID))),
          }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: runtime,
            evidenceLedger: ledger,
            resolvePreviewLease: async () => lease,
            isPreviewLeaseLive: async () => live,
          }),
        ),
      ),
    )

    expect(result.outcome).toMatchObject({ _tag: "Left", left: { code: "capture_failed" } })
    expect(result.item).toBeUndefined()
    expect(result.charged).toBe(0)
    expect(completeCalls).toBe(1)
  })

  test("fails closed before capability creation without trusted implementation contract authority", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    await fs.writeFile(path.join(workspaceTemp.path, "index.html"), "<!doctype html><main id=ready></main>")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "static", entrypoint: "index.html" },
    })
    const run = (input: WorkflowVisualHost.PrepareImplementationInput, withAuthority: boolean) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* WorkflowVisualHost.Service
            return yield* host.prepareImplementation(input)
          }),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime().runtime,
              ...(withAuthority ? { resolveImplementationContract } : {}),
            }),
          ),
          Effect.flip,
        ),
      )

    const unavailable = await run({ workflowID, revision: 1, plan }, false)
    const legacy = await run(
      {
        workflowID,
        revision: 1,
        plan,
        implementationSha256: "0".repeat(64),
        readySelector: "#attacker",
      } as WorkflowVisualHost.PrepareImplementationInput,
      true,
    )

    expect(unavailable).toMatchObject({ code: "visual_host_unavailable" })
    expect(legacy).toMatchObject({ code: "invalid_preview_plan" })
    expect((await fs.readdir(temp.path)).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([])
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
            resolveImplementationContract,
          }),
        ),
      ),
    )

    expect(contractValid).toBe(true)
    expect(abortObserved).toBe(true)
    expect((await fs.readdir(temp.path)).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([])
  })

  test("stops an owned process and publishes no preview when its lease is lost after readiness", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    await fs.writeFile(path.join(workspaceTemp.path, "server.mjs"), "setInterval(() => undefined, 60_000)\n")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "script", argv: ["node", "server.mjs"] },
      allowedOrigins: [],
    })
    const lease = testPreviewLease(workflowID)
    let live = true
    let starts = 0
    let stops = 0
    let readiness = 0
    const process: ProcessOwnership.OwnedProcess = {
      origin: "http://127.0.0.1:43119",
      exited: new Promise(() => undefined),
      stdout: new ReadableStream({ start: (controller) => controller.close() }),
      stderr: new ReadableStream({ start: (controller) => controller.close() }),
    }
    const ownership: ProcessOwnership.Service = {
      available: true,
      start: async () => {
        starts++
        return process
      },
      stop: async (input) => {
        if (input.process !== process) throw new Error("foreign process")
        stops++
      },
      recover: async () => {
        throw new Error("unused")
      },
    }

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.prepareImplementation({ workflowID, revision: 1, plan })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            processOwnership: ownership,
            probeOwnedOrigin: async (origin) => {
              if (origin !== process.origin) throw new Error("foreign readiness origin")
              readiness++
              live = false
              return true
            },
            resolveImplementationContract: async () => ({
              implementationSha256,
              readySelector: "#ready",
              previewLease: lease,
            }),
            resolvePreviewLease: async () => lease,
            isPreviewLeaseLive: async (candidate) => live && candidate.leaseOwner === lease.leaseOwner,
          }),
        ),
        Effect.match({
          onFailure: (left) => ({ _tag: "Left" as const, left }),
          onSuccess: (right) => ({ _tag: "Right" as const, right }),
        }),
      ),
    )

    expect(outcome).toMatchObject({ _tag: "Left", left: { code: "visual_host_unavailable" } })
    expect({ starts, readiness, stops }).toEqual({ starts: 1, readiness: 1, stops: 1 })
    expect((await fs.readdir(temp.path)).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([])
    expect(await VisualHostClaim.list(temp.path)).toEqual([])
  })

  test("publishes no reference handle when its lease is lost at the final publication seam", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const lease = testPreviewLease(workflowID)
    let live = true
    let publicationSeams = 0

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: reference }],
            },
          })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolvePreviewLease: async () => lease,
            isPreviewLeaseLive: async () => live,
            onBeforePreviewPublish: async () => {
              publicationSeams++
              live = false
            },
          }),
        ),
        Effect.match({
          onFailure: (left) => ({ _tag: "Left" as const, left }),
          onSuccess: (right) => ({ _tag: "Right" as const, right }),
        }),
      ),
    )

    expect(outcome).toMatchObject({ _tag: "Left", left: { code: "visual_host_unavailable" } })
    expect(publicationSeams).toBe(1)
    expect(await VisualHostClaim.list(temp.path)).toEqual([])
  })

  test("publishes no static implementation handle when its lease is lost at the final publication seam", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    await fs.writeFile(path.join(workspaceTemp.path, "index.html"), "<!doctype html><main id=ready></main>")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "static", entrypoint: "index.html" },
    })
    const lease = testPreviewLease(workflowID)
    let live = true
    let publicationSeams = 0

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.prepareImplementation({ workflowID, revision: 1, plan })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolveImplementationContract: async () => ({
              implementationSha256,
              readySelector: "#ready",
              previewLease: lease,
            }),
            resolvePreviewLease: async () => lease,
            isPreviewLeaseLive: async () => live,
            onBeforePreviewPublish: async () => {
              publicationSeams++
              live = false
            },
          }),
        ),
        Effect.match({
          onFailure: (left) => ({ _tag: "Left" as const, left }),
          onSuccess: (right) => ({ _tag: "Right" as const, right }),
        }),
      ),
    )

    expect(outcome).toMatchObject({ _tag: "Left", left: { code: "visual_host_unavailable" } })
    expect(publicationSeams).toBe(1)
    expect(await VisualHostClaim.list(temp.path)).toEqual([])
  })

  test("stops an owned process without probing readiness when its lease is lost during start", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    await fs.writeFile(path.join(workspaceTemp.path, "server.mjs"), "setInterval(() => undefined, 60_000)\n")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "script", argv: ["node", "server.mjs"] },
      allowedOrigins: [],
    })
    const lease = testPreviewLease(workflowID)
    let live = true
    let starts = 0
    let stops = 0
    let readiness = 0
    const process: ProcessOwnership.OwnedProcess = {
      origin: "http://127.0.0.1:43120",
      exited: new Promise(() => undefined),
      stdout: new ReadableStream({ start: (controller) => controller.close() }),
      stderr: new ReadableStream({ start: (controller) => controller.close() }),
    }
    const ownership: ProcessOwnership.Service = {
      available: true,
      start: async () => {
        starts++
        live = false
        return process
      },
      stop: async (input) => {
        if (input.process !== process) throw new Error("foreign process")
        stops++
      },
      recover: async () => {
        throw new Error("unused")
      },
    }

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.prepareImplementation({ workflowID, revision: 1, plan })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            processOwnership: ownership,
            probeOwnedOrigin: async () => {
              readiness++
              return true
            },
            resolveImplementationContract: async () => ({
              implementationSha256,
              readySelector: "#ready",
              previewLease: lease,
            }),
            resolvePreviewLease: async () => lease,
            isPreviewLeaseLive: async () => live,
          }),
        ),
        Effect.match({
          onFailure: (left) => ({ _tag: "Left" as const, left }),
          onSuccess: (right) => ({ _tag: "Right" as const, right }),
        }),
      ),
    )

    expect(outcome).toMatchObject({ _tag: "Left", left: { code: "visual_host_unavailable" } })
    expect({ starts, readiness, stops }).toEqual({ starts: 1, readiness: 0, stops: 1 })
    expect(await VisualHostClaim.list(temp.path)).toEqual([])
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
          const preview = yield* host.prepareImplementation({
            workflowID,
            revision: 1,
            plan,
          })
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
            resolveImplementationContract,
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
            const preview = yield* host.prepareImplementation({
              workflowID,
              revision: 1,
              plan,
            })
            directory = path.join(temp.path, preview.hostID)
            const manifest = JSON.parse(
              yield* Effect.promise(() => fs.readFile(path.join(directory, ".host.json"), "utf8")),
            )
            identity = {
              workflowID: manifest.workflowID,
              stageID: manifest.stageID,
              attempt: manifest.attempt,
              leaseOwner: manifest.leaseOwner,
              leaseExpiresAt: manifest.leaseExpiresAt,
              hostID: preview.hostID,
              nonce: manifest.nonce,
            }
          }),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime().runtime,
              processOwnership: refusingStop,
              finalizerTimeoutMs: 50,
              resolveImplementationContract,
            }),
          ),
        ),
      )

      expect(await fs.exists(directory)).toBe(true)
      expect(await fetch(`http://127.0.0.1:${port}`).then((response) => response.text())).toBe("still-owned")
    } finally {
      if (identity !== undefined) {
        await ownership.service.recover({ identity, finalGate: async () => true }).catch(() => undefined)
      }
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
          return yield* host.prepareImplementation({
            workflowID,
            revision: 1,
            plan,
          })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolveImplementationContract,
          }),
        ),
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
          const preview = yield* host.prepareImplementation({
            workflowID,
            revision: 1,
            plan,
          })
          publicURL = preview.url
          expect(preview.url).not.toBe(`http://127.0.0.1:${port}/`)
          expect(Object.keys(preview)).toEqual([
            "hostID",
            "url",
            "origin",
            "revision",
            "configSha256",
            "identity",
            "scope",
          ])
          yield* host.capture({
            preview,
            stageID: captureStageID,
            viewport: { name: "mobile", width: 390, height: 844 },
          })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: runtime,
            processOwnership: ownership.service,
            resolveImplementationContract,
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
          const preview = yield* host.prepareImplementation({
            workflowID,
            revision: 2,
            plan,
          })
          const html = yield* Effect.promise(() => fetch(preview.url).then((response) => response.text()))
          const image = yield* host.capture({
            preview,
            stageID: captureStageID,
            viewport: { name: "desktop", width: 1440, height: 900 },
          })
          return { preview, html, image }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: runtime.runtime,
            resolveImplementationContract,
          }),
        ),
      ),
    )

    expect(result.html).toBe(implementation)
    expect(result.preview.revision).toBe(2)
    expect(result.preview.configSha256).toBe(plan.configSha256)
    expect(result.image.width).toBe(1440)
    expect(runtime.fetches).toEqual([{ url: `${dependencyOrigin}/asset.js`, maxRedirects: 0 }])
    expect(runtime.fulfilled).toEqual([`${dependencyOrigin}/asset.js`])
    expect(runtime.aborted).toEqual(["https://example.com/tracker.js"])
  })

  test("serves immutable Snapshot bytes when the live workspace is edited and restored after resolution", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    const captured = "<!doctype html><main id=ready>captured</main>"
    const changed = "<!doctype html><main id=ready>changed</main>"
    const asset = "export const sealed = true\n"
    const app = path.join(workspaceTemp.path, "packages", "app")
    await fs.mkdir(app, { recursive: true })
    await fs.writeFile(path.join(app, "index.html"), captured)
    await fs.writeFile(path.join(app, "asset.js"), asset)
    const location = Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) })
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location,
      preview: { kind: "static", cwd: "packages/app", entrypoint: "index.html" },
    })
    const entries = [
      {
        path: RelativePath.make("packages/app/index.html"),
        type: "file",
        sha256: createHash("sha256").update(captured).digest("hex"),
        size: Buffer.byteLength(captured),
      },
      {
        path: RelativePath.make("packages/app/asset.js"),
        type: "file",
        sha256: createHash("sha256").update(asset).digest("hex"),
        size: Buffer.byteLength(asset),
      },
    ] as const
    const workspaceSha256 = Snapshot.workspaceSha256(entries)
    const archive = await WorkflowWorkspaceMaterialization.seal(entries, async (relative) =>
      Buffer.from(relative.endsWith("asset.js") ? asset : captured),
    )
    const sealedSnapshot = WorkflowWorkspaceMaterialization.bind({
      workflowID,
      stageID: captureStageID,
      revision: 2,
      location,
      snapshotRef: Snapshot.ID.make("captured-tree"),
      manifestSha256: implementationSha256,
      workspaceSha256,
      archive,
    })

    const html = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.prepareImplementation({ workflowID, revision: 2, plan })
          yield* Effect.promise(() => fs.writeFile(path.join(app, "index.html"), captured))
          return yield* Effect.promise(async () => ({
            html: await fetch(preview.url).then((response) => response.text()),
            asset: await fetch(new URL("asset.js", preview.url)).then((response) => response.text()),
          }))
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolveImplementationContract: async () => {
              await fs.writeFile(path.join(app, "index.html"), changed)
              return {
                implementationSha256,
                readySelector: "#ready",
                sealedSnapshot,
                previewLease: testPreviewLease(workflowID),
              }
            },
          }),
        ),
      ),
    )

    expect(html).toEqual({ html: captured, asset })
  })

  test("bounds static responses at 32 MiB and rejects oversize or growth before returning bytes", async () => {
    const serve = async (size: number, grow?: "before-read" | "after-read") => {
      await using temp = await taskTemp()
      await using workspaceTemp = await taskTemp()
      const entrypoint = path.join(workspaceTemp.path, "index.html")
      await fs.writeFile(entrypoint, new Uint8Array(size))
      const plan = PreviewPlan.freeze({
        authority: "admission",
        location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
        preview: { kind: "static", entrypoint: "index.html" },
      })
      expect(PreviewPlan.isFrozen(plan)).toBe(true)
      expect(() => PreviewPlan.verifyConfiguration(plan)).not.toThrow()
      return await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* WorkflowVisualHost.Service
            const preview = yield* host.prepareImplementation({ workflowID, revision: 2, plan })
            return yield* Effect.promise(async () => {
              const response = await fetch(preview.url)
              return { status: response.status, bytes: (await response.arrayBuffer()).byteLength }
            })
          }),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime().runtime,
              resolveImplementationContract,
              onStaticFileOpened:
                grow === "before-read"
                  ? async (file) => {
                      await fs.appendFile(file, new Uint8Array(1))
                    }
                  : undefined,
              onStaticFileRead:
                grow === "after-read"
                  ? async (file) => {
                      await fs.appendFile(file, new Uint8Array(1))
                    }
                  : undefined,
            }),
          ),
        ),
      )
    }

    expect(await serve(32 * 1024 * 1024)).toEqual({ status: 200, bytes: 32 * 1024 * 1024 })
    expect(await serve(32 * 1024 * 1024 + 1)).toMatchObject({ status: 413 })
    expect(await serve(16, "before-read")).toMatchObject({ status: 413 })
    expect(await serve(16, "after-read")).toMatchObject({ status: 413 })
  })

  test("never serves a multiply-linked static implementation file", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    await using outsideTemp = await taskTemp()
    const outside = path.join(outsideTemp.path, "outside.html")
    const entrypoint = path.join(workspaceTemp.path, "index.html")
    await fs.writeFile(outside, "outside-secret")
    await fs.link(outside, entrypoint)
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "static", entrypoint: "index.html" },
    })

    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.prepareImplementation({ workflowID, revision: 0, plan })
          return yield* Effect.promise(() => fetch(preview.url))
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolveImplementationContract,
          }),
        ),
      ),
    )

    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain("outside-secret")
  })

  test("does not serve external bytes after an admitted static file is replaced", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    await using outsideTemp = await taskTemp()
    const entrypoint = path.join(workspaceTemp.path, "index.html")
    const outside = path.join(outsideTemp.path, "outside.html")
    await fs.writeFile(entrypoint, "workspace-owned")
    await fs.writeFile(outside, "outside-secret")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "static", entrypoint: "index.html" },
    })

    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.prepareImplementation({ workflowID, revision: 0, plan })
          yield* Effect.promise(async () => {
            await fs.rm(entrypoint)
            await fs.link(outside, entrypoint)
          })
          return yield* Effect.promise(() => fetch(preview.url))
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolveImplementationContract,
          }),
        ),
      ),
    )

    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain("outside-secret")
  })

  test("applies the shared protected-root admission before any implementation preview capability", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    await fs.writeFile(path.join(workspaceTemp.path, "index.html"), "<!doctype html><main id=ready></main>")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "static", entrypoint: "index.html" },
    })
    let checks = 0

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.prepareImplementation({ workflowID, revision: 0, plan })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolveImplementationContract,
            ...({
              workspacePolicy: async () => {
                checks++
                throw new TypeError("Location overlaps protected host roots")
              },
            } as Record<string, unknown>),
          }),
        ),
        Effect.match({
          onFailure: (failure) => ({ _tag: "Left" as const, failure }),
          onSuccess: () => ({ _tag: "Right" as const }),
        }),
      ),
    )

    expect(outcome).toMatchObject({ _tag: "Left", failure: { code: "invalid_preview_plan" } })
    expect(checks).toBe(1)
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
          return yield* host.prepareImplementation({
            workflowID,
            revision: 0,
            plan,
          })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolveImplementationContract,
          }),
        ),
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
            stageID: captureStageID,
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
          const capture = (stageID: WorkflowSchema.StageID) =>
            host.capture({ preview, stageID, viewport }).pipe(
              Effect.match({
                onFailure: (error) => ({ error }),
                onSuccess: (image) => ({ image }),
              }),
            )
          return yield* Effect.all(
            [
              capture(WorkflowSchema.StageID.make("wfs_server_visual_quota_a")),
              capture(WorkflowSchema.StageID.make("wfs_server_visual_quota_b")),
            ],
            { concurrency: "unbounded" },
          )
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

    let captureAttempt = 0
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
            captureAttempt++
            return yield* host.capture({
              preview,
              stageID: WorkflowSchema.StageID.make(`wfs_server_visual_restart_${captureAttempt}`),
              viewport,
            })
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

  test("closes a database acquired before an open post-check rejects a new hardlink owner", async () => {
    await using temp = await taskTemp()
    await using outside = await taskTemp()
    const ledgerRoot = path.join(temp.path, ".evidence")
    const databasePath = path.join(ledgerRoot, "evidence.sqlite")
    const outsideLink = path.join(outside.path, "other-owner.sqlite")

    expect(() =>
      EvidenceLedger.open(ledgerRoot, {
        onBoundary: ({ operation, phase }) => {
          if (operation !== "open" || phase !== "after") return
          fsSync.linkSync(databasePath, outsideLink)
        },
      }),
    ).toThrow(TypeError)
    expect(await fs.readFile(outsideLink)).toEqual(Buffer.alloc(0))
    await expect(fs.rename(databasePath, `${databasePath}.released`)).resolves.toBeUndefined()
    await expect(fs.rm(`${databasePath}.released`)).resolves.toBeUndefined()
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
    const expiredWorkflowID = WorkflowSchema.ID.make("wfl_server_visual_expired")
    let expiredLeaseLive = true
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
            workflowID: expiredWorkflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: reference }],
            },
          })
          expiredLeaseLive = false
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
            isPreviewLeaseLive: async (lease) => lease.workflowID === workflowID || expiredLeaseLive,
            resolvePreviewLease: async (id) => testPreviewLease(id),
          }),
        ),
      ),
    )

    expect(await fs.exists(path.join(temp.path, result.leased.hostID))).toBe(false)
    expect(await fs.exists(path.join(temp.path, result.expired.hostID))).toBe(false)
    expect(await fs.exists(temp.path)).toBe(true)
  })

  test("recovers an authenticated orphan once at fresh runtime startup without sweeping a new active preview", async () => {
    await using temp = await taskTemp()
    const identity: ProcessOwnership.Identity = {
      ...testPreviewLease(workflowID),
      attempt: 1,
      leaseOwner: "expired-preview-owner",
      hostID: WorkflowVisualHost.HostID.make("8".repeat(64)),
      nonce: "9".repeat(64),
    }
    const orphan = (await claimedOrphan(temp.path, identity)).directory
    const recovered: ProcessOwnership.Identity[] = []
    const ownership: ProcessOwnership.Service = {
      available: true,
      start: async () => {
        throw new Error("unused")
      },
      stop: async () => {
        throw new Error("unused")
      },
      recover: async (candidate) => {
        if (candidate.identity.hostID !== identity.hostID || candidate.identity.nonce !== identity.nonce) {
          throw new Error("unauthenticated recovery")
        }
        if (!(await candidate.finalGate())) throw new Error("live recovery")
        recovered.push(candidate.identity)
      },
    }
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    let activeDirectory = ""

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const active = yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: reference }],
            },
          })
          activeDirectory = path.join(temp.path, active.hostID)
          expect(yield* Effect.promise(() => fs.exists(orphan))).toBe(false)
          expect(yield* Effect.promise(() => fs.exists(activeDirectory))).toBe(true)
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            processOwnership: ownership,
            resolvePreviewLease: async (id) => testPreviewLease(id),
            isPreviewLeaseLive: async (lease) => lease.leaseOwner !== identity.leaseOwner,
            now: () => 11,
          }),
        ),
      ),
    )

    expect(recovered).toEqual([identity])
    expect(await fs.exists(activeDirectory)).toBe(false)
    await Effect.runPromise(
      Effect.scoped(WorkflowVisualHost.Service).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            processOwnership: ownership,
            resolvePreviewLease: async (id) => testPreviewLease(id),
            isPreviewLeaseLive: async (lease) => lease.leaseOwner !== identity.leaseOwner,
            now: () => 12,
          }),
        ),
      ),
    )
    expect(recovered).toEqual([identity])
  })

  test("publishes a capability directory only after its exact claim-bound manifest is durable", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    let created = false
    let staged = false
    let published = false

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: reference }],
            },
          })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolvePreviewLease: async (id) => testPreviewLease(id),
            isPreviewLeaseLive: async () => true,
            onRecordStagingCreated: async () => {
              created = true
            },
            onRecordStaged: async (stagingDirectory, finalDirectory) => {
              staged = true
              expect(await fs.exists(finalDirectory)).toBe(false)
              const manifest = path.join(stagingDirectory, ".host.json")
              expect((await fs.stat(manifest)).size).toBeGreaterThan(0)
              expect((await fs.lstat(manifest)).nlink).toBe(1)
            },
            onRecordCreated: async (directory) => {
              published = true
              expect(await fs.exists(path.join(directory, ".host.json"))).toBe(true)
              expect((await fs.readdir(temp.path)).some((entry) => entry.endsWith(".pending"))).toBe(false)
            },
          }),
        ),
        Effect.match({ onFailure: (error) => ({ error }), onSuccess: () => ({ success: true as const }) }),
      ),
    )

    expect({ created, staged, published, outcome }).toEqual({
      created: true,
      staged: true,
      published: true,
      outcome: { success: true },
    })
  })

  test("preserves a foreign final capability directory when atomic record publication collides", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    let sentinel = ""

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: reference }],
            },
          })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolvePreviewLease: async (id) => testPreviewLease(id),
            isPreviewLeaseLive: async () => true,
            onRecordStaged: async (_stagingDirectory, finalDirectory) => {
              await fs.mkdir(finalDirectory)
              sentinel = path.join(finalDirectory, "foreign.txt")
              await fs.writeFile(sentinel, "preserve")
            },
          }),
        ),
        Effect.match({ onFailure: (error) => ({ error }), onSuccess: () => ({ success: true as const }) }),
      ),
    )

    expect(outcome).toMatchObject({ error: { code: "visual_host_unavailable" } })
    expect(await fs.readFile(sentinel, "utf8")).toBe("preserve")
    expect(await VisualHostClaim.list(temp.path)).toEqual([])
  })

  test.each(["empty", "partial-manifest"] as const)(
    "recovers an exact generation-and-nonce-bound %s record staging directory",
    async (variant) => {
      await using temp = await taskTemp()
      const identity: ProcessOwnership.Identity = {
        ...testPreviewLease(workflowID),
        hostID: WorkflowVisualHost.HostID.make("a".repeat(64)),
        nonce: "b".repeat(64),
      }
      const body = VisualHostClaim.make({
        purpose: "reference",
        kind: "static",
        ...identity,
        createdAt: 10,
        revision: 0,
        configurationSha256: "c".repeat(64),
        sourceSha256: "d".repeat(64),
      })
      const acquired = await VisualHostClaim.acquire(temp.path, body)
      if (acquired.status !== "acquired") throw new TypeError("staging claim did not acquire")
      const staging = path.join(temp.path, `.host.${identity.hostID}.${body.generation}.${identity.nonce}.pending`)
      await fs.mkdir(staging)
      if (variant === "partial-manifest") await fs.writeFile(path.join(staging, ".host.json"), "{")

      await Effect.runPromise(
        Effect.scoped(WorkflowVisualHost.Service).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime().runtime,
              resolvePreviewLease: async (id) => testPreviewLease(id),
              isPreviewLeaseLive: async () => false,
            }),
          ),
        ),
      )

      expect(await fs.exists(staging)).toBe(false)
      expect(await VisualHostClaim.list(temp.path)).toEqual([])
    },
  )

  test("preserves and rejects a foreign record staging directory not bound to the claim nonce", async () => {
    await using temp = await taskTemp()
    const identity: ProcessOwnership.Identity = {
      ...testPreviewLease(workflowID),
      hostID: WorkflowVisualHost.HostID.make("c".repeat(64)),
      nonce: "d".repeat(64),
    }
    const body = VisualHostClaim.make({
      purpose: "reference",
      kind: "static",
      ...identity,
      createdAt: 10,
      revision: 0,
      configurationSha256: "e".repeat(64),
      sourceSha256: "f".repeat(64),
    })
    const acquired = await VisualHostClaim.acquire(temp.path, body)
    if (acquired.status !== "acquired") throw new TypeError("staging claim did not acquire")
    const foreign = path.join(temp.path, `.host.${identity.hostID}.${body.generation}.${"0".repeat(64)}.pending`)
    await fs.mkdir(foreign)
    const sentinel = path.join(foreign, "foreign.txt")
    await fs.writeFile(sentinel, "preserve")

    const outcome = await Effect.runPromise(
      Effect.scoped(WorkflowVisualHost.Service).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolvePreviewLease: async (id) => testPreviewLease(id),
            isPreviewLeaseLive: async () => false,
          }),
        ),
        Effect.match({ onFailure: (error) => ({ error }), onSuccess: () => ({ success: true as const }) }),
      ),
    )

    expect(outcome).toMatchObject({ error: { code: "visual_host_unavailable" } })
    expect(await fs.readFile(sentinel, "utf8")).toBe("preserve")
    expect(await VisualHostClaim.list(temp.path)).toMatchObject([
      { state: "active", body: { generation: body.generation, nonce: identity.nonce } },
    ])
  })

  test("preserves an active final capability directory whose complete exact manifest is missing", async () => {
    await using temp = await taskTemp()
    const identity: ProcessOwnership.Identity = {
      ...testPreviewLease(workflowID),
      hostID: WorkflowVisualHost.HostID.make("5".repeat(64)),
      nonce: "6".repeat(64),
    }
    const claimed = await claimedOrphan(temp.path, identity, { writeManifest: false })
    const sentinel = path.join(claimed.directory, "foreign.txt")
    await fs.writeFile(sentinel, "preserve")
    const recovered: ProcessOwnership.Identity[] = []
    const ownership: ProcessOwnership.Service = {
      available: true,
      start: async () => {
        throw new Error("unused")
      },
      stop: async () => {
        throw new Error("unused")
      },
      recover: async ({ identity: candidate }) => {
        recovered.push(candidate)
      },
    }

    for (let restart = 0; restart < 2; restart++) {
      const outcome = await Effect.runPromise(
        Effect.scoped(WorkflowVisualHost.Service).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime().runtime,
              processOwnership: ownership,
              resolvePreviewLease: async (id) => testPreviewLease(id),
              isPreviewLeaseLive: async () => false,
            }),
          ),
          Effect.match({ onFailure: (error) => ({ error }), onSuccess: () => ({ success: true as const }) }),
        ),
      )
      expect(outcome).toMatchObject({ error: { code: "visual_host_unavailable" } })
      expect(await fs.readFile(sentinel, "utf8")).toBe("preserve")
      expect(recovered).toEqual([])
    }
  })

  test("never launders a pending claim with an unknown capability directory into recoverable releasing state", async () => {
    await using temp = await taskTemp()
    const identity: ProcessOwnership.Identity = {
      ...testPreviewLease(workflowID),
      hostID: WorkflowVisualHost.HostID.make("3".repeat(64)),
      nonce: "4".repeat(64),
    }
    const body = VisualHostClaim.make({
      purpose: "implementation",
      kind: "script",
      ...identity,
      createdAt: 10,
      revision: 1,
      configurationSha256: "c".repeat(64),
      sourceSha256: "d".repeat(64),
    })
    await expect(
      VisualHostClaim.acquire(temp.path, body, {
        afterMirrorLinked: async () => {
          throw new Error("simulated owner crash before active promotion")
        },
      }),
    ).rejects.toThrow("simulated owner crash")
    const directory = path.join(temp.path, identity.hostID)
    const sentinel = path.join(directory, "foreign.txt")
    await fs.mkdir(directory)
    await fs.writeFile(sentinel, "preserve")
    const recovered: ProcessOwnership.Identity[] = []
    const ownership: ProcessOwnership.Service = {
      available: true,
      start: async () => {
        throw new Error("unused")
      },
      stop: async () => {
        throw new Error("unused")
      },
      recover: async ({ identity: candidate }) => {
        recovered.push(candidate)
      },
    }
    const restart = () =>
      Effect.runPromise(
        Effect.scoped(WorkflowVisualHost.Service).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime().runtime,
              processOwnership: ownership,
              resolvePreviewLease: async (id) => testPreviewLease(id),
              isPreviewLeaseLive: async () => false,
            }),
          ),
          Effect.match({
            onFailure: (error) => ({ error }),
            onSuccess: () => ({ success: true as const }),
          }),
        ),
      )

    for (let restartCount = 0; restartCount < 2; restartCount++) {
      expect(await restart()).toMatchObject({ error: { code: "visual_host_unavailable" } })
      expect(await VisualHostClaim.list(temp.path)).toMatchObject([
        { state: "pending", body: { generation: body.generation, hostID: identity.hostID } },
      ])
      expect(await fs.readFile(sentinel, "utf8")).toBe("preserve")
      expect(recovered).toEqual([])
    }
  })

  test.each(["symlink", "hardlink", "oversize", "extra-key"] as const)(
    "preserves an orphan and starts no recovery for a %s ownership manifest",
    async (variant) => {
      await using temp = await taskTemp()
      await using outside = await taskTemp()
      const identity: ProcessOwnership.Identity = {
        ...testPreviewLease(workflowID),
        hostID: WorkflowVisualHost.HostID.make("7".repeat(64)),
        nonce: "6".repeat(64),
      }
      const claimed = await claimedOrphan(temp.path, identity, { writeManifest: false })
      const { directory } = claimed
      const manifest = path.join(directory, ".host.json")
      const sentinel = path.join(directory, "preserve.txt")
      const body = claimed.manifest
      await fs.writeFile(sentinel, "preserve")
      if (variant === "symlink") {
        const target = path.join(outside.path, "manifest.json")
        await fs.writeFile(target, JSON.stringify(body))
        await fs.symlink(target, manifest, "file")
      } else if (variant === "hardlink") {
        await fs.writeFile(manifest, JSON.stringify(body))
        await fs.link(manifest, path.join(outside.path, "manifest-owner.json"))
      } else if (variant === "oversize") {
        await fs.writeFile(manifest, "x".repeat(16 * 1024 + 1))
      } else {
        await fs.writeFile(manifest, JSON.stringify({ ...body, extra: true }))
      }
      const recovered: ProcessOwnership.Identity[] = []
      const ownership: ProcessOwnership.Service = {
        available: true,
        start: async () => {
          throw new Error("unused")
        },
        stop: async () => {
          throw new Error("unused")
        },
        recover: async ({ identity: candidate }) => {
          recovered.push(candidate)
        },
      }

      const outcome = await Effect.runPromise(
        Effect.scoped(WorkflowVisualHost.Service).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime().runtime,
              processOwnership: ownership,
              isPreviewLeaseLive: async () => false,
              resolvePreviewLease: async (id) => testPreviewLease(id),
            }),
          ),
          Effect.match({
            onFailure: (error) => ({ error }),
            onSuccess: () => ({ success: true as const }),
          }),
        ),
      )

      expect(outcome).toMatchObject({ error: { operation: "recover_expired", code: "visual_host_unavailable" } })
      expect(recovered).toEqual([])
      expect(await fs.readFile(sentinel, "utf8")).toBe("preserve")
      expect(await fs.exists(directory)).toBe(true)
      expect(await VisualHostClaim.list(temp.path)).toMatchObject([
        {
          state: "active",
          body: { generation: claimed.claim.body.generation, hostID: identity.hostID },
        },
      ])
    },
  )

  test("admits only one filesystem owner across concurrent host layers for the same Stage purpose", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    let markFirstCreated!: () => void
    const firstCreated = new Promise<void>((resolve) => {
      markFirstCreated = resolve
    })
    let releaseFirst!: () => void
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const materialize = (evidenceRoot: string, onRecordCreated?: () => Promise<void>) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(WorkflowVisualHost.Service, (host) =>
            host
              .materializeReference({
                workflowID,
                referenceApp: {
                  entrypoint: "index.html",
                  readySelector: "#ready",
                  projectStack: ["HTML"],
                  files: [{ path: "index.html", content: reference }],
                },
              })
              .pipe(
                Effect.match({
                  onFailure: (left) => ({ _tag: "Left" as const, left }),
                  onSuccess: (right) => ({ _tag: "Right" as const, right }),
                }),
              ),
          ),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              evidenceRoot,
              browser: browserRuntime().runtime,
              onRecordCreated,
            }),
          ),
        ),
      )

    const first = materialize(path.join(temp.path, "evidence-a"), async () => {
      markFirstCreated()
      await holdFirst
    })
    await firstCreated
    let second: Awaited<ReturnType<typeof materialize>>
    try {
      second = await materialize(path.join(temp.path, "evidence-b"))
    } finally {
      releaseFirst()
    }
    const admitted = await first

    expect(admitted._tag).toBe("Right")
    expect(second).toMatchObject({ _tag: "Left", left: { code: "visual_host_unavailable" } })
  })

  test("fences a stale layer finisher after another layer replaces the exact released generation", async () => {
    await using temp = await taskTemp()
    const oldIdentity: ProcessOwnership.Identity = {
      ...testPreviewLease(workflowID),
      leaseOwner: "workflow-visual-host-old-layer-owner",
      hostID: WorkflowVisualHost.HostID.make("1".repeat(64)),
      nonce: "2".repeat(64),
    }
    const orphan = await claimedOrphan(temp.path, oldIdentity, {
      kind: "static",
      purpose: "reference",
      revision: 0,
    })
    const currentLease: WorkflowVisualHost.PreviewLeaseAuthority = {
      ...testPreviewLease(workflowID),
      attempt: 2,
      leaseOwner: "workflow-visual-host-new-layer-owner",
      leaseExpiresAt: 2_000_000_000_100,
    }
    const isLive = async (lease: WorkflowVisualHost.PreviewLeaseAuthority) =>
      lease.workflowID === currentLease.workflowID &&
      lease.stageID === currentLease.stageID &&
      lease.attempt === currentLease.attempt &&
      lease.leaseOwner === currentLease.leaseOwner
    let markOldReleasing!: () => void
    const oldReleasing = new Promise<void>((resolve) => {
      markOldReleasing = resolve
    })
    let continueOldFinisher!: () => void
    const holdOldFinisher = new Promise<void>((resolve) => {
      continueOldFinisher = resolve
    })
    const staleLayer = Effect.runPromise(
      Effect.scoped(WorkflowVisualHost.Service).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolvePreviewLease: async () => currentLease,
            isPreviewLeaseLive: isLive,
            onClaimReleasing: async (claim) => {
              if (claim.body.generation !== orphan.claim.body.generation) {
                throw new Error("unexpected releasing generation")
              }
              markOldReleasing()
              await holdOldFinisher
            },
          }),
        ),
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: () => ({ success: true as const }),
        }),
      ),
    )
    await oldReleasing

    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    let markReplacement!: (directory: string) => void
    const replacementReady = new Promise<string>((resolve) => {
      markReplacement = resolve
    })
    let releaseReplacement!: () => void
    const holdReplacement = new Promise<void>((resolve) => {
      releaseReplacement = resolve
    })
    const replacementLayer = Effect.runPromise(
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
          markReplacement(path.join(temp.path, preview.hostID))
          yield* Effect.promise(() => holdReplacement)
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolvePreviewLease: async () => currentLease,
            isPreviewLeaseLive: isLive,
          }),
        ),
      ),
    )
    const replacementDirectory = await replacementReady
    expect(await fs.exists(orphan.directory)).toBe(false)
    expect(await fs.exists(replacementDirectory)).toBe(true)

    continueOldFinisher()
    expect(await staleLayer).toMatchObject({ error: { code: "visual_host_unavailable" } })
    expect(await fs.exists(replacementDirectory)).toBe(true)
    expect(await VisualHostClaim.list(temp.path)).toMatchObject([
      {
        state: "active",
        body: {
          purpose: "reference",
          attempt: 2,
          leaseOwner: currentLease.leaseOwner,
        },
      },
    ])

    releaseReplacement()
    await replacementLayer
    expect(await VisualHostClaim.list(temp.path)).toEqual([])
  })

  test("keeps an active claim active when the stale lease becomes live at the release transition gate", async () => {
    await using temp = await taskTemp()
    const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
    const firstLease = testPreviewLease(workflowID)
    const secondLease: WorkflowVisualHost.PreviewLeaseAuthority = {
      ...firstLease,
      attempt: 2,
      leaseOwner: "workflow-visual-host-transition-gate-owner",
      leaseExpiresAt: firstLease.leaseExpiresAt + 100,
    }
    let current = firstLease
    let racing = false
    let staleChecks = 0
    const same = (
      lease: WorkflowVisualHost.PreviewLeaseAuthority,
      expected: WorkflowVisualHost.PreviewLeaseAuthority,
    ) =>
      lease.workflowID === expected.workflowID &&
      lease.stageID === expected.stageID &&
      lease.attempt === expected.attempt &&
      lease.leaseOwner === expected.leaseOwner
    const isLive = async (lease: WorkflowVisualHost.PreviewLeaseAuthority) => {
      if (racing && same(lease, firstLease)) {
        staleChecks++
        return staleChecks >= 3
      }
      return same(lease, current)
    }
    const referenceInput = {
      workflowID,
      referenceApp: {
        entrypoint: "index.html",
        readySelector: "#ready",
        projectStack: ["HTML"],
        files: [{ path: "index.html", content: reference }],
      },
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const first = yield* host.materializeReference(referenceInput)
          current = secondLease
          racing = true
          const second = yield* host.materializeReference(referenceInput).pipe(
            Effect.match({
              onFailure: (left) => ({ _tag: "Left" as const, left }),
              onSuccess: (right) => ({ _tag: "Right" as const, right }),
            }),
          )
          const [claim] = yield* Effect.promise(() => VisualHostClaim.list(temp.path))
          return {
            claimState: claim?.state,
            oldReachable: yield* Effect.promise(() => fetch(first.url).then((response) => response.ok)),
            second,
            staleChecks,
          }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            resolvePreviewLease: async () => current,
            isPreviewLeaseLive: isLive,
          }),
        ),
      ),
    )

    expect(observed.second).toMatchObject({ _tag: "Left", left: { code: "visual_host_unavailable" } })
    expect(observed).toMatchObject({ claimState: "active", oldReachable: true, staleChecks: 3 })
    expect(await VisualHostClaim.list(temp.path)).toEqual([])
  })

  test.each(["afterBeginRelease", "beforeServerStop"] as const)(
    "does not stop a stale active server when its exact lease becomes live at %s",
    async (seam) => {
      await using temp = await taskTemp()
      const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
      const firstLease = testPreviewLease(workflowID)
      const secondLease: WorkflowVisualHost.PreviewLeaseAuthority = {
        ...firstLease,
        attempt: 2,
        leaseOwner: "workflow-visual-host-release-race-owner",
        leaseExpiresAt: firstLease.leaseExpiresAt + 100,
      }
      let current = firstLease
      let releaseSeams = 0
      const isLive = async (lease: WorkflowVisualHost.PreviewLeaseAuthority) =>
        lease.workflowID === current.workflowID &&
        lease.stageID === current.stageID &&
        lease.attempt === current.attempt &&
        lease.leaseOwner === current.leaseOwner
      const referenceInput = {
        workflowID,
        referenceApp: {
          entrypoint: "index.html",
          readySelector: "#ready",
          projectStack: ["HTML"],
          files: [{ path: "index.html", content: reference }],
        },
      }

      const raced = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* WorkflowVisualHost.Service
            const first = yield* host.materializeReference(referenceInput)
            current = secondLease
            const second = yield* host.materializeReference(referenceInput).pipe(
              Effect.match({
                onFailure: (left) => ({ _tag: "Left" as const, left }),
                onSuccess: (right) => ({ _tag: "Right" as const, right }),
              }),
            )
            const oldReachable = yield* Effect.promise(() =>
              fetch(first.url).then(
                (response) => response.ok,
                () => false,
              ),
            )
            return { firstURL: first.url, oldReachable, second }
          }),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime().runtime,
              resolvePreviewLease: async () => current,
              isPreviewLeaseLive: isLive,
              ...(seam === "afterBeginRelease"
                ? {
                    onAfterBeginRelease: async () => {
                      releaseSeams++
                      current = firstLease
                    },
                  }
                : {
                    onBeforeServerStop: async () => {
                      if (current === firstLease) return
                      releaseSeams++
                      current = firstLease
                    },
                  }),
            }),
          ),
        ),
      )

      expect(raced.second).toMatchObject({ _tag: "Left", left: { code: "visual_host_unavailable" } })
      expect({ releaseSeams, oldReachable: raced.oldReachable }).toEqual({ releaseSeams: 1, oldReachable: true })
      expect(await VisualHostClaim.list(temp.path)).toEqual([])
      await expect(fetch(raced.firstURL)).rejects.toThrow()
    },
  )

  test.each(["beforeCapabilityRemove", "beforeClaimDelete"] as const)(
    "fences stale release at %s and preserves the remaining exact authority until retry",
    async (seam) => {
      await using temp = await taskTemp()
      const reference = await fs.readFile(path.join(fixtureRoot, "reference", "index.html"), "utf8")
      const firstLease = testPreviewLease(workflowID)
      const secondLease: WorkflowVisualHost.PreviewLeaseAuthority = {
        ...firstLease,
        attempt: 2,
        leaseOwner: "workflow-visual-host-late-release-owner",
        leaseExpiresAt: firstLease.leaseExpiresAt + 100,
      }
      let current = firstLease
      let seams = 0
      const isLive = async (lease: WorkflowVisualHost.PreviewLeaseAuthority) =>
        lease.workflowID === current.workflowID &&
        lease.stageID === current.stageID &&
        lease.attempt === current.attempt &&
        lease.leaseOwner === current.leaseOwner
      const referenceInput = {
        workflowID,
        referenceApp: {
          entrypoint: "index.html",
          readySelector: "#ready",
          projectStack: ["HTML"],
          files: [{ path: "index.html", content: reference }],
        },
      }
      const closeGate = async () => {
        if (current === firstLease) return
        seams++
        current = firstLease
      }

      const observed = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* WorkflowVisualHost.Service
            const first = yield* host.materializeReference(referenceInput)
            current = secondLease
            const second = yield* host.materializeReference(referenceInput).pipe(
              Effect.match({
                onFailure: (left) => ({ _tag: "Left" as const, left }),
                onSuccess: (right) => ({ _tag: "Right" as const, right }),
              }),
            )
            return {
              second,
              directoryExists: yield* Effect.promise(() => fs.exists(path.join(temp.path, first.hostID))),
              claims: yield* Effect.promise(() => VisualHostClaim.list(temp.path)),
              oldReachable: yield* Effect.promise(() =>
                fetch(first.url).then(
                  (response) => response.ok,
                  () => false,
                ),
              ),
            }
          }),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot: temp.path,
              browser: browserRuntime().runtime,
              resolvePreviewLease: async () => current,
              isPreviewLeaseLive: isLive,
              ...(seam === "beforeCapabilityRemove"
                ? { onBeforeCapabilityRemove: closeGate }
                : { onBeforeClaimDelete: closeGate }),
            }),
          ),
        ),
      )

      expect(observed.second).toMatchObject({ _tag: "Left", left: { code: "visual_host_unavailable" } })
      expect({ seams, oldReachable: observed.oldReachable }).toEqual({ seams: 1, oldReachable: false })
      expect(observed.directoryExists).toBe(seam === "beforeCapabilityRemove")
      expect(observed.claims).toMatchObject([{ state: "releasing" }])
      expect(await VisualHostClaim.list(temp.path)).toEqual([])
    },
  )

  test("stops a same-layer stale active owner before starting its replacement attempt", async () => {
    await using temp = await taskTemp()
    await using workspaceTemp = await taskTemp()
    await fs.writeFile(path.join(workspaceTemp.path, "server.mjs"), "setInterval(() => undefined, 60_000)\n")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspaceTemp.path) }),
      preview: { kind: "script", argv: ["node", "server.mjs"] },
      allowedOrigins: [],
    })
    let current = { ...testPreviewLease(workflowID), leaseExpiresAt: 2_000_000_000_100 }
    const events: Array<{
      readonly operation: "start" | "stop"
      readonly attempt: number
      readonly owner: string
      readonly gated?: boolean
    }> = []
    const servers = new Map<
      ProcessOwnership.OwnedProcess,
      { readonly server: ReturnType<typeof Bun.serve>; readonly resolveExit: (exit: number) => void }
    >()
    const ownership: ProcessOwnership.Service = {
      available: true,
      start: async ({ identity }) => {
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ready") })
        let resolveExit!: (exit: number) => void
        const exited = new Promise<number>((resolve) => {
          resolveExit = resolve
        })
        const owned: ProcessOwnership.OwnedProcess = {
          origin: `http://127.0.0.1:${server.port}`,
          exited,
          stdout: new ReadableStream({ start: (controller) => controller.close() }),
          stderr: new ReadableStream({ start: (controller) => controller.close() }),
        }
        servers.set(owned, { server, resolveExit })
        events.push({ operation: "start", attempt: identity.attempt, owner: identity.leaseOwner })
        return owned
      },
      stop: async ({ identity, process, finalGate }) => {
        const gated = finalGate === undefined ? undefined : await finalGate()
        if (gated === false) throw new Error("lease became live")
        const server = servers.get(process)
        if (server === undefined) throw new Error("unknown process")
        server.server.stop(true)
        server.resolveExit(0)
        servers.delete(process)
        events.push({ operation: "stop", attempt: identity.attempt, owner: identity.leaseOwner, gated })
      },
      recover: async () => {
        throw new Error("active replacement must use the authenticated active handle")
      },
    }
    const contract: WorkflowVisualHost.ResolveImplementationContract = async () => ({
      implementationSha256,
      readySelector: "#ready",
      previewLease: current,
    })
    const isLive = async (lease: WorkflowVisualHost.PreviewLeaseAuthority) =>
      lease.workflowID === current.workflowID &&
      lease.stageID === current.stageID &&
      lease.attempt === current.attempt &&
      lease.leaseOwner === current.leaseOwner &&
      current.leaseExpiresAt >= Date.now()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          yield* host.prepareImplementation({ workflowID, revision: 1, plan })
          current = {
            ...current,
            attempt: 2,
            leaseOwner: "workflow-visual-host-replacement-owner",
            leaseExpiresAt: 2_000_000_000_200,
          }
          yield* host.prepareImplementation({ workflowID, revision: 1, plan })
          expect(events).toEqual([
            { operation: "start", attempt: 1, owner: "workflow-visual-host-test-owner" },
            { operation: "stop", attempt: 1, owner: "workflow-visual-host-test-owner", gated: true },
            { operation: "start", attempt: 2, owner: "workflow-visual-host-replacement-owner" },
          ])
          expect(servers.size).toBe(1)
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: temp.path,
            browser: browserRuntime().runtime,
            processOwnership: ownership,
            resolveImplementationContract: contract,
            resolvePreviewLease: async () => current,
            isPreviewLeaseLive: isLive,
          }),
        ),
      ),
    )

    expect(events.at(-1)).toEqual({
      operation: "stop",
      attempt: 2,
      owner: "workflow-visual-host-replacement-owner",
      gated: undefined,
    })
    expect(servers.size).toBe(0)
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
      ...testPreviewLease(workflowID),
      hostID: WorkflowVisualHost.HostID.make("a".repeat(64)),
      nonce: "b".repeat(64),
    }
    const { directory, runtimeTemp } = await claimedOrphan(temp.path, identity)
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
              isPreviewLeaseLive: async () => false,
              resolvePreviewLease: async (id) => testPreviewLease(id),
            }),
          ),
          Effect.scoped,
        ),
      )

      expect(ownership.recovered).toEqual([identity])
      expect(await fs.exists(directory)).toBe(false)
      await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow()
    } finally {
      await ownership.service.recover({ identity, finalGate: async () => true }).catch(() => undefined)
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
      ...testPreviewLease(workflowID),
      hostID: WorkflowVisualHost.HostID.make("c".repeat(64)),
      nonce: "d".repeat(64),
    }
    const { directory, runtimeTemp } = await claimedOrphan(temp.path, identity, {
      manifestNonce: "e".repeat(64),
    })
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
              isPreviewLeaseLive: async () => false,
              resolvePreviewLease: async (id) => testPreviewLease(id),
            }),
          ),
          Effect.scoped,
          Effect.match({
            onFailure: (error) => ({ error }),
            onSuccess: () => ({ success: true as const }),
          }),
        ),
      )

      expect(outcome).toMatchObject({ error: { operation: "recover_expired", code: "visual_host_unavailable" } })
      expect(ownership.recovered).toEqual([])
      expect(await fs.exists(directory)).toBe(true)
      expect(await fetch(`http://127.0.0.1:${port}`).then((response) => response.text())).toBe("owned-ready")
    } finally {
      await ownership.service.recover({ identity, finalGate: async () => true }).catch(() => undefined)
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

async function claimedOrphan(
  root: string,
  identity: ProcessOwnership.Identity,
  options: {
    readonly kind?: "static" | "script"
    readonly purpose?: VisualHostClaim.Purpose
    readonly revision?: number
    readonly writeManifest?: boolean
    readonly manifestNonce?: string
  } = {},
) {
  const kind = options.kind ?? "script"
  const purpose = options.purpose ?? "implementation"
  const revision = options.revision ?? 1
  const body = VisualHostClaim.make({
    purpose,
    kind,
    workflowID: identity.workflowID,
    stageID: identity.stageID,
    attempt: identity.attempt,
    leaseOwner: identity.leaseOwner,
    leaseExpiresAt: identity.leaseExpiresAt,
    hostID: identity.hostID,
    nonce: identity.nonce,
    createdAt: 10,
    revision,
    configurationSha256: "c".repeat(64),
    sourceSha256: "d".repeat(64),
  })
  const acquired = await VisualHostClaim.acquire(root, body)
  if (acquired.status !== "acquired") throw new TypeError("orphan claim did not acquire")
  const directory = path.join(root, identity.hostID)
  const runtimeTemp = path.join(directory, ".tmp")
  await fs.mkdir(runtimeTemp, { recursive: true })
  const manifest = {
    hostID: identity.hostID,
    createdAt: 10,
    kind,
    purpose,
    revision,
    configurationSha256: body.configurationSha256,
    sourceSha256: body.sourceSha256,
    claimKey: acquired.claim.key,
    claimGeneration: body.generation,
    claimSha256: acquired.claim.sha256,
    workflowID: identity.workflowID,
    stageID: identity.stageID,
    attempt: identity.attempt,
    leaseOwner: identity.leaseOwner,
    leaseExpiresAt: identity.leaseExpiresAt,
    nonce: options.manifestNonce ?? identity.nonce,
  }
  if (options.writeManifest !== false) {
    await fs.writeFile(path.join(directory, ".host.json"), JSON.stringify(manifest))
  }
  return { claim: acquired.claim, directory, runtimeTemp, manifest }
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

function rootIdentity(root: string) {
  const stat = fsSync.lstatSync(root, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
}

async function productionHostFixture() {
  const temp = await taskTemp()
  const deployment = path.join(temp.path, "deployment")
  const directories = {
    deployment,
    data: path.join(deployment, "data"),
    browserRuntime: path.join(deployment, "runtime", "playwright"),
    browserCache: path.join(deployment, "cache", "browser"),
    preview: path.join(deployment, "temp", "preview"),
    dockerConfig: path.join(deployment, "sandbox", "config"),
    dockerTemp: path.join(deployment, "sandbox", "temp"),
  }
  await Promise.all(Object.values(directories).map((directory) => fs.mkdir(directory, { recursive: true })))
  await fs.writeFile(path.join(deployment, "index.html"), '<!doctype html><div id="ready"></div>')
  const engine = path.join(temp.path, "docker.exe")
  await fs.writeFile(engine, "test docker engine")
  const environment = {
    OPENCODE_WORKFLOW_HOST_ROOT: deployment,
    OPENCODE_WORKFLOW_HOST_DATA: directories.data,
    OPENCODE_WORKFLOW_HOST_RUNTIME: directories.browserRuntime,
    OPENCODE_WORKFLOW_HOST_CACHE: directories.browserCache,
    OPENCODE_WORKFLOW_HOST_TEMP: directories.preview,
    OPENCODE_WORKFLOW_EVIDENCE_ROOT: directories.data,
    PLAYWRIGHT_BROWSERS_PATH: directories.browserRuntime,
    OPENCODE_WORKFLOW_SANDBOX_ENGINE: engine,
    OPENCODE_WORKFLOW_SANDBOX_IMAGE: `opencode/workflow-sandbox@sha256:${"a".repeat(64)}`,
    OPENCODE_WORKFLOW_SANDBOX_CONFIG: directories.dockerConfig,
    OPENCODE_WORKFLOW_SANDBOX_TEMP: directories.dockerTemp,
  } as const
  const sid = "S-1-5-21-1000-1000-1000-1001"
  const snapshot = {
    currentUserSid: sid,
    currentIdentitySids: [sid],
    ownerSid: sid,
    protected: true,
    reparsePoint: false,
    descriptorSddl: `O:${sid}G:${sid}D:P(A;;FA;;;${sid})(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)`,
    aces: [
      { sid, allow: true, inherited: false, mask: 0x001f01ff },
      { sid: "S-1-5-18", allow: true, inherited: false, mask: 0x001f01ff },
      { sid: "S-1-5-32-544", allow: true, inherited: false, mask: 0x001f01ff },
    ],
  }
  return {
    directories,
    environment,
    probe: () => structuredClone(snapshot),
    invalidateAcl: () => {
      snapshot.descriptorSddl = `${snapshot.descriptorSddl}-changed`
    },
    async [Symbol.asyncDispose]() {
      await temp[Symbol.asyncDispose]()
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
      return {
        origin: input.plan.allowedOrigins[0] ?? "http://127.0.0.1:4317",
        exited: subprocess.exited,
        stdout: subprocess.stdout,
        stderr: subprocess.stderr,
      }
    },
    async stop(input) {
      const owned = processes.get(key(input.identity))
      if (owned === undefined || owned.identity.nonce !== input.identity.nonce) throw new Error("unowned process")
      await stopTestProcess(owned.subprocess)
      processes.delete(key(input.identity))
      state.stopped.push(input.identity)
    },
    async recover(input) {
      if (!(await input.finalGate())) throw new Error("live process")
      const identity = input.identity
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
