import { describe, expect, test } from "bun:test"
import { WorkflowDesignArtifact } from "@opencode-ai/core/workflow/artifacts/design"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"
import { WorkflowRender } from "@opencode-ai/core/workflow/render"
import { WorkflowStageMachine } from "@opencode-ai/core/workflow/stage-machine"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { VisualReview } from "@opencode-ai/schema/visual-review"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"

const referenceSource = "<main data-render-ready>Reference</main>"
const hash = createHash("sha256").update(referenceSource).digest("hex")
const usage = (tokens: number) => ({ tokens, turns: 1, toolCalls: 0, attempts: 0 })
const png = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
)

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
const decodedSpec = Schema.decodeUnknownSync(DesignArtifact.Spec)(spec)

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
      design: (input) => {
        calls.push("kimi:design")
        expect(input.route).toMatchObject({
          role: "design",
          providerID: "kimi",
          modelID: "kimi-k3",
          protocol: "openai-chat",
        })
        return Effect.succeed({
          spec,
          referenceApp: {
            url: "http://reference.test/index.html",
            files: [{ path: "index.html", content: referenceSource }],
          },
          usage: usage(500),
        })
      },
      implement: ({ route }) => {
        calls.push("deepseek:implement")
        expect(route).toMatchObject({
          role: "implement",
          providerID: "deepseek",
          modelID: "deepseek-v4-flash",
          protocol: "openai-responses",
        })
        return Effect.succeed({ url: "http://implementation.test/index.html", usage: usage(800) })
      },
      repair: ({ revision, route }) => {
        calls.push(`deepseek:repair:${revision}`)
        expect(route).toMatchObject({
          role: "repair",
          providerID: "deepseek",
          modelID: "deepseek-v4-flash",
          protocol: "openai-responses",
        })
        return Effect.succeed({ url: "http://implementation.test/repaired.html", usage: usage(400) })
      },
      review: ({ message, evidence, revision, route }) => {
        calls.push(`kimi:review:${revision}`)
        expect(route).toMatchObject({
          role: "visual_review",
          providerID: "kimi",
          modelID: "kimi-k3",
          protocol: "openai-chat",
        })
        const media = message.content.filter((part) => part.type === "media")
        expect(media).toHaveLength(4)
        expect(media.every((part) => part.type === "media" && part.mediaType === "image/png")).toBe(true)
        expect(new Set(evidence.map((item) => item.kind))).toEqual(new Set(["reference", "implementation"]))
        expect(evidence.filter((item) => item.kind === "reference").every((item) => item.revision === 0)).toBe(true)
        expect(
          evidence.filter((item) => item.kind === "implementation").every((item) => item.revision === revision),
        ).toBe(true)
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
        return Effect.succeed(png.slice())
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
      "deepseek:repair:1",
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
      capture: () => Effect.succeed(png.slice()),
    }).pipe(Effect.runPromise)

    expect(result).toMatchObject({ status: "approval", reason: "max_revisions", revision: 1 })
  })

  test("reconstructs every durable payload without caller-held bodies and detects tampering", () => {
    const workflowID = Workflow.ID.make("wfl_codec")
    const specCommit = WorkflowDesignArtifact.commitSpec(workflowID, spec)
    expect(WorkflowDesignArtifact.encode(WorkflowDesignArtifact.decodeSpec(specCommit))).toBe(
      WorkflowDesignArtifact.encode(spec),
    )
    expect(() =>
      WorkflowDesignArtifact.decodeSpec({
        ...specCommit,
        metadata: { payload: { ...spec, goals: ["tampered"] } },
      }),
    ).toThrow()

    const appCommit = WorkflowDesignArtifact.commitReferenceApp(workflowID, decodedSpec, [
      { path: "index.html", content: referenceSource },
    ])
    expect(WorkflowDesignArtifact.decodeReferenceApp(appCommit).files).toEqual([
      { path: "index.html", content: referenceSource },
    ])
    expect(() =>
      WorkflowDesignArtifact.decodeReferenceApp({
        ...appCommit,
        metadata: {
          payload: {
            schemaVersion: 1,
            entrypoint: "index.html",
            readySelector: "[data-render-ready]",
            projectStack: ["html", "css", "javascript"],
            files: [{ path: "index.html", sha256: hash, size: 1, encoding: "base64", contentBase64: "QQ==" }],
          },
        },
      }),
    ).toThrow()

    const captured = WorkflowVisualReviewArtifact.capturedImage({
      workflowID,
      kind: "reference",
      viewport: "desktop",
      revision: 0,
      bytes: png,
    })
    const screenshot = WorkflowVisualReviewArtifact.commitScreenshot(captured)
    expect(WorkflowVisualReviewArtifact.decodeScreenshot(screenshot).bytes).toEqual(png)
    expect(() =>
      WorkflowVisualReviewArtifact.decodeScreenshot({
        ...screenshot,
        metadata: { ...screenshot.metadata, payload: { dataBase64: Buffer.from("tampered").toString("base64") } },
      }),
    ).toThrow()

    const evidence = [
      { ...captured, bytes: undefined },
      {
        ...WorkflowVisualReviewArtifact.capturedImage({
          workflowID,
          kind: "implementation",
          viewport: "desktop",
          revision: 0,
          bytes: png,
        }),
        bytes: undefined,
      },
    ].map(({ bytes: _, ...image }) => image)
    const review = Schema.decodeUnknownSync(VisualReview.Artifact)({ ...finding(0), evidence })
    const reviewCommit = WorkflowVisualReviewArtifact.commitReview(workflowID, review)
    expect(WorkflowDesignArtifact.encode(WorkflowVisualReviewArtifact.decodeReview(reviewCommit))).toBe(
      WorkflowDesignArtifact.encode(review),
    )
    expect(() => WorkflowVisualReviewArtifact.decodeReview({ ...reviewCommit, size: reviewCommit.size + 1 })).toThrow()

    expect(() => Schema.decodeUnknownSync(Workflow.ArtifactCommit)({ ...specCommit, sha256: "bad" })).toThrow()
  })

  test("rejects invalid PNGs, inconsistent screenshot metadata, and secret-bearing source", () => {
    const workflowID = Workflow.ID.make("wfl_invalid_capture")
    expect(() =>
      WorkflowVisualReviewArtifact.capturedImage({
        workflowID,
        kind: "reference",
        viewport: "desktop",
        revision: 0,
        bytes: new TextEncoder().encode("not a png"),
      }),
    ).toThrow()
    const image = WorkflowVisualReviewArtifact.capturedImage({
      workflowID,
      kind: "reference",
      viewport: "desktop",
      revision: 0,
      bytes: png,
    })
    expect(() => WorkflowVisualReviewArtifact.commitScreenshot({ ...image, sha256: "f".repeat(64) })).toThrow()
    expect(() => WorkflowVisualReviewArtifact.commitScreenshot({ ...image, size: image.size + 1 })).toThrow()
    expect(() =>
      WorkflowDesignArtifact.commitReferenceApp(workflowID, decodedSpec, [
        { path: "index.html", content: "Bearer live-secret-source-value" },
      ]),
    ).toThrow()
  })

  test("uses host-measured review usage and requests approval before accepting an over-budget pass", async () => {
    const result = await WorkflowRender.run({
      workflowID: Workflow.ID.make("wfl_review_budget"),
      limits: { maxRevisions: 1, maxTokens: 3, maxTurns: 20, maxToolCalls: 20 },
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
      repair: () => Effect.die("repair must not run after an over-budget passing review"),
      review: ({ evidence, revision }) =>
        Effect.succeed({
          review: {
            ...finding(revision),
            verdict: "pass" as const,
            score: 100,
            limits: { maxRevisions: 1, maxTokens: 3, maxTurns: 20, maxToolCalls: 20 },
            evidence,
            findings: [],
            usage: { tokens: 0, turns: 0, toolCalls: 0 },
          },
          usage: usage(1),
        }),
      capture: () => Effect.succeed(png.slice()),
    }).pipe(Effect.runPromise)

    expect(result).toMatchObject({ status: "approval", reason: "budget_exhausted", revision: 0 })
    const commit = result.artifacts.find((artifact) => artifact.kind === WorkflowVisualReviewArtifact.REVIEW_KIND)
    expect(commit).toBeDefined()
    expect(WorkflowVisualReviewArtifact.decodeReview(commit!).usage).toEqual({ tokens: 1, turns: 1, toolCalls: 0 })
  })

  test("production capture rejects non-PNG browser output", async () => {
    const capture = WorkflowRender.production({
      capturePage: () => Effect.succeed(new TextEncoder().encode("html error page")),
    })
    const error = await capture({
      kind: "reference",
      url: "http://reference.test",
      readySelector: "main",
      viewport: { name: "desktop", width: 100, height: 100 },
      revision: 0,
    }).pipe(Effect.flip, Effect.runPromise)
    expect(error).toBeInstanceOf(Error)
  })

  test("builds paired Kimi image content for later allowed revisions", () => {
    const workflowID = Workflow.ID.make("wfl_later_revision")
    const reference = WorkflowVisualReviewArtifact.capturedImage({
      workflowID,
      kind: "reference",
      viewport: "desktop",
      revision: 0,
      bytes: png,
    })
    const implementation = WorkflowVisualReviewArtifact.capturedImage({
      workflowID,
      kind: "implementation",
      viewport: "desktop",
      revision: 2,
      bytes: png,
    })
    expect(WorkflowVisualReviewArtifact.reviewMessage(decodedSpec, [reference, implementation]).content).toHaveLength(3)
  })
})
