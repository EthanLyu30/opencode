import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Message } from "@opencode-ai/llm"
import { WorkflowRoleContract } from "@opencode-ai/core/workflow/execution/contract"
import { WorkflowRoleExecution } from "@opencode-ai/core/workflow/execution/role"
import { WorkflowRouting } from "@opencode-ai/core/workflow/routing"
import { WorkflowStageMachine } from "@opencode-ai/core/workflow/stage-machine"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { DateTime, Effect } from "effect"

const workflowID = Workflow.ID.make("wfl_role_contract")
const location = Location.Ref.make({ directory: AbsolutePath.make("D:\\role-contract-workspace") })
const budget: Workflow.Budget = { maxTokens: 10_000, maxTurns: 8, maxToolCalls: 16, maxAttempts: 2 }
const source = "<!doctype html><html><body><main>Reference</main></body></html>"
const sourceSha256 = new Bun.CryptoHasher("sha256").update(source).digest("hex")

const designSpec = DesignArtifact.Spec.make({
  schemaVersion: 1,
  goals: ["Render the approved reference"],
  routes: [{ path: "/", goal: "Show the reference" }],
  layoutConstraints: ["Keep the main content visible"],
  componentTree: [{ id: "root", component: "main", children: [] }],
  states: [{ name: "ready", description: "The page is ready" }],
  typography: [{ token: "body", family: "sans-serif", weight: 400, sizePx: 16, lineHeight: 1.5 }],
  colors: [{ token: "background", value: "#ffffff" }],
  responsiveRules: [{ viewport: "desktop", width: 1280, height: 720, rules: ["Keep main visible"] }],
  accessibilityRules: ["Use semantic landmarks"],
  acceptanceCriteria: ["The reference renders"],
  projectStack: ["HTML"],
  referenceApp: {
    entrypoint: "index.html",
    readySelector: "main",
    files: [{ path: "index.html", sha256: sourceSha256, size: Buffer.byteLength(source) }],
    viewports: [{ name: "desktop", width: 1280, height: 720 }],
  },
})

const workflow = Workflow.Info.make({
  id: workflowID,
  type: "visual-build",
  status: "running",
  input: { brief: "Build the approved reference", previewPlan: { kind: "static", entrypoint: "index.html" } },
  budget,
  usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
  location,
  version: 1,
  time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
})

function stage(role: WorkflowRole.Role, revision = 0): Workflow.Stage {
  return Workflow.Stage.make({
    id: Workflow.StageID.make(`wfs_contract_${role}_${revision}`),
    workflowID,
    type: role,
    ordinal: 0,
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    recoveryPolicy: "restart_safe",
    idempotencyKey: `role-contract/${role}/r${revision}`,
    input: { revision },
    time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1), started: DateTime.makeUnsafe(1) },
  })
}

function contract(
  role: WorkflowRole.Role,
  revision = 0,
  messages?: readonly Message[],
  priorArtifacts: readonly Workflow.Artifact[] = [],
) {
  const current = stage(role, revision)
  return WorkflowRoleContract.build({
    workflow,
    stage: current,
    route: WorkflowRouting.resolve({ role, budget }),
    priorArtifacts,
    ...(messages === undefined ? {} : { messages }),
  })
}

function persisted(commit: Workflow.ArtifactCommit, owner: Workflow.Stage, suffix: string): Workflow.Artifact {
  return Workflow.Artifact.make({
    id: Workflow.ArtifactID.make(`wfa_contract_${suffix}`),
    workflowID,
    stageID: owner.id,
    ...commit,
    timeCreated: DateTime.makeUnsafe(2),
  })
}

const outcomes = {
  design: { schemaVersion: 1, role: "design", verdict: "ready", revision: 0 },
  decompose: { schemaVersion: 1, role: "decompose", verdict: "ready", revision: 0 },
  implement: { schemaVersion: 1, role: "implement", verdict: "ready", revision: 0 },
  test: { schemaVersion: 1, role: "test", verdict: "pass", revision: 0 },
  visual_review: { schemaVersion: 1, role: "visual_review", verdict: "pass", revision: 0 },
  repair: { schemaVersion: 1, role: "repair", verdict: "ready", revision: 1 },
  deliver: { schemaVersion: 1, role: "deliver", verdict: "complete", revision: 0 },
} as const

const payloads = {
  design: { spec: designSpec, sources: [{ path: "index.html", content: source }] },
  decompose: {
    acceptanceCriteria: ["The implementation matches the reference"],
    tasks: [
      {
        id: "implement-page",
        title: "Implement page",
        description: "Build the approved page.",
        acceptanceCriteria: ["The page renders"],
        dependsOn: [],
        files: ["src/app.ts"],
      },
    ],
  },
  implement: { summary: "Implemented the approved page using Location-scoped tools." },
  test: { summary: "Executed the frozen functional test plan." },
  visual_review: { verdict: "pass", score: 100, findings: [] },
  repair: { summary: "Repaired the reported visual differences using Location-scoped tools." },
  deliver: { summary: "The approved page is implemented and verified." },
} as const

