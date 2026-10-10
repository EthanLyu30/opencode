import { test, expect } from "bun:test"
import { createFakeProvider } from "../../src/offline/fake-provider"

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
