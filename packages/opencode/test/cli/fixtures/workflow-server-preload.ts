import { Server } from "../../../src/server/server"

const scenario = process.env.OPENCODE_TEST_WORKFLOW_SCENARIO ?? "success"
const workflowID = "wfl_fixture"
const responseID = "resp_fixture"
const state = {
  admissionAttempts: 0,
  admissionAccepted: false,
  admissionKey: undefined as string | undefined,
  eventConnections: 0,
  terminalAvailable: false,
  terminalReads: [] as string[],
}

const app = Server.Default().app
app.fetch = async (request) => fixtureFetch(request)

async function fixtureFetch(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "POST" && url.pathname === "/api/workflow/visual-build") return admission(request)
  if (request.method === "GET" && url.pathname === `/api/workflow/${workflowID}/event`) return events(request)
  if (request.method === "GET" && url.pathname === `/api/workflow/${workflowID}/history`) return history(url)
  if (request.method === "GET" && url.pathname === `/api/workflow/${workflowID}`) return workflowGet()
  if (request.method === "GET" && url.pathname === `/v1/responses/${responseID}`) return responseGet()
  if (request.method === "GET" && url.pathname === `/api/workflow/${workflowID}/artifact`) return artifactsGet()
  if (request.method === "POST" && url.pathname === `/api/workflow/${workflowID}/cancel`) return cancel(request)
  return Response.json({ message: "unexpected fixture request" }, { status: 500 })
}

async function admission(request: Request) {
  state.admissionAttempts++
  const key = request.headers.get("idempotency-key")
  if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    return Response.json({ message: "invalid retry identity" }, { status: 400 })
  }
  if (state.admissionKey === undefined) state.admissionKey = key
  if (state.admissionKey !== key) return Response.json({ message: "retry identity changed" }, { status: 409 })
  if (request.headers.get("x-opencode-directory") !== encodeURIComponent(process.cwd())) {
    return Response.json({ message: "location header mismatch" }, { status: 400 })
  }

  const body: unknown = await request.json()
  if (
    !isRecord(body) ||
    JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["budget", "delivery", "prompt", "visual"]) ||
    body.prompt !== "Build the fixture" ||
    body.delivery !== "background" ||
    JSON.stringify(body.budget) !==
      JSON.stringify({
        maxTokens: 20_000,
        maxTurns: 20,
        maxToolCalls: 40,
        maxAttempts: 3,
        maxDurationMs: 1_800_000,
      }) ||
    JSON.stringify(body.visual) !==
      JSON.stringify({ maxRevisions: 1, maxTokens: 12_000, maxTurns: 12, maxToolCalls: 24 }) ||
    /directory|workspace|model|provider|url|command|argv/i.test(JSON.stringify(body))
  ) {
    return Response.json({ message: "unsafe or unexpected admission payload" }, { status: 400 })
  }

  if (scenario === "transport") throw new Error("raw-error-secret")
  if (scenario === "success" && state.admissionAttempts === 1) throw new Error("fixture transport retry")
  if (state.admissionAccepted) return Response.json({ message: "duplicate admission" }, { status: 409 })
  state.admissionAccepted = true
  return Response.json({ data: { workflow: workflow("queued", 1), response: response("queued", 1) } })
}