describe("Workflow role contracts", () => {
  test("gives every role a distinct exact contract, system, messages, and fingerprint", () => {
    const roles = WorkflowRole.Role.literals
    const built = roles.map((role) => contract(role, role === "repair" ? 1 : 0))

    expect(new Set(built.map((item) => item.outputIdentifier)).size).toBe(roles.length)
    expect(new Set(built.map((item) => item.system)).size).toBe(roles.length)
    expect(new Set(built.map((item) => JSON.stringify(item.messages))).size).toBe(roles.length)
    expect(new Set(built.map((item) => item.contractFingerprint)).size).toBe(roles.length)
    for (const [index, item] of built.entries()) {
      const role = roles[index]
      expect(
        WorkflowRoleContract.decode(item, {
          contractVersion: 1,
          outcome: outcomes[role],
          payload: payloads[role],
        }),
      ).toEqual({ contractVersion: 1, outcome: outcomes[role], payload: payloads[role] })
      expect(() =>
        WorkflowRoleContract.decode(item, {
          contractVersion: 1,
          outcome: outcomes[role],
          payload: payloads[role],
          hostAuthority: { workspaceSha256: "a".repeat(64) },
        }),
      ).toThrow()
    }
  })

  test.each([
    ["implement", { manifest: { workspaceSha256: "a".repeat(64) } }],
    ["repair", { snapshotRef: "model-snapshot" }],
    ["test", { log: "model-authored-log", previewUrl: "https://example.test" }],
    ["visual_review", { evidence: [], selector: "body", revision: 0 }],
    ["deliver", { implementationSha256: "a".repeat(64), workspaceSha256: "b".repeat(64) }],
  ] as const)("rejects model-authored host authority for %s", (role, authority) => {
    const revision = role === "repair" ? 1 : 0
    const item = contract(role, revision)
    expect(() =>
      WorkflowRoleContract.decode(item, {
        contractVersion: 1,
        outcome: outcomes[role],
        payload: { ...payloads[role], ...authority },
      }),
    ).toThrow()
  })

  test("keeps media typed and rejects screenshot data in generic provider text", () => {
    const media = Message.user([
      { type: "text", text: "Compare the paired captures." },
      { type: "media", mediaType: "image/png", data: Uint8Array.from([1, 2, 3]), filename: "pair.png" },
    ])
    const built = contract("visual_review", 0, [media])
    expect(built.messages[0]?.content).toEqual(media.content)
    expect(JSON.stringify({ system: built.system, messages: built.messages })).not.toContain("data:image/")
    expect(() => contract("visual_review", 0, [Message.user("data:image/png;base64,iVBORw0KGgo=")])).toThrow()
    expect(() => contract("test", 0, [Message.user("iVBORw0KGgoAAAANSUhEUgAAAAE=")])).toThrow()
    const implement = contract("implement")
    expect(() =>
      WorkflowRoleContract.decode(implement, {
        contractVersion: 1,
        outcome: outcomes.implement,
        payload: { summary: "data:image/png;base64,iVBORw0KGgo=" },
      }),
    ).toThrow()
  })
})

