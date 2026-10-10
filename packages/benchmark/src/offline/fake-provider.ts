import { canonicalJson } from "../campaign/canonical"
import type { ArmRoute } from "../arms/types"

export type FakeTerminal = "completed" | "incomplete" | "failed" | "malformed_usage"

export interface FakeProviderCall {
  readonly provider: ArmRoute["provider"]
  readonly model: ArmRoute["model"]
  readonly protocol: ArmRoute["protocol"]
  readonly terminal: FakeTerminal
  readonly workflowRole?: WorkflowRole
  readonly workflowRevision?: number
  readonly toolResultDisposition?: "permission_denied"
  readonly webfetchAdvertised: boolean
  readonly requestSha256: string
}

type WorkflowRole = "design" | "decompose" | "implement" | "test" | "visual_review" | "repair" | "deliver"

export interface FakeProvider {
  readonly upstream: (request: Request) => Promise<Response>
  readonly calls: () => readonly FakeProviderCall[]
}

export interface FakeProviderOptions {
  readonly terminals?: readonly FakeTerminal[]
  readonly webfetchURL?: string
}

export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const observed: FakeProviderCall[] = []
  return Object.freeze({
    async upstream(request: Request) {
      const authorization = request.headers.get("authorization")
      if (!authorization?.startsWith("Bearer sk-TASK24_FAKE_")) {
        return Response.json({ error: { code: "TASK24_FAKE_PROVIDER_AUTH_INVALID" } }, { status: 401 })
      }
      const body = await request
        .clone()
        .json()
        .catch(() => undefined)
      if (!record(body) || typeof body.model !== "string") {
        return Response.json({ error: { code: "TASK24_FAKE_PROVIDER_BODY_INVALID" } }, { status: 400 })
      }
      const callIndex = observed.length
      const terminal = options.terminals?.[callIndex] ?? fakeTerminal(body.task24_fake_terminal)
      const workflow = workflowContext(body)
      const toolResultDisposition = deniedToolResult(body) || containsTypedToolResult(body) ? "permission_denied" : undefined
      const provider = request.url.includes("moonshot") ? "kimi" : "deepseek"
      const protocol = provider === "kimi" ? "chat_completions" : "responses"
      const model = body.model
      if (
        (provider === "kimi" && model !== "kimi-k3") ||
        (provider === "deepseek" && model !== "deepseek-v4-pro" && model !== "deepseek-v4-flash")
      ) {
        return Response.json({ error: { code: "TASK24_FAKE_PROVIDER_MODEL_INVALID" } }, { status: 400 })
      }
      const call: FakeProviderCall = Object.freeze({
        provider,
        model: decodeModel(provider, model),
        protocol,
        terminal,
        ...(workflow === undefined ? {} : { workflowRole: workflow.role, workflowRevision: workflow.revision }),
        ...(toolResultDisposition === undefined ? {} : { toolResultDisposition }),
        webfetchAdvertised: containsNamedTool(body, "webfetch"),
        requestSha256: new Bun.CryptoHasher("sha256").update(canonicalJson(body)).digest("hex"),
      })
      observed.push(call)
      const explicitFixture =
        Object.hasOwn(body, "task24_fake_terminal") || options.terminals?.[callIndex] !== undefined
      const content = workflow === undefined ? "TASK24_OFFLINE_BINARY_OK" : workflowEnvelope(workflow)
      const bodyText =
        options.webfetchURL && callIndex === 0 && protocol === "responses"
          ? responsesWebfetchStream(options.webfetchURL)
          : explicitFixture
            ? protocol === "chat_completions"
              ? chatStream(terminal)
              : responsesStream(terminal)
            : workflow === undefined && callIndex === 0
              ? protocol === "chat_completions"
                ? chatPatchStream()
                : responsesPatchStream()
              : protocol === "chat_completions"
                ? chatStream(terminal, content)
                : responsesStream(terminal, content)
      const frames = bodyText.split(/(?<=\n\n)/)
      let frameIndex = 0
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const frame = frames[frameIndex++]
          if (frame === undefined) controller.close()
          else controller.enqueue(new TextEncoder().encode(frame))
        },
      }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
    },
    calls: () => Object.freeze(observed.map((call) => Object.freeze({ ...call }))),
  })
}

