export * as WorkflowRender from "./render"

import { Message } from "@opencode-ai/llm"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { VisualReview } from "@opencode-ai/schema/visual-review"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Effect, Schema } from "effect"
import { WorkflowDesignArtifact } from "./artifacts/design"
import { WorkflowVisualReviewArtifact } from "./artifacts/visual-review"
import { WorkflowRouting } from "./routing"
import { WorkflowSecretGuard } from "./secret-guard"
import { WorkflowStageMachine } from "./stage-machine"

export interface CaptureInput {
  readonly kind: "reference" | "implementation"
  readonly url: string
  readonly readySelector: string
  readonly viewport: DesignArtifact.Viewport
  readonly revision: number
}

export type Capture = (input: CaptureInput) => Effect.Effect<Uint8Array, unknown>

/** A concrete browser adapter must navigate, set the exact viewport, wait for readySelector, and return PNG bytes. */
export interface BrowserDriver {
  readonly capturePage: (input: {
    readonly url: string
    readonly readySelector: string
    readonly width: number
    readonly height: number
  }) => Effect.Effect<Uint8Array, unknown>
}

/** Production adapter. Viewport fan-out remains owned by captureAll so every configured viewport is captured. */
export const production =
  (driver: BrowserDriver): Capture =>
  (input) =>
    driver
      .capturePage({
        url: input.url,
        readySelector: input.readySelector,
        width: input.viewport.width,
        height: input.viewport.height,
      })
      .pipe(
        Effect.flatMap((bytes) =>
          Effect.try({
            try: () => {
              WorkflowVisualReviewArtifact.assertPng(bytes)
              return bytes
            },
            catch: (error) => (error instanceof Error ? error : new Error("Browser capture is not a PNG")),
          }),
        ),
      )

export interface DesignResult {
  readonly spec: unknown
  readonly referenceApp: {
    readonly files: ReadonlyArray<WorkflowDesignArtifact.SourceFile>
  }
  readonly usage: Workflow.Usage
}

export interface ImplementationResult {
  readonly usage: Workflow.Usage
}

export interface ReviewResult {
  readonly review: unknown
  readonly usage: Workflow.Usage
}

export interface Input {
  readonly workflowID: Workflow.ID
  readonly limits: VisualReview.Limits
  readonly design: (input: { readonly route: WorkflowRouting.Route }) => Effect.Effect<DesignResult, unknown>
  readonly prepareReference: (input: {
    readonly artifact: Workflow.ArtifactCommit
    readonly app: WorkflowDesignArtifact.ReferenceApp
  }) => Effect.Effect<string, unknown>
  readonly implement: (input: {
    readonly route: WorkflowRouting.Route
    readonly spec: DesignArtifact.Spec
    readonly referenceApp: WorkflowDesignArtifact.ReferenceApp
  }) => Effect.Effect<ImplementationResult, unknown>
  readonly repair: (input: {
    readonly route: WorkflowRouting.Route
    readonly spec: DesignArtifact.Spec
    readonly review: VisualReview.Artifact
    readonly revision: number
  }) => Effect.Effect<ImplementationResult, unknown>
  /** Host-owned preview preparation. Model implementation and repair results never supply capture URLs. */
  readonly prepareImplementation: (input: { readonly revision: number }) => Effect.Effect<string, unknown>
  readonly review: (input: {
    readonly route: WorkflowRouting.Route
    readonly message: Message
    readonly evidence: ReadonlyArray<VisualReview.EvidenceImage>
    readonly spec: DesignArtifact.Spec
    readonly revision: number
  }) => Effect.Effect<ReviewResult, unknown>
  readonly capture: Capture
}

export type Result =
  | {
      readonly status: "passed"
      readonly revision: number
      readonly artifacts: ReadonlyArray<Workflow.ArtifactCommit>
      readonly usage: Workflow.Usage
    }
  | {
      readonly status: "approval"
      readonly reason: "max_revisions" | "budget_exhausted"
      readonly revision: number
      readonly artifacts: ReadonlyArray<Workflow.ArtifactCommit>
      readonly usage: Workflow.Usage
    }

