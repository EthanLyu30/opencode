import { chromium, type Browser } from "playwright"
import readline from "node:readline"

const PROTOCOL_VERSION = 1
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
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

interface Request {
  readonly protocolVersion: 1
  readonly browserExecutablePath: string
  readonly tempRoot: string
  readonly url: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly readySelector: string
  readonly allowedOrigins: readonly string[]
  readonly timeoutMs: number
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const iterator = lines[Symbol.asyncIterator]()
const first = await iterator.next()
if (first.done || Buffer.byteLength(first.value) > MAX_REQUEST_BYTES) fail("invalid request frame")

const request = decodeRequest(first.value)
const controller = new AbortController()
let browser: Browser | undefined
let cancelling = false
let stage = "launch"
const cancel = () => {
  if (cancelling) return
  cancelling = true
  controller.abort(new Error("capture cancelled"))
  void browser?.close().catch(() => undefined)
}
lines.on("line", (line) => {
  if (line === '{"cancel":true}') cancel()
})
process.once("SIGINT", cancel)
process.once("SIGTERM", cancel)

try {
  const launch = chromium.launch({
    executablePath: request.browserExecutablePath,
    headless: true,
    downloadsPath: request.tempRoot,
    args: [...CHROMIUM_NETWORK_SUPPRESSION_ARGS],
  })
  browser = await bounded(launch, request.timeoutMs, controller.signal)
  stage = "context"
  const context = await bounded(
    browser.newContext({
      viewport: request.viewport,
      colorScheme: "light",
      reducedMotion: "reduce",
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
    }),
    request.timeoutMs,
    controller.signal,
  )
  try {
    stage = "route"
    await bounded(
      context.route("**/*", async (route) => {
        const requestURL = route.request().url()
        if (!isAdmittedRequest(requestURL, request.url, request.allowedOrigins)) {
          await route.abort()
          return
        }
        const response = await route.fetch({ maxRedirects: 0, timeout: request.timeoutMs })
        try {
          const location = responseHeader(response.headers(), "location")
          if (
            REDIRECT_STATUSES.has(response.status()) &&
            location !== undefined &&
            !isAdmittedRequest(new URL(location, requestURL).href, request.url, request.allowedOrigins)
          ) {
            await route.abort()
            return
          }
          await route.fulfill({ response })
        } finally {
          await response.dispose()
        }
      }),
      request.timeoutMs,
      controller.signal,
    )
    stage = "websocket-route"
    await bounded(
      context.routeWebSocket("**/*", async (route) => {
        if (isAdmittedWebSocket(route.url(), request.url, request.allowedOrigins)) {
          route.connectToServer()
          return
        }
        await route.close({ code: 1008, reason: "WebSocket origin is not admitted" })
      }),
      request.timeoutMs,
      controller.signal,
    )
    stage = "page"
    const page = await bounded(context.newPage(), request.timeoutMs, controller.signal)
    stage = "navigation"
    await bounded(
      page.goto(request.url, { waitUntil: "domcontentloaded", timeout: request.timeoutMs }),
      request.timeoutMs,
      controller.signal,
    )
    stage = "ready-selector"
    await bounded(
      page.waitForSelector(request.readySelector, { state: "visible", timeout: request.timeoutMs }),
      request.timeoutMs,
      controller.signal,
    )
    stage = "fonts"
    await bounded(
      page.evaluate(() => document.fonts.ready),
      request.timeoutMs,
      controller.signal,
    )
    stage = "animation-frames"
    await bounded(
      page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      ),
      request.timeoutMs,
      controller.signal,
    )
    stage = "screenshot"
    const screenshot = await bounded(
      page.screenshot({
        type: "png",
        fullPage: false,
        animations: "disabled",
        caret: "hide",
        scale: "css",
      }),
      request.timeoutMs,
      controller.signal,
    )
    if (screenshot.byteLength === 0 || screenshot.byteLength > MAX_IMAGE_BYTES)
      throw new Error("screenshot size is invalid")
    process.stdout.write(
      `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, pngBase64: Buffer.from(screenshot).toString("base64") })}\n`,
    )
  } finally {
    await closeBounded(() => context.close())
  }
} catch (cause) {
  process.stderr.write(`${stage}: ${failureMessage(cause)}\n`)
  process.exitCode = 1
} finally {
  lines.close()
  await closeBounded(() => browser?.close())
  process.stdin.destroy()
}

function decodeRequest(text: string): Request {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return fail("invalid request JSON")
  }
  if (!isRecord(value)) return fail("invalid request")
  exactKeys(value, [
    "allowedOrigins",
    "browserExecutablePath",
    "protocolVersion",
    "readySelector",
    "tempRoot",
    "timeoutMs",
    "url",
    "viewport",
  ])
  if (value.protocolVersion !== PROTOCOL_VERSION) return fail("unsupported protocol version")
  if (!isBoundedString(value.browserExecutablePath, 1, 4096) || !isBoundedString(value.tempRoot, 1, 4096)) {
    return fail("invalid runtime path")
  }
  if (!isLoopbackOriginURL(value.url)) return fail("invalid preview URL")
  if (!isBoundedString(value.readySelector, 1, 4096)) return fail("invalid ready selector")
  if (
    !Number.isSafeInteger(value.timeoutMs) ||
    (value.timeoutMs as number) < 1 ||
    (value.timeoutMs as number) > 120_000
  ) {
    return fail("invalid timeout")
  }
  if (!isRecord(value.viewport)) return fail("invalid viewport")
  exactKeys(value.viewport, ["height", "width"])
  if (!validDimension(value.viewport.width) || !validDimension(value.viewport.height)) return fail("invalid viewport")
  if (
    !Array.isArray(value.allowedOrigins) ||
    value.allowedOrigins.length > 32 ||
    value.allowedOrigins.some((origin) => !isLoopbackOrigin(origin)) ||
    new Set(value.allowedOrigins).size !== value.allowedOrigins.length
  ) {
    return fail("invalid allowed origins")
  }
  return value as unknown as Request
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail("unexpected request fields")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  )
}

function validDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 8192
}

function isLoopbackOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port !== "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === ""
    )
  } catch {
    return false
  }
}

function isLoopbackOriginURL(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port !== "" &&
      parsed.username === "" &&
      parsed.password === ""
    )
  } catch {
    return false
  }
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

function responseHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const expected = name.toLowerCase()
  return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1]
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
    const timer = setTimeout(() => finish(() => reject(new Error("browser operation timed out"))), timeoutMs)
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
      const timer = setTimeout(() => reject(new Error("browser cleanup timed out")), 5_000)
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
  } catch (cause) {
    if (process.exitCode !== 1) {
      process.stderr.write(`${failureMessage(cause)}\n`)
      process.exitCode = 1
    }
  }
}

function failureMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function fail(message: string): never {
  throw new TypeError(message)
}
