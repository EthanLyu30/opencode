import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Task24Root } from "../../src/root"
import { BrowserCaptureFailure, loadBrowserRelease, makeBrowserRuntime } from "../../src/evaluator/browser-runtime"

const releasePath = process.env.TASK24_BROWSER_RELEASE
const integration = releasePath ? test : test.skip
const cleanup: string[] = []

afterAll(async () => {
  Bun.gc(true)
  while (cleanup.length > 0) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

describe("Task24 browser integration", () => {
  integration(
    "captures identical pixels, DOM/styles, Axe, and accessibility summaries three times at every viewport",
    async () => {
      if (!releasePath) throw new TypeError("TASK24_BROWSER_RELEASE is required")
      const layout = Task24Root.ensure()
      const output = path.join(layout.runs, `browser-integration-${crypto.randomUUID()}`)
      const temp = path.join(layout.tmp, `browser-integration-${crypto.randomUUID()}`)
      await fs.mkdir(output)
      await fs.mkdir(temp)
      cleanup.push(output, temp)
      const previewID = "b".repeat(64)
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (!url.pathname.startsWith(`/${previewID}/`)) return new Response("not found", { status: 404 })
          return new Response(fixtureHtml(), { headers: { "content-type": "text/html; charset=utf-8" } })
        },
      })
      try {
        const release = loadBrowserRelease(releasePath)
        const runtime = makeBrowserRuntime({ release, outputRoot: output, tempRoot: temp })
        for (const viewportID of ["mobile", "tablet", "desktop"] as const) {
          const captures = []
          for (let repetition = 0; repetition < 3; repetition++) {
            const result = await runtime.capture({
              runID: `fixture-${viewportID}-${repetition}`,
              previewID,
              previewURL: `http://127.0.0.1:${server.port}/${previewID}/`,
              viewportID,
              readySelector: "#app",
              interactionScriptID: "none",
              timeoutMs: 30_000,
              signal: new AbortController().signal,
            })
            captures.push({
              screenshotSha256: result.screenshotSha256,
              evidence: JSON.parse(await fs.readFile(result.evidence, "utf8")),
            })
          }
          expect(new Set(captures.map((capture) => capture.screenshotSha256))).toHaveLength(1)
          const normalized = captures.map((capture) => {
            const {
              requestID: _requestID,
              runID: _runID,
              screenshotSha256: _screenshotSha256,
              ...stable
            } = capture.evidence
            return stable
          })
          expect(normalized[1]).toEqual(normalized[0])
          expect(normalized[2]).toEqual(normalized[0])
        }
      } finally {
        server.stop(true)
      }
    },
    180_000,
  )

  integration(
    "denies evaluator-triggered popup, download, and navigation escape",
    async () => {
      if (!releasePath) throw new TypeError("TASK24_BROWSER_RELEASE is required")
      const layout = Task24Root.ensure()
      const output = path.join(layout.runs, `browser-policy-${crypto.randomUUID()}`)
      const temp = path.join(layout.tmp, `browser-policy-${crypto.randomUUID()}`)
      await fs.mkdir(output)
      await fs.mkdir(temp)
      cleanup.push(output, temp)
      const previewID = "c".repeat(64)
      let action = "popup"
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(policyHtml(action), { headers: { "content-type": "text/html; charset=utf-8" } }),
      })
      try {
        const runtime = makeBrowserRuntime({
          release: loadBrowserRelease(releasePath),
          outputRoot: output,
          tempRoot: temp,
        })
        for (const current of ["popup", "download", "navigation"] as const) {
          action = current
          const failure = runtime.capture({
            runID: `policy-${current}`,
            previewID,
            previewURL: `http://127.0.0.1:${server.port}/${previewID}/`,
            viewportID: "mobile",
            readySelector: "#app",
            interactionScriptID: "primary-click",
            timeoutMs: 15_000,
            signal: new AbortController().signal,
          })
          await expect(failure).rejects.toBeInstanceOf(BrowserCaptureFailure)
          await expect(failure).rejects.toMatchObject({ code: "TASK24_BROWSER_POLICY_VIOLATION" })
        }
      } finally {
        server.stop(true)
      }
    },
    120_000,
  )

  integration(
    "returns a typed uncertain failure when the deterministic wait condition times out",
    async () => {
      if (!releasePath) throw new TypeError("TASK24_BROWSER_RELEASE is required")
      const layout = Task24Root.ensure()
      const output = path.join(layout.runs, `browser-timeout-${crypto.randomUUID()}`)
      const temp = path.join(layout.tmp, `browser-timeout-${crypto.randomUUID()}`)
      await fs.mkdir(output)
      await fs.mkdir(temp)
      cleanup.push(output, temp)
      const previewID = "d".repeat(64)
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("<!doctype html><html><body><main>never ready</main></body></html>"),
      })
      try {
        const runtime = makeBrowserRuntime({
          release: loadBrowserRelease(releasePath),
          outputRoot: output,
          tempRoot: temp,
        })
        const failure = runtime.capture({
          runID: "timeout-fixture",
          previewID,
          previewURL: `http://127.0.0.1:${server.port}/${previewID}/`,
          viewportID: "mobile",
          readySelector: "#missing",
          interactionScriptID: "none",
          timeoutMs: 2_000,
          signal: new AbortController().signal,
        })
        await expect(failure).rejects.toBeInstanceOf(BrowserCaptureFailure)
        await expect(failure).rejects.toMatchObject({ disposition: "uncertain" })
      } finally {
        server.stop(true)
      }
    },
    30_000,
  )
})

function fixtureHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    html,body{margin:0;background:#f4f1ea;color:#17202a;font-family:Arial,sans-serif}
    main{box-sizing:border-box;display:grid;gap:16px;min-height:100vh;padding:32px}
    .card{background:#fff;border:2px solid #17202a;border-radius:12px;padding:24px}
    h1{font-size:clamp(28px,5vw,56px);line-height:1.05;margin:0}
    button{background:#17202a;border:0;border-radius:8px;color:#fff;font:700 16px Arial;padding:12px 18px}
    @media(max-width:600px){main{padding:16px}.card{padding:16px}}
  </style>
</head>
<body>
  <main id="app" data-task24-evaluate="main">
    <section class="card" data-task24-evaluate="card">
      <h1>Deterministic browser fixture</h1>
      <p>Task24 captures pixels, geometry, styles, accessibility, and policy evidence.</p>
      <button type="button" data-task24-interaction="primary">Inspect</button>
    </section>
  </main>
</body>
</html>`
}

function policyHtml(action: string): string {
  const attributes =
    action === "popup"
      ? "onclick=\"window.open('about:blank')\""
      : action === "download"
        ? "onclick=\"const a=document.createElement('a');a.href='data:text/plain,fixture';a.download='fixture.txt';a.click()\""
        : "onclick=\"location.href='https://example.com/escape'\""
  return `<!doctype html><html lang="en"><body><main id="app"><button data-task24-interaction="primary" ${attributes}>Run policy action</button></main></body></html>`
}
