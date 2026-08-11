import { describe, expect, test } from "bun:test"
import { WorkflowDesignArtifact } from "@opencode-ai/core/workflow/artifacts/design"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"
import { WorkflowRender } from "@opencode-ai/core/workflow/render"
import { WorkflowStageMachine } from "@opencode-ai/core/workflow/stage-machine"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"

const referenceSource = "<main data-render-ready>Reference</main>"
const hash = createHash("sha256").update(referenceSource).digest("hex")
const usage = (tokens: number) => ({ tokens, turns: 1, toolCalls: 0, attempts: 0 })

const spec = {
  schemaVersion: 1 as const,
  goals: ["Let users review a release"],
  routes: [{ path: "/releases/:id", goal: "Review one release" }],
  layoutConstraints: ["Keep the primary action above the fold"],
  componentTree: [{ id: "page", component: "ReleasePage", children: ["approve"] }],
  states: [{ name: "ready", description: "Release data is visible" }],
  typography: [{ token: "body", family: "Inter", weight: 400, sizePx: 16, lineHeight: 1.5 }],
  colors: [{ token: "surface", value: "#ffffff" }],
  responsiveRules: [
    { viewport: "desktop", width: 1440, height: 900, rules: ["Use two columns"] },
    { viewport: "mobile", width: 390, height: 844, rules: ["Use one column"] },
  ],
  accessibilityRules: ["All controls have accessible names"],
  acceptanceCriteria: ["The approve action remains visible"],
  projectStack: ["html", "css", "javascript"],
  referenceApp: {
    entrypoint: "index.html",
    readySelector: "[data-render-ready]",
    files: [{ path: "index.html", sha256: hash, size: new TextEncoder().encode(referenceSource).byteLength }],
    viewports: [
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 390, height: 844 },
    ],
  },
}

const finding = (revision: number) => ({
  schemaVersion: 1 as const,
  revision,
  verdict: "fail" as const,
  score: 80,
  limits: { maxRevisions: 1, maxTokens: 20_000, maxTurns: 20, maxToolCalls: 20 },
  usage: { tokens: 300, turns: 1, toolCalls: 0 },
  evidence: [],
  findings: [
    {
      id: `visual-${revision}`,
      severity: "major" as const,
      viewport: "desktop",
      selector: "#approve",
      region: "primary action",
      category: "spacing" as const,
      expected: "Matches the reference",
      actual: "Has extra margin",
      evidenceImageIDs: ["reference-desktop", `implementation-desktop-r${revision}`],
      repair: "Remove the extra margin",
      requiresRecapture: true,
    },
  ],
})

