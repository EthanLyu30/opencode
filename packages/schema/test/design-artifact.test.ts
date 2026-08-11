import { describe, expect, test } from "bun:test"
import { DesignArtifact } from "../src/design-artifact"
import { VisualReview } from "../src/visual-review"
import { Schema } from "effect"

const hash = "a".repeat(64)

const design = {
  schemaVersion: 1,
  goals: ["Let users review a release"],
  routes: [{ path: "/releases/:id", goal: "Review one release" }],
  layoutConstraints: ["Keep the primary action above the fold"],
  componentTree: [{ id: "page", component: "ReleasePage", children: ["approve"] }],
  states: [{ name: "ready", description: "Release data is visible" }],
  typography: [{ token: "body", family: "Inter", weight: 400, sizePx: 16, lineHeight: 1.5 }],
  colors: [{ token: "surface", value: "#ffffff" }],
  responsiveRules: [{ viewport: "desktop", width: 1440, height: 900, rules: ["Use two columns"] }],
  accessibilityRules: ["All controls have accessible names"],
  acceptanceCriteria: ["The approve action remains visible at 1440x900"],
  projectStack: ["html", "css", "javascript"],
  referenceApp: {
    entrypoint: "index.html",
    readySelector: "[data-render-ready]",
    files: [{ path: "index.html", sha256: hash, size: 128 }],
    viewports: [{ name: "desktop", width: 1440, height: 900 }],
  },
}

const image = (kind: "reference" | "implementation", id: string) => ({
  id,
  kind,
  viewport: "desktop",
  uri: `artifact://${id}.png`,
  mime: "image/png" as const,
  sha256: hash,
  size: 64,
})

const review = {
  schemaVersion: 1,
  revision: 0,
  verdict: "fail" as const,
  score: 82,
  limits: { maxRevisions: 2, maxTokens: 10_000, maxTurns: 8, maxToolCalls: 12 },
  usage: { tokens: 400, turns: 1, toolCalls: 0 },
  evidence: [image("reference", "reference-desktop"), image("implementation", "implementation-desktop")],
  findings: [
    {
      id: "visual-1",
      severity: "major" as const,
      viewport: "desktop",
      selector: "[data-testid=approve]",
      region: "primary action",
      category: "layout" as const,
      expected: "Button is aligned to the card edge",
      actual: "Button is inset by 16px",
      evidenceImageIDs: ["reference-desktop", "implementation-desktop"],
      repair: "Remove the extra inline margin",
      requiresRecapture: true,
    },
  ],
}

describe("design and visual artifact schemas", () => {
  test("decodes a complete design specification and strict paired-image review", () => {
    expect(Array.from(Schema.decodeUnknownSync(DesignArtifact.Spec)(design).goals)).toEqual(design.goals)
    expect(Schema.decodeUnknownSync(VisualReview.Artifact)(review).findings).toHaveLength(1)
  })

  test("rejects incomplete design specifications", () => {
    const { accessibilityRules: _, ...incomplete } = design
    expect(() => Schema.decodeUnknownSync(DesignArtifact.Spec)(incomplete)).toThrow()
  })

  test("rejects unhashed screenshot and reference-app artifacts", () => {
    const { sha256: _, ...unhashedFile } = design.referenceApp.files[0]
    expect(() =>
      Schema.decodeUnknownSync(DesignArtifact.Spec)({
        ...design,
        referenceApp: { ...design.referenceApp, files: [unhashedFile] },
      }),
    ).toThrow()

    const { sha256: _imageHash, ...unhashedImage } = review.evidence[0]
    expect(() => Schema.decodeUnknownSync(VisualReview.Artifact)({ ...review, evidence: [unhashedImage] })).toThrow()
  })

  test("rejects secret-bearing durable artifacts", () => {
    expect(() =>
      Schema.decodeUnknownSync(DesignArtifact.Spec)({
        ...design,
        goals: ["Use Bearer live-secret-token in the preview"],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VisualReview.Artifact)({
        ...review,
        findings: [{ ...review.findings[0], actual: "sk-live-secret-token" }],
      }),
    ).toThrow()
  })

  test("rejects unbounded or internally inconsistent visual reviews", () => {
    const { limits: _, ...unbounded } = review
    expect(() => Schema.decodeUnknownSync(VisualReview.Artifact)(unbounded)).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VisualReview.Artifact)({
        ...review,
        limits: { ...review.limits, maxRevisions: 999 },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VisualReview.Artifact)({
        ...review,
        evidence: [image("reference", "reference-desktop")],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VisualReview.Artifact)({
        ...review,
        verdict: "pass",
      }),
    ).toThrow()
  })
})
