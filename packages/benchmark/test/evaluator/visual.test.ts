import { describe, expect, test } from "bun:test"
import sharp from "sharp"
import { aggregateVisualViewports, composeVisualScore, evaluateVisualViewport } from "../../src/evaluator/visual"
import { evidence } from "./helpers"

const dom = [
  {
    index: 0,
    tag: "main",
    id: "app",
    role: "main",
    testID: "main",
    box: { x: 10, y: 20, width: 100, height: 80 },
    style: { color: "rgb(0, 0, 0)", "font-size": "16px", "font-family": "Inter" },
  },
]

describe("Task24 visual composite", () => {
  test("uses the sealed 35/20/25/10/10 weights without redistribution", () => {
    expect(
      composeVisualScore({
        ssim: 100,
        pixelColor: 100,
        domGeometry: 75,
        typographyStyle: 100,
        responsiveInteraction: 100,
      }),
    ).toBe(93.75)
    expect(
      composeVisualScore({
        ssim: 100,
        pixelColor: 0,
        domGeometry: 100,
        typographyStyle: 0,
        responsiveInteraction: 100,
      }),
    ).toBe(70)
  })

  test("produces deterministic exact-match pixels, geometry, styles, and interaction scores", async () => {
    const png = await solidPng("#336699")
    const result = await evaluateVisualViewport({
      viewportID: "desktop",
      referencePng: png,
      candidatePng: png,
      referenceDom: dom,
      candidateDom: dom,
      interactionCheckpoints: [{ id: "primary-click", passed: true }],
      masks: [],
      evidence: [evidence("visual")],
    })
    expect(result.composite).toBe(100)
    expect(result.design2Code).toEqual({ ssim: 1, pixelSimilarity: 1 })
  })

  test("detects color, spacing, typography, responsive, and interaction mutations", async () => {
    const reference = await solidPng("#336699")
    const changed = await solidPng("#993366")
    const spacing = structuredClone(dom)
    spacing[0]!.box.x += 4
    const typography = structuredClone(dom)
    typography[0]!.style["font-size"] = "24px"

    const colorResult = await visual(reference, changed, dom, dom, true)
    const spacingResult = await visual(reference, reference, dom, spacing, true)
    const typeResult = await visual(reference, reference, dom, typography, true)
    const interactionResult = await visual(reference, reference, dom, dom, false)

    expect(colorResult.composite).toBeLessThan(100)
    expect(spacingResult.components.domGeometry).toBeLessThan(100)
    expect(typeResult.components.typographyStyle).toBeLessThan(100)
    expect(interactionResult.components.responsiveInteraction).toBe(0)
  })

  test("treats a missing visual component as a harness failure", () => {
    expect(() =>
      composeVisualScore({
        ssim: 100,
        pixelColor: 100,
        domGeometry: 100,
        typographyStyle: Number.NaN,
        responsiveInteraction: 100,
      }),
    ).toThrow("TASK24_VISUAL_COMPONENT_INVALID")
  })

  test("requires one and only one result for every sealed viewport", async () => {
    const png = await solidPng("#336699")
    const mobile = await evaluateVisualViewport({
      viewportID: "mobile",
      referencePng: png,
      candidatePng: png,
      referenceDom: dom,
      candidateDom: dom,
      interactionCheckpoints: [{ id: "primary-click", passed: true }],
      masks: [],
      evidence: [evidence("visual-mobile")],
    })
    expect(() => aggregateVisualViewports([mobile])).toThrow("TASK24_VISUAL_VIEWPORTS_INVALID")
    const tablet = { ...mobile, viewportID: "tablet" as const, evidence: [evidence("visual-tablet")] }
    const desktop = { ...mobile, viewportID: "desktop" as const, evidence: [evidence("visual-desktop")] }
    expect(aggregateVisualViewports([desktop, mobile, tablet])).toMatchObject({
      composite: 100,
      points: 30,
      viewportScores: [100, 100, 100],
    })
  })
})

async function visual(
  reference: Uint8Array,
  candidate: Uint8Array,
  before: typeof dom,
  after: typeof dom,
  passed: boolean,
) {
  return evaluateVisualViewport({
    viewportID: "mobile",
    referencePng: reference,
    candidatePng: candidate,
    referenceDom: before,
    candidateDom: after,
    interactionCheckpoints: [{ id: "primary-click", passed }],
    masks: [],
    evidence: [evidence("visual")],
  })
}

async function solidPng(background: string): Promise<Uint8Array> {
  return sharp({ create: { width: 16, height: 12, channels: 4, background } })
    .png()
    .toBuffer()
}
