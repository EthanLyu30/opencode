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
import { WorkflowBenchmarkTransport } from "../benchmark-transport"
import { WorkflowProductionHostPlan } from "../production-host-plan"
import { WorkflowVisualHost } from "../visual-host"
import { WorkflowVisualEvidence } from "../visual-evidence"
import { Hash } from "../../util/hash"
import { deflateSync } from "node:zlib"

export function resolve(input: ResolverInput): ResolverOutput {
  const role = Schema.decodeUnknownSync(WorkflowRole.Role)(input.stage.type)
  const semantic = input.semantic
  // Task24's fake evidence is isolated from the production resolver and never
  // used to score visual quality. Keep its lineage compatible with current gates.
  const offline = WorkflowBenchmarkTransport.fromWorkflow(input.workflow)?.evidenceMode === "deterministic_offline"
  const productionPlan = offline ? WorkflowProductionHostPlan.fromWorkflow(input.workflow) : undefined
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
          schemaVersion: productionPlan ? 2 : 1,
          workflowID: input.workflow.id,
          revision: input.revision,
          snapshotRef: plan?.snapshotRef ?? `snapshot:deterministic-${input.contextDigest.slice(0, 24)}`,
          workspaceSha256,
          changes: productionPlan ? changes.map((change) => ({ change: "added", ...change })) : changes,
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
    const log = productionPlan
      ? WorkflowTestLogArtifact.commitExact(input.workflow.id, input.stage.id, input.revision, content)
      : WorkflowTestLogArtifact.commit(input.workflow.id, input.revision, content)
    const result = {
      schemaVersion: productionPlan ? 2 : 1,
      workflowID: input.workflow.id,
      ...(productionPlan ? { stageID: input.stage.id } : {}),
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
    return {
      artifacts: [
        productionPlan
          ? WorkflowTestArtifact.commitExact(input.workflow.id, input.stage.id, input.location, result)
          : WorkflowTestArtifact.commit(input.workflow.id, input.location, result),
        log,
      ],
    }
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
    const referenceCommit = latestCommit(input.priorArtifacts, WorkflowDesignArtifact.REFERENCE_APP_KIND)
    const manifestCommit = latestCommit(input.priorArtifacts, WorkflowImplementationArtifact.KIND)
    const referenceIdentity =
      productionPlan && referenceCommit
        ? WorkflowVisualHost.referenceIdentity(
            input.workflow.id,
            WorkflowDesignArtifact.decodeReferenceApp(referenceCommit, input.workflow.id),
          )
        : undefined
    const manifest =
      productionPlan && manifestCommit
        ? WorkflowImplementationArtifact.decodeExact(manifestCommit, input.workflow.id, input.location)
        : undefined
    const images = viewports.flatMap((viewport) =>
      (["reference", "implementation"] as const).map((kind) => {
        const bytes = productionPlan ? fixturePng(viewport.width, viewport.height) : png
        const revision = kind === "reference" ? 0 : input.revision
        const coordinates =
          productionPlan && referenceIdentity && manifest
            ? WorkflowVisualEvidence.validateEvidenceCoordinates({
                schemaVersion: 1,
                workflowID: input.workflow.id,
                stageID: input.stage.id,
                kind,
                revision,
                viewport,
                configSha256:
                  kind === "reference" ? referenceIdentity.configSha256 : productionPlan.preview.configSha256,
                sourceSha256:
                  kind === "reference" ? referenceIdentity.sourceSha256 : WorkflowImplementationArtifact.hash(manifest),
                readySelectorSha256:
                  kind === "reference"
                    ? referenceIdentity.readySelectorSha256
                    : Hash.sha256(spec!.referenceApp.readySelector),
              })
            : undefined
        return WorkflowVisualReviewArtifact.capturedImage({
          workflowID: input.workflow.id,
          kind,
          viewport: viewport.name,
          revision,
          bytes,
          ...(coordinates
            ? {
                evidenceReceipt: {
                  evidenceID: WorkflowVisualEvidence.evidenceID(coordinates),
                  coordinates,
                  pngSha256: Hash.sha256(Buffer.from(bytes)),
                  width: viewport.width,
                  height: viewport.height,
                  evidenceBytes: bytes.byteLength,
                },
              }
            : {}),
        })
      }),
    )
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

/** Deterministic transparent fixture, explicitly not a browser capture. */
function fixturePng(width: number, height: number): Uint8Array {
  if (
    width > WorkflowVisualEvidence.MAX_VIEWPORT_DIMENSION ||
    height > WorkflowVisualEvidence.MAX_VIEWPORT_DIMENSION ||
    width * height > WorkflowVisualEvidence.MAX_VIEWPORT_PIXELS
  )
    throw new TypeError("Offline fixture viewport exceeds host bounds")
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}
function pngChunk(name: string, body: Buffer) {
  const chunk = Buffer.alloc(body.length + 12)
  chunk.writeUInt32BE(body.length, 0)
  chunk.write(name, 4, "ascii")
  body.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}
