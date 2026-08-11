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
  revision: kind === "reference" ? 0 : 0,
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

  test("rejects excess properties at every object depth", () => {
    expect(() => Schema.decodeUnknownSync(DesignArtifact.Spec)({ ...design, unexpected: true })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(DesignArtifact.Spec)({
        ...design,
        routes: [{ ...design.routes[0], apiKey: "not-even-a-real-key" }],
      }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(VisualReview.Artifact)({ ...review, note: "unstructured" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VisualReview.Artifact)({
        ...review,
        evidence: [{ ...review.evidence[0], secret: "hidden" }, review.evidence[1]],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(DesignArtifact.Viewport)({ name: "desktop", width: 10, height: 10, extra: true }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(VisualReview.EvidenceImage)({ ...review.evidence[0], extra: true })).toThrow()
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

  test("requires one revision-bound reference and implementation image per viewport", () => {
    expect(() =>
      Schema.decodeUnknownSync(VisualReview.Artifact)({
        ...review,
        revision: 1,
        evidence: [
          { ...image("reference", "reference-desktop"), revision: 0 },
          { ...image("implementation", "implementation-desktop"), revision: 0 },
        ],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VisualReview.Artifact)({
        ...review,
        evidence: [
          image("reference", "reference-desktop"),
          image("implementation", "implementation-desktop"),
          { ...image("implementation", "implementation-copy"), id: "implementation-copy" },
        ],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VisualReview.Artifact)({
        ...review,
        evidence: [
          { ...image("reference", "reference-desktop"), revision: 1 },
          image("implementation", "implementation-desktop"),
        ],
      }),
    ).toThrow()
  })

  test("rejects unsafe source paths, duplicate files, and unsafe viewport identifiers", () => {
    for (const path of ["../secret.js", "/absolute.js", "C:/windows.js", "src\\app.js", "src//app.js"]) {
      expect(() =>
        Schema.decodeUnknownSync(DesignArtifact.Spec)({
          ...design,
          referenceApp: {
            ...design.referenceApp,
            entrypoint: path,
            files: [{ ...design.referenceApp.files[0], path }],
          },
        }),
      ).toThrow()
    }
    expect(() =>
      Schema.decodeUnknownSync(DesignArtifact.Spec)({
        ...design,
        referenceApp: {
          ...design.referenceApp,
          files: [design.referenceApp.files[0], design.referenceApp.files[0]],
        },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(DesignArtifact.Spec)({
        ...design,
        responsiveRules: [{ ...design.responsiveRules[0], viewport: "desktop/../../escape" }],
        referenceApp: {
          ...design.referenceApp,
          viewports: [{ ...design.referenceApp.viewports[0], name: "desktop/../../escape" }],
        },
      }),
    ).toThrow()
  })
})
