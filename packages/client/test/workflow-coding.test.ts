import { expect, test } from "bun:test"
import { OpenCode } from "../src"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

test("generated coding admission uses the exact public body and preserves global Location/auth plus idempotency headers", async () => {
  const requests: Request[] = []
  const workflow = {
    id: "wfl_coding",
    type: "coding-build",
    status: "queued",
    input: {},
    budget: { maxAttempts: 27 },
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
    version: 1,
    time: { created: 1, updated: 1 },
  }
  const response = {
    id: "resp_coding",
    workflowID: workflow.id,
    model: "offline",
    status: "queued",
    background: true,
    store: true,
    requestHash: "offline",
    output: [],
    createdAt: 1,
  }
  const client = OpenCode.make({
    baseUrl: "http://localhost",
    headers: { "x-opencode-directory": encodeURIComponent("D:\\coding-fixture"), Authorization: "Basic offline" },
    fetch: async (url, init) => {
      requests.push(new Request(url, init))
      return Response.json({ data: { workflow, response } })
    },
  })
  const input = {
    prompt: "Fix a library",
    budget: { maxAttempts: 27 },
    coding: { maxRevisions: 1, maxTokens: 12000, maxTurns: 12, maxToolCalls: 24 },
    checks: { cwd: ".", test: "bun-test" as const },
    delivery: "background" as const,
  }
  expect(await client.workflows.codingBuildCreate({ ...input, "idempotency-key": "coding-once" })).toEqual({
    workflow,
    response,
  })
  expect(requests[0].url).toBe("http://localhost/api/workflow/coding-build")
  expect(requests[0].headers.get("x-opencode-directory")).toBe(encodeURIComponent("D:\\coding-fixture"))
  expect(requests[0].headers.get("authorization")).toBe("Basic offline")
  expect(requests[0].headers.get("idempotency-key")).toBe("coding-once")
  expect(await requests[0].json()).toEqual(input)
})

test("generated Effect client exposes the same coding contract without importing a host runtime", async () => {
  const { OpenCode } = await import("../src/effect")
  const http = HttpClient.make((request) => {
    expect(request.method).toBe("POST")
    expect(request.url).toBe("http://localhost/api/workflow/coding-build")
    expect(request.headers["idempotency-key"]).toBe("effect-coding-once")
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          data: {
            workflow: {
              id: "wfl_coding",
              type: "coding-build",
              status: "queued",
              input: {},
              budget: { maxAttempts: 27 },
              usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
              version: 1,
              time: { created: 1, updated: 1 },
            },
            response: {
              id: "resp_coding",
              workflowID: "wfl_coding",
              model: "offline",
              status: "queued",
              background: true,
              store: true,
              requestHash: "offline",
              output: [],
              createdAt: 1,
            },
          },
        }),
      ),
    )
  })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* OpenCode.make({ baseUrl: "http://localhost" })
      return yield* client.workflows.codingBuildCreate({
        prompt: "Fix a library",
        checks: { cwd: ".", test: "bun-test" },
        budget: { maxAttempts: 27 },
        coding: { maxRevisions: 1, maxTokens: 12000, maxTurns: 12, maxToolCalls: 24 },
        delivery: "background",
        "idempotency-key": "effect-coding-once",
      })
    }).pipe(Effect.provideService(HttpClient.HttpClient, http)),
  )
  expect(result.response.workflowID).toBe(result.workflow.id)
})
