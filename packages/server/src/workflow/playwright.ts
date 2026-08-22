export * as PlaywrightCapture from "./playwright"

import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

export interface LaunchOptions {
  readonly headless: true
  readonly downloadsPath: string
  readonly args: string[]
}

export interface ContextOptions {
  readonly viewport: { readonly width: number; readonly height: number }
  readonly colorScheme: "light"
  readonly reducedMotion: "reduce"
  readonly acceptDownloads: false
  readonly serviceWorkers: "block"
  readonly permissions: readonly []
}

export interface ScreenshotOptions {
  readonly type: "png"
  readonly fullPage: false
  readonly animations: "disabled"
  readonly caret: "hide"
  readonly scale: "css"
}

export interface Request {
  readonly url: () => string
}

export interface Response {
  readonly status: () => number
  readonly headers: () => Readonly<Record<string, string>>
  readonly fulfill: () => Promise<void>
  readonly dispose: () => Promise<void>
}

export interface Route {
  readonly request: () => Request
  readonly fetch: (options: { readonly maxRedirects: 0; readonly timeout: number }) => Promise<Response>
  readonly abort: () => Promise<void>
}

export type RouteHandler = (route: Route) => Promise<void>

export interface WebSocketRoute {
  readonly url: () => string
  readonly connectToServer: () => void
  readonly close: (options: { readonly code: 1008; readonly reason: string }) => Promise<void>
}

export type WebSocketRouteHandler = (route: WebSocketRoute) => Promise<void>

export interface Page {
  readonly goto: (
    url: string,
    options: { readonly waitUntil: "domcontentloaded"; readonly timeout: number },
  ) => Promise<unknown>
  readonly waitForSelector: (
    selector: string,
    options: { readonly state: "visible"; readonly timeout: number },
  ) => Promise<unknown>
  readonly evaluate: (callback: () => unknown) => Promise<unknown>
  readonly screenshot: (options: ScreenshotOptions) => Promise<Uint8Array>
}

export interface BrowserContext {
  readonly route: (pattern: "**/*", handler: RouteHandler) => Promise<void>
  readonly routeWebSocket: (pattern: "**/*", handler: WebSocketRouteHandler) => Promise<void>
  readonly newPage: () => Promise<Page>
  readonly close: () => Promise<void>
}

export interface Browser {
  readonly newContext: (options: ContextOptions) => Promise<BrowserContext>
  readonly close: () => Promise<void>
}

export interface BrowserType {
  readonly launch: (options: LaunchOptions) => Promise<Browser>
}

export interface CaptureInput {
  readonly url: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly readySelector: string
  readonly allowedOrigins: readonly string[]
  readonly signal: AbortSignal
}

export interface Runtime {
  readonly capture: (input: CaptureInput) => Promise<Uint8Array>
  readonly close: () => Promise<void>
}

export function makeRuntime(input: {
  readonly browserType: BrowserType
  readonly tempRoot: string
  readonly timeoutMs?: number
}): Runtime {
  const tempRoot = requireDirectory(input.tempRoot)
  const timeoutMs = input.timeoutMs ?? 15_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("Playwright timeout must be positive")
  let browser: Promise<Browser> | undefined
  let closed = false

  return {
    capture: async (capture) => {
      if (closed) throw new Error("Playwright runtime is closed")
      const current = await runAbortable(
        (browser ??= input.browserType.launch({
          headless: true,
          downloadsPath: tempRoot,
          args: [...CHROMIUM_NETWORK_SUPPRESSION_ARGS],
        })),
        capture.signal,
        timeoutMs,
      )
      const contextPromise = current.newContext({
        viewport: { width: capture.viewport.width, height: capture.viewport.height },
        colorScheme: "light",
        reducedMotion: "reduce",
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
      })
      const context = await runAbortable(contextPromise, capture.signal, timeoutMs).catch((cause) => {
        void contextPromise.then(
          (value) => settleWithin(value.close(), timeoutMs),
          () => undefined,
        )
        throw cause
      })
      try {
        await runAbortable(
          context.route("**/*", async (route) => {
            const requestURL = route.request().url()
            if (!isAdmittedRequest(requestURL, capture.url, capture.allowedOrigins)) {
              await route.abort()
              return
            }
            const response = await route.fetch({ maxRedirects: 0, timeout: timeoutMs })
            try {
              const location = responseHeader(response.headers(), "location")
              if (
                REDIRECT_STATUSES.has(response.status()) &&
                location !== undefined &&
                !isAdmittedRequest(new URL(location, requestURL).href, capture.url, capture.allowedOrigins)
              ) {
                await route.abort()
                return
              }
              await response.fulfill()
            } finally {
              await response.dispose()
            }
          }),
          capture.signal,
          timeoutMs,
        )
        await runAbortable(
          context.routeWebSocket("**/*", async (route) => {
            if (isAdmittedWebSocket(route.url(), capture.url, capture.allowedOrigins)) {
              route.connectToServer()
              return
            }
            await route.close({ code: 1008, reason: "WebSocket origin is not admitted" })
          }),
          capture.signal,
          timeoutMs,
        )
        const page = await runAbortable(context.newPage(), capture.signal, timeoutMs)
        await runAbortable(
          page.goto(capture.url, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
          capture.signal,
          timeoutMs,
        )
        await runAbortable(
          page.waitForSelector(capture.readySelector, { state: "visible", timeout: timeoutMs }),
          capture.signal,
          timeoutMs,
        )
        await runAbortable(
          page.evaluate(() => document.fonts.ready),
          capture.signal,
          timeoutMs,
        )
        await runAbortable(
          page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
          ),
          capture.signal,
          timeoutMs,
        )
        return await runAbortable(
          page.screenshot({
            type: "png",
            fullPage: false,
            animations: "disabled",
            caret: "hide",
            scale: "css",
          }),
          capture.signal,
          timeoutMs,
        )
      } finally {
        await settleWithin(context.close(), timeoutMs)
      }
    },
    close: async () => {
      if (closed) return
      closed = true
      await browser?.then(
        (value) => value.close(),
        () => undefined,
      )
    },
  }
}

