export * as PlaywrightCapture from "./playwright"

import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

export interface LaunchOptions {
  readonly headless: true
  readonly downloadsPath: string
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

export interface Route {
  readonly request: () => Request
  readonly continue: () => Promise<void>
  readonly abort: () => Promise<void>
}

export type RouteHandler = (route: Route) => Promise<void>

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
      const current = await (browser ??= input.browserType.launch({ headless: true, downloadsPath: tempRoot }))
      const context = await current.newContext({
        viewport: { width: capture.viewport.width, height: capture.viewport.height },
        colorScheme: "light",
        reducedMotion: "reduce",
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
      })
      try {
        await context.route("**/*", async (route) => {
          if (isAdmittedRequest(route.request().url(), capture.url, capture.allowedOrigins)) {
            await route.continue()
            return
          }
          await route.abort()
        })
        const page = await context.newPage()
        await page.goto(capture.url, { waitUntil: "domcontentloaded", timeout: timeoutMs })
        await page.waitForSelector(capture.readySelector, { state: "visible", timeout: timeoutMs })
        await page.evaluate(() => document.fonts.ready)
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        )
        return await page.screenshot({
          type: "png",
          fullPage: false,
          animations: "disabled",
          caret: "hide",
          scale: "css",
        })
      } finally {
        await context.close()
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
                    continue: () => route.continue(),
                    abort: () => route.abort(),
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
