import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { WorkflowSchema } from "@opencode-ai/core/workflow"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { PlaywrightCapture } from "../src/workflow/playwright"
import { WorkflowVisualHostServer } from "../src/workflow/visual-host"

const suiteRoot = path.join(
  "D:\\OpenCode-Local\\tmp\\workflow-host\\acceptance",
  `server-security-${crypto.randomUUID()}`,
)
const workflowID = WorkflowSchema.ID.make("wfl_visual_security_acceptance")
const stageID = WorkflowSchema.StageID.make("wfs_visual_security_acceptance")
const previewLease = (id: WorkflowSchema.ID): WorkflowVisualHost.PreviewLeaseAuthority => ({
  workflowID: id,
  stageID,
  attempt: 1,
  leaseOwner: "visual-security-owner",
  leaseExpiresAt: 2_000_000_000_000,
})

afterAll(async () => {
  const canonicalParent = await fs.realpath(path.dirname(suiteRoot)).catch(() => undefined)
  const canonical = await fs.realpath(suiteRoot).catch(() => undefined)
  if (canonical !== undefined && canonicalParent !== undefined && path.dirname(canonical) === canonicalParent) {
    await fs.rm(canonical, { recursive: true, force: true })
  }
})

describe("production visual-host security acceptance", () => {
  test("rejects hostile reference paths and keeps every request inside its exact capability", async () => {
    await using testCase = await caseRoot("paths")
    const invalidFiles = [
      [{ path: "D:/absolute.html", content: "absolute" }],
      [{ path: "../escape.html", content: "traversal" }],
      [{ path: "assets\\escape.js", content: "backslash" }],
      [{ path: "%2e%2e/escape.js", content: "encoded" }],
      [{ path: "CON", content: "device" }],
      [
        { path: "index.html", content: "lower" },
        { path: "INDEX.HTML", content: "case-alias" },
      ],
      [
        { path: "assets", content: "file" },
        { path: "assets/app.js", content: "child" },
      ],
    ] as const

    for (const [index, files] of invalidFiles.entries()) {
      const hostRoot = path.join(testCase.path, `invalid-${index}`)
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(WorkflowVisualHost.Service, (host) =>
            host.materializeReference({
              workflowID,
              referenceApp: {
                entrypoint: files[0]!.path,
                readySelector: "#ready",
                projectStack: ["HTML"],
                files: [...files],
              },
            }),
          ),
        ).pipe(
          Effect.provide(
            WorkflowVisualHostServer.makeLayer({
              hostRoot,
              browser: unusedBrowser(),
              resolvePreviewLease: async (id) => previewLease(id),
              isPreviewLeaseLive: async () => true,
            }),
          ),
          Effect.exit,
        ),
      )
      expect(result._tag).toBe("Failure")
      expect(
        (await fs.readdir(hostRoot, { withFileTypes: true })).filter(
          (entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name),
        ),
      ).toEqual([])
    }

    const marker = path.join(testCase.path, "outside-marker.txt")
    await fs.writeFile(marker, "preserve")
    const statuses = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: '<!doctype html><main id="ready">safe</main>' }],
            },
          })
          const base = `${preview.origin}/${preview.hostID}`
          const attacks = [
            `${preview.origin}/absolute.txt`,
            `${base}/../outside-marker.txt`,
            `${base}/%2e%2e/outside-marker.txt`,
            `${base}/..%5coutside-marker.txt`,
            `${base}/CON`,
            `${base}/con`,
            `${base}/index.html/child`,
          ]
          return yield* Effect.promise(() =>
            Promise.all(attacks.map((url) => fetch(url, { redirect: "manual" }).then((response) => response.status))),
          )
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: path.join(testCase.path, "valid-host"),
            browser: unusedBrowser(),
            resolvePreviewLease: async (id) => previewLease(id),
            isPreviewLeaseLive: async () => true,
          }),
        ),
      ),
    )

    expect(statuses.every((status) => status === 404)).toBe(true)
    expect(await fs.readFile(marker, "utf8")).toBe("preserve")
  })

  test("locks each fake browser context to one ephemeral loopback origin and closes it exactly once", async () => {
    await using testCase = await caseRoot("browser")
    const port = await unusedPort()
    const origin = `http://127.0.0.1:${port}`
    const runtime = browserRuntime(path.join(testCase.path, "browser"))
    const allowed = `${origin}/asset.js`
    const redirect = `${origin}/redirect`
    const hostile = [
      "https://example.invalid/tracker.js",
      "file:///D:/secret.txt",
      "data:text/plain,secret",
      "blob:https://example.invalid/id",
      "ftp://example.invalid/file",
      `http://localhost:${port}/alias`,
      `http://[::1]:${port}/ipv6`,
      `http://user:pass@127.0.0.1:${port}/userinfo`,
    ]
    runtime.requestURLs.push(allowed, redirect, ...hostile)
    runtime.responses.set(redirect, { status: 302, headers: { location: "https://example.invalid/escape" } })
    runtime.webSocketURLs.push(`ws://127.0.0.1:${port}/hmr`, `ws://localhost:${port}/hmr`, "wss://example.invalid/ws")

    const capture = {
      url: `${origin}/`,
      viewport: { width: 390, height: 844 },
      readySelector: "#ready",
      allowedOrigins: [],
      signal: new AbortController().signal,
    } as const
    await runtime.runtime.capture(capture)
    await runtime.runtime.capture(capture)
    await runtime.runtime.close()
    await runtime.runtime.close()

    expect(runtime.fetches).toEqual([
      { url: allowed, maxRedirects: 0 },
      { url: redirect, maxRedirects: 0 },
      { url: allowed, maxRedirects: 0 },
      { url: redirect, maxRedirects: 0 },
    ])
    expect(runtime.fulfilled).toEqual([allowed, allowed])
    expect(runtime.aborted).toEqual([redirect, ...hostile, redirect, ...hostile])
    expect(runtime.webSocketsConnected).toEqual([`ws://127.0.0.1:${port}/hmr`, `ws://127.0.0.1:${port}/hmr`])
    expect(runtime.webSocketsClosed).toEqual([
      `ws://localhost:${port}/hmr`,
      "wss://example.invalid/ws",
      `ws://localhost:${port}/hmr`,
      "wss://example.invalid/ws",
    ])
    expect(runtime.contextOptions).toEqual([
      {
        viewport: capture.viewport,
        colorScheme: "light",
        reducedMotion: "reduce",
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
      },
      {
        viewport: capture.viewport,
        colorScheme: "light",
        reducedMotion: "reduce",
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
      },
    ])
    expect(runtime.contextsCreated).toBe(2)
    expect(runtime.contextsClosed).toBe(2)
    expect(runtime.browserClosed).toBe(1)
  })
})

