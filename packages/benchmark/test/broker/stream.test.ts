import { describe, expect, test } from "bun:test"
import type { StreamObservation } from "../../src/broker/stream"
import { observeProviderStream } from "../../src/broker/stream"

async function fixture(name: string) {
  return Bun.file(new URL(`../fixtures/provider/${name}`, import.meta.url)).text()
}

async function observe(
  text: string,
  protocol: "chat_completions" | "responses",
  successful = true,
): Promise<{ readonly output: string; readonly observation: StreamObservation }> {
  const bytes = new TextEncoder().encode(text)
  const chunks = [bytes.slice(0, 7), bytes.slice(7, 29), bytes.slice(29)]
  let resolve!: (value: StreamObservation) => void
  const completed = new Promise<StreamObservation>((done) => (resolve = done))
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift()
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
  })
  const output = await new Response(observeProviderStream({ body, protocol, successful, onFinish: resolve })).text()
  return { output, observation: await completed }
}

describe("Task24 provider stream observer", () => {
  test("preserves arbitrarily chunked native bytes and extracts provider usage", async () => {
    const kimi = await fixture("kimi-chat.sse")
    const kimiResult = await observe(kimi, "chat_completions")
    expect(kimiResult.output).toBe(kimi)
    expect(kimiResult.observation.resultClass).toBe("completed")
    expect(kimiResult.observation.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 6,
      reasoningTokens: 2,
    })

    const deepseek = await fixture("deepseek-responses.sse")
    const deepseekResult = await observe(deepseek, "responses")
    expect(deepseekResult.output).toBe(deepseek)
    expect(deepseekResult.observation.terminalType).toBe("response.completed")
    expect(deepseekResult.observation.usage?.reasoningTokens).toBe(3)
  })

  test("classifies incomplete, failed, missing usage, duplicate terminal, and malformed streams", async () => {
    expect((await observe(await fixture("incomplete.sse"), "responses")).observation.resultClass).toBe("incomplete")
    expect((await observe(await fixture("failed.sse"), "responses")).observation.resultClass).toBe("failed")

    const missing = await observe("data: {}\n\ndata: [DONE]\n\n", "chat_completions")
    expect(missing.observation.resultClass).toBe("completed")
    expect(missing.observation.usage).toBeUndefined()

    const duplicate = await observe(
      'event: response.completed\ndata: {"type":"response.completed"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      "responses",
    )
    expect(duplicate.observation.resultClass).toBe("malformed")
    expect(duplicate.observation.usage).toBeUndefined()

    const malformed = await observe("data: {not-json}\n\n", "responses")
    expect(malformed.observation.resultClass).toBe("malformed")
  })

  test("classifies a downstream cancellation and finalizes exactly once", async () => {
    let finishes = 0
    let resolve!: (value: StreamObservation) => void
    const completed = new Promise<StreamObservation>((done) => (resolve = done))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"partial":true}\n\n'))
      },
    })
    const reader = observeProviderStream({
      body,
      protocol: "chat_completions",
      successful: true,
      onFinish(value) {
        finishes++
        resolve(value)
      },
    }).getReader()
    await reader.read()
    await reader.cancel("test cancellation")
    expect((await completed).resultClass).toBe("cancelled")
    expect(finishes).toBe(1)
  })

  test("upstream errors remain upstream errors even when their body is not valid SSE", async () => {
    const result = await observe("CANARY_PROVIDER_FAILURE", "responses", false)
    expect(result.observation.resultClass).toBe("upstream_error")
    expect(result.observation.usage).toBeUndefined()
  })
})