export const run = Effect.fn("WorkflowRender.run")(function* (input: Input): Effect.fn.Return<Result, unknown> {
  const workflowID = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(DesignArtifact.SafeWorkflowID)(input.workflowID),
    catch: (error) => (error instanceof Error ? error : new Error("Workflow ID is unsafe")),
  })
  let usage = zeroUsage
  const artifacts: Workflow.ArtifactCommit[] = []
  const limits = Schema.decodeUnknownSync(VisualReview.Limits)(input.limits)
  const budget = {
    maxTokens: limits.maxTokens,
    maxTurns: limits.maxTurns,
    maxToolCalls: limits.maxToolCalls,
  }

  const rawDesigned = yield* input.design({ route: WorkflowRouting.resolve({ role: "design", budget }) })
  const designed = yield* Effect.try({
    try: () => validateDesignResult(rawDesigned),
    catch: (error) => (error instanceof Error ? error : new Error("Design result is invalid")),
  })
  usage = addUsage(usage, designed.usage)
  const specCommit = WorkflowDesignArtifact.commitSpec(workflowID, designed.spec)
  const spec = WorkflowDesignArtifact.decodeSpec(specCommit, workflowID)
  const referenceCommit = WorkflowDesignArtifact.commitReferenceApp(workflowID, spec, designed.referenceApp.files)
  const durableReference = WorkflowDesignArtifact.decodeReferenceApp(referenceCommit, workflowID)
  artifacts.push(specCommit, referenceCommit)
  if (exhausted(limits, usage)) return approval("budget_exhausted", 0, artifacts, usage)
  const referenceUrl = yield* input.prepareReference({ artifact: referenceCommit, app: durableReference })
  yield* Effect.try({
    try: () => validateHostPreviewUrl(referenceUrl, "Reference preview"),
    catch: (error) => (error instanceof Error ? error : new Error("Host reference preview URL is invalid")),
  })

  const reference = yield* captureAll({
    workflowID,
    kind: "reference",
    url: referenceUrl,
    readySelector: spec.referenceApp.readySelector,
    viewports: spec.referenceApp.viewports,
    revision: 0,
    capture: input.capture,
  })
  artifacts.push(...reference.map(WorkflowVisualReviewArtifact.commitScreenshot))

  const rawImplementation = yield* input.implement({
    route: WorkflowRouting.resolve({ role: "implement", budget }),
    spec,
    referenceApp: durableReference,
  })
  const implementation = yield* Effect.try({
    try: () => validateImplementationResult(rawImplementation, "Implementation result"),
    catch: (error) => (error instanceof Error ? error : new Error("Implementation result is invalid")),
  })
  usage = addUsage(usage, implementation.usage)
  if (exhausted(limits, usage)) return approval("budget_exhausted", 0, artifacts, usage)

  let revision = 0
  let implementationUrl = yield* input.prepareImplementation({ revision })
  implementationUrl = yield* Effect.try({
    try: () => validateHostPreviewUrl(implementationUrl, "Implementation preview"),
    catch: (error) => (error instanceof Error ? error : new Error("Host implementation preview URL is invalid")),
  })
  while (true) {
    const candidate = yield* captureAll({
      workflowID,
      kind: "implementation",
      url: implementationUrl,
      readySelector: spec.referenceApp.readySelector,
      viewports: spec.referenceApp.viewports,
      revision,
      capture: input.capture,
    })
    artifacts.push(...candidate.map(WorkflowVisualReviewArtifact.commitScreenshot))
    const images = [...reference, ...candidate]
    const evidence = images.map(({ bytes: _, ...image }) => image)
    const rawReviewed = yield* input.review({
      route: WorkflowRouting.resolve({ role: "visual_review", budget }),
      message: WorkflowVisualReviewArtifact.reviewMessage(spec, images),
      evidence,
      spec,
      revision,
    })
    const reviewed = yield* Effect.try({
      try: () => validateReviewResult(rawReviewed),
      catch: (error) => (error instanceof Error ? error : new Error("Visual review result is invalid")),
    })
    usage = addUsage(usage, reviewed.usage)
    WorkflowSecretGuard.assertSafe(reviewed.review)
    if (reviewed.review === null || typeof reviewed.review !== "object" || Array.isArray(reviewed.review))
      throw new Error("Visual review model output must be an object")
    const review = Schema.decodeUnknownSync(VisualReview.Artifact)({
      ...reviewed.review,
      usage: measuredReviewUsage(reviewed.usage),
    })
    assertReviewContext(review, limits, evidence, revision)
    artifacts.push(WorkflowVisualReviewArtifact.commitReview(workflowID, review))
    if (exhausted(limits, usage)) return approval("budget_exhausted", revision, artifacts, usage)
    if (review.verdict === "pass") return { status: "passed", revision, artifacts, usage }
    const decision = WorkflowStageMachine.decideVisualRepair({
      revision,
      maxRevisions: limits.maxRevisions,
      budget: limits,
      usage,
    })
    if (decision.type === "approval") return approval(decision.reason, revision, artifacts, usage)
    const rawRepair = yield* input.repair({
      route: WorkflowRouting.resolve({ role: "repair", budget }),
      spec,
      review,
      revision: decision.revision,
    })
    const repair = yield* Effect.try({
      try: () => validateImplementationResult(rawRepair, "Repair result"),
      catch: (error) => (error instanceof Error ? error : new Error("Repair result is invalid")),
    })
    usage = addUsage(usage, repair.usage)
    revision = decision.revision
    if (exhausted(limits, usage)) return approval("budget_exhausted", revision, artifacts, usage)
    implementationUrl = yield* input.prepareImplementation({ revision })
    implementationUrl = yield* Effect.try({
      try: () => validateHostPreviewUrl(implementationUrl, "Implementation preview"),
      catch: (error) => (error instanceof Error ? error : new Error("Host implementation preview URL is invalid")),
    })
  }
})

