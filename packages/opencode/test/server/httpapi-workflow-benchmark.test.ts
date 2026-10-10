import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Context } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { WorkflowExecution } from "@opencode-ai/core/workflow/execution"
import { WorkflowBenchmarkTransport } from "@opencode-ai/core/workflow/benchmark-transport"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

test("production CLI HTTP routes persist trusted benchmark authority at admission", async () => {
  const root = path.join("D:\\OpenCode-Benchmark\\Task24\\runs", `httpapi-transport-${crypto.randomUUID()}`)
  const file = path.join(root, "transport.json")
  const names = [
    "OPENCODE_BENCHMARK_TRANSPORT_FILE",
    "OPENCODE_BENCHMARK_RUN_DATA_ROOT",
    "OPENCODE_BENCHMARK_CAMPAIGN_ID",
    "OPENCODE_BENCHMARK_RUN_ID",
  ] as const
  const prior = names.map((name) => process.env[name])
  await fs.mkdir(root)
  const grant = "task24-httpapi-test-grant-000000000000000001"
  await fs.writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      campaignID: "httpapi-campaign",
      runID: "httpapi-run",
      brokerOrigin: "http://127.0.0.1:43191",
      providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
      evidenceMode: "deterministic_offline",
      expiresAt: Date.now() + 60_000,
      grant,
    }),
  )
  for (const [index, value] of [file, root, "httpapi-campaign", "httpapi-run"].entries())
    process.env[names[index]] = value
  const app = HttpRouter.toWebHandler(
    HttpApiApp.createRoutes(undefined, { workflowExecution: WorkflowExecution.node }),
    { disableLogger: true },
  )
  try {
    await using workspace = await tmpdir({
      git: true,
      init: async (directory) => {
        await fs.writeFile(path.join(directory, "index.html"), "<!doctype html><title>fixture</title>")
        await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
      },
    })
    const response = await app.handler(
      new Request("http://localhost/api/workflow/visual-build", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": encodeURIComponent(workspace.path),
          "idempotency-key": "httpapi-transport-once",
        },
        body: JSON.stringify({
          prompt: "Build a dashboard",
          budget: { maxTokens: 20000, maxTurns: 20, maxToolCalls: 40, maxAttempts: 3, maxDurationMs: 1800000 },
          visual: { maxRevisions: 1, maxTokens: 12000, maxTurns: 12, maxToolCalls: 24 },
          delivery: "background",
        }),
      }),
      Context.makeUnsafe<unknown>(new Map()),
    )
    const body = await response.json()
    expect({ status: response.status, body }).toMatchObject({ status: 200 })
    expect(WorkflowBenchmarkTransport.fromWorkflow(body.data.workflow)).toMatchObject({
      campaignID: "httpapi-campaign",
      runID: "httpapi-run",
      evidenceMode: "deterministic_offline",
    })
    expect(JSON.stringify(body)).not.toContain(grant)
  } finally {
    await app.dispose()
    await resetDatabase()
    for (const [index, name] of names.entries()) {
      if (prior[index] === undefined) delete process.env[name]
      else process.env[name] = prior[index]
    }
    await fs.rm(root, { recursive: true, force: true })
  }
})
