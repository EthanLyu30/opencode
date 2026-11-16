import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { startProductionCommandEndpoint } from "../../src/sandbox/production-command-http"

const hostID = "b".repeat(64)
const engine = {
  execute: async () => ({ exit: 0, stdout: "", stderr: "", truncated: false }),
  outstanding: () => ({ containers: [], uncertainNames: [] }),
}
const html = Buffer.from('<div id="ready">frozen public page</div>')
const css = Buffer.from("body { color: green }")
const snapshot = {
  entrypoint: "web/index.html",
  root: "web",
  files: [
    { path: "web/index.html", bytes: html },
    { path: "web/style.css", bytes: css },
  ],
}
// Independently encode the wire descriptor rather than reusing the snapshot builder.
const sha256 = createHash("sha256")
  .update(
    JSON.stringify([
      "web/index.html",
      "web",
      snapshot.files.map((f) => [f.path, createHash("sha256").update(f.bytes).digest("hex")]),
    ]),
  )
  .digest("hex")

async function control(bridge: Awaited<ReturnType<typeof startProductionCommandEndpoint>>, body: object) {
  return fetch(`http://127.0.0.1:${bridge.port}/task24/production-preview`, {
    method: "POST",
    proxy: "",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability: bridge.capability, ...body }),
  })
}

test("static preview serves only controller-frozen bytes on the existing command port and revokes exact ownership", async () => {
  const original = Buffer.from(html)
  const bridge = await startProductionCommandEndpoint(engine, { previews: [snapshot] })
  try {
    const opened = await control(bridge, { operation: "open", hostID, sha256 })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual({ port: bridge.port, hostID, sha256 })
    const url = `http://127.0.0.1:${bridge.port}/${hostID}/`
    html.fill(120)
    const response = await fetch(url, { proxy: "" })
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(original)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(await (await fetch(url + "style.css", { proxy: "" })).text()).toBe("body { color: green }")
    expect(bridge.previewObservation()).toEqual([{ hostID, sha256, active: true, requests: 2 }])
    expect(() => bridge.admitStaticPreview(url)).not.toThrow()
    expect(() => bridge.admitStaticPreview(url + "style.css")).toThrow()
    const closed = await control(bridge, { operation: "close", hostID, sha256 })
    expect(closed.status).toBe(200)
    await closed.body?.cancel()
    const expired = await fetch(url, { proxy: "" })
    expect(expired.status).toBe(403)
    await expired.body?.cancel()
    expect(() => bridge.admitStaticPreview(url)).toThrow()
    const reopen = await control(bridge, { operation: "open", hostID, sha256 })
    expect(reopen.status).toBe(403)
    await reopen.body?.cancel()
  } finally {
    original.copy(html)
    await bridge.close()
  }
})

test("static preview refuses foreign snapshots, identities, paths and browser control requests", async () => {
  const bridge = await startProductionCommandEndpoint(engine, { previews: [snapshot] })
  const legacy = await startProductionCommandEndpoint(engine)
  try {
    for (const change of [
      { sha256: "0".repeat(64) },
      { hostID: "../other" },
      { file: "D:\\secret" },
      { capability: "0".repeat(64) },
    ]) {
      const response = await control(bridge, { operation: "open", hostID, sha256, ...change })
      expect(response.status).toBe(403)
      await response.body?.cancel()
    }
    const refused = await control(legacy, { operation: "open", hostID, sha256 })
    expect(refused.status).toBe(403)
    await refused.body?.cancel()
    const opened = await control(bridge, { operation: "open", hostID, sha256 })
    expect(opened.status).toBe(200)
    await opened.body?.cancel()
    const url = `http://127.0.0.1:${bridge.port}/${hostID}/`
    for (const suffix of ["missing.html", "%252e%252e/private", "..%2fsecret", "index.html?query=1", "%5csecret"]) {
      const response = await fetch(url + suffix, { proxy: "" })
      expect(response.status).toBe(403)
      await response.body?.cancel()
    }
    const origin = await fetch(url, { proxy: "", headers: { origin: "https://foreign.invalid" } })
    expect(origin.status).toBe(403)
    await origin.body?.cancel()
    expect(() => bridge.admitStaticPreview(`http://localhost:${bridge.port}/${hostID}/`)).toThrow()
    expect(() => bridge.admitStaticPreview(`http://127.0.0.1:${bridge.port + 1}/${hostID}/`)).toThrow()
    const closeWrong = await control(bridge, { operation: "close", hostID, sha256: "0".repeat(64) })
    expect(closeWrong.status).toBe(403)
    await closeWrong.body?.cancel()
    expect(() => bridge.admitStaticPreview(url)).not.toThrow()
  } finally {
    await bridge.close()
    await legacy.close()
  }
})

test("frozen static admission cannot be bypassed by a permissive capture callback, including mid-capture release", async () => {
  let captures = 0
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const bridge = await startProductionCommandEndpoint(engine, {
    previews: [snapshot],
    capture: {
      async admit() {},
      async capture() {
        captures++
        entered.resolve()
        await release.promise
        return Buffer.from("89504e470d0a1a0a", "hex")
      },
      async close() {},
    },
  })
  const url = `http://127.0.0.1:${bridge.port}/${hostID}/`
  const capture = (target: string) =>
    fetch(`http://127.0.0.1:${bridge.port}/task24/production-capture`, {
      method: "POST",
      proxy: "",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: bridge.capability,
        url: target,
        viewport: { width: 390, height: 844 },
        readySelector: "#ready",
        allowedOrigins: [],
      }),
    })
  try {
    const unknown = await capture(url)
    expect(unknown.status).toBe(403)
    await unknown.body?.cancel()
    expect(captures).toBe(0)
    const opened = await control(bridge, { operation: "open", hostID, sha256 })
    expect(opened.status).toBe(200)
    await opened.body?.cancel()
    const pending = capture(url)
    await entered.promise
    const closed = await control(bridge, { operation: "close", hostID, sha256 })
    expect(closed.status).toBe(200)
    await closed.body?.cancel()
    release.resolve()
    const refused = await pending
    expect(refused.status).toBe(403)
    await refused.body?.cancel()
    expect(captures).toBe(1)
  } finally {
    release.resolve()
    await bridge.close()
  }
})

test("static snapshot registration rejects aliases and expired lifetimes before opening a listener", async () => {
  for (const value of [
    { ...snapshot, entrypoint: "../secret" },
    { ...snapshot, root: "other" },
    { ...snapshot, files: [...snapshot.files, { path: "WEB/INDEX.HTML", bytes: html }] },
    { ...snapshot, files: [{ path: "web/CON.txt", bytes: html }] },
    { ...snapshot, files: [{ path: "web/%2e/index.html", bytes: html }] },
  ])
    await expect(startProductionCommandEndpoint(engine, { previews: [value] })).rejects.toThrow(
      "TASK24_PRODUCTION_PREVIEW_SNAPSHOT",
    )
  await expect(startProductionCommandEndpoint(engine, { previews: [snapshot], previewExpiresAt: 1 })).rejects.toThrow(
    "TASK24_PRODUCTION_PREVIEW_EXPIRY",
  )
})