describe("Workflow role business-evidence authority", () => {
  test("mints and validates a context/contract/artifact-set-bound role settlement", async () => {
    const current = stage("design")
    const roleContract = contract("design")
    const semantic = WorkflowRoleContract.decode(roleContract, {
      contractVersion: 1,
      outcome: outcomes.design,
      payload: payloads.design,
    })
    const settlement = await WorkflowRoleExecution.settle({
      workflow,
      stage: current,
      contract: roleContract,
      semantic,
      priorArtifacts: [],
      settledToolEvidence: [],
    }).pipe(Effect.provide(WorkflowRoleExecution.deterministicLayer), Effect.runPromise)

    expect(WorkflowRoleExecution.requiredKinds("design")).toEqual([
      "workflow.design.spec",
      "workflow.design.reference-app",
    ])
    expect(WorkflowRoleExecution.requiredKinds("test")).toEqual(["workflow.test.result", "workflow.test.log"])
    expect(WorkflowRoleExecution.requiredKinds("visual_review")).toEqual([
      "workflow.visual-review",
      "workflow.visual.reference-screenshot",
      "workflow.visual.implementation-screenshot",
    ])
    expect(settlement.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      "workflow.design.reference-app",
      "workflow.design.spec",
      "workflow.role.outcome",
    ])
    expect(() =>
      WorkflowRoleExecution.validateSettlement({
        workflow,
        stage: current,
        priorArtifacts: [],
        artifacts: settlement.artifacts,
        receipt: settlement.receipt,
      }),
    ).not.toThrow()

    const business = settlement.artifacts.filter((artifact) => artifact.kind !== "workflow.role.outcome")
    for (const tampered of [
      business.slice(1),
      [...business, business[0]],
      [{ ...business[0], uri: "workflow://artifact/wfl_other/design-spec.json" }, business[1]],
    ]) {
      expect(() =>
        WorkflowRoleExecution.validateSettlement({
          workflow,
          stage: current,
          priorArtifacts: [],
          artifacts: [...tampered, settlement.artifacts.at(-1)!],
          receipt: settlement.receipt,
        }),
      ).toThrow()
    }

    for (const receipt of [
      { ...settlement.receipt, contractFingerprint: "0".repeat(64) },
      { ...settlement.receipt, contextDigest: "1".repeat(64) },
      { ...settlement.receipt, requiredArtifactSetSha256: "2".repeat(64) },
    ]) {
      expect(() =>
        WorkflowRoleExecution.validateSettlement({
          workflow,
          stage: current,
          priorArtifacts: [],
          artifacts: settlement.artifacts,
          receipt,
        }),
      ).toThrow()
    }
  })

  test("rejects an outcome verdict that contradicts the durable test result", async () => {
    const implementStage = stage("implement")
    const implementContract = contract("implement")
    const implementation = await WorkflowRoleExecution.settle({
      workflow,
      stage: implementStage,
      contract: implementContract,
      semantic: WorkflowRoleContract.decode(implementContract, {
        contractVersion: 1,
        outcome: outcomes.implement,
        payload: payloads.implement,
      }),
      priorArtifacts: [],
      settledToolEvidence: [],
    }).pipe(Effect.provide(WorkflowRoleExecution.deterministicLayer), Effect.runPromise)
    const manifest = implementation.artifacts.find((artifact) => artifact.kind === "workflow.implementation-manifest")
    if (!manifest) throw new Error("deterministic implementation manifest missing")
    const priorArtifacts = [persisted(manifest, implementStage, "test_manifest")]
    const current = stage("test")
    const testContract = contract("test", 0, undefined, priorArtifacts)
    const settlement = await WorkflowRoleExecution.settle({
      workflow,
      stage: current,
      contract: testContract,
      semantic: WorkflowRoleContract.decode(testContract, {
        contractVersion: 1,
        outcome: outcomes.test,
        payload: payloads.test,
      }),
      priorArtifacts,
      settledToolEvidence: [],
    }).pipe(Effect.provide(WorkflowRoleExecution.deterministicLayer), Effect.runPromise)
    expect(() =>
      WorkflowRoleExecution.validateSettlement({
        workflow,
        stage: current,
        priorArtifacts,
        artifacts: settlement.artifacts,
        receipt: settlement.receipt,
      }),
    ).not.toThrow()

    const outcome = settlement.artifacts.find((artifact) => artifact.kind === "workflow.role.outcome")
    if (!outcome) throw new Error("deterministic role outcome missing")
    const binding = WorkflowStageMachine.decodeOutcomeBinding(outcome)
    if (binding.outcome.role !== "test") throw new Error("unexpected role outcome")
    const wrongBinding = WorkflowStageMachine.OutcomeBinding.make({
      ...binding,
      outcome: { ...binding.outcome, verdict: "revise" },
    })
    const body = WorkflowStageMachine.encodeOutcome(wrongBinding)
    const outcomeSha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
    const wrongOutcome = { ...outcome, metadata: wrongBinding, sha256: outcomeSha256, size: Buffer.byteLength(body) }
    expect(() =>
      WorkflowRoleExecution.validateSettlement({
        workflow,
        stage: current,
        priorArtifacts,
        artifacts: [...settlement.artifacts.filter((artifact) => artifact !== outcome), wrongOutcome],
        receipt: { ...settlement.receipt, outcomeSha256 },
      }),
    ).toThrow("Test outcome does not match the durable test result")
  })

  test("keeps legacy plain outcomes replayable but requires bindings for visual-build settlement", () => {
    const current = stage("design")
    const body = JSON.stringify(outcomes.design)
    const legacy = {
      kind: "workflow.role.outcome",
      uri: `workflow://${workflowID}/stages/${current.id}/role-outcome.json`,
      mime: "application/vnd.opencode.workflow-role-outcome+json",
      sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
      size: Buffer.byteLength(body),
      metadata: outcomes.design,
    } satisfies Workflow.ArtifactCommit
    expect(() => WorkflowRoleExecution.validateLegacyOutcome(legacy)).not.toThrow()
    expect(() =>
      WorkflowRoleExecution.validateSettlement({
        workflow,
        stage: current,
        priorArtifacts: [],
        artifacts: [legacy],
      }),
    ).toThrow()
  })
})

test("production workflow modules do not import WorkflowRender", async () => {
  const root = path.join(import.meta.dir, "..", "src", "workflow")
  const files = await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: root, absolute: true }))
  const offenders: string[] = []
  for (const file of files) {
    if (file.endsWith(`${path.sep}render.ts`)) continue
    const source = await fs.readFile(file, "utf8")
    if (/from\s+["'][^"']*\/render["']|WorkflowRender/.test(source)) offenders.push(path.relative(root, file))
  }
  expect(offenders).toEqual([])
})
