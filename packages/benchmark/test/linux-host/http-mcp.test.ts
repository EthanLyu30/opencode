import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { callPublicToolLoopback, startPublicToolLoopback } from "../../src/sandbox/mcp-server"
import fs from "node:fs/promises"
import path from "node:path"
import { sessionFixture } from "./fixture"
import { orchestratorFixture } from "../independent/fixture"
import { makePublicToolHost } from "../../src/sandbox/public-tools"
import { sha256Text } from "../../src/hash"

function fixture() {
  const calls: unknown[] = []
  const read = async (value: unknown) => {
    calls.push(value)
    return { text: "设计✓" }
  }
  return { calls, host: { read, write: read, check: read, preview: read, capture: read } }
}

test("opt-in standard MCP HTTP uses the existing port and the same five tool handlers", async () => {
  const f = fixture()
  const bridge = await startPublicToolLoopback({ host: f.host, mcpHttp: true })
  const client = new Client({ name: "task24-own", version: "1" })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridge.port}/task24/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.capability}` } },
      }),
    )
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "read",
      "write",
      "check",
      "preview",
      "capture",
    ])
    expect(await client.callTool({ name: "read", arguments: { path: "src/own", offset: 0, length: 3 } })).toEqual({
      content: [{ type: "text", text: '{"text":"设计✓"}' }],
    })
    expect((await client.callTool({ name: "shell", arguments: {} })).isError).toBe(true)
    expect(await callPublicToolLoopback({ ...bridge, name: "read", parameters: { legacy: true } })).toEqual({
      text: "设计✓",
    })
    expect(f.calls).toEqual([{ path: "src/own", offset: 0, length: 3 }, { legacy: true }])
  } finally {
    await client.close()
    await bridge.close()
  }
})

test("MCP HTTP authenticates before dispatch, rejects origin, aliases, oversized and invalid framing; default stays closed", async () => {
  const f = fixture()
  const bridge = await startPublicToolLoopback({ host: f.host, mcpHttp: true })
  const legacy = await startPublicToolLoopback({ host: f.host })
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: {} } })
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    Authorization: `Bearer ${bridge.capability}`,
  }
  try {
    for (const variant of [
      { headers: { ...headers, Authorization: "Bearer " + "0".repeat(64) } },
      { headers: { ...headers, origin: "http://127.0.0.1:12345" } },
      { headers: { ...headers, host: "localhost:" + bridge.port } },
      { suffix: "?extra=1" },
      { body: body + body },
      { body: "[" + body + "]" },
      { body: Buffer.from('{"bad":"\xff"}', "binary") },
      { port: legacy.port },
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${variant.port ?? bridge.port}/task24/mcp${variant.suffix ?? ""}`,
        {
          method: "POST",
          headers,
          body,
          proxy: "",
          ...variant,
        },
      )
      expect(response.status).toBe(403)
      await response.body?.cancel()
    }
    const oversized = await fetch(`http://127.0.0.1:${bridge.port}/task24/mcp`, {
      method: "POST",
      headers,
      body: "x".repeat(12 * 1024 * 1024 + 1),
      proxy: "",
    }).catch((error: unknown) => {
      if (error instanceof Error && Reflect.get(error, "code") === "ECONNRESET") return null
      throw error
    })
    expect([null, 403, 413]).toContain(oversized?.status ?? null)
    await oversized?.body?.cancel()
    expect(f.calls).toEqual([])
  } finally {
    await bridge.close()
    await legacy.close()
  }
})

test("closing MCP HTTP revokes authority and drains a dispatched tool before workspace retirement", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const f = fixture()
  const bridge = await startPublicToolLoopback({
    mcpHttp: true,
    host: {
      ...f.host,
      read: async () => {
        started.resolve()
        await release.promise
        return "late"
      },
    },
  })
  const client = new Client({ name: "own", version: "1" })
  let closing: Promise<void> | undefined
  let request: Promise<unknown> | undefined
  let finished = false
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridge.port}/task24/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.capability}` } },
      }),
    )
    request = client.callTool({ name: "read", arguments: {} })
    void request.catch(() => {})
    await started.promise
    closing = bridge.close().then(() => {
      finished = true
    })
    await Bun.sleep(20)
    expect(finished).toBe(false)
    release.resolve()
    await closing
    expect(finished).toBe(true)
    await expect(request).rejects.toThrow()
  } finally {
    release.resolve()
    await (closing ?? bridge.close())
    await client.close()
    await request?.catch(() => {})
  }
})

test("standard HTTP retains production CAS, protected files and controller readonly authority", async () => {
  const f = await sessionFixture()
  const c = await orchestratorFixture()
  const client = new Client({ name: "own", version: "1" })
  let bridge: Awaited<ReturnType<typeof startPublicToolLoopback>> | undefined
  try {
    const workspace = path.join(f.manifest.roots.work, "http-tools")
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "src/math.js"), "wrong")
    await fs.writeFile(path.join(workspace, "package.json"), '{"private":true}')
    const denied = async () => {
      throw Error("not a build/browser acceptance")
    }
    const host = makePublicToolHost({
      workspace,
      profile: c.input.bundle.profile,
      guard: async () => {},
      maxCalls: 20,
      backend: { check: denied, preview: denied, capture: denied },
    })
    bridge = await startPublicToolLoopback({ host, mcpHttp: true })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridge.port}/task24/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.capability}` } },
      }),
    )
    const write = (file: string, baseSha256: string | null, content: string) =>
      client.callTool({
        name: "write",
        arguments: { path: file, baseSha256, content },
      })
    expect((await write("src/math.js", sha256Text("stale"), "bad")).isError).toBe(true)
    expect((await write("src/math.js", sha256Text("wrong"), "correct")).isError).not.toBe(true)
    for (const file of ["package.json", "../private", "tests/test.js", ".env.local"])
      expect((await write(file, null, "bad")).isError).toBe(true)
    await host.setReadonly()
    expect((await write("src/math.js", sha256Text("correct"), "bad")).isError).toBe(true)
    const read = await client.callTool({ name: "read", arguments: { path: "src/math.js", offset: 0, length: 64 } })
    expect(read.isError).not.toBe(true)
    expect(read.content).toMatchObject([{ type: "text", text: expect.stringContaining("correct") }])
    expect(await fs.readFile(path.join(workspace, "src/math.js"), "utf8")).toBe("correct")
    expect(await fs.readFile(path.join(workspace, "package.json"), "utf8")).toBe('{"private":true}')
    expect(host.observation().writes).toHaveLength(1)
    expect(host.observation().deniedWrites).toBeGreaterThan(0)
  } finally {
    await client.close()
    await bridge?.close()
    await c.dispose()
    await f.dispose()
  }
})

test("HTTP cleanup reports uncertainty for a non-cooperative tool without retiring the workspace", async () => {
  const f = fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const bridge = await startPublicToolLoopback({
    mcpHttp: true,
    cleanupTimeoutMs: 20,
    host: {
      ...f.host,
      read: async () => {
        started.resolve()
        await release.promise
        return "late"
      },
    },
  })
  const client = new Client({ name: "own", version: "1" })
  let request: Promise<unknown> | undefined
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridge.port}/task24/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.capability}` } },
      }),
    )
    request = client.callTool({ name: "read", arguments: {} })
    void request.catch(() => {})
    await started.promise
    await expect(bridge.close()).rejects.toMatchObject({ cleanupUncertain: true })
    await expect(bridge.close()).rejects.toMatchObject({ cleanupUncertain: true })
  } finally {
    release.resolve()
    await request?.catch(() => {})
    await client.close()
    await bridge.close().catch(() => {})
  }
})
