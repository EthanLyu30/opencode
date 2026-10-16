import { Server } from "../../../src/server/server"

const workflowID = "wfl_coding"
const responseID = "resp_coding"
const usage = { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 }
let key: string | null = null
let attempts = 0
const workflow = (status: string) => ({
  id: workflowID,
  type: "coding-build",
  status,
  input: {},
  budget: { maxAttempts: 27 },
  usage,
  version: 1,
  time: { created: 1, updated: 1 },
})
const response = (status: string) => ({
  id: responseID,
  workflowID,
  model: "offline-fixture",
  status,
  background: true,
  store: true,
  requestHash: "offline",
  output: [],
  createdAt: 1,
})
Server.Default().app.fetch = async (request) => {
  if (process.env.OPENCODE_TEST_CODING_REJECT === "1") {
    console.error("CODING_ADMISSION_CALLED")
    return Response.json({ message: "invalid options reached server" }, { status: 500 })
  }
  const url = new URL(request.url)
  if (request.method === "POST" && url.pathname === "/api/workflow/coding-build") {
    const incomingKey = request.headers.get("idempotency-key")
    if (attempts++ === 0) key = incomingKey
    if (
      !key ||
      incomingKey !== key ||
      request.headers.get("x-opencode-directory") !== encodeURIComponent(process.cwd())
    )
      throw new Error("coding retry/location mismatch")
    const body = await request.json()
    if (
      JSON.stringify(body) !==
      JSON.stringify({
        prompt: "Fix the coding fixture",
        budget: { maxTokens: 20000, maxTurns: 20, maxToolCalls: 40, maxAttempts: 27, maxDurationMs: 1800000 },
        coding: { maxRevisions: 1, maxTokens: 12000, maxTurns: 12, maxToolCalls: 24 },
        checks: { cwd: ".", test: "bun-test" },
        delivery: "background",
      })
    )
      return Response.json({ message: "unsafe coding body" }, { status: 400 })
    if (attempts === 1) throw new Error("offline transport retry")
    return Response.json({ data: { workflow: workflow("queued"), response: response("queued") } })
  }
  if (url.pathname === `/api/workflow/${workflowID}/event`) {
    const event = (seq: number, type: string, data: object) => ({
      id: `evt_coding_${seq}`,
      type,
      durable: { aggregateID: workflowID, seq, version: 1 },
      data: { workflowID, timestamp: seq, ...data },
    })
    const events = [
      event(0, "workflow.created", {
        type: "coding-build",
        input: {},
        budget: { maxAttempts: 27 },
        stages: [
          {
            id: "wfs_review",
            type: "code_review",
            ordinal: 0,
            maxAttempts: 3,
            recoveryPolicy: "restart_safe",
            idempotencyKey: "review/0",
            input: { revision: 0 },
          },
        ],
      }),
      event(1, "workflow.stage.started", { stageID: "wfs_review", attempt: 1 }),
      event(2, "workflow.succeeded", { usage }),
    ]
    return new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  }
  if (url.pathname === `/api/workflow/${workflowID}`)
    return Response.json({ data: { run: workflow("succeeded"), stages: [], artifacts: [] } })
  if (url.pathname === `/v1/responses/${responseID}`) return Response.json(response("completed"))
  if (url.pathname === `/api/workflow/${workflowID}/artifact`)
    return Response.json({
      data: [
        {
          id: "wfa_coding_delivery",
          workflowID,
          stageID: "wfs_deliver",
          kind: "workflow.coding.delivery",
          mime: "application/vnd.opencode.workflow-coding-delivery+json",
          uri: "workflow://private-source",
          sha256: "a".repeat(64),
          size: 1,
          metadata: { secret: "offline-artifact-canary" },
          timeCreated: 1,
        },
      ],
    })
  return Response.json({ message: "unexpected coding fixture route" }, { status: 500 })
}
