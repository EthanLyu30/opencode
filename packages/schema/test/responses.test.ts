import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { ResponseEvent } from "../src/response-event"
import { Responses } from "../src/responses"

describe("Responses schemas", () => {
  test("decodes durable response and conversation resources", () => {
    const response = Schema.decodeUnknownSync(Responses.Resource)({
      id: "resp_schema",
      workflowID: "wfl_schema",
      model: "deepseek-v4-flash",
      status: "completed",
      background: false,
      store: true,
      requestHash: "sha256:request",
      output: [{ type: "message", role: "assistant", content: "done" }],
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      createdAt: 1_000,
      completedAt: 2_000,
    })

    expect(String(response.id)).toBe("resp_schema")
    expect(DateTime.toEpochMillis(response.createdAt)).toBe(1_000)
    expect(
      Schema.encodeSync(Responses.Resource)({
        ...response,
        createdAt: DateTime.makeUnsafe(3_000),
      }).createdAt,
    ).toBe(3_000)

    expect(
      Schema.decodeUnknownSync(Responses.Conversation)({
        id: "conv_schema",
        metadata: { purpose: "design" },
        createdAt: 4_000,
      }).id as string,
    ).toBe("conv_schema")
  })

  test("rejects malformed identifiers, statuses, and item ordinals", () => {
    expect(() => Responses.ID.make("bad_response")).toThrow()
    expect(() => Responses.ConversationID.make("bad_conversation")).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Responses.ResponseItem)({
        responseID: "resp_schema",
        ordinal: -1,
        kind: "input",
        payload: { type: "message" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Responses.Resource)({
        id: "resp_schema",
        workflowID: "wfl_schema",
        model: "deepseek-v4-flash",
        status: "unknown",
        background: false,
        store: true,
        requestHash: "sha256:request",
        output: [],
        createdAt: 1_000,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Responses.CreateInput)({
        workflowID: "wfl_schema",
        model: "deepseek-v4-flash",
        background: false,
        store: true,
        requestHash: "sha256:request",
        input: [],
      }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(Responses.ItemPayload)({ type: "message", content: undefined })).toThrow()
  })

  test("owns every response and conversation lifecycle event", () => {
    expect(ResponseEvent.Definitions.map((definition) => definition.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.completed",
      "response.incomplete",
      "response.failed",
      "response.cancelled",
      "response.deleted",
      "conversation.created",
      "conversation.item.added",
      "conversation.deleted",
    ])
    expect(ResponseEvent.DurableDefinitions).toBe(ResponseEvent.Definitions)
    expect(ResponseEvent.Created.durable).toEqual({ version: 1, aggregate: "responseID" })
    expect(ResponseEvent.Conversation.ItemAdded.durable).toEqual({ version: 1, aggregate: "conversationID" })
  })
})
