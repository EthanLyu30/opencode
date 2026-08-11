export * as VisualReview from "./visual-review"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "./schema"
import { DesignArtifact } from "./design-artifact"

export const MAX_VISUAL_REVISIONS = 10

const MaxRevisions = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_VISUAL_REVISIONS))
const Score = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100))

export const Limits = Schema.Struct({
  maxRevisions: MaxRevisions,
  maxTokens: PositiveInt,
  maxTurns: PositiveInt,
  maxToolCalls: PositiveInt,
}).annotate({ identifier: "VisualReview.Limits" })
export interface Limits extends Schema.Schema.Type<typeof Limits> {}

export const Usage = Schema.Struct({
  tokens: NonNegativeInt,
  turns: NonNegativeInt,
  toolCalls: NonNegativeInt,
}).annotate({ identifier: "VisualReview.Usage" })
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

export const EvidenceImage = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["reference", "implementation"]),
  viewport: Schema.NonEmptyString,
  uri: Schema.NonEmptyString,
  mime: Schema.Literal("image/png"),
  sha256: DesignArtifact.Sha256,
  size: PositiveInt,
}).annotate({ identifier: "VisualReview.EvidenceImage" })
export interface EvidenceImage extends Schema.Schema.Type<typeof EvidenceImage> {}

export const Finding = Schema.Struct({
  id: Schema.NonEmptyString,
  severity: Schema.Literals(["critical", "major", "minor"]),
  viewport: Schema.NonEmptyString,
  selector: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
  category: Schema.Literals([
    "layout",
    "typography",
    "color",
    "spacing",
    "content",
    "interaction",
    "responsive",
    "accessibility",
  ]),
  expected: Schema.NonEmptyString,
  actual: Schema.NonEmptyString,
  evidenceImageIDs: Schema.NonEmptyArray(Schema.NonEmptyString),
  repair: Schema.NonEmptyString,
  requiresRecapture: Schema.Boolean,
}).annotate({ identifier: "VisualReview.Finding" })
export interface Finding extends Schema.Schema.Type<typeof Finding> {}

const ArtifactShape = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: NonNegativeInt,
  verdict: Schema.Literals(["pass", "fail"]),
  score: Score,
  limits: Limits,
  usage: Usage,
  evidence: Schema.NonEmptyArray(EvidenceImage),
  findings: Schema.Array(Finding),
})

const safePersistence = Schema.makeFilter<Schema.Schema.Type<typeof ArtifactShape>>((value) =>
  containsSecret(value) ? "Visual review artifacts must not contain provider secrets" : undefined,
)

const internallyConsistent = Schema.makeFilter<Schema.Schema.Type<typeof ArtifactShape>>((value) => {
  if (value.revision > value.limits.maxRevisions) return "Visual review revision exceeds maxRevisions"
  if ((value.verdict === "pass") !== (value.findings.length === 0))
    return "Passing reviews must have no findings and failing reviews must have findings"
  const evidence = new Map(value.evidence.map((image) => [image.id, image]))
  if (evidence.size !== value.evidence.length) return "Evidence image IDs must be unique"
  if (!value.evidence.some((image) => image.kind === "reference")) return "Reference image evidence is required"
  if (!value.evidence.some((image) => image.kind === "implementation"))
    return "Implementation image evidence is required"
  for (const finding of value.findings) {
    const images = finding.evidenceImageIDs.map((id) => evidence.get(id))
    if (images.some((image) => image === undefined)) return `Finding ${finding.id} references unknown evidence`
    if (!images.some((image) => image?.kind === "reference" && image.viewport === finding.viewport))
      return `Finding ${finding.id} requires reference evidence for its viewport`
    if (!images.some((image) => image?.kind === "implementation" && image.viewport === finding.viewport))
      return `Finding ${finding.id} requires implementation evidence for its viewport`
  }
  return undefined
})

export const Artifact = ArtifactShape.check(safePersistence, internallyConsistent).annotate({
  identifier: "VisualReview.Artifact",
})
export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/.test(value)
  if (Array.isArray(value)) return value.some(containsSecret)
  if (value === null || typeof value !== "object") return false
  return Object.entries(value).some(
    ([key, item]) =>
      /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|set-cookie)$/i.test(key) ||
      containsSecret(item),
  )
}
