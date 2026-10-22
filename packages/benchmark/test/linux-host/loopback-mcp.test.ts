import { expect, test } from "bun:test"
import path from "node:path"
import { callPublicToolLoopback, startPublicToolLoopback } from "../../src/sandbox/mcp-server"
import { publicMcpArguments, publicMcpCommand } from "../../src/sandbox/capability"

function fixture() {
  const calls: unknown[] = []
  const read = async (value: unknown) => {
    calls.push(value)
    return { text: "设计✓", value }
  }
  return { calls, host: { read, write: read, check: read, preview: read, capture: read } }
}

async function exchange(port: number, chunks: readonly Buffer[]) {
  const response = await fetch(`http://127.0.0.1:${port}/task24/public-tools`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    proxy: "",
    signal: AbortSignal.timeout(5000),
  })
  return response.text()
}

test("loopback MCP binds IPv4 localhost only, checks launcher capability and revokes on close", async () => {
  const f = fixture()
  const bridge = await startPublicToolLoopback({ host: f.host })
  try {
    expect(bridge.host).toBe("127.0.0.1")
    expect(Number.isInteger(bridge.port) && bridge.port > 0 && bridge.port <= 65535).toBe(true)
    expect(await callPublicToolLoopback({ ...bridge, name: "read", parameters: { path: "设计" } })).toEqual({
      text: "设计✓",
      value: { path: "设计" },
    })
    for (const override of [{ capability: "0".repeat(64) }, { host: "localhost" }, { host: "::1" }, { port: 0 }])
      await expect(callPublicToolLoopback({ ...bridge, name: "read", parameters: {}, ...override })).rejects.toThrow()
    expect(f.calls).toEqual([{ path: "设计" }])
  } finally {
    await bridge.close()
  }
  await expect(callPublicToolLoopback({ ...bridge, name: "read", parameters: {} })).rejects.toThrow()
  await bridge.close()
})

test("loopback MCP requires exactly one complete bounded UTF-8 frame before dispatch", async () => {
  const f = fixture()
  const bridge = await startPublicToolLoopback({ host: f.host })
  const frame = Buffer.from(JSON.stringify({ capability: bridge.capability, name: "read", parameters: "设计" }) + "\n")
  try {
    // Byte-at-a-time writes include split UTF-8 and must still produce one call.
    expect(
      JSON.parse(
        await exchange(
          bridge.port,
          [...frame].map((byte) => Buffer.from([byte])),
        ),
      ).ok,
    ).toBe(true)
    expect(f.calls).toEqual(["设计"])
    for (const bad of [
      Buffer.concat([frame, frame]),
      Buffer.concat([frame, Buffer.from("junk")]),
      frame.subarray(0, -1),
      Buffer.from('{"capability":"' + bridge.capability + '","name":"read","parameters":"\xff"}\n', "binary"),
      Buffer.from(JSON.stringify({ capability: bridge.capability, name: "constructor", parameters: {} }) + "\n"),
      Buffer.from(JSON.stringify({ capability: bridge.capability, name: "read", parameters: {}, extra: true }) + "\n"),
    ])
      expect(await exchange(bridge.port, [bad])).toBe('{"ok":false}\n')
    expect(f.calls).toEqual(["设计"])
  } finally {
    await bridge.close()
  }
})

test("loopback MCP rejects HTTP routing, origin, oversized requests and oversized replies without extra dispatch", async () => {
  const f = fixture()
  const bridge = await startPublicToolLoopback({
    host: { ...f.host, capture: async () => "x".repeat(12 * 1024 * 1024) },
  })
  const body = JSON.stringify({ capability: bridge.capability, name: "read", parameters: {} }) + "\n"
  try {
    for (const options of [
      { method: "GET" },
      { method: "POST", headers: { "content-type": "text/plain" }, body },
      { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:12345" }, body },
    ]) {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/task24/public-tools`, { ...options, proxy: "" })
      expect(response.status).toBe(403)
      await response.body?.cancel()
    }
    const wrong = await fetch(`http://127.0.0.1:${bridge.port}/task24/public-tools?extra=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      proxy: "",
    })
    expect(wrong.status).toBe(403)
    await wrong.body?.cancel()
    await expect(
      callPublicToolLoopback({ ...bridge, name: "read", parameters: "x".repeat(12 * 1024 * 1024) }),
    ).rejects.toThrow("TASK24_PUBLIC_LOOPBACK_LIMIT")
    await expect(callPublicToolLoopback({ ...bridge, name: "capture", parameters: {} })).rejects.toThrow(
      "TASK24_PUBLIC_LOOPBACK_DENIED",
    )
    expect(f.calls).toEqual([])
  } finally {
    await bridge.close()
  }
})