function events(request: Request) {
  const url = new URL(request.url)
  if (scenario === "schema") {
    return sse([{ type: "workflow.created", data: { workflowID, raw: "raw-error-secret" } }])
  }
  if (scenario === "sigint") {
    if (url.searchParams.has("after")) return Response.json({ message: "unexpected reconnect" }, { status: 500 })
    setTimeout(() => process.emit("SIGINT"), 20)
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), {
            once: true,
          })
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  }

  if (scenario === "success") {
    const connection = state.eventConnections++
    if (connection === 0 && url.searchParams.has("after")) {
      return Response.json({ message: "first replay included a cursor" }, { status: 500 })
    }
    if (connection === 1 && url.searchParams.get("after") !== "2") {
      return Response.json({ message: "reconnect cursor was not exclusive" }, { status: 500 })
    }
    if (connection === 0) return sse([created(1), stageStarted(2, "wfs_design")])
    if (connection === 1) return sse([stageStarted(2, "wfs_design"), succeeded(8)])
    return Response.json({ message: "too many reconnects" }, { status: 500 })
  }

  if (url.searchParams.has("after"))
    return Response.json({ message: "first replay included a cursor" }, { status: 500 })
  if (scenario === "approval") return sse([created(1), approval(2)])
  if (scenario === "failed") {
    state.terminalAvailable = true
    return sse([created(1), failed(2)])
  }
  state.terminalAvailable = true
  return sse([created(1), cancelled(2)])
}

function history(url: URL) {
  if (scenario !== "success" || url.searchParams.get("limit") !== "100") {
    return Response.json({ message: "unexpected history request" }, { status: 500 })
  }
  if (url.searchParams.get("after") === "2") {
    return Response.json({ data: [stageStarted(3, "wfs_test_0"), budget(4)], hasMore: true })
  }
  if (url.searchParams.get("after") === "4") {
    state.terminalAvailable = true
    return Response.json({
      data: [stageStarted(5, "wfs_repair_1"), stageStarted(6, "wfs_visual_1"), artifactCreated(7)],
      hasMore: false,
    })
  }
  return Response.json({ message: "unexpected history cursor" }, { status: 500 })
}

function workflowGet() {
  if (scenario === "approval") return Response.json({ data: detail("waiting_approval", 2) })
  if (!state.terminalAvailable) return Response.json({ message: "workflow fetched before terminal" }, { status: 500 })
  state.terminalReads.push("workflow")
  const status = scenario === "failed" ? "failed" : scenario === "cancelled" ? "cancelled" : "succeeded"
  return Response.json({ data: detail(status, scenario === "success" ? 8 : 2) })
}

function responseGet() {
  if (!state.terminalAvailable || state.terminalReads.join(",") !== "workflow") {
    return Response.json({ message: "response fetched out of terminal order" }, { status: 500 })
  }
  state.terminalReads.push("response")
  const status = scenario === "failed" ? "failed" : scenario === "cancelled" ? "cancelled" : "completed"
  return Response.json(response(status, scenario === "success" ? 8 : 2))
}

function artifactsGet() {
  if (!state.terminalAvailable || state.terminalReads.join(",") !== "workflow,response") {
    return Response.json({ message: "artifacts fetched out of terminal order" }, { status: 500 })
  }
  state.terminalReads.push("artifacts")
  if (scenario !== "success") return Response.json({ data: [] })
  return Response.json({
    data: [
      {
        id: "wfa_fixture",
        workflowID,
        stageID: "wfs_deliver",
        kind: "workflow.delivery",
        uri: "workflow://capability/raw-output-secret",
        mime: "application/vnd.opencode.workflow-delivery+json",
        sha256: "sha256:metadata-secret",
        size: 123,
        metadata: {
          secret: "metadata-secret",
          bytes: "data:image/png;base64,raw-output-secret",
          preview: "http://127.0.0.1:4999/capability",
        },
        timeCreated: 8,
      },
      {
        id: "wfa_untrusted",
        workflowID,
        stageID: "wfs_deliver",
        kind: "raw-output-secret",
        uri: "workflow://raw-output-secret",
        mime: "provider-secret/mime",
        sha256: "sha256:metadata-secret",
        size: 7,
        metadata: { secret: "metadata-secret" },
        timeCreated: 8,
      },
    ],
  })
}

async function cancel(request: Request) {
  if (request.signal.aborted) return Response.json({ message: "cancel used aborted signal" }, { status: 499 })
  await Bun.sleep(50)
  console.error("fixture cancellation acknowledged")
  return new Response(null, { status: 204 })
}

