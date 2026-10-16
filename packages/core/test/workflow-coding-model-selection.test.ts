import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { Types } from "effect"
import { CodingModelSelection } from "../src/workflow/coding/model-selection"
import { CodingRouting } from "../src/workflow/coding/routing"
import { CodingRoleAgentProfiles } from "../src/workflow/coding/role-agent-profiles"
import { CodingPermissions } from "../src/workflow/coding/permissions"
import { BuildRouting } from "../src/workflow/execution/build-routing"
import { ModelSelection } from "../src/workflow/model-selection"
import { WorkflowBusinessArtifact } from "../src/workflow/artifacts/business"
import { fixtureAdmissionSnapshot } from "./fixtures/workflow-model-catalog"
import { codingBudget, codingLocation, codingFixture, codingLegacyFixture } from "./fixtures/workflow-coding"

describe("Coding frozen model selection", () => {
  test("uses seven explicit coding routes and keeps code review text-only", () => {
    const selection = CodingModelSelection.freeze(fixtureAdmissionSnapshot(), codingLocation)
    const expected = {
      design: ["kimi", "kimi-k3", "openai-chat", "max"],
      decompose: ["kimi", "kimi-k3", "openai-chat", "high"],
      implement: ["deepseek", "deepseek-v4-pro", "openai-responses", "max"],
      test: ["deepseek", "deepseek-v4-flash", "openai-responses", "high"],
      code_review: ["kimi", "kimi-k3", "openai-chat", "max"],
      repair: ["deepseek", "deepseek-v4-pro", "openai-responses", "max"],
      deliver: ["deepseek", "deepseek-v4-pro", "openai-responses", "high"],
    }
    for (const role of WorkflowCodingBuild.Role.literals) {
      const route = CodingRouting.resolve({ role, budget: codingBudget, selection })
      expect([route.providerID, route.modelID, route.protocol, route.reasoningEffort]).toEqual(expected[role])
      expect(route.role).toBe(role)
      expect(Object.isFrozen(route)).toBe(true)
    }
    expect(selection.routes.code_review.requiredCapabilities).not.toContain("vision_input")
    expect(Object.hasOwn(selection.routes, "visual_review")).toBe(false)
  })

  test("pins old choices even when a successor becomes available", () => {
    const original = CodingModelSelection.freeze(fixtureAdmissionSnapshot(), codingLocation)
    const successor = CodingModelSelection.freeze(fixtureAdmissionSnapshot(true), codingLocation)
    expect(CodingModelSelection.validate(original)).toEqual(original)
    expect(CodingRouting.resolve({ role: "code_review", budget: {}, selection: original }).modelID).toBe("kimi-k3")
    expect(CodingRouting.resolve({ role: "code_review", budget: {}, selection: successor }).modelID).toBe(
      "kimi-k3-successor-fixture",
    )
    expect(original.sha256).not.toBe(successor.sha256)
  })

  test("rejects tampered models/protocols/adapters and cross-Location reuse", () => {
    const source = fixtureAdmissionSnapshot()
    for (const changed of [
      { modelID: "kimi-k2.7" },
      { protocol: "openai-responses" as const },
      { adapterProfileSha256: "0".repeat(64) },
    ]) {
      const { sha256, ...original } = source
      const content = { ...original, routes: { ...source.routes, design: { ...source.routes.design, ...changed } } }
      expect(() =>
        CodingModelSelection.freeze({ ...content, sha256: WorkflowBusinessArtifact.hash(content) }, codingLocation),
      ).toThrow()
    }
    const fixture = codingFixture("code_review")
    expect(() => CodingModelSelection.validate({ ...fixture.selection, sha256: "0".repeat(64) })).toThrow()
    expect(() =>
      CodingModelSelection.fromWorkflow({
        ...fixture.workflow,
        location: Location.Ref.make({ directory: AbsolutePath.make("D:/other-coding-location") }),
      }),
    ).toThrow()
  })

  test("rejects non-coding roles and requested provider substitution before any provider call", () => {
    const selection = CodingModelSelection.freeze(fixtureAdmissionSnapshot(), codingLocation)
    expect(() =>
      CodingRouting.resolve({ role: "visual_review" as WorkflowCodingBuild.Role, budget: {}, selection }),
    ).toThrow()
    expect(() =>
      CodingRouting.resolve({
        role: "code_review",
        budget: {},
        selection,
        requested: { providerID: "deepseek", modelID: "deepseek-v4-pro", protocol: "openai-responses" },
      }),
    ).toThrow()
  })

  test("does not reinterpret old persisted seven-role selections", () => {
    const fixture = codingLegacyFixture()
    expect(fixture.selection.sha256).toBe("3efe79ca08ad57621649a119d3326e6c879ce766965c66d3c8be59ca91fd782c")
    expect(ModelSelection.fromWorkflow(fixture.workflow)).toEqual(fixture.selection)
    expect(Object.keys(fixture.selection.snapshot.routes)).toHaveLength(7)
    expect(Object.hasOwn(fixture.selection.snapshot.routes, "code_review")).toBe(false)
    expect(() => CodingModelSelection.fromWorkflow(fixture.workflow)).toThrow()
    expect(BuildRouting.resolve({ workflow: fixture.workflow, stage: fixture.stage }).role).toBe("design")
    const current = codingFixture("code_review")
    expect(BuildRouting.resolve({ workflow: current.workflow, stage: current.stage }).role).toBe("code_review")
  })

  test("reinstalls immutable read-only coding profiles after hostile configuration", () => {
    const agents = new Map<string, Types.DeepMutable<Agent.Info>>()
    CodingRoleAgentProfiles.install({
      update: (id, update) => {
        const agent: Types.DeepMutable<Agent.Info> = {
          id,
          request: { headers: { "x-fixture": "true" }, body: { unsafe: true } },
          mode: "primary",
          hidden: false,
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        }
        Object.assign(agent, { extra: true })
        update(agent)
        agents.set(id, agent)
      },
    })
    for (const role of WorkflowCodingBuild.Role.literals) {
      const id = CodingRoleAgentProfiles.agentForRole(role)
      const agent = agents.get(id)
      expect(CodingRoleAgentProfiles.matches(role, agent)).toBe(true)
      expect(Object.hasOwn(agent!, "extra")).toBe(false)
    }
    const review = agents.get(CodingRoleAgentProfiles.agentForRole("code_review"))!
    expect(review.permissions.filter((rule) => rule.effect === "allow").map((rule) => rule.action)).toEqual([
      "read",
      "glob",
      "grep",
    ])
    expect(
      CodingPermissions.forRole("implement").some((rule) => rule.action === "edit" && rule.effect === "allow"),
    ).toBe(true)
    expect(CodingRoleAgentProfiles.matches("code_review", Object.freeze({ ...review, hidden: false }))).toBe(false)
  })
})
