import { test, expect } from "bun:test"
import { verifyBinaryCapabilities, openCapabilityTools } from "../../src/sandbox/capability"
import { sessionFixture } from "./fixture"
import { startFixtureCapabilityProvider, requireFixtureCapabilityProvider } from "../../src/sandbox/fixture-provider"
import { sha256Text } from "../../src/hash"

test("A never starts an unused MCP listener; direct arms retain their real loopback tool endpoint", async () => {
  const opened: ReturnType<typeof Bun.serve>[] = []
  const open = async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ tool: "public-only" }) })
    opened.push(server)
    return server
  }
  try {
    expect(await openCapabilityTools("A", open)).toBeUndefined()
    expect(opened).toHaveLength(0)
    for (const armID of ["B", "C", "D", "E"] as const) {
      const server = await openCapabilityTools(armID, open)
      expect(server).toBeDefined()
      const response = await fetch(`http://127.0.0.1:${server!.port}/`, { proxy: "" })
      expect(await response.json()).toEqual({ tool: "public-only" })
    }
    expect(opened).toHaveLength(4)
  } finally {
    await Promise.all(opened.map((server) => server.stop(true)))
  }
})
test("no verified OS isolation means zero binary launches and no capability receipt", async () => {
  const f = await sessionFixture()
  let launches = 0
  try {
    const result = await verifyBinaryCapabilities({
      binary: f.cli,
      armID: "A",
      session: f.session,
      isolation: {
        verify: async () => ({ kind: "ready", value: { isolated: true } }),
        launch: async () => {
          launches++
          throw Error("must not launch")
        },
      } as never,
    } as never)
    expect(result).toMatchObject({ status: "blocked", code: "tool_capability_blocked" })
    expect(launches).toBe(0)
  } finally {
    await f.dispose()
  }
})
test("capability provider is a closed finite local script, rejects wrong routes and cannot forward paid requests", async () => {
  const provider = startFixtureCapabilityProvider([
    {
      protocol: "responses",
      model: "deepseek-v4-pro",
      events: [
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: { id: "own", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
          },
        },
      ],
    },
  ])
  try {
    const response = await fetch(provider.origin + "/v1/deepseek/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + provider.grant, "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-pro", stream: true }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("response.completed")
    expect(provider.observation()).toEqual({ calls: 1, rejected: 0, complete: true })
    expect((await fetch(provider.origin + "/v1/deepseek/responses", { method: "POST" })).status).toBe(403)
    expect(provider.observation().calls).toBe(1)
  } finally {
    await provider.stop()
  }
})
test("R7 actual finite Responses fixture binds a returned preview ID without any provider lookup", async () => {
  const provider = startFixtureCapabilityProvider([
    {
      protocol: "responses",
      model: "deepseek-v4-pro",
      events: [
        {
          event: "response.function_call_arguments.done",
          data: { arguments: '{"previewID":"{{tool:own-preview:previewID}}"}' },
        },
      ],
    },
  ])
  try {
    const r = await fetch(provider.origin + "/v1/deepseek/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + provider.grant, "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: [
          {
            type: "function_call_output",
            call_id: "own-preview",
            output: JSON.stringify({
              content: [{ type: "text", text: JSON.stringify({ previewID: "d".repeat(64) }) }],
            }),
          },
        ],
      }),
    })
    expect(r.status).toBe(200)
    expect(await r.text()).toContain("d".repeat(64))
    expect(provider.observation()).toEqual({ calls: 1, rejected: 0, complete: true })
  } finally {
    await provider.stop()
  }
})

test("closed provider records only actually returned known tool replies, with bounded immutable controller observations", async () => {
  const provider = startFixtureCapabilityProvider([
    {
      protocol: "chat_completions",
      model: "kimi-k3",
      events: [
        {
          data: {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "ro-write",
                      type: "function",
                      function: { name: "write", arguments: '{"path":"sum.ts","content":"forbidden"}' },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
    {
      protocol: "chat_completions",
      model: "kimi-k3",
      events: [{ data: { choices: [{ index: 0, delta: { content: "{}" }, finish_reason: "stop" }] } }],
    },
  ])
  const send = async (messages: unknown[]) => {
    const response = await fetch(provider.origin + "/v1/kimi/chat/completions", {
      method: "POST",
      proxy: "",
      headers: { authorization: "Bearer " + provider.grant, "content-type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", stream: true, messages }),
    })
    expect(response.status).toBe(200)
    await response.text()
  }
  try {
    requireFixtureCapabilityProvider(provider)
    expect(() => requireFixtureCapabilityProvider({ ...provider })).toThrow("TASK24_FIXTURE_PROVIDER_AUTHORITY")
    expect(provider.toolResults()).toEqual([])
    await send([{ role: "user", content: "read-only fixture" }])
    const before = provider.toolResults()
    const content = '{"error":"Tool write is not available"}'
    await send([
      { role: "tool", tool_call_id: "ro-write", content },
      { role: "tool", tool_call_id: "not-issued", content: "do not record unissued outputs" },
    ])
    expect(provider.toolResults()).toEqual([
      {
        callID: "ro-write",
        name: "write",
        bytes: Buffer.byteLength(content),
        sha256: sha256Text(content),
        text: content,
      },
    ])
    expect(before).toEqual([])
    expect(Object.isFrozen(provider.toolResults())).toBe(true)
    expect(Object.isFrozen(provider.toolResults()[0])).toBe(true)
    expect(provider.observation()).toEqual({ calls: 2, rejected: 0, complete: true })
  } finally {
    await provider.stop()
  }
  expect(() => requireFixtureCapabilityProvider(provider)).toThrow("TASK24_FIXTURE_PROVIDER_AUTHORITY")
})
