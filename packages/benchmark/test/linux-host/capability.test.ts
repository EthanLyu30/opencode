import { test, expect } from "bun:test"
import { verifyBinaryCapabilities } from "../../src/sandbox/capability"
import { sessionFixture } from "./fixture"
import { startFixtureCapabilityProvider } from "../../src/sandbox/fixture-provider"
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