function containsNamedTool(value: unknown, name: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsNamedTool(item, name))
  if (!record(value)) return false
  if (value.name === name && (value.type === "function" || record(value.function))) return true
  return Object.values(value).some((item) => containsNamedTool(item, name))
}

function deniedToolResult(value: unknown): boolean {
  const text = [...strings(value)].join("\n").toLowerCase()
  return (
    /(?:permission|access).{0,96}(?:deny|denied|not grant|forbidden)/.test(text) ||
    /(?:deny|denied|forbidden).{0,96}(?:permission|access)/.test(text)
  )
}

function containsTypedToolResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTypedToolResult)
  if (!record(value)) return false
  if (value.type === "function_call_output" || value.type === "custom_tool_call_output" || value.role === "tool") return true
  return Object.values(value).some(containsTypedToolResult)
}

function responsesWebfetchStream(url: string): string {
  const argumentsText = JSON.stringify({ url, format: "text", timeout: 5 })
  const frames = [
    { type: "response.created", sequence_number: 0, response: { id: "resp_offline_webfetch", status: "in_progress" } },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: {
        id: "item_offline_webfetch",
        call_id: "call_offline_webfetch",
        type: "function_call",
        name: "webfetch",
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 2,
      output_index: 0,
      item_id: "item_offline_webfetch",
      delta: argumentsText,
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 3,
      output_index: 0,
      item_id: "item_offline_webfetch",
      arguments: argumentsText,
    },
    {
      type: "response.output_item.done",
      sequence_number: 4,
      output_index: 0,
      item: {
        id: "item_offline_webfetch",
        call_id: "call_offline_webfetch",
        type: "function_call",
        name: "webfetch",
        arguments: argumentsText,
        status: "completed",
      },
    },
    {
      type: "response.completed",
      sequence_number: 5,
      response: { id: "resp_offline_webfetch", status: "completed", output: [], usage: validResponsesUsage },
    },
  ]
  return frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("")
}

function chatPatchStream(): string {
  const patchText = offlinePatch()
  const chunks = [
    {
      id: "chat-offline-patch",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_offline_patch",
                type: "function",
                function: { name: "apply_patch", arguments: JSON.stringify({ patchText }) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
      usage: null,
    },
    {
      id: "chat-offline-patch",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: null,
    },
    {
      id: "chat-offline-patch",
      choices: [],
      usage: {
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens: 6,
        completion_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 16,
      },
    },
  ]
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
}

function responsesPatchStream(): string {
  const patchText = offlinePatch()
  const frames = [
    { type: "response.created", sequence_number: 0, response: { id: "resp_offline_patch", status: "in_progress" } },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: {
        id: "item_offline_patch",
        call_id: "call_offline_patch",
        type: "custom_tool_call",
        name: "apply_patch",
        input: "",
      },
    },
    {
      type: "response.custom_tool_call_input.delta",
      sequence_number: 2,
      output_index: 0,
      item_id: "item_offline_patch",
      delta: patchText,
    },
    {
      type: "response.custom_tool_call_input.done",
      sequence_number: 3,
      output_index: 0,
      item_id: "item_offline_patch",
      input: patchText,
    },
    {
      type: "response.output_item.done",
      sequence_number: 4,
      output_index: 0,
      item: {
        id: "item_offline_patch",
        call_id: "call_offline_patch",
        type: "custom_tool_call",
        name: "apply_patch",
        input: patchText,
        status: "completed",
      },
    },
    {
      type: "response.completed",
      sequence_number: 5,
      response: { id: "resp_offline_patch", status: "completed", output: [], usage: validResponsesUsage },
    },
  ]
  return frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("")
}

function offlinePatch(): string {
  return "*** Begin Patch\n*** Add File: task24-offline-provider-edit.txt\n+TASK24_OFFLINE_BINARY_EDIT\n*** End Patch"
}

