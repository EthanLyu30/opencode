import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { activateWorkflowModel, formatModelChoices } from "../../src/cli/cmd/workflow-models"
import { observeWorkflow } from "../../src/cli/cmd/workflow"
import { fixtureAdmissionSnapshot } from "../../../core/test/fixtures/workflow-model-catalog"

function view(): WorkflowModelCatalog.View {
  const profile = WorkflowModelCatalog.adapterProfile("deepseek-responses-v4-v1")!
  const entry = {
    providerID: "deepseek",
    modelID: "deepseek-pro-successor-fixture",
    displayName: "Offline candidate",
    family: "deepseek-pro",
    predecessor: "deepseek-v4-pro",
    advertisedRevision: "fixture-v1",
    contextWindow: 8192,
    maxOutputTokens: 1024,
    capabilities: [...profile.capabilities],
    effortLevels: [...profile.effortLevels],
    protocol: profile.protocol,
    adapterProfileID: profile.id,
    adapterProfileSha256: profile.wireContractSha256,
    priceSha256: "b".repeat(64),
    evidence: [
      {
        url: "https://api-docs.deepseek.com/api/create-response/",
        sha256: "c".repeat(64),
        observedAt: 0,
        contractRevision: "offline-only",
      },
    ],
    availability: "available",
    compatibility: "supported",
    lifecycle: "current",
    missingObservation: null,
  }
  return Schema.decodeUnknownSync(WorkflowModelCatalog.View)({
    head: {
      schemaVersion: 1,
      scopeSha256: "a".repeat(64),
      generation: 1,
      catalogueSha256: "c".repeat(64),
      policySha256: "d".repeat(64),
      sha256: "e".repeat(64),
    },
    catalogue: {
      schemaVersion: 1,
      scopeSha256: "a".repeat(64),
      observedAt: 0,
      models: [entry],
      sha256: "c".repeat(64),
    },
    policy: {
      schemaVersion: 1,
      scopeSha256: "a".repeat(64),
      choices: {
        "kimi-flagship": { providerID: "kimi", modelID: "kimi-k3" },
        "deepseek-pro": { providerID: "deepseek", modelID: "deepseek-v4-pro" },
        "deepseek-flash": { providerID: "deepseek", modelID: "deepseek-v4-flash" },
      },
      sha256: "d".repeat(64),
    },
    stale: false,
    refreshStatus: "idle",
    failureCode: null,
  })
}
describe("confirmed workflow model choices", () => {
  test.each([true, false])("volatile displayed views reach trusted fresh confirmation (yes=%s)", async (yes) => {
    const current = { ...view(), stale: true }
    const requests: WorkflowModelCatalog.ActivationInput[] = []
    await activateWorkflowModel({
      client: {
        list: async () => current,
        activate: async (input) => {
          requests.push(input)
          return current
        },
      },
      family: "deepseek-pro",
      modelID: "deepseek-pro-successor-fixture",
      yes,
      interactive: !yes,
      confirm: async () => true,
      preview: () => undefined,
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.expectedHeadSha256).toBe(current.head!.sha256)
  })
  test("progress uses the admitted model ID instead of today's static generation label", async () => {
    const lines: string[] = []
    const event = (seq: number, type: string, data: unknown) => ({
      id: `evt_${seq}`,
      type,
      data,
      durable: { aggregateID: "wfl_model_progress", seq, version: 1 },
    })
    const created = event(0, "workflow.created", {
      workflowID: "wfl_model_progress",
      timestamp: 0,
      type: "visual-build",
      input: {
        "workflow.model-selection.v1": {
          schemaVersion: 1,
          locationSha256: "a".repeat(64),
          snapshot: fixtureAdmissionSnapshot(true),
          sha256: "b".repeat(64),
        },
      },
      budget: {},
      stages: [
        {
          id: "wfs_model_progress",
          type: "design",
          ordinal: 0,
          maxAttempts: 1,
          recoveryPolicy: "restart_safe",
          idempotencyKey: "model-progress",
          input: { revision: 0 },
        },
      ],
    })
    await observeWorkflow({
      workflowID: "wfl_model_progress",
      signal: new AbortController().signal,
      client: {
        events: () => ({
          async *[Symbol.asyncIterator]() {
            yield created
            yield event(1, "workflow.stage.started", {
              workflowID: "wfl_model_progress",
              stageID: "wfs_model_progress",
              timestamp: 1,
              attempt: 1,
              leaseOwner: "offline",
            })
            yield event(2, "workflow.succeeded", {
              workflowID: "wfl_model_progress",
              timestamp: 2,
              usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
            })
          },
        }),
        history: async () => ({ data: [], hasMore: false }),
        get: async () => {
          throw new Error("unused")
        },
      },
      onProgress: (line) => lines.push(line),
    })
    expect(lines[0]).toBe("kimi/kimi-k3-successor-fixture design r0 started")
  })
  test("noninteractive activation without --yes cannot mutate", async () => {
    let mutations = 0
    await expect(
      activateWorkflowModel({
        client: {
          list: async () => view(),
          activate: async () => {
            mutations++
            return view()
          },
        },
        family: "deepseek-pro",
        modelID: "deepseek-pro-successor-fixture",
        yes: false,
        interactive: false,
        preview: () => undefined,
      }),
    ).rejects.toThrow()
    expect(mutations).toBe(0)
  })
  test("declined confirmation retains its displayed head", async () => {
    let mutations = 0
    const previews: string[] = []
    const result = await activateWorkflowModel({
      client: {
        list: async () => view(),
        activate: async () => {
          mutations++
          return view()
        },
      },
      family: "deepseek-pro",
      modelID: "deepseek-pro-successor-fixture",
      yes: false,
      interactive: true,
      confirm: async () => false,
      preview: (line) => previews.push(line),
    })
    expect(result).toBeUndefined()
    expect(mutations).toBe(0)
    expect(previews.join("\n")).toContain("deepseek-v4-pro → deepseek-pro-successor-fixture")
    expect(previews.join("\n")).toContain("implement")
    expect(previews.join("\n")).toContain("repair")
    expect(previews.join("\n")).toContain("deliver")
    expect(previews.join("\n")).toContain("pinned")
  })
  test("--yes sends only the exact displayed CAS head and identifiers", async () => {
    const requests: unknown[] = []
    await activateWorkflowModel({
      client: {
        list: async () => view(),
        activate: async (input) => {
          requests.push(input)
          return view()
        },
      },
      family: "deepseek-pro",
      modelID: "deepseek-pro-successor-fixture",
      yes: true,
      interactive: false,
      preview: () => undefined,
    })
    expect(requests).toEqual([
      {
        expectedHeadSha256: "e".repeat(64),
        replacements: [{ family: "deepseek-pro", providerID: "deepseek", modelID: "deepseek-pro-successor-fixture" }],
      },
    ])
  })
  test("unverified candidates are visible but cannot be enabled", async () => {
    const candidate = view()
    const unknown = {
      ...candidate,
      catalogue: {
        ...candidate.catalogue!,
        models: candidate.catalogue!.models.map((entry) => ({
          ...entry,
          compatibility: "unverified" as const,
          priceSha256: null,
        })),
      },
    }
    let mutations = 0
    const lines = formatModelChoices(unknown).join("\n")
    expect(lines).toContain("deepseek-pro-successor-fixture")
    expect(lines).toContain("unverified")
    expect(lines).toContain("unknown")
    await expect(
      activateWorkflowModel({
        client: {
          list: async () => unknown,
          activate: async () => {
            mutations++
            return candidate
          },
        },
        family: "deepseek-pro",
        modelID: "deepseek-pro-successor-fixture",
        yes: true,
        interactive: false,
        preview: () => undefined,
      }),
    ).rejects.toThrow()
    expect(mutations).toBe(0)
  })
  test("a stale CAS conflict is not retried with a newly fetched head", async () => {
    let reads = 0
    let mutations = 0
    await expect(
      activateWorkflowModel({
        client: {
          list: async () => {
            reads++
            return view()
          },
          activate: async () => {
            mutations++
            throw new Error("selection_conflict")
          },
        },
        family: "deepseek-pro",
        modelID: "deepseek-pro-successor-fixture",
        yes: true,
        interactive: false,
        preview: () => undefined,
      }),
    ).rejects.toThrow("selection_conflict")
    expect(reads).toBe(1)
    expect(mutations).toBe(1)
  })
})
