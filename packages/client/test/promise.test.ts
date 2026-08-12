import { expect, test } from "bun:test"
import { isSessionNotFoundError, isUnauthorizedError, OpenCode } from "../src"

test("exposes every standard HTTP API group", () => {
  const client = OpenCode.make({ baseUrl: "http://localhost:3000" })

  expect(Object.keys(client)).toEqual([
    "health",
    "location",
    "agents",
    "sessions",
    "workflows",
    "responses",
    "conversations",
    "messages",
    "models",
    "providers",
    "integrations",
    "credentials",
    "permissions",
    "files",
    "commands",
    "skills",
    "events",
    "ptys",
    "questions",
    "references",
    "projectCopies",
  ])
  expect(Object.keys(client.responses)).toEqual(["create", "get", "delete", "cancel", "inputItems", "events"])
  expect(Object.keys(client.conversations)).toEqual(["create", "get", "delete", "appendItem", "items"])
  expect(Object.keys(client.messages)).toEqual(["list"])
  expect(Object.keys(client.integrations)).toEqual([
    "list",
    "get",
    "connectKey",
    "connectOauth",
    "attemptStatus",
    "attemptComplete",
    "attemptCancel",
  ])
  expect(Object.keys(client.files)).toEqual(["list", "find"])
  expect(Object.keys(client.ptys)).toEqual(["list", "create", "get", "update", "remove"])
})

test("workflow methods use the public HTTP contract", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (url.includes("/event")) {
        return new Response(`data: ${JSON.stringify(workflowCreatedEvent)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      if (url.includes("/history")) return Response.json({ data: [workflowCreatedEvent], hasMore: false })
      if (url.includes("/artifact")) return Response.json({ data: [] })
      if (url.endsWith("/budget")) return Response.json(workflowInfo)
      if (url.endsWith("/recovery") || url.endsWith("/cancel")) return new Response(null, { status: 204 })
      if (url.endsWith("/wfl_test")) return Response.json(workflowDetail)
      if (init?.method === "POST") return Response.json(workflowInfo)
      return Response.json({ data: [workflowInfo.data] })
    },
  })

  const created = await client.workflows.create(workflowCreateInput)
  const list = await client.workflows.list({ limit: 10 })
  const detail = await client.workflows.get({ workflowID: "wfl_test" })
  const history = await client.workflows.history({ workflowID: "wfl_test", after: 0, limit: 10 })
  const events = []
  for await (const event of client.workflows.events({ workflowID: "wfl_test", after: 0 })) events.push(event)
  const artifacts = await client.workflows.artifacts({ workflowID: "wfl_test" })
  await client.workflows.cancel({ workflowID: "wfl_test" })
  const updated = await client.workflows.updateBudget({ workflowID: "wfl_test", budget: { maxAttempts: 4 } })
  await client.workflows.resolveRecovery({ workflowID: "wfl_test", stageID: "wfs_design", action: "retry" })

  expect(created.id).toBe("wfl_test")
  expect(list).toEqual([workflowInfo.data])
  expect(detail.run.id).toBe("wfl_test")
  expect(history).toEqual({ data: [workflowCreatedEvent], hasMore: false })
  expect(events).toEqual([workflowCreatedEvent])
  expect(artifacts).toEqual([])
  expect(updated.budget).toEqual({ maxAttempts: 3 })
  expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
    ["POST", "http://localhost:3000/api/workflow"],
    ["GET", "http://localhost:3000/api/workflow?limit=10"],
    ["GET", "http://localhost:3000/api/workflow/wfl_test"],
    ["GET", "http://localhost:3000/api/workflow/wfl_test/history?limit=10&after=0"],
    ["GET", "http://localhost:3000/api/workflow/wfl_test/event?after=0"],
    ["GET", "http://localhost:3000/api/workflow/wfl_test/artifact"],
    ["POST", "http://localhost:3000/api/workflow/wfl_test/cancel"],
    ["POST", "http://localhost:3000/api/workflow/wfl_test/budget"],
    ["POST", "http://localhost:3000/api/workflow/wfl_test/stage/wfs_design/recovery"],
  ])
})

test("sessions.get returns the wire projection", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      expect(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).toBe(
        "http://localhost:3000/api/session/ses_test",
      )
      return Response.json(session)
    },
  })

  const result = await client.sessions.get({ sessionID: "ses_test" })

  expect(result.time.created).toBe(1_717_171_717_000)
})

test("events.subscribe exposes the Promise event stream wire projection", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(
        `: heartbeat\n\ndata: ${JSON.stringify({ id: "evt_connected", type: "server.connected", data: {} })}\n\n` +
          `data: ${JSON.stringify(modelSwitchedEvent)}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const events = []
  for await (const event of client.events.subscribe()) events.push(event)

  expect(events).toEqual([{ id: "evt_connected", type: "server.connected", data: {} }, modelSwitchedEvent])
  expect(events[1]?.type === "session.next.model.switched" && events[1].data.timestamp).toBe(1_717_171_717_000)
})

test("events.subscribe terminates on malformed Promise SSE data", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () => new Response("data: {not-json}\n\n", { headers: { "content-type": "text/event-stream" } }),
  })

  await expect(client.events.subscribe()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    name: "ClientError",
    reason: "MalformedResponse",
  })
})

