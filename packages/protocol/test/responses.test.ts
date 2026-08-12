import { describe, expect, test } from "bun:test"
import { Responses } from "@opencode-ai/schema/responses"
import { DateTime, Effect, Schema } from "effect"
import {
  ResponseEventsQuery,
  ResponseStreamEvent,
  ResponsesCreatePayload,
  ResponsesGroup,
  unsupportedResponseFields,
} from "../src/groups/responses"
import { ConversationGroup, ConversationItemAppendPayload } from "../src/groups/conversation"
import {
  ConversationNotFoundError,
  ResponseConflictError,
  ResponseNotFoundError,
  UnsupportedCapabilityError,
  UnsupportedModelCapabilityError,
} from "../src/errors"

const createInput = {
  workflowID: "wfl_protocol",
  model: "deepseek-v4-flash",
  background: false,
  store: true,
  requestHash: "sha256:protocol",
  input: [{ type: "message", role: "user", content: "hello" }],
}

const documentedUnsupported = [
  ["context_management", [{ type: "compaction" }]],
  ["include", ["message.output_text.logprobs"]],
  ["instructions", "implement the task"],
  ["max_output_tokens", 4_096],
  ["max_tool_calls", 8],
  ["metadata", { purpose: "test" }],
  ["moderation", { model: "omni-moderation-latest" }],
  ["parallel_tool_calls", true],
  ["prompt", { id: "pmpt_test" }],
  ["prompt_cache_key", "cache-key"],
  ["prompt_cache_options", { mode: "explicit", ttl: "30m" }],
  ["prompt_cache_retention", "24h"],
  ["reasoning", { effort: "high" }],
  ["safety_identifier", "hashed-user"],
  ["service_tier", "default"],
  ["stream_options", { include_obfuscation: false }],
  ["temperature", 0.2],
  ["text", { format: { type: "text" } }],
  ["tool_choice", "auto"],
  ["tools", [{ type: "function", name: "test" }]],
  ["top_logprobs", 4],
  ["top_p", 0.9],
  ["truncation", "disabled"],
  ["user", "hashed-user"],
] as const

describe("Responses protocol groups", () => {
  test("owns the public response and conversation route groups", () => {
    expect(ResponsesGroup.identifier).toBe("server.responses")
    expect(ConversationGroup.identifier).toBe("server.conversation")
    expect(Object.keys(ResponsesGroup.endpoints)).toEqual([
      "responses.create",
      "responses.get",
      "responses.delete",
      "responses.cancel",
      "responses.inputItems",
      "responses.events",
    ])
    expect(Object.keys(ConversationGroup.endpoints)).toEqual([
      "conversation.create",
      "conversation.get",
      "conversation.delete",
      "conversation.appendItem",
      "conversation.items",
    ])
  })

  test("preserves unsupported create fields for typed handler rejection", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(ResponsesCreatePayload)({
        ...createInput,
        tools: [{ type: "mcp", server_label: "private" }],
      }),
    )

    expect(decoded.tools).toEqual([{ type: "mcp", server_label: "private" }])
    expect(unsupportedResponseFields(decoded)).toEqual(["tools"])
  })

  test("preserves every documented but locally unsupported top-level request field", () => {
    for (const [field, value] of documentedUnsupported) {
      const decoded = Schema.decodeUnknownSync(ResponsesCreatePayload)({ ...createInput, [field]: value })
      expect(unsupportedResponseFields(decoded)).toEqual([field])
    }

    const camelCase = Schema.decodeUnknownSync(ResponsesCreatePayload)({
      ...createInput,
      maxOutputTokens: 4_096,
      promptCacheOptions: { mode: "explicit" },
      toolChoice: "auto",
    })
    expect(unsupportedResponseFields(camelCase)).toEqual(["maxOutputTokens", "promptCacheOptions", "toolChoice"])
  })

  test("does not treat generated optional undefined keys as requested capabilities", () => {
    const decoded = Schema.decodeUnknownSync(ResponsesCreatePayload)(createInput)
    const generatedPayload = {
      ...decoded,
      id: undefined,
      previousResponseID: undefined,
      conversationID: undefined,
      tools: undefined,
      include: undefined,
      prompt: undefined,
      truncation: undefined,
      stream: undefined,
    }

    expect(unsupportedResponseFields(generatedPayload)).toEqual([])
    expect(unsupportedResponseFields({ ...decoded, stream: false })).toEqual([])
    expect(unsupportedResponseFields({ ...decoded, stream: true })).toEqual([])
    expect(Array.from(ResponsesGroup.endpoints["responses.create"].success)).toHaveLength(2)
  })

  test("decodes exclusive SSE cursors and emits wire-compatible sequence numbers", async () => {
    const query = await Effect.runPromise(Schema.decodeUnknownEffect(ResponseEventsQuery)({ after: "3" }))
    const encoded = Schema.encodeUnknownSync(ResponseStreamEvent)({
      type: "response.in_progress",
      sequenceNumber: 4,
      data: { responseID: Responses.ID.make("resp_protocol"), timestamp: DateTime.makeUnsafe(1_000) },
    })

    expect(query).toEqual({ after: 3 })
    expect(encoded).toEqual({
      type: "response.in_progress",
      sequence_number: 4,
      data: { responseID: "resp_protocol", timestamp: 1_000 },
    })
  })

  test("decodes conversation item appends without duplicating the path identifier", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(ConversationItemAppendPayload)({
        responseID: "resp_protocol",
        payload: { type: "message", role: "user", content: "continue" },
      }),
    )

    expect(String(decoded.responseID)).toBe("resp_protocol")
    expect(decoded.payload).toEqual({ type: "message", role: "user", content: "continue" })
  })

  test("exposes typed public errors for missing, conflicting, and unsupported resources", () => {
    expect(new ResponseNotFoundError({ responseID: "resp_protocol", message: "missing" })._tag).toBe(
      "ResponseNotFoundError",
    )
    expect(new ConversationNotFoundError({ conversationID: "conv_protocol", message: "missing" })._tag).toBe(
      "ConversationNotFoundError",
    )
    expect(
      new ResponseConflictError({ resourceID: "resp_protocol", operation: "cancel", message: "conflict" })._tag,
    ).toBe("ResponseConflictError")
    expect(
      new UnsupportedCapabilityError({
        capability: "tools",
        message: "unsupported",
        supportedAlternatives: [],
      })._tag,
    ).toBe("UnsupportedCapabilityError")
    expect(
      new UnsupportedModelCapabilityError({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        required: "responses",
        supported: ["chat", "structured_output"],
        planned: true,
        message: "deepseek-v4-pro does not support Responses yet",
      })._tag,
    ).toBe("UnsupportedModelCapabilityError")
  })
})
