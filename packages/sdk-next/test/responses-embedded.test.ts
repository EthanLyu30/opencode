import { expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Option, Scope, Stream } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function removeTestDirectory(directory: string, retries = 30): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    if (retries === 0 || !error || typeof error !== "object" || !("code" in error) || error.code !== "EBUSY") {
      throw error
    }
    Bun.gc(true)
    await Bun.sleep(100)
    await removeTestDirectory(directory, retries - 1)
  }
}

const withEmbedded = async (name: string, run: (directory: string) => Effect.Effect<void, unknown, Scope.Scope>) => {
  const directory = await mkdtemp(join(tmpdir(), `opencode-responses-${name}-`))
  const database = Flag.OPENCODE_DB
  Flag.OPENCODE_DB = join(directory, "opencode.sqlite")
  try {
    await Effect.runPromise(Effect.scoped(run(directory)))
  } finally {
    Flag.OPENCODE_DB = database
    await removeTestDirectory(directory)
  }
}

test("embedded gateway admits foreground and background responses without dropping unsupported fields", async () => {
  await withEmbedded("admission", () =>
    Effect.gen(function* () {
      const { OpenCode, Responses, Workflow } = yield* Effect.promise(() => import("../src"))
      const opencode = yield* OpenCode.create()
      const workflowID = Workflow.ID.make(`wfl_gateway_${crypto.randomUUID()}`)
      yield* opencode.workflows.create({
        id: workflowID,
        type: "responses-gateway-test",
        input: {},
        budget: { maxAttempts: 1 },
        stages: [
          {
            type: "gateway-test",
            ordinal: 0,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: `gateway/${workflowID}`,
            input: {},
          },
        ],
      })

      const foregroundID = Responses.ID.make(`resp_foreground_${crypto.randomUUID()}`)
      const foreground = yield* opencode.responses.create({
        id: foregroundID,
        workflowID,
        model: "deepseek-v4-flash",
        background: false,
        store: true,
        requestHash: `sha256:${foregroundID}`,
        input: [{ type: "message", role: "user", content: "foreground" }],
      })
      const inputItems = yield* opencode.responses.inputItems({ responseID: foregroundID })

      const backgroundID = Responses.ID.make(`resp_background_${crypto.randomUUID()}`)
      const background = yield* opencode.responses.create({
        id: backgroundID,
        workflowID,
        model: "deepseek-v4-flash",
        background: true,
        store: true,
        requestHash: `sha256:${backgroundID}`,
        input: [{ type: "message", role: "user", content: "background" }],
      })
      const retrieved = yield* opencode.responses.get({ responseID: backgroundID })
      const generated = yield* opencode.responses.create({
        workflowID,
        model: "deepseek-v4-flash",
        background: false,
        store: true,
        requestHash: `sha256:generated:${crypto.randomUUID()}`,
        input: [{ type: "message", role: "user", content: "generated id" }],
      })

      const unsupported = yield* opencode.responses
        .create({
          workflowID,
          model: "deepseek-v4-flash",
          background: false,
          store: true,
          requestHash: `sha256:unsupported:${crypto.randomUUID()}`,
          input: [{ type: "message", role: "user", content: "unsupported" }],
          tools: [{ type: "mcp", server_label: "private" }],
        })
        .pipe(Effect.flip)
      const unsupportedModel = yield* opencode.responses
        .create({
          workflowID,
          model: "deepseek-v4-pro",
          background: false,
          store: true,
          requestHash: `sha256:unsupported-model:${crypto.randomUUID()}`,
          input: [{ type: "message", role: "user", content: "unsupported model" }],
        })
        .pipe(Effect.flip)

      expect(foreground).toMatchObject({ id: foregroundID, background: false, status: "queued" })
      expect(inputItems.map((item) => [item.ordinal, item.kind, item.payload.content])).toEqual([
        [0, "input", "foreground"],
      ])
      expect(background).toMatchObject({ id: backgroundID, background: true, status: "queued" })
      expect(retrieved.id).toBe(backgroundID)
      expect(generated.id).toStartWith("resp_")
      expect(unsupported).toMatchObject({ _tag: "UnsupportedCapabilityError", capability: "tools" })
      expect(unsupportedModel).toMatchObject({
        _tag: "UnsupportedModelCapabilityError",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        required: "responses",
        planned: true,
      })
    }),
  )
}, 10_000)

