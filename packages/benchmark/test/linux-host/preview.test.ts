import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sha256Text } from "../../src/hash"
import { startLinuxPreview, relayHttp } from "../../src/sandbox/preview"
import { sessionFixture } from "./fixture"

test("each preview has its own origin/capability and serves only unchanged manifest files", async () => {
  const f = await sessionFixture()
  const controller = new AbortController()
  let stops = 0
  try {
    const root = path.join(f.manifest.roots.work, "preview-own")
    await fs.mkdir(root)
    await fs.writeFile(path.join(root, "page.html"), "<p>own</p>")
    await fs.writeFile(path.join(root, "private.txt"), "must not serve")
    const files = [{ path: "page.html", sha256: sha256Text("<p>own</p>"), size: 10 }]
    const source = {
      root,
      files,
      buildSha256: sha256Text("build"),
      stop: async () => {
        stops++
      },
    }
    const lease = await startLinuxPreview({
      source,
      policy: { methods: ["GET"], paths: ["/page.html"] },
      guard: async () => {},
      signal: controller.signal,
    })
    const r = await fetch(lease.url + "page.html")
    expect(r.status).toBe(200)
    expect(await r.text()).toBe("<p>own</p>")
    expect((await fetch(lease.url + "private.txt")).status).toBe(404)
    expect(
      (
        await relayHttp({
          lease,
          request: {
            capability: "0".repeat(64),
            previewID: lease.previewID,
            method: "GET",
            path: "/page.html",
            headers: [],
            body: new Uint8Array(),
          },
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await relayHttp({
          lease,
          request: {
            capability: lease.capability,
            previewID: lease.previewID,
            method: "CONNECT",
            path: "/page.html",
            headers: [],
            body: new Uint8Array(),
          },
        })
      ).status,
    ).toBe(405)
    await fs.writeFile(path.join(root, "page.html"), "<p>bad</p>")
    expect((await fetch(lease.url + "page.html")).status).toBe(502)
    controller.abort()
    await lease.stop()
    expect(stops).toBe(1)
    await expect(fetch(lease.url + "page.html")).rejects.toThrow()
  } finally {
    controller.abort()
    await f.dispose()
  }
})
