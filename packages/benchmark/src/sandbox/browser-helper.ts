import axe from "axe-core"
import { chromium, type Page, type BrowserContext } from "playwright"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Bytes } from "../hash"
import { FIXED_VIEWPORTS, type BrowserCaptureRequest } from "../evaluator/browser-protocol"
import { directRoot } from "../corpus/direct-root"
import {
  isAdmittedLinuxBrowserURL,
  validateBrowserProbe,
  validateBrowserAdmission,
  dataFrameWasBlocked,
  enforcedDataFrameViolation,
} from "./browser-contracts"
import type { ProbeRequest } from "../evaluator/independent/host"
import { decodeEvaluationIdentity } from "../corpus/evaluation-profile"
const abort = new AbortController()
let phase = "input"
export function browserHelperFailurePhase() {
  return phase
}
class HelperFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
const Request = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  operation: Schema.Literals(["capture", "probe", "admission"]),
  identity: Schema.Unknown,
  base: Schema.String,
  previewID: Schema.String,
  paths: Schema.Array(Schema.String),
  browser: Schema.String,
  temp: Schema.String,
  evidence: Schema.String,
  plans: Schema.Array(Schema.Unknown),
  data: Schema.Unknown,
})
export function browserLaunchPolicy(browser?: string) {
  return {
    chromiumSandbox: true,
    args: [
      ...(browser ? ["--browser-subprocess-path=" + browser] : []),
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--font-render-hinting=none",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  }
}
export async function browserHelperMain() {
  let size = 0
  const chunks: Buffer[] = []
  for await (const part of process.stdin) {
    const b = Buffer.from(part)
    size += b.length
    if (size > 2097152) throw Error("size")
    chunks.push(b)
  }
  const request = Schema.decodeUnknownSync(Request)(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
    onExcessProperty: "error",
  })
  const identity = decodeEvaluationIdentity(request.identity)
  const admission = request.operation === "admission" ? validateBrowserAdmission(request.data) : undefined
  if (
    !/^[a-f0-9]{64}$/.test(request.previewID) ||
    (!request.base.includes("/" + request.previewID + "/") &&
      !/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/$/.test(request.base))
  )
    throw Error("preview")
  await directRoot(request.temp)
  await directRoot(request.evidence)
  const profile = path.join(request.temp, "browser-" + crypto.randomUUID())
  await fs.mkdir(profile)
  phase = "launch"
  const context = await chromium.launchPersistentContext(profile, {
    ...browserLaunchPolicy(request.browser),
    executablePath: request.browser,
    headless: true,
    viewport:
      request.operation === "capture"
        ? FIXED_VIEWPORTS[(request.data as BrowserCaptureRequest).viewportID]
        : FIXED_VIEWPORTS.desktop,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    acceptDownloads: false,
    serviceWorkers: "block",
    permissions: [],
  })
  const timer = setTimeout(() => {
    abort.abort()
    void context.close()
  }, 29000)
  try {
    phase = "route"
    let blocked = 0
    let deniedCanaryAttempts = 0
    await context.route("**/*", async (route) => {
      if (!isAdmittedLinuxBrowserURL(route.request().url(), request.base, request.paths)) {
        blocked++
        if (admission && route.request().url() === admission.canaryURL) deniedCanaryAttempts++
        await route.abort("blockedbyclient")
        return
      }
      const response = await route.fetch({ maxRedirects: 0, timeout: 10000 })
      try {
        if (response.status() >= 300 && response.status() < 400) {
          const location = response.headers()["location"]
          if (
            !location ||
            !isAdmittedLinuxBrowserURL(new URL(location, route.request().url()).href, request.base, request.paths)
          ) {
            blocked++
            await route.abort("blockedbyclient")
            return
          }
        }
        await route.fulfill({ response })
      } finally {
        await response.dispose()
      }
    })
    await context.routeWebSocket("**/*", async (socket) => {
      blocked++
      if (admission && socket.url() === admission.canaryURL.replace("http:", "ws:")) deniedCanaryAttempts++
      await socket.close({ code: 1008, reason: "WebSocket not admitted" })
    })
    const page = context.pages()[0] ?? (await context.newPage()),
      consoleErrors: string[] = [],
      pageErrors: string[] = []
    page.on("popup", (popup) => {
      blocked++
      void popup.close()
    })
    page.on("download", (download) => {
      blocked++
      void download.cancel()
    })
    page.on("console", (m) => {
      if (m.type() === "error" && consoleErrors.length < 200) consoleErrors.push(m.text().slice(0, 512))
    })
    page.on("pageerror", (e) => {
      if (pageErrors.length < 200) pageErrors.push(e.message.slice(0, 512))
    })
    page.on("framenavigated", (frame) => {
      if (frame.url() !== "about:blank" && !isAdmittedLinuxBrowserURL(frame.url(), request.base, request.paths)) {
        blocked++
        if (frame === page.mainFrame()) {
          void page.close()
          return
        }
        // A rejected child navigation must not destroy the parent's independent
        // admission observations (notably the browser-generated CSP event).
        void frame
          .frameElement()
          .then((element) => element.evaluate((node) => node.parentNode?.removeChild(node)))
          .catch(() => {})
      }
    })
    let result: unknown
    const captures = request.data as BrowserCaptureRequest
    const previewURL =
      request.operation === "capture"
        ? captures.previewURL
        : request.base + request.paths.find((p) => p.endsWith(".html"))?.slice(1)
    if (!previewURL || !isAdmittedLinuxBrowserURL(previewURL, request.base, request.paths)) throw Error("url")
    phase = "navigate"
    await page.goto(previewURL, { waitUntil: "load", timeout: 15000 })
    await page.waitForSelector("body", { state: "visible", timeout: 10000 })
    await page.evaluate(() => document.fonts.ready)
    await twoFrames(page, 10000)
    if (request.operation === "admission") {
      const input = validateBrowserAdmission(request.data),
        cross = new URL(request.base)
      cross.pathname = "/" + "0".repeat(64) + "/index.html"
      const networkBlocked = await page.evaluate(async (url) => {
        try {
          await fetch(url)
          return false
        } catch {
          return true
        }
      }, input.canaryURL)
      const crossCapabilityBlocked = await page.evaluate(async (url) => {
        try {
          await fetch(url)
          return false
        } catch {
          return true
        }
      }, cross.href)
      const websocketBlocked = await page.evaluate(
        (url) =>
          new Promise<boolean>((resolve) => {
            const socket = new WebSocket(url.replace("http:", "ws:"))
            const timer = setTimeout(() => {
              socket.close()
              resolve(false)
            }, 1500)
            socket.onopen = () => {
              clearTimeout(timer)
              socket.close()
              resolve(false)
            }
            socket.onerror = socket.onclose = () => {
              clearTimeout(timer)
              resolve(true)
            }
          }),
        input.canaryURL,
      )
      // These attempts originate in page script, as candidate attacks do; the controller never navigates to host files.
      const fileBlocked = await page
        .evaluate(
          (url) =>
            new Promise<boolean>((resolve) => {
              const f = document.createElement("iframe")
              const timer = setTimeout(() => {
                let blocked = true
                try {
                  blocked = !f.contentDocument || f.contentWindow?.location.href === "about:blank"
                } catch {}
                f.remove()
                resolve(blocked)
              }, 500)
              f.onload = () => {
                try {
                  if (f.contentWindow?.location.href === url) {
                    clearTimeout(timer)
                    resolve(false)
                  }
                } catch {}
              }
              f.src = url
              document.body.append(f)
            }),
          input.fileURL,
        )
        .catch(() => page.isClosed())
      const dataObservation = await page
        .evaluate(
          () =>
            new Promise<{
              executed: boolean
              closed: boolean
              frameURL: string
              violations: Array<{
                isTrusted: boolean
                disposition: string
                effectiveDirective: string
                blockedURI: string
                originalPolicy: string
              }>
            }>((resolve) => {
              const f = document.createElement("iframe"),
                nonce = crypto.randomUUID()
              let executed = false
              const violations: Array<{
                isTrusted: boolean
                disposition: string
                effectiveDirective: string
                blockedURI: string
                originalPolicy: string
              }> = []
              const message = (event: MessageEvent) => {
                if (event.source === f.contentWindow && event.data === nonce) executed = true
              }
              const violation = (event: SecurityPolicyViolationEvent) => {
                if (violations.length < 16)
                  violations.push({
                    isTrusted: event.isTrusted,
                    disposition: event.disposition,
                    effectiveDirective: event.effectiveDirective,
                    blockedURI: event.blockedURI.slice(0, 4096),
                    originalPolicy: event.originalPolicy.slice(0, 8192),
                  })
              }
              window.addEventListener("message", message)
              document.addEventListener("securitypolicyviolation", violation)
              f.src =
                "data:text/html," +
                encodeURIComponent("<script>parent.postMessage(" + JSON.stringify(nonce) + ',"*")</script>')
              document.body.append(f)
              setTimeout(() => {
                let frameURL = "opaque"
                try {
                  frameURL = f.contentWindow?.location.href ?? ""
                } catch {}
                f.remove()
                window.removeEventListener("message", message)
                document.removeEventListener("securitypolicyviolation", violation)
                resolve({ executed, closed: false, frameURL, violations })
              }, 500)
            }),
        )
        .catch(() => ({ executed: false, closed: page.isClosed(), frameURL: "", violations: [] }))
      const dataBlocked = dataFrameWasBlocked({
        ...dataObservation,
        cspDenied: dataObservation.violations.some(enforcedDataFrameViolation),
      })
      result = {
        networkBlocked,
        websocketBlocked,
        fileBlocked,
        dataBlocked,
        crossCapabilityBlocked,
        blockedRequests: blocked,
        deniedCanaryAttempts,
      }
    } else if (request.operation === "probe") {
      validateBrowserProbe(request.data)
      const r = request.data as ProbeRequest
      result = await page.evaluate(
        async ({ r, url }) => {
          const mod = await import(url)
          const cases = []
          let count = 0
          for (const c of r.operations) {
            const outputs = []
            const handles = Object.assign(
              Object.create(null),
              structuredClone(r.inputs.find((i) => i.id === c.id)?.fixtures ?? {}),
            )
            const resolve = (name: string): unknown => {
              const parts = name.split(".")
              if (parts.some((p) => ["__proto__", "prototype", "constructor"].includes(p))) throw Error("target")
              let value: Record<string, unknown> = Object.hasOwn(handles, parts[0]!) ? handles : mod
              for (const p of parts) value = value[p] as Record<string, unknown>
              return value
            }
            const arg = (value: unknown): unknown => {
              if (Array.isArray(value)) return value.map(arg)
              if (value && typeof value === "object") {
                if ("$ref" in value) {
                  if (Object.keys(value).length !== 1 || typeof value.$ref !== "string") throw Error("ref")
                  return resolve(value.$ref)
                }
                return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, arg(v)]))
              }
              return value
            }
            for (const op of c.steps) {
              if (++count > 1000) throw Error("size")
              try {
                const parts = op.target.split("."),
                  value = resolve(op.target),
                  owner = parts.length === 1 ? mod : resolve(parts.slice(0, -1).join("."))
                const output =
                  op.kind === "get"
                    ? value
                    : await (value as (...args: unknown[]) => unknown).apply(
                        op.kind === "method" ? owner : undefined,
                        op.args.map(arg),
                      )
                if (op.store) handles[op.store] = output
                outputs.push({ kind: "value", value: JSON.parse(JSON.stringify(output === undefined ? null : output)) })
              } catch (e) {
                outputs.push({ kind: "throw", message: e instanceof Error ? e.message : "error" })
              }
            }
            cases.push({ id: c.id, outputs })
          }
          return { cases }
        },
        { r, url: new URL(r.module, request.base).href },
      )
    } else {
      phase = "interaction"
      await runInteraction(page, captures.interactionScriptID, 10000)
      await twoFrames(page, 10000)
      phase = "capture"
      const [dom, accessibility, axeResult, png] = await Promise.all([
        collectDom(page, 10000),
        collectAccessibility(context, page, 10000),
        collectAxe(page, 10000),
        page.screenshot({ type: "png", fullPage: false, animations: "disabled", caret: "hide", scale: "css" }),
      ])
      phase = "keyboard"
      const keyboard = await probeKeyboard(page, 10000)
      phase = "state"
      const stateProbe = await probeState(page, 10000)
      const root = path.join(request.evidence, "browser-" + crypto.randomUUID())
      await fs.mkdir(root)
      const screenshot = path.join(root, "screenshot.png"),
        evidence = path.join(root, "evidence.json"),
        screenshotSha256 = sha256Bytes(png)
      const value = {
        schemaVersion: 2,
        runID: identity.runID,
        previewID: request.previewID,
        viewportID: captures.viewportID,
        screenshotSha256,
        dom,
        keyboard,
        stateProbe,
        accessibility,
        axe: axeResult,
        consoleErrors,
        pageErrors,
        blockedRequests: blocked,
      }
      phase = "publish"
      const bytes = Buffer.from(canonicalJson(value))
      if (png.length > 8388608 || bytes.length > 1048576) throw Error("size")
      await fs.writeFile(screenshot, png, { flag: "wx" })
      await fs.writeFile(evidence, bytes, { flag: "wx" })
      result = {
        root,
        screenshot,
        evidence,
        screenshotSha256,
        evidenceSha256: sha256Bytes(bytes),
        screenshotBytes: png.length,
      }
    }
    phase = "observations"
    const dom = []
    for (const raw of request.operation === "admission" ? [] : request.plans) {
      const p = raw as { kind?: string; selector?: string }
      if (p.kind !== "dom" || typeof p.selector !== "string") continue
      const locator = page.locator(p.selector)
      dom.push({
        selector: p.selector,
        count: await locator.count(),
        text: (await locator.allTextContents()).join(""),
        visible: await locator.first().isVisible(),
      })
    }
    const observations = { dom, interactions: [] }
    process.stdout.write(
      canonicalJson({ identity, previewID: request.previewID, operation: request.operation, result, observations }),
    )
  } finally {
    clearTimeout(timer)
    await context.close()
    if (path.dirname(profile) !== request.temp) throw Error("profile")
    await directRoot(profile)
    await fs.rm(profile, { recursive: true })
  }
}
async function probeKeyboard(page: Page, timeoutMs: number) {
  return bounded(
    (async () => {
      const semantic = () =>
        page.evaluate(() =>
          JSON.stringify({
            text: document.body.innerText,
            path: location.pathname + location.hash,
            state: [...document.querySelectorAll("input,select,details,[aria-expanded],[aria-pressed]")].map(
              (node) => ({
                checked: node instanceof HTMLInputElement ? node.checked : undefined,
                value: node instanceof HTMLInputElement || node instanceof HTMLSelectElement ? node.value : undefined,
                open: node instanceof HTMLDetailsElement ? node.open : undefined,
                expanded: node.getAttribute("aria-expanded"),
                pressed: node.getAttribute("aria-pressed"),
              }),
            ),
          }),
        )
      const required = await page.evaluate(
        () =>
          [
            ...document.querySelectorAll<HTMLElement>(
              'button,summary,[role="button"],input[type="button"],input[type="submit"],input[type="checkbox"],input[type="radio"]',
            ),
          ].filter((element) => {
            const box = element.getBoundingClientRect()
            return (
              !element.matches(':disabled,[aria-disabled="true"]') &&
              getComputedStyle(element).visibility !== "hidden" &&
              box.width > 0 &&
              box.height > 0
            )
          }).length,
      )
      const focusPath: string[] = []
      let focusVisible = false
      const controls: Array<{ descriptor: string; enter: boolean; space: boolean }> = []
      const visited = new Set<string>()
      for (let index = 0; index < 48; index++) {
        await page.keyboard.press("Tab")
        const focused = await page.evaluate(() => {
          const element = document.activeElement
          if (!(element instanceof HTMLElement) || element === document.body) return null
          const tag = element.tagName.toLowerCase()
          const role = element.getAttribute("role") ?? ""
          const type = element.getAttribute("type") ?? ""
          return {
            descriptor: `${[...document.querySelectorAll("*")].indexOf(element)}:${tag}:${role}:${type}`.slice(0, 128),
            enterRequired: type !== "checkbox" && type !== "radio",
            focusVisible: element.matches(":focus-visible"),
            activatable:
              tag === "button" ||
              tag === "summary" ||
              role === "button" ||
              (tag === "input" && (type === "button" || type === "submit" || type === "checkbox" || type === "radio")),
          }
        })
        if (!focused) continue
        if (visited.has(focused.descriptor)) break
        visited.add(focused.descriptor)
        focusPath.push(focused.descriptor)
        focusVisible ||= focused.focusVisible
        if (focused.activatable) {
          const before = await semantic()
          await page.keyboard.press("Enter")
          await twoFrames(page, timeoutMs)
          const after = await semantic()
          await page.keyboard.press("Space")
          await twoFrames(page, timeoutMs)
          const afterSpace = await semantic()
          controls.push({
            descriptor: focused.descriptor,
            enter: !focused.enterRequired || after !== before,
            space: afterSpace !== after,
          })
          if (controls.length === required) break
        }
      }
      const covered = required > 0 && controls.length === required
      return {
        tabFocusMoved: focusPath.length > 0,
        focusVisible,
        enterActivated: covered && controls.every((control) => control.enter),
        spaceActivated: covered && controls.every((control) => control.space),
        focusPath,
        controls,
        requiredControls: required,
      }
    })(),
    timeoutMs,
    abort.signal,
  )
}

