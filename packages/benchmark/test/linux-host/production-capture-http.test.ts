import { expect, spyOn, test } from "bun:test"
import { startProductionCommandEndpoint, callProductionCommandBridge } from "../../src/sandbox/production-command-http"
import { sha256Bytes } from "../../src/hash"

const url = "http://127.0.0.1:23456/own-preview/index.html"
const captureInput = { url, viewport: { width: 390, height: 844 }, readySelector: "#ready", allowedOrigins: [] }
const engine = {
  execute: async () => ({ exit: 0, stdout: "command", stderr: "", truncated: false }),
  outstanding: () => ({ containers: [], uncertainNames: [] }),
}

test("production capture shares the finite command port and capability, with independent exact preview admission", async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex")
  let admitted = 0,
    captures = 0,
    closed = 0
  const bridge = await startProductionCommandEndpoint(engine, {
    capture: {
      async admit(input) {
        if (input.url !== url) throw Error("TASK24_PREVIEW_NOT_OWNED")
        admitted++
      },
      async capture() {
        captures++
        return png
      },
      async close() {
        closed++
      },
    },
  })
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/task24/production-capture`, {
      method: "POST",
      proxy: "",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: bridge.capability, ...captureInput }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      mimeType: "image/png",
      data: png.toString("base64"),
      bytes: 8,
      sha256: sha256Bytes(png),
    })
    expect(await callProductionCommandBridge({ ...bridge, argv: ["container", "inspect", "own"] })).toEqual({
      exit: 0,
      stdout: "command",
      stderr: "",
      truncated: false,
    })
    expect({ admitted, captures }).toEqual({ admitted: 2, captures: 1 })
  } finally {
    await bridge.close()
  }
  expect(closed).toBe(1)
})

test("production capture rejects unknown preview, foreign origin, wrong capability and extra fields before capture", async () => {
  let captures = 0
  const bridge = await startProductionCommandEndpoint(engine, {
    capture: {
      async admit(input) {
        if (input.url !== url) throw Error("TASK24_PREVIEW_NOT_OWNED")
      },
      async capture() {
        captures++
        return Buffer.from("89504e470d0a1a0a", "hex")
      },
      async close() {},
    },
  })
  const legacy = await startProductionCommandEndpoint(engine)
  try {
    for (const change of [
      { url: "http://127.0.0.1:23456/foreign/index.html" },
      { url: "http://localhost:23456/own-preview/index.html" },
      { capability: "0".repeat(64) },
      { allowedOrigins: ["https://outside.invalid"] },
      { arbitraryURL: "http://elsewhere" },
    ]) {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/task24/production-capture`, {
        method: "POST",
        proxy: "",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: bridge.capability, ...captureInput, ...change }),
      })
      expect(response.status).toBe(403)
      await response.body?.cancel()
    }
    const response = await fetch(`http://127.0.0.1:${legacy.port}/task24/production-capture`, {
      method: "POST",
      proxy: "",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: legacy.capability, ...captureInput }),
    })
    expect(response.status).toBe(403)
    await response.body?.cancel()
    expect(captures).toBe(0)
  } finally {
    await bridge.close()
    await legacy.close()
  }
})

test("production capture keeps real callback ownership through timeout and never retires a pending browser", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  let retired = 0
  const bridge = await startProductionCommandEndpoint(engine, {
    cleanupTimeoutMs: 20,
    capture: {
      async admit() {},
      async capture() {
        entered.resolve()
        await release.promise
        return Buffer.from("89504e470d0a1a0a", "hex")
      },
      async close() {
        retired++
      },
    },
  })
  const request = fetch(`http://127.0.0.1:${bridge.port}/task24/production-capture`, {
    method: "POST",
    proxy: "",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability: bridge.capability, ...captureInput }),
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    timer = setTimeout(() => release.resolve(), 1000)
    await entered.promise
    await expect(bridge.close()).rejects.toThrow("TASK24_PRODUCTION_COMMAND_CLEANUP_UNCERTAIN")
    expect(retired).toBe(0)
  } finally {
    clearTimeout(timer)
    release.resolve()
    const response = await request
    await response.body?.cancel()
    await bridge.close().catch(() => {})
  }
})

test("shutdown during capture admission never dispatches a late browser action", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let captures = 0
  const bridge = await startProductionCommandEndpoint(engine, {
    capture: {
      async admit() {
        entered.resolve()
        await release.promise
      },
      async capture() {
        captures++
        return Buffer.from("89504e470d0a1a0a", "hex")
      },
      async close() {},
    },
  })
  const request = fetch(`http://127.0.0.1:${bridge.port}/task24/production-capture`, {
    method: "POST",
    proxy: "",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability: bridge.capability, ...captureInput }),
  })
  try {
    await entered.promise
    const closing = bridge.close()
    release.resolve()
    await closing
    const response = await request
    expect(response.status).toBe(403)
    await response.body?.cancel()
    expect(captures).toBe(0)
  } finally {
    release.resolve()
    await bridge.close()
  }
})

test("browser close rejection does not suppress independent exact engine cleanup", async () => {
  const calls: string[][] = []
  const owned = new Set(["a".repeat(64)])
  let retired = 0
  const bridge = await startProductionCommandEndpoint(
    {
      async execute(input) {
        calls.push([...input.argv])
        if (input.argv[1] === "rm") owned.delete(input.argv[3]!)
        return { exit: 0, stdout: "", stderr: "", truncated: false }
      },
      outstanding: () => ({ containers: [...owned], uncertainNames: [] }),
      async retire() {
        retired++
      },
    },
    {
      capture: {
        async admit() {},
        async capture() {
          throw Error("not requested")
        },
        async close() {
          throw Error("TASK24_OWN_BROWSER_CLOSE_FAILURE")
        },
      },
    },
  )
  await expect(bridge.close()).rejects.toThrow()
  expect(calls).toEqual([
    ["container", "kill", "a".repeat(64)],
    ["container", "rm", "--force", "a".repeat(64)],
  ])
  expect(retired).toBe(1)
  expect(owned.size).toBe(0)
  await expect(bridge.close()).rejects.toThrow()
  expect(retired).toBe(1)
})

test("startup rollback attempts engine retirement even when browser close rejects", async () => {
  let retired = 0
  const failure = spyOn(Bun, "serve").mockImplementation(() => {
    throw Error("OWN_BIND_FAILURE")
  })
  let pending: Promise<unknown> | undefined
  try {
    pending = startProductionCommandEndpoint(
      {
        ...engine,
        async retire() {
          retired++
        },
      },
      {
        capture: {
          async admit() {},
          async capture() {
            throw Error("not requested")
          },
          async close() {
            throw Error("OWN_BROWSER_CLOSE_FAILURE")
          },
        },
      },
    )
  } finally {
    failure.mockRestore()
  }
  const error = await pending!.then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(AggregateError)
  expect(retired).toBe(1)
})

test("a hanging browser close does not delay independent engine retirement beyond the total cleanup deadline", async () => {
  const release = Promise.withResolvers<void>()
  let retired = 0
  const bridge = await startProductionCommandEndpoint(
    {
      ...engine,
      async retire() {
        retired++
      },
    },
    {
      cleanupTimeoutMs: 20,
      capture: {
        async admit() {},
        async capture() {
          throw Error("not requested")
        },
        async close() {
          await release.promise
        },
      },
    },
  )
  try {
    await expect(bridge.close()).rejects.toThrow("CLEANUP_UNCERTAIN")
    expect(retired).toBe(1)
  } finally {
    release.resolve()
    await bridge.close().catch(() => {})
  }
})