function runAbortable<A>(work: PromiseLike<A>, signal: AbortSignal, timeoutMs: number): Promise<A> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const finish = (callback: () => void) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(signal.reason))
    const timer = setTimeout(() => finish(() => reject(new Error("Playwright operation timed out"))), timeoutMs)
    signal.addEventListener("abort", onAbort, { once: true })
    void Promise.resolve(work).then(
      (value) => finish(() => resolve(value)),
      (cause) => finish(() => reject(cause)),
    )
  })
}

function settleWithin(work: PromiseLike<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    void Promise.resolve(work).then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      },
    )
  })
}

export function productionRuntime(input: { readonly tempRoot: string; readonly timeoutMs?: number }): Runtime {
  requireDirectory(requireBrowserRoot())
  return makeRuntime({
    tempRoot: input.tempRoot,
    timeoutMs: input.timeoutMs,
    browserType: {
      launch: async (options) => {
        const browser = await chromium.launch(options)
        return {
          newContext: async (contextOptions) => {
            const context = await browser.newContext({
              ...contextOptions,
              permissions: [...contextOptions.permissions],
            })
            return {
              route: async (pattern, handler) => {
                await context.route(pattern, (route) =>
                  handler({
                    request: () => ({ url: () => route.request().url() }),
                    fetch: async (fetchOptions) => {
                      const response = await route.fetch(fetchOptions)
                      return {
                        status: () => response.status(),
                        headers: () => response.headers(),
                        fulfill: () => route.fulfill({ response }),
                        dispose: () => response.dispose(),
                      }
                    },
                    abort: () => route.abort(),
                  }),
                )
              },
              routeWebSocket: async (pattern, handler) => {
                await context.routeWebSocket(pattern, (route) =>
                  handler({
                    url: () => route.url(),
                    connectToServer: () => {
                      route.connectToServer()
                    },
                    close: (closeOptions) => route.close(closeOptions),
                  }),
                )
              },
              newPage: async () => {
                const page = await context.newPage()
                return {
                  goto: (url, gotoOptions) => page.goto(url, gotoOptions),
                  waitForSelector: (selector, selectorOptions) => page.waitForSelector(selector, selectorOptions),
                  evaluate: (callback) => page.evaluate(callback),
                  screenshot: async (screenshotOptions) => Uint8Array.from(await page.screenshot(screenshotOptions)),
                }
              },
              close: () => context.close(),
            }
          },
          close: () => browser.close(),
        }
      },
    },
  })
}

const CHROMIUM_NETWORK_SUPPRESSION_ARGS = Object.freeze([
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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function responseHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const expected = name.toLowerCase()
  return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1]
}

function isAdmittedWebSocket(url: string, previewURL: string, allowedOrigins: readonly string[]): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "ws:") return false
    parsed.protocol = "http:"
    return isAdmittedRequest(parsed.href, previewURL, allowedOrigins)
  } catch {
    return false
  }
}

function isAdmittedRequest(url: string, previewURL: string, allowedOrigins: readonly string[]): boolean {
  try {
    const parsed = new URL(url)
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.port === "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return false
    }
    const preview = new URL(previewURL)
    return parsed.origin === preview.origin || allowedOrigins.includes(parsed.origin)
  } catch {
    return false
  }
}

function requireBrowserRoot(): string {
  const value = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (value === undefined || !path.isAbsolute(value)) {
    throw new TypeError("PLAYWRIGHT_BROWSERS_PATH must be an absolute managed browser root")
  }
  return value
}

function requireDirectory(value: string): string {
  if (!path.isAbsolute(value)) throw new TypeError("Playwright runtime paths must be absolute")
  fs.mkdirSync(value, { recursive: true })
  const canonical = fs.realpathSync.native(value)
  if (!fs.statSync(canonical).isDirectory()) throw new TypeError("Playwright runtime path is not a directory")
  return canonical
}
