import { describe, expect, test } from "bun:test"
import { LLM } from "@opencode-ai/llm"
import { WorkflowModelExecution } from "@opencode-ai/core/workflow/execution/model"
import { WorkflowBenchmarkTransport } from "@opencode-ai/core/workflow/benchmark-transport"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { Workflow } from "@opencode-ai/schema/workflow"
import { DateTime } from "effect"

const now = 1_800_000_000_000
const grant = "task24-broker-grant-that-is-long-and-random-000001"
const budget: Workflow.Budget = { maxTokens: 20_000, maxTurns: 20, maxToolCalls: 40, maxAttempts: 3 }

const profile = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  schemaVersion: 1,
  campaignID: "task24-campaign-001",
  runID: "task24-run-001",
  brokerOrigin: "http://127.0.0.1:43191",
  providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
  expiresAt: now + 60_000,
  grant,
  ...overrides,
})

const binding = () =>
  WorkflowBenchmarkTransport.freezeProfile({
    authority: "server",
    profile: profile(),
    expectedCampaignID: "task24-campaign-001",
    expectedRunID: "task24-run-001",
    now,
  })

describe("WorkflowBenchmarkTransport", () => {
  test("freezes a nonsecret, self-authenticating loopback binding", () => {
    const result = binding()

    expect(result).toMatchObject({
      kind: "workflow.benchmark-transport.v1",
      campaignID: "task24-campaign-001",
      runID: "task24-run-001",
      brokerOrigin: "http://127.0.0.1:43191",
      providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
      expiresAt: now + 60_000,
    })
    expect(result.grantSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.bindingSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(result)).not.toContain(grant)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.providerPaths)).toBe(true)
  })

  test.each([
    ["remote host", { brokerOrigin: "https://api.deepseek.com" }],
    ["IPv6 loopback", { brokerOrigin: "http://[::1]:43191" }],
    ["userinfo", { brokerOrigin: "http://user:pass@127.0.0.1:43191" }],
    ["query", { brokerOrigin: "http://127.0.0.1:43191?token=bad" }],
    ["fragment", { brokerOrigin: "http://127.0.0.1:43191#grant" }],
    ["origin path", { brokerOrigin: "http://127.0.0.1:43191/v1" }],
    ["wrong Kimi path", { providerPaths: { kimi: "/v1/deepseek", deepseek: "/v1/deepseek" } }],
  ])("rejects an unsafe %s", (_label, override) => {
    expect(() =>
      WorkflowBenchmarkTransport.freezeProfile({
        authority: "server",
        profile: profile(override),
        expectedCampaignID: "task24-campaign-001",
        expectedRunID: "task24-run-001",
        now,
      }),
    ).toThrow()
  })

  test("rejects expired grants and mismatched campaign/run authority", () => {
    const freeze = (overrides: Readonly<Record<string, unknown>>, campaign = "task24-campaign-001") =>
      WorkflowBenchmarkTransport.freezeProfile({
        authority: "server",
        profile: profile(overrides),
        expectedCampaignID: campaign,
        expectedRunID: "task24-run-001",
        now,
      })

    expect(() => freeze({ expiresAt: now })).toThrow(/expired/i)
    expect(() => freeze({}, "another-campaign")).toThrow(/campaign/i)
    expect(() =>
      WorkflowBenchmarkTransport.freezeProfile({
        authority: "server",
        profile: profile(),
        expectedCampaignID: "task24-campaign-001",
        expectedRunID: "another-run",
        now,
      }),
    ).toThrow(/run/i)
  })

  test("keeps Kimi Chat and DeepSeek Responses native while binding their loopback bases", () => {
    const transport = binding()
    const kimi = WorkflowRouting.resolve({ role: "design", budget, benchmarkTransport: transport, now })
    const deepseek = WorkflowRouting.resolve({ role: "implement", budget, benchmarkTransport: transport, now })

    expect(kimi.protocol).toBe("openai-chat")
    expect(kimi.model.route.protocol).toBe("openai-chat")
    expect(kimi.model.route.endpoint.baseURL).toBe("http://127.0.0.1:43191/v1/kimi")
    expect(deepseek.protocol).toBe("openai-responses")
    expect(deepseek.model.route.protocol).toBe("openai-responses")
    expect(deepseek.model.route.endpoint.baseURL).toBe("http://127.0.0.1:43191/v1/deepseek")
  })

  test("persists recovery authority and never falls back to a public provider endpoint", () => {
    const transport = binding()
    const workflow = Workflow.Info.make({
      id: Workflow.ID.make("wfl_task24_transport"),
      type: "visual-build",
      status: "running",
      input: WorkflowBenchmarkTransport.withBinding({ prompt: "Build it" }, transport),
      budget,
      usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
      version: 1,
      time: { created: DateTime.makeUnsafe(now), updated: DateTime.makeUnsafe(now) },
    })

    const recovered = WorkflowBenchmarkTransport.fromWorkflow(workflow, now + 1)
    const route = WorkflowRouting.resolve({
      role: "visual_review",
      budget,
      benchmarkTransport: recovered,
      now: now + 1,
    })

    expect(recovered).toEqual(transport)
    expect(route.model.route.endpoint.baseURL).toBe("http://127.0.0.1:43191/v1/kimi")
    expect(route.model.route.endpoint.baseURL).not.toBe("https://api.moonshot.cn/v1")
    expect(() => WorkflowBenchmarkTransport.fromWorkflow(workflow, now + 60_001)).toThrow(/expired/i)
  })

  test("binds provider request fingerprints without including the grant", () => {
    const direct = WorkflowRouting.resolve({ role: "implement", budget })
    const measured = WorkflowRouting.resolve({ role: "implement", budget, benchmarkTransport: binding(), now })
    const fingerprint = (route: WorkflowRouting.Route) =>
      WorkflowModelExecution.fingerprintProviderRequest({
        request: LLM.request({ model: route.model, prompt: "Implement the page" }),
        route,
        contractFingerprint: "contract-sha256",
        sequence: 1,
        catalogFingerprint: "catalog-sha256",
      })

    expect(fingerprint(measured)).not.toBe(fingerprint(direct))
    expect(JSON.stringify(measured)).not.toContain(grant)
  })

  test("rejects a missing, mismatched, or expired persisted benchmark grant", () => {
    const transport = binding()

    expect(() => WorkflowBenchmarkTransport.verifyGrant(transport, undefined, now + 1)).toThrow(/missing/i)
    expect(() =>
      WorkflowBenchmarkTransport.verifyGrant(transport, "wrong-grant-value-that-is-long-enough", now + 1),
    ).toThrow(/match/i)
    expect(() => WorkflowBenchmarkTransport.verifyGrant(transport, grant, now + 60_001)).toThrow(/expired/i)
    expect(() => WorkflowBenchmarkTransport.verifyGrant(transport, grant, now + 1)).not.toThrow()
  })
})