function workflow(status: string, updated: number) {
  return {
    id: workflowID,
    type: "visual-build",
    status,
    input: { prompt: "raw-output-secret" },
    budget: { maxTokens: 20_000 },
    usage: status === "queued" ? { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 } : usage(),
    location: { directory: process.cwd() },
    sessionID: "ses_private",
    agent: "provider-secret",
    version: updated,
    time: {
      created: 1,
      updated,
      ...(status === "queued" || status === "waiting_approval" ? {} : { completed: updated }),
    },
  }
}

function detail(status: string, updated: number) {
  return { run: workflow(status, updated), stages: [], artifacts: [] }
}

function response(status: string, updated: number) {
  return {
    id: responseID,
    workflowID,
    model: "provider-secret/model-secret",
    credentials: "credentials-secret",
    previewEnv: { PRIVATE_TOKEN: "preview-env-secret" },
    status,
    background: true,
    store: true,
    requestHash: "raw-output-secret",
    output: [{ type: "message", content: "raw-output-secret" }],
    error: status === "failed" ? { code: "raw-error-secret", message: "raw-error-secret" } : undefined,
    usage: status === "queued" ? undefined : { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    createdAt: 1,
    ...(status === "queued" ? {} : { completedAt: updated }),
  }
}

function created(seq: number) {
  return event(seq, "workflow.created", {
    workflowID,
    timestamp: seq,
    type: "visual-build",
    input: { prompt: "raw-output-secret" },
    budget: { maxTokens: 20_000 },
    stages: [
      stage("wfs_design", "design", 0, 0),
      stage("wfs_test_0", "test", 1, 0),
      stage("wfs_repair_1", "repair", 2, 1),
      stage("wfs_visual_1", "visual_review", 3, 1),
    ],
  })
}

function stage(id: string, type: string, ordinal: number, revision: number) {
  return {
    id,
    type,
    ordinal,
    maxAttempts: 3,
    recoveryPolicy: "restart_safe",
    idempotencyKey: `${type}/r${revision}`,
    input: { revision },
  }
}

function stageStarted(seq: number, stageID: string) {
  return event(seq, "workflow.stage.started", { workflowID, timestamp: seq, stageID, attempt: 1 })
}

function budget(seq: number) {
  return event(seq, "workflow.budget.threshold_reached", {
    workflowID,
    timestamp: seq,
    percent: 80,
    dimension: "tokens",
    usage: usage(),
    budget: { maxTokens: 20_000 },
  })
}

function artifactCreated(seq: number) {
  return event(seq, "workflow.artifact.created", {
    workflowID,
    timestamp: seq,
    stageID: "wfs_visual_1",
    artifact: {
      uri: "workflow://raw-output-secret",
      metadata: { secret: "metadata-secret" },
    },
  })
}

function approval(seq: number) {
  return event(seq, "workflow.approval.requested", {
    workflowID,
    timestamp: seq,
    reason: "budget_exhausted",
    failure: { message: "raw-error-secret" },
  })
}

function succeeded(seq: number) {
  return event(seq, "workflow.succeeded", { workflowID, timestamp: seq, usage: usage() })
}

function failed(seq: number) {
  return event(seq, "workflow.failed", {
    workflowID,
    timestamp: seq,
    failure: { category: "unknown", code: "raw-error-secret", message: "raw-error-secret" },
    usage: usage(),
  })
}

function cancelled(seq: number) {
  return event(seq, "workflow.cancelled", { workflowID, timestamp: seq })
}

function event(seq: number, type: string, data: Record<string, unknown>) {
  return {
    id: `evt_${seq}`,
    type,
    durable: { aggregateID: workflowID, seq, version: 1 },
    metadata: { secret: "metadata-secret" },
    data,
  }
}

function usage() {
  return { tokens: 15, turns: 6, toolCalls: 3, attempts: 2 }
}

function sse(events: ReadonlyArray<Record<string, unknown>>) {
  return new Response(events.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