export function fakeRequest(route: ArmRoute, terminal: FakeTerminal = "completed"): Record<string, unknown> {
  const common = { model: route.model, stream: true, task24_fake_terminal: terminal }
  return route.protocol === "chat_completions"
    ? {
        ...common,
        max_completion_tokens: 64,
        messages: [{ role: "user", content: "TASK24_OFFLINE_FAKE_INPUT" }],
        tools: [applyPatchChatTool],
      }
    : {
        ...common,
        max_output_tokens: 64,
        input: "TASK24_OFFLINE_FAKE_INPUT",
        tools: [{ type: "custom", name: "apply_patch", description: "Apply a deterministic offline patch" }],
      }
}

function chatStream(terminal: FakeTerminal, content?: string): string {
  if (terminal === "incomplete") return 'data: {"id":"chat-offline","choices":[]}\n\n'
  if (terminal === "failed") return "data: {not-json}\n\ndata: [DONE]\n\n"
  const usage =
    terminal === "malformed_usage"
      ? { prompt_tokens: 2, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens: 1 }
      : {
          prompt_tokens: 10,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens: 6,
          completion_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 16,
        }
  const chunks =
    content === undefined
      ? [
          {
            id: "chat-offline",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_offline",
                      type: "function",
                      function: { name: "apply_patch", arguments: '{"patch":"offline"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { id: "chat-offline", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
        ]
      : [
          { id: "chat-offline", choices: [{ index: 0, delta: { content }, finish_reason: null }], usage: null },
          { id: "chat-offline", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null },
          { id: "chat-offline", choices: [], usage },
        ]
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
}

function responsesStream(terminal: FakeTerminal, content?: string): string {
  if (terminal === "incomplete") return responseTerminal("response.incomplete", validResponsesUsage)
  if (terminal === "failed") return responseTerminal("response.failed", validResponsesUsage)
  const usage =
    terminal === "malformed_usage"
      ? { input_tokens: 1, input_tokens_details: { cached_tokens: 2 }, output_tokens: 1 }
      : validResponsesUsage
  const frames =
    content === undefined
      ? [
          { type: "response.created", sequence_number: 0, response: { id: "resp_offline", status: "in_progress" } },
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: { id: "call_offline", type: "custom_tool_call", name: "apply_patch", input: "" },
          },
          {
            type: "response.custom_tool_call_input.delta",
            sequence_number: 2,
            output_index: 0,
            item_id: "call_offline",
            delta: "*** Begin Patch\\n*** End Patch",
          },
          {
            type: "response.custom_tool_call_input.done",
            sequence_number: 3,
            output_index: 0,
            item_id: "call_offline",
            input: "*** Begin Patch\\n*** End Patch",
          },
          {
            type: "response.completed",
            sequence_number: 4,
            response: { id: "resp_offline", status: "completed", usage },
          },
        ]
      : [
          { type: "response.created", sequence_number: 0, response: { id: "resp_offline", status: "in_progress" } },
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: { id: "message_offline", type: "message", role: "assistant", status: "in_progress", content: [] },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 2,
            output_index: 0,
            item_id: "message_offline",
            content_index: 0,
            delta: content,
            logprobs: [],
          },
          {
            type: "response.output_text.done",
            sequence_number: 3,
            output_index: 0,
            item_id: "message_offline",
            content_index: 0,
            text: content,
            logprobs: [],
          },
          {
            type: "response.output_item.done",
            sequence_number: 4,
            output_index: 0,
            item: {
              id: "message_offline",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: content, annotations: [], logprobs: [] }],
            },
          },
          {
            type: "response.completed",
            sequence_number: 5,
            response: { id: "resp_offline", status: "completed", output: [], usage },
          },
        ]
  return frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("")
}

function responseTerminal(type: "response.incomplete" | "response.failed", usage: object): string {
  const frame = { type, sequence_number: 0, response: { id: "resp_offline", status: type.slice(9), usage } }
  return `event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`
}

const validResponsesUsage = {
  input_tokens: 12,
  input_tokens_details: { cached_tokens: 5 },
  output_tokens: 8,
  output_tokens_details: { reasoning_tokens: 3 },
  total_tokens: 20,
}