function browserRuntime(tempRoot: string) {
  const state = {
    requestURLs: [] as string[],
    responses: new Map<string, { readonly status: number; readonly headers: Readonly<Record<string, string>> }>(),
    webSocketURLs: [] as string[],
    fetches: [] as { readonly url: string; readonly maxRedirects: number }[],
    fulfilled: [] as string[],
    aborted: [] as string[],
    webSocketsConnected: [] as string[],
    webSocketsClosed: [] as string[],
    contextOptions: [] as PlaywrightCapture.ContextOptions[],
    contextsCreated: 0,
    contextsClosed: 0,
    browserClosed: 0,
  }
  const browserType: PlaywrightCapture.BrowserType = {
    launch: async () => ({
      newContext: async (options) => {
        state.contextOptions.push(options)
        state.contextsCreated++
        let routeHandler: PlaywrightCapture.RouteHandler | undefined
        let webSocketHandler: PlaywrightCapture.WebSocketRouteHandler | undefined
        return {
          route: async (_pattern, handler) => {
            routeHandler = handler
          },
          routeWebSocket: async (_pattern, handler) => {
            webSocketHandler = handler
          },
          newPage: async () => ({
            goto: async () => {
              if (routeHandler === undefined || webSocketHandler === undefined) throw new Error("Route policy missing")
              for (const url of state.requestURLs) {
                const configured = state.responses.get(url) ?? { status: 200, headers: {} }
                await routeHandler({
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
                })
              }
              for (const url of state.webSocketURLs) {
                await webSocketHandler({
                  url: () => url,
                  connectToServer: () => {
                    state.webSocketsConnected.push(url)
                  },
                  close: async () => {
                    state.webSocketsClosed.push(url)
                  },
                })
              }
            },
            waitForSelector: async () => undefined,
            evaluate: async () => undefined,
            screenshot: async () => new Uint8Array([1, 2, 3]),
          }),
          close: async () => {
            state.contextsClosed++
          },
        }
      },
      close: async () => {
        state.browserClosed++
      },
    }),
  }
  return Object.assign(state, { runtime: PlaywrightCapture.makeRuntime({ browserType, tempRoot }) })
}

function unusedBrowser(): PlaywrightCapture.Runtime {
  return {
    capture: async () => {
      throw new Error("Browser capture was not admitted")
    },
    close: async () => undefined,
  }
}

async function caseRoot(name: string) {
  await fs.mkdir(suiteRoot, { recursive: true })
  const directory = await fs.realpath(await fs.mkdtemp(path.join(suiteRoot, `${name}-`)))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      const canonicalSuite = await fs.realpath(suiteRoot)
      const canonical = await fs.realpath(directory)
      if (path.dirname(canonical) !== canonicalSuite) throw new Error("Refusing to clean a foreign test root")
      await fs.rm(canonical, { recursive: true, force: true })
    },
  }
}

async function unusedPort(): Promise<number> {
  using server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  if (server.port === undefined) throw new Error("Bun did not allocate an ephemeral port")
  return server.port
}
