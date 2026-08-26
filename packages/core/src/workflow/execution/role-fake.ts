import { VisualReview } from "@opencode-ai/schema/visual-review"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Schema } from "effect"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowDecompositionArtifact } from "../artifacts/decomposition"
import { WorkflowDeliveryArtifact } from "../artifacts/delivery"
import { WorkflowDesignArtifact } from "../artifacts/design"
import { WorkflowImplementationArtifact } from "../artifacts/implementation"
import { WorkflowTestArtifact } from "../artifacts/test"
import { WorkflowTestLogArtifact } from "../artifacts/test-log"
import { WorkflowVisualReviewArtifact } from "../artifacts/visual-review"
import { WorkflowRoleContract } from "./contract"
import type { DecodedPriorArtifact, ResolverInput, ResolverOutput } from "./role"

export function resolve(input: ResolverInput): ResolverOutput {
  const role = Schema.decodeUnknownSync(WorkflowRole.Role)(input.stage.type)
  const semantic = input.semantic
  if (semantic.outcome.role !== role) throw new Error("Deterministic evidence role mismatch")
  if (semantic.outcome.role === "design") {
    const { spec, sources } = Schema.decodeUnknownSync(WorkflowRoleContract.DesignPayload)(semantic.payload)
    return {
      artifacts: [
        WorkflowDesignArtifact.commitSpec(input.workflow.id, spec),
        WorkflowDesignArtifact.commitReferenceApp(input.workflow.id, spec, sources),
      ],
    }
  }
  if (semantic.outcome.role === "decompose") {
    const payload = Schema.decodeUnknownSync(WorkflowRoleContract.DecomposePayload)(semantic.payload)
    return {
      artifacts: [
        WorkflowDecompositionArtifact.commit(input.workflow.id, input.location, {
          schemaVersion: 1,
          workflowID: input.workflow.id,
          revision: input.revision,
          snapshotRef: `snapshot:deterministic-${input.contextDigest.slice(0, 24)}`,
          acceptanceCriteria: payload.acceptanceCriteria,
          tasks: payload.tasks,
        }),
      ],
    }
  }
  if (semantic.outcome.role === "implement" || semantic.outcome.role === "repair") {
    Schema.decodeUnknownSync(
      semantic.outcome.role === "implement"
        ? WorkflowRoleContract.ImplementPayload
        : WorkflowRoleContract.RepairPayload,
    )(semantic.payload)
    const planCommit = latestCommit(input.priorArtifacts, WorkflowDecompositionArtifact.KIND)
    const plan =
      planCommit === undefined
        ? undefined
        : WorkflowDecompositionArtifact.decode(planCommit, input.workflow.id, input.location)
    const paths = [...new Set(plan?.tasks.flatMap((task) => task.files) ?? ["src/app.ts"])]
    const changes = paths.map((file) => ({
      path: file,
      afterSha256: WorkflowBusinessArtifact.hash({ file, revision: input.revision, context: input.contextDigest }),
    }))
    const workspaceSha256 = WorkflowBusinessArtifact.hash(changes)
    return {
      artifacts: [
        WorkflowImplementationArtifact.commit(input.workflow.id, input.location, {
          schemaVersion: 1,
          workflowID: input.workflow.id,
          revision: input.revision,
          snapshotRef: plan?.snapshotRef ?? `snapshot:deterministic-${input.contextDigest.slice(0, 24)}`,
          workspaceSha256,
          changes,
        }),
      ],
    }
  }
  if (semantic.outcome.role === "test") {
    Schema.decodeUnknownSync(WorkflowRoleContract.TestPayload)(semantic.payload)
    const manifestCommit = latestCommit(input.priorArtifacts, WorkflowImplementationArtifact.KIND)
    if (!manifestCommit) throw new Error("Deterministic test evidence requires an implementation manifest")
    const manifest = WorkflowImplementationArtifact.decode(manifestCommit, input.workflow.id, input.location)
    const implementationSha256 = WorkflowImplementationArtifact.hash(manifest)
    const pass = input.semantic.outcome.verdict === "pass"
    const content = pass ? "deterministic test pass\n" : "deterministic test failure\n"
    const log = WorkflowTestLogArtifact.commit(input.workflow.id, input.revision, content)
    const result = {
      schemaVersion: 1 as const,
      workflowID: input.workflow.id,
      revision: input.revision,
      implementationSha256,
      verdict: pass ? ("pass" as const) : ("fail" as const),
      tests: [
        {
          name: "deterministic",
          argv: ["bun", "test"],
          cwd: ".",
          exitCode: pass ? 0 : 1,
          log: { uri: log.uri, sha256: log.sha256, size: log.size },
        },
      ],
      preview: {
        workflowID: input.workflow.id,
        revision: input.revision,
        implementationSha256,
        uri: `workflow://preview/${input.workflow.id}/r${input.revision}/${implementationSha256}`,
      },
    }
    return { artifacts: [WorkflowTestArtifact.commit(input.workflow.id, input.location, result), log] }
  }
  if (semantic.outcome.role === "visual_review") {
    const proposal = Schema.decodeUnknownSync(WorkflowRoleContract.VisualPayload)(semantic.payload)
    const specCommit = latestCommit(input.priorArtifacts, WorkflowDesignArtifact.SPEC_KIND)
    const spec = specCommit === undefined ? undefined : WorkflowDesignArtifact.decodeSpec(specCommit, input.workflow.id)
    const viewports = spec?.referenceApp.viewports ?? [{ name: "desktop", width: 1, height: 1 }]
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    )
    const images = viewports.flatMap((viewport) => [
      WorkflowVisualReviewArtifact.capturedImage({
        workflowID: input.workflow.id,
        kind: "reference",
        viewport: viewport.name,
        revision: 0,
        bytes: png,
      }),
      WorkflowVisualReviewArtifact.capturedImage({
        workflowID: input.workflow.id,
        kind: "implementation",
        viewport: viewport.name,
        revision: input.revision,
        bytes: png,
      }),
    ])
    const [firstEvidence, ...restEvidence] = images.map(({ bytes: _, evidenceReceipt: __, ...image }) => image)
    if (!firstEvidence) throw new Error("Deterministic visual review requires evidence")
    const evidence = [firstEvidence, ...restEvidence] as const
    const findings = proposal.findings.map((finding) => ({
      ...finding,
      selector: "body",
      evidenceImageIDs: evidence.filter((image) => image.viewport === finding.viewport).map((image) => image.id),
    }))
    const review = Schema.decodeUnknownSync(VisualReview.Artifact)({
      schemaVersion: 1,
      revision: input.revision,
      verdict: proposal.verdict,
      score: proposal.score,
      limits: {
        maxRevisions: VisualReview.MAX_VISUAL_REVISIONS,
        maxTokens: input.execution.workflowBudget.maxTokens ?? 1,
        maxTurns: input.execution.workflowBudget.maxTurns ?? 1,
        maxToolCalls: input.execution.workflowBudget.maxToolCalls ?? 1,
      },
      usage: {
        tokens: input.execution.executionUsage.tokens,
        turns: input.execution.executionUsage.turns,
        toolCalls: input.execution.executionUsage.toolCalls,
      },
      evidence,
      findings,
    })
    return {
      artifacts: [
        ...images.map(WorkflowVisualReviewArtifact.commitScreenshot),
        WorkflowVisualReviewArtifact.commitReview(input.workflow.id, review),
      ],
    }
  }
  const manifestCommit = latestCommit(input.priorArtifacts, WorkflowImplementationArtifact.KIND)
  const testCommit = latestCommit(input.priorArtifacts, WorkflowTestArtifact.KIND)
  const reviewCommit = latestCommit(input.priorArtifacts, WorkflowVisualReviewArtifact.REVIEW_KIND)
  if (!manifestCommit || !testCommit || !reviewCommit)
    throw new Error("Deterministic delivery evidence requires prior artifacts")
  const manifest = WorkflowImplementationArtifact.decode(manifestCommit, input.workflow.id, input.location)
  const test = WorkflowTestArtifact.decode(testCommit, input.workflow.id, input.location)
  const review = WorkflowVisualReviewArtifact.decodeReview(reviewCommit, input.workflow.id)
  const payload = Schema.decodeUnknownSync(WorkflowRoleContract.DeliverPayload)(semantic.payload)
  return {
    artifacts: [
      WorkflowDeliveryArtifact.commit(input.workflow.id, input.location, {
        schemaVersion: 1,
        workflowID: input.workflow.id,
        revision: input.revision,
        implementationSha256: WorkflowImplementationArtifact.hash(manifest),
        testSha256: WorkflowTestArtifact.hash(test),
        visualReviewSha256: WorkflowDeliveryArtifact.hashVisualReview(review),
        summary: payload.summary,
      }),
    ],
  }
}

function latestCommit(artifacts: readonly DecodedPriorArtifact[], kind: string) {
  return artifacts.filter((artifact) => artifact.kind === kind).at(-1)?.commit
}