const applyPatchChatTool = {
  type: "function",
  function: {
    name: "apply_patch",
    description: "Apply a deterministic offline patch",
    parameters: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] },
  },
}

function workflowContext(value: unknown): { readonly role: WorkflowRole; readonly revision: number } | undefined {
  for (const text of strings(value)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    if (!record(parsed) || !record(parsed.stage)) continue
    const role = parsed.stage.role
    const revision = parsed.stage.revision
    if (workflowRole(role) && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) {
      return { role, revision }
    }
  }
  return undefined
}

function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* strings(item)
    return
  }
  if (!record(value)) return
  for (const item of Object.values(value)) yield* strings(item)
}

function workflowEnvelope(input: { readonly role: WorkflowRole; readonly revision: number }): string {
  const referenceSource = "<!doctype html><html><body><main>Task24 offline reference</main></body></html>"
  const referenceSha256 = new Bun.CryptoHasher("sha256").update(referenceSource).digest("hex")
  const payloads: Readonly<Record<WorkflowRole, unknown>> = {
    design: {
      spec: {
        schemaVersion: 1,
        goals: ["Render the deterministic Task24 reference"],
        routes: [{ path: "/", goal: "Show the reference" }],
        layoutConstraints: ["Keep the main content visible"],
        componentTree: [{ id: "root", component: "main", children: [] }],
        states: [{ name: "ready", description: "The page is ready" }],
        typography: [{ token: "body", family: "sans-serif", weight: 400, sizePx: 16, lineHeight: 1.5 }],
        colors: [{ token: "background", value: "#ffffff" }],
        responsiveRules: [{ viewport: "desktop", width: 1280, height: 720, rules: ["Keep main visible"] }],
        accessibilityRules: ["Use semantic landmarks"],
        acceptanceCriteria: ["The deterministic reference renders"],
        projectStack: ["HTML"],
        referenceApp: {
          entrypoint: "index.html",
          readySelector: "main",
          files: [{ path: "index.html", sha256: referenceSha256, size: Buffer.byteLength(referenceSource) }],
          viewports: [{ name: "desktop", width: 1280, height: 720 }],
        },
      },
      sources: [{ path: "index.html", content: referenceSource }],
    },
    decompose: {
      acceptanceCriteria: ["The deterministic implementation is complete"],
      tasks: [
        {
          id: "implement-page",
          title: "Implement page",
          description: "Build the deterministic page.",
          acceptanceCriteria: ["The page renders"],
          dependsOn: [],
          files: ["src/app.ts"],
        },
      ],
    },
    implement: { summary: "Implemented the deterministic page." },
    test: { summary: "Executed the deterministic functional test." },
    visual_review: { verdict: "pass", score: 100, findings: [] },
    repair: { summary: "Repaired the deterministic page." },
    deliver: { summary: "The deterministic page is complete." },
  }
  const verdict =
    input.role === "deliver"
      ? "complete"
      : input.role === "test"
        ? input.revision === 0
          ? "revise"
          : "pass"
        : input.role === "visual_review"
          ? "pass"
          : "ready"
  return JSON.stringify({
    contractVersion: 1,
    outcome: { schemaVersion: 1, role: input.role, verdict, revision: input.revision },
    payload: payloads[input.role],
  })
}

function workflowRole(value: unknown): value is WorkflowRole {
  return (
    value === "design" ||
    value === "decompose" ||
    value === "implement" ||
    value === "test" ||
    value === "visual_review" ||
    value === "repair" ||
    value === "deliver"
  )
}

function fakeTerminal(value: unknown): FakeTerminal {
  if (value === undefined || value === "completed") return "completed"
  if (value === "incomplete" || value === "failed" || value === "malformed_usage") return value
  throw new TypeError("TASK24_FAKE_PROVIDER_TERMINAL_INVALID")
}

function decodeModel(provider: "kimi" | "deepseek", value: string): ArmRoute["model"] {
  if (provider === "kimi" && value === "kimi-k3") return value
  if (provider === "deepseek" && (value === "deepseek-v4-pro" || value === "deepseek-v4-flash")) return value
  throw new TypeError("TASK24_FAKE_PROVIDER_MODEL_INVALID")
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