test("session methods use the public HTTP contract", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  let historyPage = 0
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (url.includes("/event")) {
        return new Response(`data: ${JSON.stringify(modelSwitchedEvent)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      if (url.includes("/history")) {
        historyPage++
        return Response.json(
          historyPage === 1 ? { data: [modelSwitchedEvent], hasMore: true } : { data: [], hasMore: false },
        )
      }
      if (url.includes("/prompt")) return Response.json(admission)
      if (url.includes("/context")) return Response.json({ data: [] })
      if (url.includes("/message/")) return Response.json({ data: modelSwitchedMessage })
      if (url.endsWith("/api/session/active")) return Response.json({ data: { ses_test: { type: "running" } } })
      if (init?.method === "POST" && url.endsWith("/api/session")) return Response.json(session)
      if (init?.method === "POST") return new Response(null, { status: 204 })
      return Response.json({ data: [session.data], cursor: { next: "next" } })
    },
  })

  const page = await client.sessions.list({ limit: 10, order: "desc" })
  const active = await client.sessions.active()
  const created = await client.sessions.create({ location: { directory: "/tmp/project" } })
  await client.sessions.switchAgent({ sessionID: "ses_test", agent: "build" })
  await client.sessions.switchModel({
    sessionID: "ses_test",
    model: { id: "claude", providerID: "anthropic" },
  })
  const admitted = await client.sessions.prompt({
    sessionID: "ses_test",
    prompt: { text: "Hello" },
    resume: false,
  })
  await client.sessions.compact({ sessionID: "ses_test" })
  await client.sessions.wait({ sessionID: "ses_test" })
  const context = await client.sessions.context({ sessionID: "ses_test" })
  const history = await client.sessions.history({ sessionID: "ses_test", after: 0, limit: 1 })
  const historyAfter = history.data.at(-1)?.durable?.seq
  const historyNext = history.hasMore
    ? await client.sessions.history({ sessionID: "ses_test", after: historyAfter, limit: 2 })
    : undefined
  const events = []
  for await (const event of client.sessions.events({ sessionID: "ses_test", after: 0 })) events.push(event)
  await client.sessions.interrupt({ sessionID: "ses_test" })
  const message = await client.sessions.message({ sessionID: "ses_test", messageID: "msg_model" })

  expect(page.cursor.next).toBe("next")
  expect(active).toEqual({ ses_test: { type: "running" } })
  expect(created.id).toBe("ses_test")
  expect(admitted.id).toBe("msg_test")
  expect(context).toEqual([])
  expect(history).toEqual({ data: [modelSwitchedEvent], hasMore: true })
  expect(historyNext).toEqual({ data: [], hasMore: false })
  expect(events).toEqual([modelSwitchedEvent])
  expect(message).toEqual(modelSwitchedMessage)
  expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
    ["GET", "http://localhost:3000/api/session?limit=10&order=desc"],
    ["GET", "http://localhost:3000/api/session/active"],
    ["POST", "http://localhost:3000/api/session"],
    ["POST", "http://localhost:3000/api/session/ses_test/agent"],
    ["POST", "http://localhost:3000/api/session/ses_test/model"],
    ["POST", "http://localhost:3000/api/session/ses_test/prompt"],
    ["POST", "http://localhost:3000/api/session/ses_test/compact"],
    ["POST", "http://localhost:3000/api/session/ses_test/wait"],
    ["GET", "http://localhost:3000/api/session/ses_test/context"],
    ["GET", "http://localhost:3000/api/session/ses_test/history?limit=1&after=0"],
    ["GET", "http://localhost:3000/api/session/ses_test/history?limit=2&after=1"],
    ["GET", "http://localhost:3000/api/session/ses_test/event?after=0"],
    ["POST", "http://localhost:3000/api/session/ses_test/interrupt"],
    ["GET", "http://localhost:3000/api/session/ses_test/message/msg_model"],
  ])
  const body = requests.find((request) => request.url.endsWith("/api/session/ses_test/prompt"))?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toEqual({
    prompt: { text: "Hello" },
    resume: false,
  })
})

test("middleware errors remain declared client errors", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      Response.json({ _tag: "UnauthorizedError", message: "Authentication required" }, { status: 401 }),
  })

  try {
    await client.sessions.create({})
    throw new Error("Expected request to fail")
  } catch (error) {
    expect(isUnauthorizedError(error)).toBe(true)
  }
})

test("sessions.history decodes SessionNotFoundError", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      Response.json(
        { _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Session not found" },
        { status: 404 },
      ),
  })

  try {
    await client.sessions.history({ sessionID: "ses_missing" })
    throw new Error("Expected request to fail")
  } catch (error) {
    expect(isSessionNotFoundError(error)).toBe(true)
  }
})

test("responses methods preserve the native Responses wire contract", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (url.endsWith("/event?after=1")) {
        return new Response(`data: ${JSON.stringify(responseCompletedEvent)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      if (url.endsWith("/input_items")) return Response.json({ data: [responseInputItem] })
      if (init?.method === "DELETE") return new Response(null, { status: 204 })
      return Response.json(responseResource)
    },
  })

  const created = await client.responses.create(responseCreateInput)
  const retrieved = await client.responses.get({ responseID: "resp_test" })
  const cancelled = await client.responses.cancel({ responseID: "resp_test" })
  const inputItems = await client.responses.inputItems({ responseID: "resp_test" })
  const events = []
  for await (const event of client.responses.events({ responseID: "resp_test", after: 1 })) events.push(event)
  await client.responses.delete({ responseID: "resp_test" })

  expect(created).toEqual(responseResource)
  expect(retrieved).toEqual(responseResource)
  expect(cancelled).toEqual(responseResource)
  expect(inputItems).toEqual([responseInputItem])
  expect(events).toEqual([responseCompletedEvent])
  expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
    ["POST", "http://localhost:3000/v1/responses"],
    ["GET", "http://localhost:3000/v1/responses/resp_test"],
    ["POST", "http://localhost:3000/v1/responses/resp_test/cancel"],
    ["GET", "http://localhost:3000/v1/responses/resp_test/input_items"],
    ["GET", "http://localhost:3000/v1/responses/resp_test/event?after=1"],
    ["DELETE", "http://localhost:3000/v1/responses/resp_test"],
  ])
  const body = requests[0]?.init?.body
  if (typeof body !== "string") throw new Error("Expected Responses JSON request body")
  expect(JSON.parse(body)).toEqual(responseCreateInput)
})

