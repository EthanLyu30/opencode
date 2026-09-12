import sharp from "sharp"
import { validateEvidenceReferences, type EvidenceReference } from "./evidence"
import { geometryScore } from "./geometry"
import { interactionScore, type InteractionCheckpoint } from "./interaction"
import { styleScore } from "./style"

const weights = Object.freeze({
  ssim: 35,
  pixelColor: 20,
  domGeometry: 25,
  typographyStyle: 10,
  responsiveInteraction: 10,
})

export interface VisualComponents {
  readonly ssim: number
  readonly pixelColor: number
  readonly domGeometry: number
  readonly typographyStyle: number
  readonly responsiveInteraction: number
}

export interface VisualMask {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface VisualViewportResult {
  readonly viewportID: "mobile" | "tablet" | "desktop"
  readonly composite: number
  readonly points: number
  readonly components: VisualComponents
  readonly design2Code: Readonly<{ ssim: number; pixelSimilarity: number }>
  readonly evidence: readonly EvidenceReference[]
}

export interface VisualResult {
  readonly composite: number
  readonly points: number
  readonly viewportScores: readonly number[]
  readonly viewports: readonly VisualViewportResult[]
  readonly evidence: readonly EvidenceReference[]
}

export function composeVisualScore(components: VisualComponents): number {
  for (const value of Object.values(components)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new TypeError("TASK24_VISUAL_COMPONENT_INVALID")
    }
  }
  return round(
    (components.ssim * weights.ssim +
      components.pixelColor * weights.pixelColor +
      components.domGeometry * weights.domGeometry +
      components.typographyStyle * weights.typographyStyle +
      components.responsiveInteraction * weights.responsiveInteraction) /
      100,
  )
}

export async function evaluateVisualViewport(input: {
  readonly viewportID: VisualViewportResult["viewportID"]
  readonly referencePng: Uint8Array
  readonly candidatePng: Uint8Array
  readonly referenceDom: readonly unknown[]
  readonly candidateDom: readonly unknown[]
  readonly interactionCheckpoints: readonly InteractionCheckpoint[]
  readonly masks: readonly VisualMask[]
  readonly evidence: readonly EvidenceReference[]
}): Promise<VisualViewportResult> {
  const [reference, candidate] = await Promise.all([decode(input.referencePng), decode(input.candidatePng)])
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new TypeError("TASK24_VISUAL_DIMENSIONS_MISMATCH")
  }
  const included = includedPixels(reference.width, reference.height, input.masks)
  const pixel = pixelScores(reference.data, candidate.data, included)
  const components: VisualComponents = Object.freeze({
    ssim: round(pixel.ssim * 100),
    pixelColor: round(pixel.similarity * 100),
    domGeometry: geometryScore(input.referenceDom, input.candidateDom),
    typographyStyle: styleScore(input.referenceDom, input.candidateDom),
    responsiveInteraction: interactionScore(input.interactionCheckpoints),
  })
  const composite = composeVisualScore(components)
  return Object.freeze({
    viewportID: input.viewportID,
    composite,
    points: round(composite * 0.3),
    components,
    design2Code: Object.freeze({ ssim: round(pixel.ssim), pixelSimilarity: round(pixel.similarity) }),
    evidence: validateEvidenceReferences(input.evidence),
  })
}

export function aggregateVisualViewports(values: readonly VisualViewportResult[]): VisualResult {
  const required = ["mobile", "tablet", "desktop"] as const
  if (values.length !== required.length) throw new TypeError("TASK24_VISUAL_VIEWPORTS_INVALID")
  const byID = new Map(values.map((value) => [value.viewportID, value]))
  if (byID.size !== required.length || required.some((id) => !byID.has(id))) {
    throw new TypeError("TASK24_VISUAL_VIEWPORTS_INVALID")
  }
  const viewports = required.map((id) => byID.get(id)!)
  const composite = round(viewports.reduce((sum, value) => sum + value.composite, 0) / viewports.length)
  const references = new Map<string, EvidenceReference>()
  for (const viewport of viewports) {
    for (const reference of validateEvidenceReferences(viewport.evidence)) {
      references.set(`${reference.kind}\0${reference.relativePath}\0${reference.sha256}`, reference)
    }
  }
  return Object.freeze({
    composite,
    points: round(composite * 0.3),
    viewportScores: Object.freeze(viewports.map((value) => value.composite)),
    viewports: Object.freeze(viewports),
    evidence: validateEvidenceReferences([...references.values()]),
  })
}

