import { Workflow } from "@opencode-ai/schema/workflow"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { DateTime, Effect, Schema } from "effect"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { Snapshot } from "../../src/snapshot"
import { RelativePath } from "../../src/schema"
import { CodingArtifacts } from "../../src/workflow/coding/artifacts"
import { CodingEvidence } from "../../src/workflow/coding/evidence"
import { CodingHostPlan } from "../../src/workflow/coding/host-plan"
import { CodingModelSelection } from "../../src/workflow/coding/model-selection"
import { CodingRouting } from "../../src/workflow/coding/routing"
import { CodingContract } from "../../src/workflow/coding/contract"
import { WorkflowBusinessArtifact } from "../../src/workflow/artifacts/business"
import { WorkflowWorkspaceMaterialization } from "../../src/workflow/workspace-materialization"
import { fixtureAdmissionSnapshot } from "./workflow-model-catalog"
import { codingFixture } from "./workflow-coding"
import { Hash } from "../../src/util/hash"

/** In-memory exact-Snapshot/check authority fixture, not a claim of executing a real sandbox. */
export function codingEvidenceFixture(directory: string) {
  const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
  const selection = CodingModelSelection.freeze(fixtureAdmissionSnapshot(), location)
  const plan = CodingHostPlan.freeze({ authority: "admission", location, checks: { cwd: ".", test: "bun-test" } })
  const original = codingFixture()
  const workflow = {
    ...original.workflow,
    location,
    input: {
      brief: "Fix sum",
      [CodingModelSelection.RESERVED_INPUT_KEY]: selection,
      [CodingHostPlan.RESERVED_INPUT_KEY]: plan,
    },
  }
  const artifacts: Workflow.Artifact[] = []
  let source = "export const sum = () => 0"
  let pass = true
  const snapshots = new Map<Snapshot.ID, readonly Snapshot.Entry[]>()
  const entries = (): readonly Snapshot.Entry[] => [
    { path: RelativePath.make("sum.ts"), type: "file", sha256: Hash.sha256(source), size: Buffer.byteLength(source) },
  ]
  const capture = () => {
    const id = Snapshot.ID.make(Snapshot.workspaceSha256(entries()))
    snapshots.set(id, entries())
    return id
  }
  const evidence = CodingEvidence.make(
    {
      captureSnapshot: () => Effect.sync(capture),
      snapshotEntries: (_, snapshot) => Effect.succeed(snapshots.get(snapshot)!),
      sealWorkspace: (input) =>
        Effect.promise(async () =>
          WorkflowWorkspaceMaterialization.bind({
            ...input,
            snapshotRef: capture(),
            archive: await WorkflowWorkspaceMaterialization.seal(entries(), async () => Buffer.from(source)),
          }),
        ),
      run: (input) =>
        Effect.succeed(
          CodingArtifacts.checkpointChecks(input.stage) ?? {
            schemaVersion: 1,
            workflowID: workflow.id,
            stageID: input.stage.id,
            attempt: input.stage.attempt,
            leaseOwner: input.stage.leaseOwner!,
            revision: input.revision,
            locationSha256: WorkflowBusinessArtifact.locationSha256(location),
            planSha256: plan.sha256,
            configSha256: plan.configSha256,
            implementationSha256: input.sealedSnapshot.manifestSha256,
            workspaceSha256: input.sealedSnapshot.workspaceSha256,
            snapshotRef: input.sealedSnapshot.snapshotRef,
            sealedAuthoritySha256: input.sealedSnapshot.authoritySha256,
            checks: [
              {
                id: "test",
                status: "executed",
                argv: plan.commands[0]!.argv,
                cwd: ".",
                exitCode: pass ? 0 : 1,
                timedOut: false,
                observedTests: 1,
                failedTests: pass ? 0 : 1,
                reportSha256: "a".repeat(64),
                log: pass ? "1 pass" : "1 fail",
                logSha256: WorkflowBusinessArtifact.hash(pass ? "1 pass" : "1 fail"),
                ownerSha256: "b".repeat(64),
              },
              { id: "build", status: "not-applicable" },
              { id: "typecheck", status: "not-applicable" },
            ],
          },
        ),
    },
    { require: () => Effect.void },
  )
  return {
    workflow,
    artifacts,
    evidence,
    plan,
    source: (value: string) => {
      source = value
    },
    pass: (value: boolean) => {
      pass = value
    },
    async run(
      role: string,
      revision: number,
      ordinal: number,
      payload: Readonly<Record<string, unknown>>,
      verdict = "ready",
    ) {
      const stage = {
        ...codingFixture(role, revision).stage,
        workflowID: workflow.id,
        ordinal,
        leaseOwner: "coding-worker",
      }
      const effective = CodingArtifacts.revisionOf(workflow, stage, artifacts)
      const preparation = await evidence
        .prepare({
          workflow,
          stage,
          revision: effective,
          location,
          priorArtifacts: artifacts,
          admission: { workflowInput: workflow.input, stageInput: stage.input },
        })
        .pipe(Effect.runPromise)
      const contract = CodingContract.build({
        workflow,
        stage,
        route: CodingRouting.resolve({ role: contractRole(role), budget: workflow.budget, selection }),
        priorArtifacts: artifacts,
        ...(preparation.messages === undefined ? {} : { messages: preparation.messages }),
      })
      const semantic = CodingContract.decode(contract, {
        contractVersion: 1,
        outcome: { schemaVersion: 1, role, revision: effective, verdict },
        payload,
      })
      const result = await evidence
        .settle({
          workflow,
          stage,
          contract,
          semantic,
          priorArtifacts: artifacts,
          settledToolEvidence: [],
          executionUsage: { tokens: 1, turns: 1, toolCalls: 0, attempts: 0 },
          providerUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          preparation,
        })
        .pipe(Effect.runPromise)
      const durable = result.artifacts.map((commit) =>
        Workflow.Artifact.make({
          ...commit,
          id: Workflow.ArtifactID.create(),
          workflowID: workflow.id,
          stageID: stage.id,
          timeCreated: DateTime.makeUnsafe(1),
        }),
      )
      artifacts.push(...durable)
      return { ...result, stage, preparation, durable }
    },
  }
}
function contractRole(role: string) {
  return Schema.decodeUnknownSync(WorkflowCodingBuild.Role)(role)
}
