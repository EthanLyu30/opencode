import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Task24Root } from "../../src/root"
import { loadBrowserRelease, makeBrowserRuntime } from "../../src/evaluator/browser-runtime"

const releasePath = process.env.TASK24_BROWSER_RELEASE
const integration = releasePath ? test : test.skip
const cleanup: string[] = []

afterEach(async () => {
  while (cleanup.length > 0) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

integration(
  "prints byte-identical PDFs twice through the authenticated Node/Chromium helper",
  async () => {
    if (!releasePath) throw new TypeError("TASK24_BROWSER_RELEASE is required")
    const reportID = "campaign-fixture"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== `/${reportID}/`) return new Response("not found", { status: 404 })
        return new Response(fixtureHtml(), { headers: { "content-type": "text/html; charset=utf-8" } })
      },
    })
    try {
      const layout = Task24Root.ensure()
      const release = loadBrowserRelease(releasePath)
      const results = []
      for (let index = 0; index < 2; index++) {
        const outputRoot = path.join(layout.reports, `pdf-browser-${crypto.randomUUID()}`)
        const tempRoot = path.join(layout.tmp, `pdf-browser-${crypto.randomUUID()}`)
        cleanup.push(outputRoot, tempRoot)
        await fs.mkdir(outputRoot)
        await fs.mkdir(tempRoot)
        const runtime = makeBrowserRuntime({ release, outputRoot, tempRoot })
        results.push(
          await runtime.renderPdf({
            reportID,
            reportURL: `http://127.0.0.1:${server.port}/${reportID}/`,
            evidenceHashes: ["1".repeat(64)],
            timeoutMs: 30_000,
            signal: new AbortController().signal,
          }),
        )
      }
      expect(results[0]?.sha256).toBe(results[1]?.sha256)
      expect(Buffer.from(await fs.readFile(results[0]!.pdf)).toString("latin1")).toStartWith("%PDF-")
    } finally {
      server.stop(true)
    }
  },
  90_000,
)

function fixtureHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font:16px "Microsoft YaHei",Arial,sans-serif;color:#172033}h1{border-bottom:3px solid #172033;padding-bottom:12px}</style></head><body><h1>Task24 benchmark report</h1><p>Deterministic authenticated PDF fixture. 工作流效果评测。</p><table><caption>Qualified success</caption><tr><th>Arm A</th><td>100%</td></tr><tr><th>Arm B</th><td>50%</td></tr></table></body></html>`
}