describe("Kimi design and visual review loop", () => {
  test("uses the stage-machine authority for bounded visual repair decisions", () => {
    expect(
      WorkflowStageMachine.decideVisualRepair({
        revision: 1,
        maxRevisions: 1,
        budget: { maxTokens: 100, maxTurns: 3, maxToolCalls: 2 },
        usage: { tokens: 20, turns: 1, toolCalls: 0, attempts: 0 },
      }),
    ).toEqual({ type: "approval", reason: "max_revisions" })
    expect(
      WorkflowStageMachine.decideVisualRepair({
        revision: 0,
        maxRevisions: 1,
        budget: { maxTokens: 100, maxTurns: 3, maxToolCalls: 2 },
        usage: { tokens: 100, turns: 1, toolCalls: 0, attempts: 0 },
      }),
    ).toEqual({ type: "approval", reason: "budget_exhausted" })
  })

  test("renders Kimi's app, reviews paired images, repairs once, and passes", async () => {
    const calls: string[] = []
    let reviewCount = 0
    const result = await WorkflowRender.run({
      workflowID: Workflow.ID.make("wfl_visual_loop"),
      limits: { maxRevisions: 1, maxTokens: 20_000, maxTurns: 20, maxToolCalls: 20 },
      design: () => {
        calls.push("kimi:design")
        return Effect.succeed({
          spec,
          referenceApp: {
            url: "http://reference.test/index.html",
            files: [{ path: "index.html", content: referenceSource }],
          },
          usage: usage(500),
        })
      },
      implement: () => {
        calls.push("deepseek:implement")
        return Effect.succeed({ url: "http://implementation.test/index.html", usage: usage(800) })
      },
      repair: ({ review }) => {
        calls.push(`deepseek:repair:${review.revision}`)
        return Effect.succeed({ url: "http://implementation.test/repaired.html", usage: usage(400) })
      },
      review: ({ message, evidence, revision, route }) => {
        calls.push(`kimi:review:${revision}`)
        expect(route).toEqual({ providerID: "kimi", modelID: "kimi-k3", protocol: "openai-chat" })
        const media = message.content.filter((part) => part.type === "media")
        expect(media).toHaveLength(4)
        expect(media.every((part) => part.type === "media" && part.mediaType === "image/png")).toBe(true)
        expect(new Set(evidence.map((item) => item.kind))).toEqual(new Set(["reference", "implementation"]))
        reviewCount++
        if (reviewCount === 1) return Effect.succeed({ review: { ...finding(revision), evidence }, usage: usage(300) })
        return Effect.succeed({
          review: {
            ...finding(revision),
            verdict: "pass" as const,
            score: 100,
            evidence,
            findings: [],
          },
          usage: usage(300),
        })
      },
      capture: ({ kind, viewport, revision }) => {
        calls.push(`browser:${kind}:${viewport.name}:r${revision}`)
        return Effect.succeed(new TextEncoder().encode(`${kind}:${viewport.name}:r${revision}`))
      },
    }).pipe(Effect.runPromise)

    expect(result.status).toBe("passed")
    expect(result.revision).toBe(1)
    expect(calls).toEqual([
      "kimi:design",
      "browser:reference:desktop:r0",
      "browser:reference:mobile:r0",
      "deepseek:implement",
      "browser:implementation:desktop:r0",
      "browser:implementation:mobile:r0",
      "kimi:review:0",
      "deepseek:repair:0",
      "browser:implementation:desktop:r1",
      "browser:implementation:mobile:r1",
      "kimi:review:1",
    ])
    expect(result.artifacts.some((item) => item.kind === WorkflowDesignArtifact.SPEC_KIND)).toBe(true)
    expect(result.artifacts.filter((item) => item.kind === WorkflowVisualReviewArtifact.REVIEW_KIND)).toHaveLength(2)
    for (const artifact of result.artifacts) expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("enters approval when the visual revision ceiling is exhausted", async () => {
    const result = await WorkflowRender.run({
      workflowID: Workflow.ID.make("wfl_visual_approval"),
      limits: { maxRevisions: 1, maxTokens: 20_000, maxTurns: 20, maxToolCalls: 20 },
      design: () =>
        Effect.succeed({
          spec,
          referenceApp: {
            url: "http://reference.test/index.html",
            files: [{ path: "index.html", content: referenceSource }],
          },
          usage: usage(1),
        }),
      implement: () => Effect.succeed({ url: "http://implementation.test/index.html", usage: usage(1) }),
      repair: () => Effect.succeed({ url: "http://implementation.test/repaired.html", usage: usage(1) }),
      review: ({ evidence, revision }) =>
        Effect.succeed({ review: { ...finding(revision), evidence }, usage: usage(1) }),
      capture: ({ kind, viewport, revision }) =>
        Effect.succeed(new TextEncoder().encode(`${kind}:${viewport.name}:r${revision}`)),
    }).pipe(Effect.runPromise)

    expect(result).toMatchObject({ status: "approval", reason: "max_revisions", revision: 1 })
  })

  test("artifact codecs reject body/hash mismatches", () => {
    const commit = WorkflowDesignArtifact.commitSpec(Workflow.ID.make("wfl_codec"), spec)
    expect(() => WorkflowDesignArtifact.decodeSpec(commit, JSON.stringify({ ...spec, goals: ["tampered"] }))).toThrow()
    expect(() => Schema.decodeUnknownSync(Workflow.ArtifactCommit)({ ...commit, sha256: "bad" })).toThrow()
  })
})