test("closing the MCP bridge revokes the tool lifetime and waits for an already dispatched operation", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const lifecycle = new AbortController()
  const f = fixture()
  const bridge = await startPublicToolLoopback({
    lifecycle,
    host: {
      ...f.host,
      read: async () => {
        started.resolve()
        await release.promise
        return { text: "settled" }
      },
    },
  })
  const request = callPublicToolLoopback({ ...bridge, name: "read", parameters: {} })
  void request.catch(() => {})
  let finished = false
  let closing: Promise<void> | undefined
  try {
    await started.promise
    closing = bridge.close().then(() => {
      finished = true
    })
    expect(lifecycle.signal.aborted).toBe(true)
    await Bun.sleep(20)
    expect(finished).toBe(false)
    release.resolve()
    await closing
    expect(finished).toBe(true)
    await expect(request).rejects.toThrow()
  } finally {
    release.resolve()
    await (closing ?? bridge.close())
  }
})

test("MCP cleanup bounds a non-cooperative tool and reports uncertainty rather than retiring its workspace", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const f = fixture()
  const bridge = await startPublicToolLoopback({
    cleanupTimeoutMs: 20,
    host: {
      ...f.host,
      read: async () => {
        started.resolve()
        await release.promise
        return { text: "late" }
      },
    },
  })
  const request = callPublicToolLoopback({ ...bridge, name: "read", parameters: {} })
  void request.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await started.promise
    // A safety release keeps the red implementation from hanging the test runner.
    timer = setTimeout(() => release.resolve(), 1000)
    await expect(bridge.close()).rejects.toMatchObject({ cleanupUncertain: true })
    await expect(bridge.close()).rejects.toMatchObject({ cleanupUncertain: true })
  } finally {
    clearTimeout(timer)
    release.resolve()
    await bridge.close().catch(() => {})
    await request.catch(() => {})
  }
})

test("production MCP CLI carries the launcher token over loopback without exposing it as a model argument", async () => {
  const f = fixture()
  const bridge = await startPublicToolLoopback({ host: f.host })
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "run", path.resolve("script/public-mcp.ts"), "--loopback", String(bridge.port)],
    {
      env: { ...process.env, TASK24_PUBLIC_TOOL_CAPABILITY: bridge.capability },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const output = new Response(child.stdout).text()
    const error = new Response(child.stderr).text()
    for (const request of [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "own", version: "1" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read", arguments: { path: "src/own", offset: 0, length: 3 } },
      },
    ])
      child.stdin.write(JSON.stringify(request) + "\n")
    child.stdin.end()
    expect(await child.exited).toBe(0)
    expect(await error).toBe("")
    const lines = (await output)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines.find((line) => line.id === 2).result.content[0].text).toContain("设计✓")
    expect(f.calls).toEqual([{ path: "src/own", offset: 0, length: 3 }])
  } finally {
    child.kill()
    await child.exited
    await bridge.close()
  }
})

test("MCP launcher preserves pipes and admits only a finite localhost port, never an arbitrary endpoint", () => {
  const file = { path: "D:\\own\\bun.exe", sha256: "a".repeat(64), fileID: "own" }
  const base = { capability: "a".repeat(64), bun: file, entry: { ...file, path: "D:\\own\\public-mcp.js" } }
  const pipe = "\\\\.\\pipe\\opencode-task24-" + "b".repeat(64)
  expect(publicMcpArguments({ ...base, pipe })).toEqual(["--pipe", pipe])
  expect(publicMcpArguments({ ...base, host: "127.0.0.1", port: 12451 })).toEqual(["--loopback", "12451"])
  expect(publicMcpCommand({ ...base, pipe })).toEqual([
    file.path,
    "--no-env-file",
    "run",
    base.entry.path,
    "--pipe",
    pipe,
  ])
  const entry = { ...file, path: "D:\\own\\public-mcp.exe" }
  expect(publicMcpCommand({ ...base, entry, host: "127.0.0.1", port: 12451 })).toEqual([
    entry.path,
    "--loopback",
    "12451",
  ])
  for (const endpoint of [
    { host: "localhost", port: 12451 },
    { host: "0.0.0.0", port: 12451 },
    { host: "127.0.0.1", port: 0 },
    { host: "127.0.0.1", port: 65536 },
    { host: "127.0.0.1", port: 1.5 },
    { pipe, host: "127.0.0.1", port: 12451 },
    { pipe: "\\\\.\\pipe\\docker_engine" },
  ])
    expect(() => publicMcpArguments({ ...base, ...endpoint } as never)).toThrow("TASK24_PUBLIC_MCP_CONFIG")
})