export const captureAll = Effect.fn("WorkflowRender.captureAll")(function* (input: {
  readonly workflowID: Workflow.ID
  readonly kind: "reference" | "implementation"
  readonly url: string
  readonly readySelector: string
  readonly viewports: ReadonlyArray<DesignArtifact.Viewport>
  readonly revision: number
  readonly capture: Capture
}) {
  const workflowID = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(DesignArtifact.SafeWorkflowID)(input.workflowID),
    catch: (error) => (error instanceof Error ? error : new Error("Workflow ID is unsafe")),
  })
  return yield* Effect.forEach(
    input.viewports,
    (viewport) =>
      input
        .capture({
          kind: input.kind,
          url: input.url,
          readySelector: input.readySelector,
          viewport,
          revision: input.revision,
        })
        .pipe(
          Effect.map((bytes) =>
            WorkflowVisualReviewArtifact.capturedImage({
              workflowID,
              kind: input.kind,
              viewport: viewport.name,
              revision: input.revision,
              bytes,
            }),
          ),
        ),
    { concurrency: 1 },
  )
})

function assertReviewContext(
  review: VisualReview.Artifact,
  limits: VisualReview.Limits,
  evidence: ReadonlyArray<VisualReview.EvidenceImage>,
  revision: number,
): void {
  if (
    review.revision !== revision ||
    review.limits.maxRevisions !== limits.maxRevisions ||
    review.limits.maxTokens !== limits.maxTokens ||
    review.limits.maxTurns !== limits.maxTurns ||
    review.limits.maxToolCalls !== limits.maxToolCalls ||
    WorkflowDesignArtifact.encode(review.evidence) !== WorkflowDesignArtifact.encode(evidence)
  ) {
    throw new Error("Visual review is not bound to the configured revision, limits, and evidence")
  }
}

