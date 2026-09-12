import axe from "axe-core"
import { chromium, type BrowserContext, type Page } from "playwright"
import fs from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"
import { publishPdfReport } from "../report/pdf"
import { decodeBrowserPdfRequestLine, isPdfRequestLine, type BrowserPdfRequest } from "../report/pdf-protocol"
import {
  BROWSER_PROTOCOL_VERSION,
  decodeBrowserRequestLine,
  isAdmittedPreviewRequest,
  type BrowserCaptureRequest,
  type FailedCapture,
} from "./browser-protocol"
import { publishCapture } from "./capture"

declare global {
  interface Window {
    axe: {
      run: (context: Document, options: object) => Promise<Record<string, unknown>>
    }
  }
}

const networkSuppression = Object.freeze([
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-features=AutofillServerCommunication,CertificateTransparencyComponentUpdater,MediaRouter,OptimizationHints,Translate",
  "--disable-sync",
  "--font-render-hinting=none",
  "--metrics-recording-only",
  "--no-default-browser-check",
  "--no-first-run",
  "--safebrowsing-disable-auto-update",
])

class HelperFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const grant = requiredEnvironment("TASK24_BROWSER_GRANT")
const outputRoot = requiredEnvironment("TASK24_BROWSER_OUTPUT_ROOT")
const browserExecutable = requiredEnvironment("TASK24_BROWSER_EXECUTABLE")
const tempRoot = requiredEnvironment("TEMP")
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const iterator = lines[Symbol.asyncIterator]()
const first = await iterator.next()
let disposition: FailedCapture["disposition"] = "unstarted"
let requestID = "0".repeat(32)
let context: BrowserContext | undefined
let profile: string | undefined
const abort = new AbortController()
let cancelling = false

const cancel = () => {
  if (cancelling) return
  cancelling = true
  abort.abort(new Error("capture canceled"))
  void context?.close().catch(() => undefined)
}
lines.on("line", (line) => {
  if (line === '{"cancel":true}') cancel()
})
process.once("SIGINT", cancel)
process.once("SIGTERM", cancel)