test("mixed Responses POST classifies JSON, SSE, transport, and content-type failures", async () => {
  const encoder = new TextEncoder()
  const event = JSON.stringify({ type: "response.completed", sequence_number: 1, data: {} })
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { requestHash: string }
      if (request.requestHash.endsWith("declared")) {
        return Response.json(
          { _tag: "InvalidRequestError", message: "declared", kind: "invalid_model" },
          { status: 400 },
        )
      }
      if (request.requestHash.endsWith("wrong-content-type")) {
        return new Response("not json", { headers: { "content-type": "text/plain" } })
      }
      if (request.requestHash.endsWith("malformed-json")) {
        return new Response("{not-json", { headers: { "content-type": "application/json" } })
      }
      if (request.requestHash.endsWith("reader-error")) {
        let reads = 0
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (reads++ === 0) controller.enqueue(encoder.encode(`data: ${event}\n\n`))
              else controller.error(new Error("reader failed"))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${event}\r`))
            controller.enqueue(encoder.encode("\n\r"))
            controller.enqueue(encoder.encode("\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const create = (suffix: string) =>
    client.responses.create({ ...responseCreateInput, stream: true, requestHash: `sha256:mixed:${suffix}` })

  await expect(create("declared")).rejects.toMatchObject({ _tag: "InvalidRequestError", kind: "invalid_model" })
  await expect(create("wrong-content-type")).rejects.toMatchObject({
    name: "ClientError",
    reason: "UnsupportedContentType",
  })
  await expect(create("malformed-json")).rejects.toMatchObject({
    name: "ClientError",
    reason: "MalformedResponse",
  })

  const crlf = await create("crlf")
  if (!(Symbol.asyncIterator in Object(crlf))) throw new Error("Expected CRLF SSE branch")
  const crlfEvents = []
  for await (const item of crlf) crlfEvents.push(item)
  expect(crlfEvents).toEqual([{ type: "response.completed", sequence_number: 1, data: {} }])

  const broken = await create("reader-error")
  if (!(Symbol.asyncIterator in Object(broken))) throw new Error("Expected failing SSE branch")
  const iterator = broken[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual({ type: "response.completed", sequence_number: 1, data: {} })
  await expect(iterator.next()).rejects.toMatchObject({ name: "ClientError", reason: "Transport" })
})

const session = {
  data: {
    id: "ses_test",
    projectID: "project",
    cost: 0,
    tokens: {
      input: 1,
      output: 2,
      reasoning: 3,
      cache: { read: 4, write: 5 },
    },
    time: {
      created: 1_717_171_717_000,
      updated: 1_717_171_717_000,
    },
    title: "Test",
    location: { directory: "/tmp/project" },
  },
}

const admission = {
  data: {
    admittedSeq: 0,
    id: "msg_test",
    sessionID: "ses_test",
    prompt: { text: "Hello" },
    delivery: "steer",
    timeCreated: 1_717_171_717_000,
  },
}

const modelSwitchedMessage = {
  id: "msg_model",
  type: "model-switched",
  time: { created: 1_717_171_717_000 },
  model: { id: "claude", providerID: "anthropic" },
}

const modelSwitchedEvent = {
  id: "evt_model",
  type: "session.next.model.switched",
  durable: { aggregateID: "ses_test", seq: 1, version: 1 },
  data: {
    timestamp: 1_717_171_717_000,
    sessionID: "ses_test",
    messageID: "msg_model",
    model: { id: "claude", providerID: "anthropic" },
  },
}

const workflowCreateInput = {
  type: "development",
  input: { brief: "Build" },
  budget: { maxAttempts: 3 },
  stages: [
    {
      id: "wfs_design",
      type: "design",
      ordinal: 0,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe" as const,
      idempotencyKey: "design",
      input: {},
    },
  ],
}

const workflowInfo = {
  data: {
    id: "wfl_test",
    type: "development",
    status: "queued" as const,
    input: { brief: "Build" },
    budget: { maxAttempts: 3 },
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
    version: 1,
    time: { created: 1_717_171_717_000, updated: 1_717_171_717_000 },
  },
}

const workflowDetail = {
  data: {
    run: workflowInfo.data,
    stages: [
      {
        id: "wfs_design",
        workflowID: "wfl_test",
        type: "design",
        ordinal: 0,
        status: "pending",
        attempt: 0,
        maxAttempts: 3,
        recoveryPolicy: "restart_safe",
        idempotencyKey: "design",
        input: {},
        time: { created: 1_717_171_717_000, updated: 1_717_171_717_000 },
      },
    ],
    artifacts: [],
  },
}

const workflowCreatedEvent = {
  id: "evt_workflow",
  type: "workflow.created",
  durable: { aggregateID: "wfl_test", seq: 1, version: 1 },
  data: {
    workflowID: "wfl_test",
    timestamp: 1_717_171_717_000,
    type: "development",
    input: { brief: "Build" },
    budget: { maxAttempts: 3 },
    stages: workflowCreateInput.stages,
  },
}

const responseCreateInput = {
  id: "resp_test",
  workflowID: "wfl_test",
  model: "deepseek-v4-flash",
  background: false,
  store: true,
  previous_response_id: "resp_parent",
  requestHash: "sha256:response-test",
  input: [{ type: "message", role: "user", content: "Continue" }],
}

const responseResource = {
  id: "resp_test",
  workflowID: "wfl_test",
  model: "deepseek-v4-flash",
  status: "completed" as const,
  background: false,
  store: true,
  previousResponseID: "resp_parent",
  requestHash: "sha256:response-test",
  output: [{ type: "message", role: "assistant", content: "Done" }],
  usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
  createdAt: 1_717_171_717_000,
  completedAt: 1_717_171_718_000,
}

const responseInputItem = {
  responseID: "resp_test",
  ordinal: 0,
  kind: "input" as const,
  payload: { type: "message", role: "user", content: "Continue" },
}

const responseCompletedEvent = {
  type: "response.completed" as const,
  sequence_number: 2,
  data: {
    responseID: "resp_test",
    timestamp: 1_717_171_718_000,
    output: [{ type: "message", role: "assistant", content: "Done" }],
    usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
  },
}
