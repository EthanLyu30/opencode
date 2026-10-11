import { test, expect } from "bun:test"
import { createFakeProvider } from "../../src/offline/fake-provider"

test.each(["incomplete", "failed"] as const)(
  "fake Responses %s carries terminal detail instead of a normal stop",
  async (terminal) => {
    const fake = createFakeProvider({ terminals: [terminal] })
    const response = await fake.upstream(
      new Request("https://api.deepseek.com/responses", {
        method: "POST",
        headers: { authorization: "Bearer sk-TASK24_FAKE_DEEPSEEK" },
        body: JSON.stringify({ model: "deepseek-v4-pro", stream: true }),
      }),
    )
    const line = (await response.text()).split("\n").find((value) => value.startsWith("data: "))!
    const frame = JSON.parse(line.slice(6))
    expect(frame.response.status).toBe(terminal)
    if (terminal === "incomplete") expect(frame.response.incomplete_details).toEqual({ reason: "max_output_tokens" })
    if (terminal === "failed")
      expect(frame.response.error).toEqual({
        code: "offline_provider_failed",
        message: "Deterministic offline failure",
      })
  },
)

test.each(["kimi", "deepseek"])("fake %s edit uses the write tool actually advertised by the CLI", async (provider) => {
  const fake = createFakeProvider()
  const tool = { type: "function", name: "write", parameters: { type: "object" } }
  const response = await fake.upstream(
    new Request(
      provider === "kimi" ? "https://api.moonshot.cn/v1/chat/completions" : "https://api.deepseek.com/responses",
      {
        method: "POST",
        headers: { authorization: `Bearer sk-TASK24_FAKE_${provider.toUpperCase()}` },
        body: JSON.stringify({
          model: provider === "kimi" ? "kimi-k3" : "deepseek-v4-pro",
          stream: true,
          tools:
            provider === "kimi"
              ? [{ type: "function", function: { name: "write", parameters: tool.parameters } }]
              : [tool],
        }),
      },
    ),
  )
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)))
  const call =
    provider === "kimi"
      ? events[0].choices[0].delta.tool_calls[0].function
      : events.find((event) => event.type === "response.output_item.done").item
  expect(call.name).toBe("write")
  expect(JSON.parse(call.arguments)).toEqual({
    filePath: "task24-offline-provider-edit.txt",
    content: "TASK24_OFFLINE_BINARY_EDIT\n",
  })
})

test("fake delivery resumes the workflow Response context without a default stage message", async () => {
  const fake = createFakeProvider()
  const request = (provider: string, body: unknown) =>
    new Request(
      `https://${provider === "kimi" ? "api.moonshot.cn/v1/chat/completions" : "api.deepseek.com/responses"}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer sk-TASK24_FAKE_${provider.toUpperCase()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    )
  await fake.upstream(
    request("kimi", {
      model: "kimi-k3",
      messages: [{ role: "user", content: JSON.stringify({ stage: { role: "visual_review", revision: 1 } }) }],
    }),
  )
  const response = await fake.upstream(
    request("deepseek", {
      model: "deepseek-v4-pro",
      instructions:
        "Return only the strict delivery envelope with a bounded summary; all artifact hashes and current-workspace facts are host supplied.",
      input: "Original admitted user prompt",
    }),
  )
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
  const delta = events.find((event) => event.type === "response.output_text.delta")
  expect(JSON.parse(delta.delta).outcome).toMatchObject({ role: "deliver", revision: 1 })
  expect(fake.calls().at(-1)).toMatchObject({ workflowRole: "deliver", workflowRevision: 1 })
})
