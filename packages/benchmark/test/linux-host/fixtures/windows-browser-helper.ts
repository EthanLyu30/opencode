import { chromium } from "playwright"
import fs from "node:fs/promises"

async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  const context = await chromium.launchPersistentContext(request.profile, {
    executablePath: request.browser,
    headless: true,
    chromiumSandbox: true,
    viewport: { width: 640, height: 480 },
    locale: "en-US",
    timezoneId: "UTC",
    acceptDownloads: false,
    serviceWorkers: "block",
    permissions: [],
    args: [
      "--browser-subprocess-path=" + request.browser,
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--font-render-hinting=none",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  })
  try {
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto(request.preview, { waitUntil: "load", timeout: 15000 })
    await page.locator("button").click()
    const text = await page.locator("output").textContent()
    const denied = await page.evaluate(
      async ({ canary, file }) => {
        const results = []
        for (const url of [canary, file]) {
          const abort = new AbortController()
          const timer = setTimeout(() => abort.abort(), 1500)
          try {
            await fetch(url, { signal: abort.signal })
            results.push(false)
          } catch {
            results.push(true)
          } finally {
            clearTimeout(timer)
          }
        }
        return results
      },
      { canary: request.canary, file: request.file },
    )
    await page.screenshot({ path: request.screenshot })
    // Keep the real renderer alive long enough for the independent native token observer.
    await page.waitForTimeout(1000)
    process.stdout.write(
      JSON.stringify({ buttonText: text, denied, screenshotBytes: (await fs.stat(request.screenshot)).size }),
    )
  } finally {
    await context.close()
  }
}
void main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error))
  process.exitCode = 1
})