async function decode(value: Uint8Array): Promise<{ data: Uint8Array; width: number; height: number }> {
  const result = await sharp(value).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (result.info.channels !== 4 || result.info.width < 1 || result.info.height < 1) {
    throw new TypeError("TASK24_VISUAL_IMAGE_INVALID")
  }
  return { data: result.data, width: result.info.width, height: result.info.height }
}

function includedPixels(width: number, height: number, masks: readonly VisualMask[]): readonly number[] {
  if (masks.length > 1_000) throw new TypeError("TASK24_VISUAL_MASK_INVALID")
  const excluded = new Uint8Array(width * height)
  for (const mask of masks) {
    if (
      ![mask.x, mask.y, mask.width, mask.height].every(Number.isSafeInteger) ||
      mask.x < 0 ||
      mask.y < 0 ||
      mask.width < 1 ||
      mask.height < 1 ||
      mask.x + mask.width > width ||
      mask.y + mask.height > height
    ) {
      throw new TypeError("TASK24_VISUAL_MASK_INVALID")
    }
    for (let y = mask.y; y < mask.y + mask.height; y++) {
      for (let x = mask.x; x < mask.x + mask.width; x++) excluded[y * width + x] = 1
    }
  }
  const result: number[] = []
  for (let index = 0; index < excluded.length; index++) if (excluded[index] === 0) result.push(index)
  if (result.length === 0) throw new TypeError("TASK24_VISUAL_MASK_EMPTY")
  return result
}

function pixelScores(reference: Uint8Array, candidate: Uint8Array, pixels: readonly number[]) {
  let meanReference = 0
  let meanCandidate = 0
  let absolute = 0
  const referenceLuma: number[] = []
  const candidateLuma: number[] = []
  for (const pixel of pixels) {
    const offset = pixel * 4
    let channelDifference = 0
    for (let channel = 0; channel < 4; channel++) {
      channelDifference += Math.abs((reference[offset + channel] ?? 0) - (candidate[offset + channel] ?? 0))
    }
    absolute += channelDifference / 4
    const left = luma(reference, offset)
    const right = luma(candidate, offset)
    referenceLuma.push(left)
    candidateLuma.push(right)
    meanReference += left
    meanCandidate += right
  }
  meanReference /= pixels.length
  meanCandidate /= pixels.length
  let varianceReference = 0
  let varianceCandidate = 0
  let covariance = 0
  for (let index = 0; index < pixels.length; index++) {
    const left = (referenceLuma[index] ?? 0) - meanReference
    const right = (candidateLuma[index] ?? 0) - meanCandidate
    varianceReference += left * left
    varianceCandidate += right * right
    covariance += left * right
  }
  const denominator = Math.max(1, pixels.length - 1)
  varianceReference /= denominator
  varianceCandidate /= denominator
  covariance /= denominator
  const c1 = (0.01 * 255) ** 2
  const c2 = (0.03 * 255) ** 2
  const ssim =
    ((2 * meanReference * meanCandidate + c1) * (2 * covariance + c2)) /
    ((meanReference ** 2 + meanCandidate ** 2 + c1) * (varianceReference + varianceCandidate + c2))
  return { similarity: Math.max(0, 1 - absolute / pixels.length / 255), ssim: Math.max(0, Math.min(1, ssim)) }
}

function luma(value: Uint8Array, offset: number): number {
  return (value[offset] ?? 0) * 0.2126 + (value[offset + 1] ?? 0) * 0.7152 + (value[offset + 2] ?? 0) * 0.0722
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