function exhausted(limits: VisualReview.Limits, usage: Workflow.Usage): boolean {
  const decision = WorkflowStageMachine.decideVisualRepair({
    revision: 0,
    maxRevisions: limits.maxRevisions,
    budget: limits,
    usage,
  })
  return decision.type === "approval" && decision.reason === "budget_exhausted"
}

function addUsage(left: Workflow.Usage, right: Workflow.Usage): Workflow.Usage {
  return {
    tokens: left.tokens + right.tokens,
    turns: left.turns + right.turns,
    toolCalls: left.toolCalls + right.toolCalls,
    attempts: left.attempts + right.attempts,
  }
}

function measuredReviewUsage(usage: Workflow.Usage): VisualReview.Usage {
  return { tokens: usage.tokens, turns: usage.turns, toolCalls: usage.toolCalls }
}

function validateDesignResult(result: DesignResult): DesignResult {
  WorkflowSecretGuard.assertSafe(result)
  assertPlainObject(result, "Design result")
  assertExactKeys(result, ["referenceApp", "spec", "usage"], "Design result")
  assertPlainObject(result.referenceApp, "Design referenceApp")
  assertExactKeys(result.referenceApp, ["files"], "Design referenceApp")
  if (!Array.isArray(result.referenceApp.files) || result.referenceApp.files.length === 0)
    throw new Error("Design referenceApp must contain source files")
  for (const file of result.referenceApp.files) {
    if (file === null || typeof file !== "object" || Array.isArray(file))
      throw new Error("Design reference source must be an object")
    assertExactKeys(file, ["content", "path"], "Design reference source")
    if (typeof file.path !== "string" || typeof file.content !== "string")
      throw new Error("Design reference source path and content must be strings")
  }
  return { ...result, usage: decodeUsage(result.usage) }
}

function validateImplementationResult(result: ImplementationResult, name: string): ImplementationResult {
  WorkflowSecretGuard.assertSafe(result)
  assertPlainObject(result, name)
  assertExactKeys(result, ["usage"], name)
  return { usage: decodeUsage(result.usage) }
}

function validateReviewResult(result: ReviewResult): ReviewResult {
  WorkflowSecretGuard.assertSafe(result)
  assertPlainObject(result, "Visual review result")
  assertExactKeys(result, ["review", "usage"], "Visual review result")
  if (result.review === null || typeof result.review !== "object" || Array.isArray(result.review))
    throw new Error("Visual review model output must be an object")
  return { review: result.review, usage: decodeUsage(result.usage) }
}

function decodeUsage(input: unknown): Workflow.Usage {
  WorkflowSecretGuard.assertSafe(input)
  return Schema.decodeUnknownSync(Workflow.Usage)(input, { onExcessProperty: "error" })
}

function validateHostPreviewUrl(input: unknown, name: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error(`${name} URL must not be empty`)
  WorkflowSecretGuard.assertSafe(input)
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error(`${name} URL must be absolute`)
  }
  if (!new Set(["http:", "https:", "file:"]).has(parsed.protocol) || parsed.username || parsed.password)
    throw new Error(`${name} URL is unsafe`)
  return input
}

function assertPlainObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${name} must be a plain object`)
}

function assertExactKeys(value: object, expected: ReadonlyArray<string>, name: string): void {
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error(`${name} contains an unexpected property`)
}

function approval(
  reason: "max_revisions" | "budget_exhausted",
  revision: number,
  artifacts: ReadonlyArray<Workflow.ArtifactCommit>,
  usage: Workflow.Usage,
): Result {
  return { status: "approval", reason, revision, artifacts, usage }
}

const zeroUsage: Workflow.Usage = { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 }
