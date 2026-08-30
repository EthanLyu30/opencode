import { expect, test } from "bun:test"
import { createOpencodeClient } from "../src/v2/client"
import type { EventSessionDeleted, WorkflowVisualBuildCreateInput } from "../src/v2/gen/types.gen"

test("generates the authoritative minimal v3 Session deletion event", () => {
  const event = {
    id: "evt_sdk_v3_deleted",
    type: "session.deleted",
    properties: {
      sessionID: "ses_sdk_v3_deleted",
      visibility: "public",
      timeDeleted: 1,
    },
  } satisfies EventSessionDeleted

  expect(Object.keys(event.properties).sort()).toEqual(["sessionID", "timeDeleted", "visibility"])
})

test("generates the bounded-header visual-build SDK operation", async () => {
  let captured: Request | undefined
  const fetch = Object.assign(
    async (request: RequestInfo | URL, init?: RequestInit) => {
      captured = request instanceof Request ? request : new Request(request, init)
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch
  const client = createOpencodeClient({ baseUrl: "http://opencode.local", fetch })
  const input = {
    prompt: "Build a generated SDK visual",
    budget: { maxAttempts: 2, maxTokens: 2_000, maxTurns: 4, maxToolCalls: 8 },
    visual: { maxRevisions: 1, maxTokens: 1_000, maxTurns: 2, maxToolCalls: 4 },
    delivery: "background",
  } satisfies WorkflowVisualBuildCreateInput

  await client.workflow.visualBuildCreate({
    "idempotency-key": "sdk-js-visual-build",
    workflowVisualBuildCreateInput: input,
  })

  expect(captured?.method).toBe("POST")
  expect(new URL(captured!.url).pathname).toBe("/api/workflow/visual-build")
  expect(captured?.headers.get("idempotency-key")).toBe("sdk-js-visual-build")
  expect(await captured?.json()).toEqual(input)
})
