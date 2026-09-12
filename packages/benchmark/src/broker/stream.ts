import { createHash } from "node:crypto"
import type { BrokerProtocol } from "./grant"
import type { ProviderUsage } from "./pricing"
import type { ResultClass } from "./ledger"

export interface StreamObservation {
  readonly resultClass: ResultClass
  readonly terminalType?: string
  readonly usage?: ProviderUsage
  readonly responseBytes: number
  readonly responseSha256: string
}

export function observeProviderStream(input: {
  readonly body: ReadableStream<Uint8Array>
  readonly protocol: BrokerProtocol
  readonly successful: boolean
  readonly onFinish: (observation: StreamObservation) => void | Promise<void>
}): ReadableStream<Uint8Array> {
  const reader = input.body.getReader()
  const hash = createHash("sha256")
  const decoder = new TextDecoder()
  let responseBytes = 0
  let buffer = ""
  let usage: ProviderUsage | undefined
  let terminalType: string | undefined
  let terminalCount = 0
  let malformed = false
  let finished = false

  const inspect = (text: string, final = false) => {
    buffer += text.replace(/\r\n/g, "\n")
    if (buffer.length > 1024 * 1024) {
      malformed = true
      buffer = ""
      return
    }
    const frames = buffer.split("\n\n")
    buffer = frames.pop() ?? ""
    if (final && buffer.trim().length > 0) {
      frames.push(buffer)
      buffer = ""
    }
    for (const frame of frames) inspectFrame(frame)
  }

  const inspectFrame = (frame: string) => {
    if (frame.trim().length === 0) return
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!data) return
    if (input.protocol === "chat_completions" && data === "[DONE]") {
      terminalCount++
      terminalType = "[DONE]"
      return
    }
    try {
      const value: unknown = JSON.parse(data)
      if (input.protocol === "chat_completions") {
        const candidate = readChatUsage(value)
        if (candidate) usage = candidate
        return
      }
      if (value === null || typeof value !== "object") return
      const type = Reflect.get(value, "type")
      if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
        terminalCount++
        terminalType = type
        const candidate = readResponsesUsage(value)
        if (candidate) usage = candidate
      }
    } catch {
      malformed = true
    }
  }

  const finalize = async (cancelled = false) => {
    if (finished) return
    finished = true
    inspect(decoder.decode(), true)
    const complete = terminalCount === 1
    let resultClass: ResultClass
    if (cancelled) resultClass = "cancelled"
    else if (!input.successful) resultClass = "upstream_error"
    else if (malformed || !complete) resultClass = "malformed"
    else if (input.protocol === "chat_completions") resultClass = "completed"
    else if (terminalType === "response.completed") resultClass = "completed"
    else if (terminalType === "response.incomplete") resultClass = "incomplete"
    else resultClass = "failed"
    await input.onFinish({
      resultClass,
      terminalType,
      usage: malformed || !complete ? undefined : usage,
      responseBytes,
      responseSha256: hash.digest("hex"),
    })
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          await finalize()
          controller.close()
          return
        }
        responseBytes += next.value.byteLength
        hash.update(next.value)
        inspect(decoder.decode(next.value, { stream: true }))
        controller.enqueue(next.value)
      } catch (cause) {
        await finalize()
        controller.error(cause)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        await finalize(true)
      }
    },
  })
}

function readChatUsage(value: unknown): ProviderUsage | undefined {
  if (value === null || typeof value !== "object") return undefined
  return normalizeUsage({
    inputTokens: nestedNumber(value, "usage", "prompt_tokens"),
    cachedInputTokens: nestedNumber(value, "usage", "prompt_tokens_details", "cached_tokens") ?? 0,
    outputTokens: nestedNumber(value, "usage", "completion_tokens"),
    reasoningTokens: nestedNumber(value, "usage", "completion_tokens_details", "reasoning_tokens") ?? 0,
  })
}

function readResponsesUsage(value: object): ProviderUsage | undefined {
  return normalizeUsage({
    inputTokens: nestedNumber(value, "response", "usage", "input_tokens"),
    cachedInputTokens: nestedNumber(value, "response", "usage", "input_tokens_details", "cached_tokens") ?? 0,
    outputTokens: nestedNumber(value, "response", "usage", "output_tokens"),
    reasoningTokens: nestedNumber(value, "response", "usage", "output_tokens_details", "reasoning_tokens") ?? 0,
  })
}

function normalizeUsage(input: {
  readonly inputTokens: number | undefined
  readonly cachedInputTokens: number
  readonly outputTokens: number | undefined
  readonly reasoningTokens: number
}): ProviderUsage | undefined {
  if (input.inputTokens === undefined || input.outputTokens === undefined) return undefined
  const usage = {
    inputTokens: input.inputTokens,
    cachedInputTokens: input.cachedInputTokens,
    outputTokens: input.outputTokens,
    reasoningTokens: input.reasoningTokens,
  }
  for (const value of Object.values(usage)) if (!Number.isSafeInteger(value) || value < 0) return undefined
  if (usage.cachedInputTokens > usage.inputTokens || usage.reasoningTokens > usage.outputTokens) return undefined
  return usage
}

function nestedNumber(value: unknown, ...keys: string[]): number | undefined {
  let current = value
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined
    current = Reflect.get(current, key)
  }
  return typeof current === "number" ? current : undefined
}