test("embedded gateway replays SSE after an exclusive cursor and emits one terminal event", async () => {
  await withEmbedded("sse", () =>
    Effect.gen(function* () {
      const { OpenCode, Responses, Workflow } = yield* Effect.promise(() => import("../src"))
      const workflowID = Workflow.ID.make(`wfl_gateway_${crypto.randomUUID()}`)
      const responseID = Responses.ID.make(`resp_sse_${crypto.randomUUID()}`)
      const cancelled = yield* Effect.scoped(
        Effect.gen(function* () {
          const opencode = yield* OpenCode.create()
          yield* opencode.workflows.create({
            id: workflowID,
            type: "responses-gateway-test",
            input: {},
            budget: { maxAttempts: 1 },
            stages: [
              {
                type: "gateway-test",
                ordinal: 0,
                maxAttempts: 1,
                recoveryPolicy: "restart_safe",
                idempotencyKey: `gateway/${workflowID}`,
                input: {},
              },
            ],
          })
          yield* opencode.responses.create({
            id: responseID,
            workflowID,
            model: "deepseek-v4-flash",
            background: false,
            store: true,
            requestHash: `sha256:${responseID}`,
            input: [{ type: "message", role: "user", content: "stream" }],
          })
          return yield* opencode.responses.cancel({ responseID })
        }),
      )

      expect(cancelled.status).toBe("cancelled")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const restarted = yield* OpenCode.create()
          const replay = Array.from(yield* restarted.responses.events({ responseID, after: 0 }).pipe(Stream.runCollect))
          expect(replay.map((event) => [event.type, event.sequenceNumber])).toEqual([["response.cancelled", 1]])
          const fullyConsumed = Array.from(
            yield* restarted.responses.events({ responseID, after: 1 }).pipe(Stream.runCollect),
          )
          expect(fullyConsumed).toEqual([])

          yield* restarted.responses.delete({ responseID })
          const missing = yield* restarted.responses.get({ responseID }).pipe(Effect.flip)
          expect(missing._tag).toBe("ResponseNotFoundError")
        }),
      )
    }),
  )
}, 10_000)

test("embedded gateway preserves conversation item order and protects active conversations", async () => {
  await withEmbedded("conversation", () =>
    Effect.gen(function* () {
      const { OpenCode, Responses, Workflow } = yield* Effect.promise(() => import("../src"))
      const opencode = yield* OpenCode.create()
      const workflowID = Workflow.ID.make(`wfl_gateway_${crypto.randomUUID()}`)
      yield* opencode.workflows.create({
        id: workflowID,
        type: "responses-gateway-test",
        input: {},
        budget: { maxAttempts: 1 },
        stages: [
          {
            type: "gateway-test",
            ordinal: 0,
            maxAttempts: 1,
            recoveryPolicy: "restart_safe",
            idempotencyKey: `gateway/${workflowID}`,
            input: {},
          },
        ],
      })
      const conversationID = Responses.ConversationID.make(`conv_gateway_${crypto.randomUUID()}`)
      const responseID = Responses.ID.make(`resp_conversation_${crypto.randomUUID()}`)
      const generated = yield* opencode.conversations.create({ metadata: { purpose: "generated-id" } })
      yield* opencode.conversations.delete({ conversationID: generated.id })
      const created = yield* opencode.conversations.create({ id: conversationID, metadata: { purpose: "test" } })
      yield* opencode.conversations.appendItem({
        conversationID,
        payload: { type: "message", role: "user", content: "first" },
      })
      yield* opencode.responses.create({
        id: responseID,
        workflowID,
        model: "deepseek-v4-flash",
        background: false,
        store: true,
        conversation: conversationID,
        requestHash: `sha256:${responseID}`,
        input: [{ type: "message", role: "user", content: "second" }],
      })
      const items = yield* opencode.conversations.items({ conversationID })
      const active = yield* opencode.conversations.delete({ conversationID }).pipe(Effect.flip)

      expect(generated.id).toStartWith("conv_")
      expect(created.id).toBe(conversationID)
      expect(items.map((item) => [item.ordinal, item.responseID, item.payload.content])).toEqual([
        [0, undefined, "first"],
        [1, responseID, "second"],
      ])
      expect(active._tag).toBe("ResponseConflictError")

      yield* opencode.responses.cancel({ responseID })
      yield* opencode.conversations.delete({ conversationID })
      const missing = yield* opencode.conversations.get({ conversationID }).pipe(Effect.flip)
      expect(missing._tag).toBe("ConversationNotFoundError")
      expect(Option.isNone(Option.fromNullishOr(items[0]?.responseID))).toBe(true)
    }),
  )
}, 10_000)
