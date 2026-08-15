import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import { assertTask21CassetteSafe, makeTask21LiveBudget, redactTask21Body } from "../script/task21-live-contract"
import { LLM, MediaPart, Message, ToolCallPart } from "../src"
import { DeepSeek, Kimi } from "../src/providers"
import { authorizeTask21RecordedRequest } from "./recorded-golden"
import { it } from "./lib/effect"

test("Task21 dry-run prints the complete hard budget without credentials or network", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== "DEEPSEEK_API_KEY" &&
        entry[0] !== "MOONSHOT_API_KEY" &&
        entry[0] !== "RECORD" &&
        entry[0] !== "TASK21_LIVE_TOKEN_CEILING",
    ),
  )
  const child = Bun.spawn([process.execPath, "run", "script/setup-recording-env.ts", "--task21-dry-run"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(exitCode).toBe(0)
  expect(stderr).toBe("")
  expect(stdout).toContain("Task21 live contract dry-run (no requests sent)")
  expect(stdout).toContain("kimi-k3 | 1 provider request | max output 256 tokens")
  expect(stdout).toContain("POST https://api.moonshot.cn/v1/chat/completions")
  expect(stdout).toContain("1x1 PNG + compact review prompt + strict approved/summary JSON schema")
  expect(stdout).toContain("deepseek-v4-flash | at most 2 provider requests | max output 128 tokens each")
  expect(stdout).toContain("POST https://api.deepseek.com/responses")
  expect(stdout).toContain("turn 1: prompt + read_file function schema")
  expect(stdout).toContain("turn 2: function call + function output; no tools")
  expect(stdout).toContain("Planned interactions: 2")
  expect(stdout).toContain("Maximum provider requests: 3")
  expect(stdout).toContain("Hard generated-token ceiling: 512")
  expect(stdout).toContain("Required approval: TASK21_LIVE_TOKEN_CEILING=512")
  expect(stdout).not.toContain("Validating credentials")
})

test("Task21 golden file registers the two filtered live-contract scenarios offline", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== "DEEPSEEK_API_KEY" &&
        entry[0] !== "MOONSHOT_API_KEY" &&
        entry[0] !== "RECORD" &&
        entry[0] !== "TASK21_LIVE_TOKEN_CEILING",
    ),
  )
  const child = Bun.spawn([process.execPath, "test", "test/provider/golden.recorded.test.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...env, RECORDED_PREFIX: "kimi-k3,deepseek-responses" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const output = `${stdout}\n${stderr}`

  expect(exitCode).toBe(0)
  expect(output).toContain("design vision review")
  expect(output).toContain("flash text tool")
  expect(output).toContain("0 fail")
})

test("recording env check exposes Kimi without reading or printing the credential", async () => {
  const packageDir = path.resolve(import.meta.dir, "..")
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "MOONSHOT_API_KEY",
    ),
  )
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      path.join(packageDir, "script/setup-recording-env.ts"),
      "--check",
      "--providers",
      "kimi",
      "--env",
      path.join(packageDir, ".env.task21-missing"),
    ],
    {
      cwd: path.resolve(packageDir, "../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const output = `${stdout}\n${stderr}`

  expect(exitCode).toBe(0)
  expect(output).toContain("Kimi K3")
  expect(output).toContain("missing MOONSHOT_API_KEY")
  expect(output).not.toContain("fixture-kimi-key")
})

test("Task21 recording requires both credentials, exact filters, and the displayed approval", () => {
  const base = {
    RECORD: "true",
    RECORDED_PREFIX: "kimi-k3,deepseek-responses",
    DEEPSEEK_API_KEY: "fixture-deepseek-key",
    MOONSHOT_API_KEY: "fixture-kimi-key",
  }

  expect(() => makeTask21LiveBudget(base)).toThrow("TASK21_LIVE_TOKEN_CEILING=512")
  expect(() => makeTask21LiveBudget({ ...base, TASK21_LIVE_TOKEN_CEILING: "511" })).toThrow(
    "TASK21_LIVE_TOKEN_CEILING=512",
  )
  expect(() =>
    makeTask21LiveBudget({ ...base, TASK21_LIVE_TOKEN_CEILING: "512", RECORDED_PREFIX: "deepseek-responses" }),
  ).toThrow("RECORDED_PREFIX=kimi-k3,deepseek-responses")
  expect(() =>
    makeTask21LiveBudget({ ...base, TASK21_LIVE_TOKEN_CEILING: "512", MOONSHOT_API_KEY: undefined }),
  ).toThrow("MOONSHOT_API_KEY")

  expect(() => makeTask21LiveBudget({ ...base, TASK21_LIVE_TOKEN_CEILING: "512" })).not.toThrow()
})