async function probeState(page: Page, timeoutMs: number) {
  return bounded(
    (async () => {
      const find = () =>
        page.evaluate(() => {
          const candidates = [...document.querySelectorAll('[role="alert"],[role="status"],[data-task24-state]')]
          const visible = candidates.find((candidate) => {
            if (!(candidate instanceof HTMLElement)) return false
            const style = getComputedStyle(candidate)
            const box = candidate.getBoundingClientRect()
            return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0
          })
          if (!(visible instanceof HTMLElement)) return null
          return {
            role: visible.getAttribute("role"),
            text: (visible.innerText || visible.textContent || "").trim().slice(0, 512),
          }
        })
      const before = await find()
      let interactionAttempted = false
      {
        interactionAttempted = await page.evaluate(() => {
          const input = [...document.querySelectorAll<HTMLInputElement>("input")].find(
            (candidate) => !candidate.disabled && candidate.type !== "hidden",
          )
          if (!input) return false
          input.focus()
          input.value = "__task24_no_results__"
          input.dispatchEvent(new Event("input", { bubbles: true }))
          input.dispatchEvent(new Event("change", { bubbles: true }))
          const button =
            document.querySelector<HTMLElement>('[data-task24-interaction="primary"]') ??
            document.querySelector<HTMLElement>('button[type="submit"],button')
          button?.click()
          return true
        })
        await twoFrames(page, timeoutMs)
      }
      const state = await find()
      return {
        interactionAttempted,
        visible:
          interactionAttempted &&
          state !== null &&
          JSON.stringify(state) !== JSON.stringify(before) &&
          /error|failed|wasn.t completed|empty|no (?:data|results|items)|invalid/i.test(state.text),
        role: state?.role ?? null,
        text: state?.text ?? null,
      }
    })(),
    timeoutMs,
    abort.signal,
  )
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
      const value = {
        violations: result.violations,
        incomplete: result.incomplete,
        passes: result.passes,
        inapplicable: result.inapplicable,
      }
      // axe includes optional own-properties with undefined values. Cross the
      // page's JSON boundary before canonical publication; do not change checks.
      const json: typeof value = JSON.parse(JSON.stringify(value))
      return json
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

function bounded<A>(work: PromiseLike<A>, timeoutMs: number, signal: AbortSignal, label = "operation"): Promise<A> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const finish = (callback: () => void) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(signal.reason))
    const timer = setTimeout(
      () => finish(() => reject(new HelperFailure("TASK24_BROWSER_TIMEOUT", `${label} timed out`))),
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