try {
  if (first.done) throw new HelperFailure("TASK24_BROWSER_REQUEST_INVALID", "request frame is missing")
  const request = isPdfRequestLine(first.value)
    ? decodeBrowserPdfRequestLine(first.value, grant)
    : decodeBrowserRequestLine(first.value, grant)
  requestID = request.requestID
  profile = path.join(tempRoot, `browser-profile-${request.requestID}`)
  await fs.mkdir(profile, { recursive: false })
  context = await bounded(
    chromium.launchPersistentContext(profile, {
      executablePath: browserExecutable,
      headless: true,
      viewport: request.operation === "report-pdf" ? { width: 1440, height: 900 } : request.viewport,
      deviceScaleFactor: request.operation === "report-pdf" ? 1 : request.viewport.deviceScaleFactor,
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "reduce",
      bypassCSP: true,
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
      downloadsPath: tempRoot,
      args: [...networkSuppression],
    }),
    request.timeoutMs,
    abort.signal,
  )
  if (request.operation === "report-pdf") {
    const pdf = await runPdf(context, request)
    const published = await publishPdfReport({
      outputRoot,
      reportID: request.reportID,
      pdf,
      evidenceHashes: request.evidenceHashes,
    })
    process.stdout.write(
      `${JSON.stringify({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        requestID: request.requestID,
        disposition: "published",
        ok: true,
        evidence: {
          pdfRootRelativePath: request.outputRelativePath,
          pdfSha256: published.sha256,
          evidenceSha256: published.evidenceSha256,
          pdfBytes: published.bytes,
        },
      })}\n`,
    )
  } else {
    const evidence = await runCapture(context, request)
    const published = await publishCapture({
      outputRoot,
      relative: request.outputRelativePath,
      screenshot: evidence.screenshot,
      evidence: {
        schemaVersion: 1,
        requestID: request.requestID,
        runID: request.runID,
        previewID: request.previewID,
        viewportID: request.viewportID,
        dom: evidence.dom,
        consoleErrors: evidence.consoleErrors,
        pageErrors: evidence.pageErrors,
        accessibility: evidence.accessibility,
        axe: evidence.axe,
      },
    })
    process.stdout.write(
      `${JSON.stringify({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        requestID: request.requestID,
        disposition: "published",
        ok: true,
        evidence: {
          captureRootRelativePath: request.outputRelativePath,
          screenshotSha256: published.screenshotSha256,
          evidenceSha256: published.evidenceSha256,
          screenshotBytes: published.screenshotBytes,
        },
      })}\n`,
    )
  }
} catch (cause) {
  const error = helperError(cause)
  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      requestID,
      disposition,
      ok: false,
      error,
    })}\n`,
  )
  process.exitCode = 1
} finally {
  lines.close()
  await closeBounded(() => context?.close())
  if (profile) await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined)
  process.stdin.destroy()
}

async function runCapture(current: BrowserContext, request: BrowserCaptureRequest) {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  let policyViolation: string | undefined
  await bounded(
    current.route("**/*", async (route) => {
      const url = route.request().url()
      if (!isAdmittedPreviewRequest(url, request.previewURL)) {
        if (route.request().resourceType() === "document") policyViolation = "navigation escaped the preview origin"
        await route.abort("blockedbyclient")
        return
      }
      const response = await route.fetch({ maxRedirects: 0, timeout: request.timeoutMs })
      try {
        const location = header(response.headers(), "location")
        if (
          new Set([301, 302, 303, 307, 308]).has(response.status()) &&
          location &&
          !isAdmittedPreviewRequest(new URL(location, url).href, request.previewURL)
        ) {
          policyViolation = "navigation escaped the preview origin"
          await route.abort("blockedbyclient")
          return
        }
        await route.fulfill({ response })
      } finally {
        await response.dispose()
      }
    }),
    request.timeoutMs,
    abort.signal,
  )
  await bounded(
    current.routeWebSocket("**/*", async (socket) => {
      const url = socket.url().replace(/^ws:/, "http:").replace(/^wss:/, "https:")
      if (isAdmittedPreviewRequest(url, request.previewURL)) {
        socket.connectToServer()
        return
      }
      policyViolation = "websocket escaped the preview origin"
      await socket.close({ code: 1008, reason: "origin not admitted" })
    }),
    request.timeoutMs,
    abort.signal,
  )
  const pages = current.pages()
  const page = pages[0] ?? (await bounded(current.newPage(), request.timeoutMs, abort.signal))
  for (const extra of pages.slice(1)) await closeBounded(() => extra.close())
  page.on("console", (message) => {
    if (message.type() === "error" && consoleErrors.length < 200) consoleErrors.push(safeText(message.text(), 2048))
  })
  page.on("pageerror", (error) => {
    if (pageErrors.length < 200) pageErrors.push(safeText(error.message, 2048))
  })
  page.on("popup", (popup) => {
    policyViolation = "popup creation is forbidden"
    void popup.close().catch(() => undefined)
  })
  page.on("download", (download) => {
    policyViolation = "downloads are forbidden"
    void download.cancel().catch(() => undefined)
  })
  page.on("framenavigated", (frame) => {
    if (
      frame === page.mainFrame() &&
      frame.url() !== "about:blank" &&
      !isAdmittedPreviewRequest(frame.url(), request.previewURL)
    ) {
      policyViolation = "navigation escaped the preview origin"
    }
  })

  disposition = "uncertain"
  await bounded(
    page.goto(request.previewURL, { waitUntil: "domcontentloaded", timeout: request.timeoutMs }),
    request.timeoutMs,
    abort.signal,
  )
  await bounded(
    page.waitForSelector(request.wait.selector, { state: "visible", timeout: request.timeoutMs }),
    request.timeoutMs,
    abort.signal,
  )
  await bounded(
    page.addStyleTag({
      content:
        "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
    }),
    request.timeoutMs,
    abort.signal,
  )
  await bounded(
    page.evaluate(() => document.fonts.ready),
    request.timeoutMs,
    abort.signal,
  )
  await twoFrames(page, request.timeoutMs)
  await runInteraction(page, request.interactionScriptID, request.timeoutMs)
  await twoFrames(page, request.timeoutMs)
  if (policyViolation) throw new HelperFailure("TASK24_BROWSER_POLICY_VIOLATION", policyViolation)
  const [dom, accessibility, axeResult, screenshot] = await Promise.all([
    collectDom(page, request.timeoutMs),
    collectAccessibility(current, page, request.timeoutMs),
    collectAxe(page, request.timeoutMs),
    bounded(
      page.screenshot({
        type: "png",
        fullPage: false,
        animations: "disabled",
        caret: "hide",
        scale: "css",
      }),
      request.timeoutMs,
      abort.signal,
    ),
  ])
  if (policyViolation) throw new HelperFailure("TASK24_BROWSER_POLICY_VIOLATION", policyViolation)
  return {
    screenshot: Uint8Array.from(screenshot),
    dom,
    accessibility,
    axe: axeResult,
    consoleErrors,
    pageErrors,
  }
}

async function runPdf(current: BrowserContext, request: BrowserPdfRequest): Promise<Uint8Array> {
  let policyViolation: string | undefined
  await bounded(
    current.route("**/*", async (route) => {
      const url = route.request().url()
      if (!isAdmittedPreviewRequest(url, request.reportURL)) {
        if (route.request().resourceType() === "document") policyViolation = "navigation escaped the report origin"
        await route.abort("blockedbyclient")
        return
      }
      const response = await route.fetch({ maxRedirects: 0, timeout: request.timeoutMs })
      try {
        const location = header(response.headers(), "location")
        if (
          new Set([301, 302, 303, 307, 308]).has(response.status()) &&
          location &&
          !isAdmittedPreviewRequest(new URL(location, url).href, request.reportURL)
        ) {
          policyViolation = "navigation escaped the report origin"
          await route.abort("blockedbyclient")
          return
        }
        await route.fulfill({ response })
      } finally {
        await response.dispose()
      }
    }),
    request.timeoutMs,
    abort.signal,
  )
  const pages = current.pages()
  const page = pages[0] ?? (await bounded(current.newPage(), request.timeoutMs, abort.signal))
  for (const extra of pages.slice(1)) await closeBounded(() => extra.close())
  page.on("popup", (popup) => {
    policyViolation = "popup creation is forbidden"
    void popup.close().catch(() => undefined)
  })
  page.on("download", (download) => {
    policyViolation = "downloads are forbidden"
    void download.cancel().catch(() => undefined)
  })
  page.on("framenavigated", (frame) => {
    if (
      frame === page.mainFrame() &&
      frame.url() !== "about:blank" &&
      !isAdmittedPreviewRequest(frame.url(), request.reportURL)
    ) {
      policyViolation = "navigation escaped the report origin"
    }
  })
  disposition = "uncertain"
  await bounded(
    page.goto(request.reportURL, { waitUntil: "domcontentloaded", timeout: request.timeoutMs }),
    request.timeoutMs,
    abort.signal,
  )
  await bounded(
    page.addStyleTag({
      content:
        "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
    }),
    request.timeoutMs,
    abort.signal,
  )
  await bounded(
    page.evaluate(() => document.fonts.ready),
    request.timeoutMs,
    abort.signal,
  )
  await bounded(
    page.emulateMedia({ media: "print", colorScheme: "light", reducedMotion: "reduce" }),
    request.timeoutMs,
    abort.signal,
  )
  await twoFrames(page, request.timeoutMs)
  if (policyViolation) throw new HelperFailure("TASK24_BROWSER_POLICY_VIOLATION", policyViolation)
  const pdf = await bounded(
    page.pdf({
      format: "A4",
      displayHeaderFooter: false,
      printBackground: true,
      preferCSSPageSize: true,
      tagged: true,
      outline: true,
    }),
    request.timeoutMs,
    abort.signal,
  )
  if (policyViolation) throw new HelperFailure("TASK24_BROWSER_POLICY_VIOLATION", policyViolation)
  return Uint8Array.from(pdf)
}

async function runInteraction(page: Page, id: BrowserCaptureRequest["interactionScriptID"], timeoutMs: number) {
  if (id === "none") return
  const selector = id === "primary-click" ? '[data-task24-interaction="primary"]' : '[data-task24-interaction="menu"]'
  await bounded(page.locator(selector).click({ timeout: timeoutMs }), timeoutMs, abort.signal)
}

async function collectDom(page: Page, timeoutMs: number): Promise<readonly unknown[]> {
  return bounded(
    page.evaluate(() => {
      const styleNames = [
        "background-color",
        "border-radius",
        "color",
        "display",
        "font-family",
        "font-size",
        "font-weight",
        "gap",
        "line-height",
        "opacity",
        "padding-bottom",
        "padding-left",
        "padding-right",
        "padding-top",
        "position",
      ]
      return [...document.querySelectorAll("body,[data-task24-evaluate]")].slice(0, 2_000).map((element, index) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          index,
          tag: element.tagName.toLowerCase(),
          id: element.id.slice(0, 256),
          role: element.getAttribute("role")?.slice(0, 128) ?? null,
          testID: element.getAttribute("data-task24-evaluate")?.slice(0, 256) ?? null,
          box: {
            x: Math.round(rect.x * 1_000) / 1_000,
            y: Math.round(rect.y * 1_000) / 1_000,
            width: Math.round(rect.width * 1_000) / 1_000,
            height: Math.round(rect.height * 1_000) / 1_000,
          },
          style: Object.fromEntries(styleNames.map((name) => [name, style.getPropertyValue(name)])),
        }
      })
    }),
    timeoutMs,
    abort.signal,
  )
}

async function collectAccessibility(context: BrowserContext, page: Page, timeoutMs: number) {
  const session = await bounded(context.newCDPSession(page), timeoutMs, abort.signal)
  try {
    const tree = await bounded(session.send("Accessibility.getFullAXTree"), timeoutMs, abort.signal)
    return tree.nodes.slice(0, 5_000).map((node, index) => ({
      index,
      ignored: node.ignored,
      role: node.role?.value ?? null,
      name: node.name?.value ?? null,
      description: node.description?.value ?? null,
      childCount: node.childIds?.length ?? 0,
    }))
  } finally {
    await closeBounded(() => session.detach())
  }
}

async function collectAxe(page: Page, timeoutMs: number) {
  await bounded(page.addScriptTag({ content: axe.source }), timeoutMs, abort.signal)
  return bounded(
    page.evaluate(async () => {
      const result = await window.axe.run(document, {
        resultTypes: ["violations", "incomplete", "passes", "inapplicable"],
      })
      return {
        violations: result.violations,
        incomplete: result.incomplete,
        passes: result.passes,
        inapplicable: result.inapplicable,
      }
    }),
    timeoutMs,
    abort.signal,
  )
}

async function twoFrames(page: Page, timeoutMs: number) {
  await bounded(
    page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    ),
    timeoutMs,
    abort.signal,
  )
}

function bounded<A>(work: PromiseLike<A>, timeoutMs: number, signal: AbortSignal): Promise<A> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const finish = (callback: () => void) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(signal.reason))
    const timer = setTimeout(
      () => finish(() => reject(new HelperFailure("TASK24_BROWSER_TIMEOUT", "operation timed out"))),
      timeoutMs,
    )
    signal.addEventListener("abort", onAbort, { once: true })
    void Promise.resolve(work).then(
      (result) => finish(() => resolve(result)),
      (cause) => finish(() => reject(cause)),
    )
  })
}

async function closeBounded(close: () => Promise<unknown> | undefined) {
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cleanup timed out")), 5_000)
      void Promise.resolve(close()).then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (cause) => {
          clearTimeout(timer)
          reject(cause)
        },
      )
    })
  } catch {
    // The parent owns final process-tree termination.
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value || /[\u0000-\u001f\u007f]/u.test(value))
    throw new HelperFailure("TASK24_BROWSER_ENV_INVALID", `${name} is missing`)
  return value
}

function helperError(cause: unknown): { readonly code: string; readonly message: string } {
  if (cause instanceof HelperFailure) return { code: cause.code, message: safeText(cause.message, 2048) }
  return {
    code: "TASK24_BROWSER_HELPER_FAILED",
    message: safeText(cause instanceof Error ? cause.message : "capture failed", 2048),
  }
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
}

function safeText(value: string, maximum: number): string {
  const redacted = value
    .replace(/[A-Za-z0-9_-]{43}/g, "[REDACTED]")
    .replace(/[a-f0-9]{64}/g, "[ID]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, maximum)
  return redacted || "browser helper failed"
}
