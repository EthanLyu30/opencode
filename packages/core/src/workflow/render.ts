export * as WorkflowRender from "./render"

import { Message } from "@opencode-ai/llm"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { VisualReview } from "@opencode-ai/schema/visual-review"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Effect, Schema } from "effect"
import { WorkflowDesignArtifact } from "./artifacts/design"
import { WorkflowVisualReviewArtifact } from "./artifacts/visual-review"
import { WorkflowStageMachine } from "./stage-machine"

export interface CaptureInput {
  readonly kind: "reference" | "implementation"
  readonly url: string
  readonly readySelector: string
  readonly viewport: DesignArtifact.Viewport
  readonly revision: number
}

export type Capture = (input: CaptureInput) => Effect.Effect<Uint8Array, unknown>

export const KIMI_VISUAL_REVIEW_ROUTE = {
  providerID: "kimi",
  modelID: "kimi-k3",
  protocol: "openai-chat",
} as const

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
    driver.capturePage({
      url: input.url,
      readySelector: input.readySelector,
      width: input.viewport.width,
      height: input.viewport.height,
    })

export interface DesignResult {
  readonly spec: unknown
  readonly referenceApp: {
    readonly url: string
    readonly files: ReadonlyArray<WorkflowDesignArtifact.SourceFile>
  }
  readonly usage: Workflow.Usage
}

export interface ImplementationResult {
  readonly url: string
  readonly usage: Workflow.Usage
}

export interface ReviewResult {
  readonly review: unknown
  readonly usage: Workflow.Usage
}

export interface Input {
  readonly workflowID: Workflow.ID
  readonly limits: VisualReview.Limits
  readonly design: () => Effect.Effect<DesignResult, unknown>
  readonly implement: (input: {
    readonly spec: DesignArtifact.Spec
    readonly referenceApp: DesignResult["referenceApp"]
  }) => Effect.Effect<ImplementationResult, unknown>
  readonly repair: (input: {
    readonly spec: DesignArtifact.Spec
    readonly review: VisualReview.Artifact
    readonly revision: number
  }) => Effect.Effect<ImplementationResult, unknown>
  readonly review: (input: {
    readonly route: typeof KIMI_VISUAL_REVIEW_ROUTE
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
  let usage = zeroUsage
  const artifacts: Workflow.ArtifactCommit[] = []
  const limits = Schema.decodeUnknownSync(VisualReview.Limits)(input.limits)

  const designed = yield* input.design()
  usage = addUsage(usage, designed.usage)
  const specCommit = WorkflowDesignArtifact.commitSpec(input.workflowID, designed.spec)
  const spec = WorkflowDesignArtifact.decodeSpec(specCommit, WorkflowDesignArtifact.encode(designed.spec))
  artifacts.push(
    specCommit,
    WorkflowDesignArtifact.commitReferenceApp(input.workflowID, spec, designed.referenceApp.files),
  )
  if (exhausted(limits, usage)) return approval("budget_exhausted", 0, artifacts, usage)

  const reference = yield* captureAll({
    workflowID: input.workflowID,
    kind: "reference",
    url: designed.referenceApp.url,
    readySelector: spec.referenceApp.readySelector,
    viewports: spec.referenceApp.viewports,
    revision: 0,
    capture: input.capture,
  })
  artifacts.push(...reference.map(WorkflowVisualReviewArtifact.commitScreenshot))

  let implementation = yield* input.implement({ spec, referenceApp: designed.referenceApp })
  usage = addUsage(usage, implementation.usage)
  if (exhausted(limits, usage)) return approval("budget_exhausted", 0, artifacts, usage)

  for (let revision = 0; ; revision++) {
    const candidate = yield* captureAll({
      workflowID: input.workflowID,
      kind: "implementation",
      url: implementation.url,
      readySelector: spec.referenceApp.readySelector,
      viewports: spec.referenceApp.viewports,
      revision,
      capture: input.capture,
    })
    artifacts.push(...candidate.map(WorkflowVisualReviewArtifact.commitScreenshot))
    const images = [...reference, ...candidate]
    const evidence = images.map(({ bytes: _, ...image }) => image)
    const reviewed = yield* input.review({
      route: KIMI_VISUAL_REVIEW_ROUTE,
      message: WorkflowVisualReviewArtifact.reviewMessage(spec, images),
      evidence,
      spec,
      revision,
    })
    usage = addUsage(usage, reviewed.usage)
    const review = Schema.decodeUnknownSync(VisualReview.Artifact)(reviewed.review)
    assertReviewContext(review, limits, evidence, revision)
    artifacts.push(WorkflowVisualReviewArtifact.commitReview(input.workflowID, review))
    if (review.verdict === "pass") return { status: "passed", revision, artifacts, usage }
    const decision = WorkflowStageMachine.decideVisualRepair({
      revision,
      maxRevisions: limits.maxRevisions,
      budget: limits,
      usage,
    })
    if (decision.type === "approval") return approval(decision.reason, revision, artifacts, usage)
    implementation = yield* input.repair({ spec, review, revision })
    usage = addUsage(usage, implementation.usage)
    if (exhausted(limits, usage)) return approval("budget_exhausted", revision + 1, artifacts, usage)
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
              workflowID: input.workflowID,
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

function approval(
  reason: "max_revisions" | "budget_exhausted",
  revision: number,
  artifacts: ReadonlyArray<Workflow.ArtifactCommit>,
  usage: Workflow.Usage,
): Result {
  return { status: "approval", reason, revision, artifacts, usage }
}

const zeroUsage: Workflow.Usage = { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 }