test("Task21 budget validates actual request bodies and rejects a fourth provider request", () => {
  const budget = makeTask21LiveBudget({
    RECORD: "true",
    RECORDED_PREFIX: "kimi-k3,deepseek-responses",
    TASK21_LIVE_TOKEN_CEILING: "512",
    DEEPSEEK_API_KEY: "fixture-deepseek-key",
    MOONSHOT_API_KEY: "fixture-kimi-key",
  })

  budget.authorize("design-vision-review", {
    model: "kimi-k3",
    max_completion_tokens: 256,
    messages: [{ role: "user", content: "review" }],
  })
  budget.authorize("flash-text-tool", {
    model: "deepseek-v4-flash",
    max_output_tokens: 128,
    input: "call the tool",
  })
  budget.authorize("flash-text-tool", {
    model: "deepseek-v4-flash",
    max_output_tokens: 128,
    input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
  })

  expect(budget.snapshot()).toEqual({ providerRequests: 3, generatedTokenCeiling: 512 })
  expect(() =>
    budget.authorize("flash-text-tool", {
      model: "deepseek-v4-flash",
      max_output_tokens: 1,
      input: "extra request",
    }),
  ).toThrow("provider request limit")
})

test("Task21 budget rejects wrong models, excessive output, and oversized inputs before sending", () => {
  const approved = {
    RECORD: "true",
    RECORDED_PREFIX: "kimi-k3,deepseek-responses",
    TASK21_LIVE_TOKEN_CEILING: "512",
    DEEPSEEK_API_KEY: "fixture-deepseek-key",
    MOONSHOT_API_KEY: "fixture-kimi-key",
  }

  expect(() =>
    makeTask21LiveBudget(approved).authorize("flash-text-tool", {
      model: "deepseek-v4-pro",
      max_output_tokens: 128,
      input: "wrong model",
    }),
  ).toThrow("deepseek-v4-flash")
  expect(() =>
    makeTask21LiveBudget(approved).authorize("design-vision-review", {
      model: "kimi-k3",
      max_completion_tokens: 257,
      messages: [],
    }),
  ).toThrow("max output 256")
  expect(() =>
    makeTask21LiveBudget(approved).authorize("design-vision-review", {
      model: "kimi-k3",
      max_completion_tokens: 256,
      messages: [{ role: "user", content: "x".repeat(8_192) }],
    }),
  ).toThrow("request body exceeds 8192 UTF-8 bytes")
  expect(() =>
    makeTask21LiveBudget(approved).authorize("flash-text-tool", {
      model: "deepseek-v4-flash",
      max_output_tokens: 128,
      input: "x".repeat(12_288),
    }),
  ).toThrow("request body exceeds 12288 UTF-8 bytes")
})

