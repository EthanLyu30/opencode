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

const withoutPngChunk = (input: Uint8Array, removedType: string) => {
  const output = Array.from(input.slice(0, 8))
  let offset = 8
  while (offset < input.byteLength) {
    const length = new DataView(input.buffer, input.byteOffset + offset, 4).getUint32(0)
    const end = offset + 12 + length
    const type = new TextDecoder().decode(input.slice(offset + 4, offset + 8))
    if (type !== removedType) output.push(...input.slice(offset, end))
    offset = end
  }
  return Uint8Array.from(output)
}

const pngCrc32 = (type: Uint8Array, data: Uint8Array) => {
  let crc = 0xffffffff
  for (const bytes of [type, data]) {
    for (const value of bytes) {
      crc ^= value
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

const withIhdr = (
  input: Uint8Array,
  field: "bitDepth" | "colorType" | "compression" | "filter" | "interlace",
  value: number,
) => {
  const output = input.slice()
  const offsets = { bitDepth: 24, colorType: 25, compression: 26, filter: 27, interlace: 28 } as const
  output[offsets[field]] = value
  const type = output.slice(12, 16)
  const data = output.slice(16, 29)
  new DataView(output.buffer, output.byteOffset + 29, 4).setUint32(0, pngCrc32(type, data))
  return output
}

const withIhdrDimension = (input: Uint8Array, field: "width" | "height", value: number) => {
  const output = input.slice()
  new DataView(output.buffer, output.byteOffset + 16, 8).setUint32(field === "width" ? 0 : 4, value)
  const type = output.slice(12, 16)
  const data = output.slice(16, 29)
  new DataView(output.buffer, output.byteOffset + 29, 4).setUint32(0, pngCrc32(type, data))
  return output
}

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

const evidenceID = (workflowID: string, kind: "reference" | "implementation", viewport: string, revision: number) =>
  `screenshot-${workflowID}-${kind}-${viewport}${kind === "reference" ? "" : `-r${revision}`}`

const finding = (revision: number, workflowID = "wfl_visual_loop") => ({
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
      evidenceImageIDs: [
        evidenceID(workflowID, "reference", "desktop", 0),
        evidenceID(workflowID, "implementation", "desktop", revision),
      ],
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
            files: [{ path: "index.html", content: referenceSource }],
          },
          usage: usage(500),
        })
      },
      prepareReference: ({ artifact, app }) => {
        calls.push("host:prepare-reference")
        expect(artifact.kind).toBe(WorkflowDesignArtifact.REFERENCE_APP_KIND)
        expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(app.files).toEqual([{ path: "index.html", content: referenceSource }])
        return Effect.succeed("http://host-preview.test/index.html")
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
      capture: ({ kind, url, viewport, revision }) => {
        calls.push(`browser:${kind}:${viewport.name}:r${revision}`)
        if (kind === "reference") expect(url).toBe("http://host-preview.test/index.html")
        return Effect.succeed(png.slice())
      },
    }).pipe(Effect.runPromise)

    expect(result.status).toBe("passed")
    expect(result.revision).toBe(1)
    expect(calls).toEqual([
      "kimi:design",
      "host:prepare-reference",
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
            files: [{ path: "index.html", content: referenceSource }],
          },
          usage: usage(1),
        }),
      prepareReference: () => Effect.succeed("http://host-preview.test/index.html"),
      implement: () => Effect.succeed({ url: "http://implementation.test/index.html", usage: usage(1) }),
      repair: () => Effect.succeed({ url: "http://implementation.test/repaired.html", usage: usage(1) }),
      review: ({ evidence, revision }) =>
        Effect.succeed({
          review: { ...finding(revision, "wfl_visual_approval"), evidence },
          usage: usage(1),
        }),
      capture: () => Effect.succeed(png.slice()),
    }).pipe(Effect.runPromise)

    expect(result).toMatchObject({ status: "approval", reason: "max_revisions", revision: 1 })
  })

  test("reconstructs every durable payload without caller-held bodies and detects tampering", () => {
    const workflowID = Workflow.ID.make("wfl_codec")
    const otherWorkflowID = Workflow.ID.make("wfl_codec_other")
    const specCommit = WorkflowDesignArtifact.commitSpec(workflowID, spec)
    expect(WorkflowDesignArtifact.commitSpec(otherWorkflowID, spec).sha256).not.toBe(specCommit.sha256)
    expect(WorkflowDesignArtifact.encode(WorkflowDesignArtifact.decodeSpec(specCommit, workflowID))).toBe(
      WorkflowDesignArtifact.encode(spec),
    )
    expect(() => WorkflowDesignArtifact.decodeSpec(specCommit, otherWorkflowID)).toThrow()
    expect(() =>
      WorkflowDesignArtifact.decodeSpec(
        { ...specCommit, uri: "workflow://wfl_codec_other/design-spec.json" },
        workflowID,
      ),
    ).toThrow()
    expect(() =>
      WorkflowDesignArtifact.decodeSpec(
        {
          ...specCommit,
          metadata: {
            payload: {
              workflowID,
              artifactKind: WorkflowDesignArtifact.SPEC_KIND,
              spec: { ...spec, goals: ["tampered"] },
            },
          },
        },
        workflowID,
      ),
    ).toThrow()

    const appCommit = WorkflowDesignArtifact.commitReferenceApp(workflowID, decodedSpec, [
      { path: "index.html", content: referenceSource },
    ])
    expect(
      WorkflowDesignArtifact.commitReferenceApp(otherWorkflowID, decodedSpec, [
        { path: "index.html", content: referenceSource },
      ]).sha256,
    ).not.toBe(appCommit.sha256)
    expect(WorkflowDesignArtifact.decodeReferenceApp(appCommit, workflowID).files).toEqual([
      { path: "index.html", content: referenceSource },
    ])
    expect(() => WorkflowDesignArtifact.decodeReferenceApp(appCommit, otherWorkflowID)).toThrow()
    expect(() =>
      WorkflowDesignArtifact.decodeReferenceApp(
        { ...appCommit, uri: "workflow://wfl_codec_other/reference-app/manifest.json" },
        workflowID,
      ),
    ).toThrow()
    expect(() =>
      WorkflowDesignArtifact.decodeReferenceApp(
        {
          ...appCommit,
          metadata: {
            payload: {
              schemaVersion: 1,
              workflowID,
              artifactKind: WorkflowDesignArtifact.REFERENCE_APP_KIND,
              entrypoint: "index.html",
              readySelector: "[data-render-ready]",
              projectStack: ["html", "css", "javascript"],
              files: [{ path: "index.html", sha256: hash, size: 1, encoding: "base64", contentBase64: "QQ==" }],
            },
          },
        },
        workflowID,
      ),
    ).toThrow()

    const captured = WorkflowVisualReviewArtifact.capturedImage({
      workflowID,
      kind: "reference",
      viewport: "desktop",
      revision: 0,
      bytes: png,
    })
    const screenshot = WorkflowVisualReviewArtifact.commitScreenshot(captured)
    const { bytes: _capturedBytes, ...capturedEvidence } = captured
    expect(screenshot.sha256).not.toBe(captured.sha256)
    expect(WorkflowVisualReviewArtifact.decodeScreenshot(screenshot, workflowID).bytes).toEqual(png)
    expect(() => Reflect.apply(WorkflowVisualReviewArtifact.decodeScreenshot, undefined, [screenshot])).toThrow()
    expect(() =>
      WorkflowVisualReviewArtifact.decodeScreenshot(screenshot, Workflow.ID.make("wfl_other_workflow")),
    ).toThrow()
    expect(() =>
      WorkflowVisualReviewArtifact.decodeScreenshot(
        {
          ...screenshot,
          metadata: { ...screenshot.metadata, payload: { dataBase64: Buffer.from("tampered").toString("base64") } },
        },
        workflowID,
      ),
    ).toThrow()
    expect(() =>
      WorkflowVisualReviewArtifact.decodeScreenshot(
        {
          ...screenshot,
          metadata: {
            payload: {
              image: { ...capturedEvidence, id: "attacker-id" },
              dataBase64: Buffer.from(png).toString("base64"),
            },
          },
        },
        workflowID,
      ),
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
    const review = Schema.decodeUnknownSync(VisualReview.Artifact)({ ...finding(0, "wfl_codec"), evidence })
    const reviewCommit = WorkflowVisualReviewArtifact.commitReview(workflowID, review)
    expect(WorkflowDesignArtifact.encode(WorkflowVisualReviewArtifact.decodeReview(reviewCommit, workflowID))).toBe(
      WorkflowDesignArtifact.encode(review),
    )
    expect(() => WorkflowVisualReviewArtifact.decodeReview(reviewCommit, otherWorkflowID)).toThrow()
    expect(() =>
      WorkflowVisualReviewArtifact.decodeReview(
        { ...reviewCommit, uri: "workflow://wfl_codec_other/visual-review-r0.json" },
        workflowID,
      ),
    ).toThrow()
    expect(() =>
      WorkflowVisualReviewArtifact.decodeReview({ ...reviewCommit, size: reviewCommit.size + 1 }, workflowID),
    ).toThrow()

    const otherEvidence = evidence.map((item) => ({ ...item, workflowID: otherWorkflowID }))
    const otherReview = Schema.decodeUnknownSync(VisualReview.Artifact)({ ...review, evidence: otherEvidence })
    expect(() => WorkflowVisualReviewArtifact.commitReview(workflowID, otherReview)).toThrow()

    expect(() => Schema.decodeUnknownSync(Workflow.ArtifactCommit)({ ...specCommit, sha256: "bad" })).toThrow()
  })

  test("rejects invalid PNGs, inconsistent screenshot metadata, and secret-bearing source", () => {
    const workflowID = Workflow.ID.make("wfl_invalid_capture")
    const malformed = [
      png.slice(0, 8),
      Uint8Array.from(png, (value, index) => (index === 11 ? 0 : value)),
      Uint8Array.from(png, (value, index) => (index === 29 ? value ^ 1 : value)),
      withoutPngChunk(png, "IDAT"),
      withoutPngChunk(png, "IEND"),
      Uint8Array.from([...png, 0]),
      withIhdr(png, "compression", 1),
      withIhdr(png, "filter", 1),
      withIhdr(png, "interlace", 2),
      withIhdr(png, "colorType", 1),
      withIhdr(withIhdr(png, "colorType", 2), "bitDepth", 1),
      withIhdrDimension(png, "width", 0x80000000),
      withIhdrDimension(png, "height", 0x80000000),
    ]
    for (const bytes of malformed) {
      expect(() =>
        WorkflowVisualReviewArtifact.capturedImage({
          workflowID,
          kind: "reference",
          viewport: "desktop",
          revision: 0,
          bytes,
        }),
      ).toThrow()
    }
    const image = WorkflowVisualReviewArtifact.capturedImage({
      workflowID,
      kind: "reference",
      viewport: "desktop",
      revision: 0,
      bytes: png,
    })
    expect(() => WorkflowVisualReviewArtifact.commitScreenshot({ ...image, sha256: "f".repeat(64) })).toThrow()
    expect(() => WorkflowVisualReviewArtifact.commitScreenshot({ ...image, size: image.size + 1 })).toThrow()
    expect(() => WorkflowVisualReviewArtifact.commitScreenshot({ ...image, id: "attacker-id" })).toThrow()
    expect(() =>
      WorkflowVisualReviewArtifact.commitScreenshot({ ...image, uri: "workflow://attacker/image.png" }),
    ).toThrow()
    expect(() =>
      WorkflowVisualReviewArtifact.capturedImage({
        workflowID,
        kind: "reference",
        viewport: "desktop",
        revision: 7,
        bytes: png,
      }),
    ).toThrow()
    expect(() =>
      WorkflowDesignArtifact.commitReferenceApp(workflowID, decodedSpec, [
        { path: "index.html", content: "Bearer live-secret-source-value" },
      ]),
    ).toThrow()
  })

  test("rejects unsafe workflow owners before constructing artifact identities", () => {
    for (const value of ["wfl_a/../wfl_b", "wfl_a@evil.test", "wfl_a:80"]) {
      const workflowID = Workflow.ID.make(value)
      expect(() => WorkflowDesignArtifact.commitSpec(workflowID, spec)).toThrow()
      expect(() =>
        WorkflowDesignArtifact.commitReferenceApp(workflowID, decodedSpec, [
          { path: "index.html", content: referenceSource },
        ]),
      ).toThrow()
      expect(() =>
        WorkflowVisualReviewArtifact.capturedImage({
          workflowID,
          kind: "reference",
          viewport: "desktop",
          revision: 0,
          bytes: png,
        }),
      ).toThrow()

      const evidence = [
        {
          id: "reference-desktop",
          workflowID,
          kind: "reference" as const,
          viewport: "desktop",
          revision: 0,
          uri: "artifact://reference-desktop.png",
          mime: "image/png" as const,
          sha256: hash,
          size: 64,
        },
        {
          id: "implementation-desktop",
          workflowID,
          kind: "implementation" as const,
          viewport: "desktop",
          revision: 0,
          uri: "artifact://implementation-desktop.png",
          mime: "image/png" as const,
          sha256: hash,
          size: 64,
        },
      ]
      const review = {
        schemaVersion: 1,
        revision: 0,
        verdict: "pass",
        score: 100,
        limits: { maxRevisions: 1, maxTokens: 10, maxTurns: 10, maxToolCalls: 10 },
        usage: { tokens: 1, turns: 1, toolCalls: 0 },
        evidence,
        findings: [],
      }
      expect(() => WorkflowVisualReviewArtifact.commitReview(workflowID, review)).toThrow()
    }
  })

  test("rejects an unsafe workflow owner before invoking a model callback", async () => {
    let designed = false
    const error = await WorkflowRender.run({
      workflowID: Workflow.ID.make("wfl_a@evil.test"),
      limits: { maxRevisions: 1, maxTokens: 10, maxTurns: 10, maxToolCalls: 10 },
      design: () => {
        designed = true
        return Effect.succeed({
          spec,
          referenceApp: { files: [{ path: "index.html", content: referenceSource }] },
          usage: usage(1),
        })
      },
      prepareReference: () => Effect.fail(new Error("must not prepare")),
      implement: () => Effect.fail(new Error("must not implement")),
      repair: () => Effect.fail(new Error("must not repair")),
      review: () => Effect.fail(new Error("must not review")),
      capture: () => Effect.fail(new Error("must not capture")),
    }).pipe(Effect.flip, Effect.runPromise)
    expect(error).toBeInstanceOf(Error)
    expect(designed).toBe(false)
  })

  test("uses host-measured review usage and requests approval before accepting an over-budget pass", async () => {
    const result = await WorkflowRender.run({
      workflowID: Workflow.ID.make("wfl_review_budget"),
      limits: { maxRevisions: 1, maxTokens: 3, maxTurns: 20, maxToolCalls: 20 },
      design: () =>
        Effect.succeed({
          spec,
          referenceApp: {
            files: [{ path: "index.html", content: referenceSource }],
          },
          usage: usage(1),
        }),
      prepareReference: () => Effect.succeed("http://host-preview.test/index.html"),
      implement: () => Effect.succeed({ url: "http://implementation.test/index.html", usage: usage(1) }),
      repair: () => Effect.die("repair must not run after an over-budget passing review"),
      review: ({ evidence, revision }) =>
        Effect.succeed({
          review: {
            ...finding(revision, "wfl_review_budget"),
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
    expect(WorkflowVisualReviewArtifact.decodeReview(commit!, Workflow.ID.make("wfl_review_budget")).usage).toEqual({
      tokens: 1,
      turns: 1,
      toolCalls: 0,
    })
  })

  test("rejects untrusted usage and non-exact implementation, repair, and review results", async () => {
    const cases = [
      { name: "design usage", phase: "design", badUsage: { ...usage(1), tokens: -1 } },
      { name: "implementation usage", phase: "implement", badUsage: { ...usage(1), unexpected: 1 } },
      { name: "review usage", phase: "review", badUsage: { ...usage(1), tokens: Number.NaN } },
      { name: "repair usage", phase: "repair", badUsage: { ...usage(1), toolCalls: -1 } },
      { name: "implementation result", phase: "implement-result", badUsage: usage(1) },
      { name: "implementation URL", phase: "implement-url", badUsage: usage(1) },
      { name: "review result", phase: "review-result", badUsage: usage(1) },
      { name: "repair result", phase: "repair-result", badUsage: usage(1) },
    ] as const

    for (const item of cases) {
      const workflowID = Workflow.ID.make(`wfl_invalid_${item.phase.replaceAll("-", "_")}`)
      const mustRepair = item.phase === "repair" || item.phase === "repair-result"
      const error = await WorkflowRender.run({
        workflowID,
        limits: { maxRevisions: 1, maxTokens: 20_000, maxTurns: 20, maxToolCalls: 20 },
        design: () =>
          Effect.succeed({
            spec,
            referenceApp: { files: [{ path: "index.html", content: referenceSource }] },
            usage: item.phase === "design" ? item.badUsage : usage(1),
          }),
        prepareReference: () => Effect.succeed("http://host-preview.test/index.html"),
        implement: () =>
          Effect.succeed({
            url: item.phase === "implement-url" ? "" : "http://implementation.test/index.html",
            usage: item.phase === "implement" ? item.badUsage : usage(1),
            ...(item.phase === "implement-result" ? { unexpected: true } : {}),
          }),
        repair: () =>
          Effect.succeed({
            url: "http://implementation.test/repaired.html",
            usage: item.phase === "repair" ? item.badUsage : usage(1),
            ...(item.phase === "repair-result" ? { unexpected: true } : {}),
          }),
        review: ({ evidence, revision }) =>
          Effect.succeed({
            review: mustRepair
              ? { ...finding(revision, workflowID), evidence }
              : {
                  ...finding(revision, workflowID),
                  verdict: "pass" as const,
                  score: 100,
                  evidence,
                  findings: [],
                },
            usage: item.phase === "review" ? item.badUsage : usage(1),
            ...(item.phase === "review-result" ? { unexpected: true } : {}),
          }),
        capture: () => Effect.succeed(png.slice()),
      }).pipe(Effect.flip, Effect.runPromise)
      expect(error, item.name).toBeInstanceOf(Error)
    }
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

  test("rejects model-authored reference URLs before host preview preparation", async () => {
    let prepared = false
    const modelResultWithUrl = {
      spec,
      referenceApp: {
        url: "http://model-controlled.test/index.html",
        files: [{ path: "index.html", content: referenceSource }],
      },
      usage: usage(1),
    }
    const error = await WorkflowRender.run({
      workflowID: Workflow.ID.make("wfl_model_reference_url"),
      limits: { maxRevisions: 1, maxTokens: 20, maxTurns: 20, maxToolCalls: 20 },
      design: () => Effect.succeed(modelResultWithUrl),
      prepareReference: () => {
        prepared = true
        return Effect.succeed("http://host-preview.test/index.html")
      },
      implement: () => Effect.die("implementation must not run"),
      repair: () => Effect.die("repair must not run"),
      review: () => Effect.die("review must not run"),
      capture: () => Effect.succeed(png),
    }).pipe(Effect.flip, Effect.runPromise)
    expect(error).toBeInstanceOf(Error)
    expect(prepared).toBe(false)
  })

  test("rejects invalid UTF-8 in otherwise self-consistent durable reference source", () => {
    const workflowID = Workflow.ID.make("wfl_invalid_utf8")
    const commit = WorkflowDesignArtifact.commitReferenceApp(workflowID, decodedSpec, [
      { path: "index.html", content: referenceSource },
    ])
    const invalidBytes = Buffer.from([0xff])
    const payload = {
      schemaVersion: 1,
      workflowID,
      artifactKind: WorkflowDesignArtifact.REFERENCE_APP_KIND,
      entrypoint: "index.html",
      readySelector: "[data-render-ready]",
      projectStack: ["html", "css", "javascript"],
      files: [
        {
          path: "index.html",
          sha256: createHash("sha256").update(invalidBytes).digest("hex"),
          size: 1,
          encoding: "base64",
          contentBase64: invalidBytes.toString("base64"),
        },
      ],
    }
    const body = WorkflowDesignArtifact.encode(payload)
    expect(() =>
      WorkflowDesignArtifact.decodeReferenceApp(
        {
          ...commit,
          sha256: createHash("sha256").update(body).digest("hex"),
          size: new TextEncoder().encode(body).byteLength,
          metadata: { payload },
        },
        workflowID,
      ),
    ).toThrow()
  })
})
