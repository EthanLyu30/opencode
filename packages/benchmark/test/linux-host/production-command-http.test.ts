import { expect, test } from "bun:test"
import { callProductionCommandBridge, startProductionCommandEndpoint } from "../../src/sandbox/production-command-http"
import type { ProductionInvocation } from "../../src/sandbox/production-command-bridge"

test("private production RPC rejects wrong authority, browser origins, excess properties and arbitrary routes before dispatch", async () => {
  const calls: ProductionInvocation[] = []
  const bridge = await startProductionCommandEndpoint({
    async execute(value) {
      calls.push(value)
      return { exit: 7, stdout: "生产✓", stderr: "error", truncated: false }
    },
    outstanding: () => ({ containers: [], uncertainNames: [] }),
  })
  try {
    expect(await callProductionCommandBridge({ ...bridge, argv: ["container", "inspect", "owned"] })).toEqual({
      exit: 7,
      stdout: "生产✓",
      stderr: "error",
      truncated: false,
    })
    for (const change of [{ capability: "a".repeat(64) }, { host: "localhost" }, { port: 0 }])
      await expect(callProductionCommandBridge({ ...bridge, argv: [], ...change })).rejects.toThrow()
    const body = { capability: bridge.capability, argv: ["container", "inspect", "owned"] }
    for (const [suffix, headers, content] of [
      ["?url=http://evil", {}, body],
      ["", { origin: "http://evil" }, body],
      ["", {}, { ...body, arbitraryURL: "http://evil" }],
      ["", {}, { ...body, stdin: "YQ==garbage" }],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/task24/production-command${suffix}`, {
        method: "POST",
        proxy: "",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(content),
      })
      expect(response.status).toBe(403)
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]!.timeoutMs).toBe(15000)
    expect(calls[0]!.maxOutputBytes).toBe(1048576)
  } finally {
    await bridge.close()
  }
  await expect(callProductionCommandBridge({ ...bridge, argv: [] })).rejects.toThrow()
})

test("production RPC close revokes in-flight launch and performs only exact owned cleanup", async () => {
  const started = Promise.withResolvers<void>()
  const calls: string[][] = []
  const owned = new Set(["b".repeat(64)])
  const bridge = await startProductionCommandEndpoint({
    async execute(value) {
      calls.push([...value.argv])
      if (value.argv[1] === "start") {
        started.resolve()
        await new Promise<void>((resolve) => value.signal!.addEventListener("abort", () => resolve(), { once: true }))
        throw Error("cancelled")
      }
      if (value.argv[1] === "rm") owned.delete(value.argv[3]!)
      return { exit: 0, stdout: "", stderr: "", truncated: false }
    },
    outstanding: () => ({ containers: [...owned], uncertainNames: [] }),
  })
  const pending = callProductionCommandBridge({
    ...bridge,
    argv: ["container", "start", "--attach", "--interactive", "b".repeat(64)],
  })
  const rejected = pending.then(
    () => false,
    () => true,
  )
  await started.promise
  await bridge.close()
  expect(await rejected).toBe(true)
  expect(calls).toEqual([
    ["container", "start", "--attach", "--interactive", "b".repeat(64)],
    ["container", "kill", "b".repeat(64)],
    ["container", "rm", "--force", "b".repeat(64)],
  ])
  expect(owned.size).toBe(0)
})

test("production RPC exposes only bounded classification codes, never arbitrary exception text", async () => {
  for (const [message, expected] of [
    ["TASK24_PRODUCTION_COMMAND_NOT_FROZEN", "TASK24_PRODUCTION_COMMAND_NOT_FROZEN"],
    ["private-content-must-not-leak", "TASK24_PRODUCTION_COMMAND_DENIED"],
  ]) {
    const bridge = await startProductionCommandEndpoint({
      async execute() {
        throw new TypeError(message)
      },
      outstanding: () => ({ containers: [], uncertainNames: [] }),
    })
    try {
      await expect(callProductionCommandBridge({ ...bridge, argv: [] })).rejects.toThrow(expected)
    } finally {
      await bridge.close()
    }
  }
})

test("production RPC cleanup has one total deadline and never continues to remove after an uncertain kill", async () => {
  const blocked = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const calls: string[][] = []
  const bridge = await startProductionCommandEndpoint(
    {
      async execute(value) {
        calls.push([...value.argv])
        entered.resolve()
        await blocked.promise
        return { exit: 0, stdout: "", stderr: "", truncated: false }
      },
      outstanding: () => ({ containers: ["b".repeat(64)], uncertainNames: [] }),
    },
    { cleanupTimeoutMs: 25 },
  )
  const closing = bridge.close()
  const outcome = closing.then(
    () => false,
    () => true,
  )
  await entered.promise
  const bounded = await Promise.race([outcome, new Promise<false>((resolve) => setTimeout(() => resolve(false), 150))])
  blocked.resolve()
  expect(bounded).toBe(true)
  expect(await outcome).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(calls).toEqual([["container", "kill", "b".repeat(64)]])
  await expect(bridge.close()).rejects.toThrow("UNCERTAIN")
})