it.effect("Task21 authorizes the three real lowered provider requests within the hard ceiling", () =>
  Effect.gen(function* () {
    const budget = makeTask21LiveBudget({
      RECORD: "true",
      RECORDED_PREFIX: "kimi-k3,deepseek-responses",
      TASK21_LIVE_TOKEN_CEILING: "512",
      DEEPSEEK_API_KEY: "fixture-deepseek-key",
      MOONSHOT_API_KEY: "fixture-kimi-key",
    })
    const kimi = Kimi.configure({ apiKey: "fixture-kimi-key" }).model("kimi-k3")
    const deepseek = DeepSeek.configure({ apiKey: "fixture-deepseek-key" }).responses("deepseek-v4-flash")

    yield* authorizeTask21RecordedRequest(
      budget,
      "design-vision-review",
      LLM.request({
        model: kimi,
        messages: [
          Message.user([
            MediaPart.make({ mediaType: "image/png", data: new Uint8Array([0, 1, 2, 3]) }),
            Message.text("Review this tiny reference."),
          ]),
        ],
        responseFormat: {
          type: "json",
          schema: {
            type: "object",
            properties: { approved: { type: "boolean" }, summary: { type: "string" } },
            required: ["approved", "summary"],
            additionalProperties: false,
          },
        },
        generation: { maxTokens: 256 },
        providerOptions: { kimi: { reasoningEffort: "low" } },
      }),
    )

    const first = LLM.request({
      model: deepseek,
      prompt: "Call read_file once.",
      tools: [
        {
          name: "read_file",
          description: "Read one file.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
      toolChoice: { type: "tool", name: "read_file" },
      generation: { maxTokens: 128 },
    })
    yield* authorizeTask21RecordedRequest(budget, "flash-text-tool", first)
    yield* authorizeTask21RecordedRequest(
      budget,
      "flash-text-tool",
      LLM.updateRequest(first, {
        messages: [
          ...first.messages,
          Message.assistant(ToolCallPart.make({ id: "call_1", name: "read_file", input: { path: "tokens.json" } })),
          Message.tool({ id: "call_1", name: "read_file", result: { primary: "#0057ff" } }),
        ],
      }),
    )

    expect(budget.snapshot()).toEqual({ providerRequests: 3, generatedTokenCeiling: 512 })
  }),
)

test("Task21 redacts volatile provider IDs and personal paths before cassette persistence", () => {
  const redacted = redactTask21Body(
    'data: {"id":"resp_123456789","request_id":"req_123456789","call_id":"call_123456789","item_id":"550e8400-e29b-41d4-a716-446655440000","same_item":"550e8400-e29b-41d4-a716-446655440000","other_item":"7d444840-9dc0-4f43-9d9d-05a4559e3401","created":1770000000,"created_at":1770000001,"completed_at":1770000002,"path":"C:\\\\Users\\\\Ada\\\\project","chat":"chatcmpl-123456789"}\n\n',
  )

  expect(redacted).toContain('"id":"resp_task21"')
  expect(redacted).toContain('"request_id":"[REDACTED]"')
  expect(redacted).toContain('"call_id":"call_task21"')
  expect(redacted.match(/uuid_task21_1/g)).toHaveLength(2)
  expect(redacted).toContain('"other_item":"uuid_task21_2"')
  expect(redacted).toContain('"created":0')
  expect(redacted).toContain('"created_at":0')
  expect(redacted).toContain('"completed_at":0')
  expect(redacted).toContain('"path":"[PERSONAL_PATH]"')
  expect(redacted).toContain('"chat":"chatcmpl-task21"')
  expect(() => assertTask21CassetteSafe({ response: { body: redacted } })).not.toThrow()
})

test("Task21 cassette audit rejects secrets, auth state, volatile IDs, and personal paths", () => {
  expect(() =>
    assertTask21CassetteSafe({
      request: {
        headers: { authorization: "not-redacted", cookie: "not-redacted" },
        body: '{"api_key":"not-redacted","request_id":"req_987654321","id":"550e8400-e29b-41d4-a716-446655440000","created":1770000000}',
      },
      response: { body: "C:\\\\Users\\\\Ada\\\\private.txt" },
    }),
  ).toThrow("unsafe Task21 cassette")

  expect(() =>
    assertTask21CassetteSafe({
      request: { headers: { authorization: "[REDACTED]", cookie: "[REDACTED]" }, body: "{}" },
      response: { body: 'data: {"id":"resp_task21"}\n\n' },
    }),
  ).not.toThrow()

  expect(() =>
    assertTask21CassetteSafe({
      request: { headers: { authorization: "[REDACTED]" }, body: "{}" },
      response: {
        body: 'data: {"id":"550e8400-e29b-41d4-a716-446655440000","completed_at":1770000000}\n\n',
      },
    }),
  ).toThrow("unsafe Task21 cassette")

  expect(() =>
    assertTask21CassetteSafe({
      response: { body: 'data: {"id":"01890f47-e1b7-7cc2-a6c3-8b8f9b35c5a1"}\n\n' },
    }),
  ).toThrow("unsafe Task21 cassette")

  try {
    assertTask21CassetteSafe({ response: { body: 'data: {"id":"req_987654321"}\n\n' } })
    throw new Error("expected Task21 cassette audit to reject a volatile provider id")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain("volatile provider id")
    expect(message).not.toContain("req_987654321")
  }
})
