export * as CodingContract from "./contract"

import { Message } from "@opencode-ai/llm"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { WorkflowCodingArtifact } from "@opencode-ai/schema/workflow-coding-artifact"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { Hash } from "../../util/hash"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowRoleContract } from "../execution/contract"
import { CodingPermissions } from "./permissions"
import { CodingModelSelection } from "./model-selection"
import { CodingRouting } from "./routing"
import { WorkflowBenchmarkTransport } from "../benchmark-transport"
import { CodingArtifacts } from "./artifacts"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const Summary = Schema.NonEmptyString.check(Schema.isMaxLength(4096))
export const Outcome = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: WorkflowCodingBuild.Role,
  revision: NonNegativeInt,
  verdict: Schema.Literals(["ready", "pass", "revise", "complete"]),
})
  .annotate({ identifier: "CodingContract.Outcome", ...exact })
  .check(
    Schema.makeFilter((value) => {
      if (value.role === "design" && value.revision !== 0) return "Coding design revision must be zero"
      const valid =
        value.role === "test" || value.role === "code_review"
          ? value.verdict === "pass" || value.verdict === "revise"
          : value.role === "deliver"
            ? value.verdict === "complete"
            : value.verdict === "ready"
      return valid ? undefined : "Coding outcome verdict does not match role"
    }),
  )
export type Outcome = typeof Outcome.Type

export const DesignPayload = Schema.Struct({
  objective: Summary,
  constraints: Schema.Array(Summary),
  interfaces: Schema.NonEmptyArray(Summary),
  files: Schema.NonEmptyArray(DesignArtifact.SourcePath),
  risks: Schema.Array(Summary),
  acceptanceCriteria: Schema.NonEmptyArray(Summary),
}).annotate({ identifier: "CodingContract.DesignPayload", ...exact })
export const ReviewPayload = Schema.Struct({
  verdict: Schema.Literals(["pass", "revise"]),
  findings: Schema.Array(WorkflowCodingArtifact.Finding),
}).annotate({ identifier: "CodingContract.ReviewPayload", ...exact })
const payloads = {
  design: DesignPayload,
  decompose: WorkflowRoleContract.DecomposePayload,
  implement: WorkflowRoleContract.ImplementPayload,
  test: WorkflowRoleContract.TestPayload,
  code_review: ReviewPayload,
  repair: WorkflowRoleContract.RepairPayload,
  deliver: WorkflowRoleContract.DeliverPayload,
} satisfies Record<WorkflowCodingBuild.Role, Schema.Top>
const systems = {
  design:
    "Return only the strict coding engineering-plan envelope. Propose objective, constraints, interfaces, files, risks and acceptance criteria; never provide host identity, hashes, test commands, preview URLs or screenshots.",
  decompose:
    "Return only the strict coding decomposition envelope. Propose an acyclic task plan and acceptance criteria within the admitted Location; never manufacture host identity or evidence.",
  implement:
    "Return only the strict coding implementation envelope. Use admitted tools to edit the real Location. Host-measured source and test evidence, not assertions in text, determine success.",
  test: "Return only the strict coding test envelope. Interpret the trusted host check results. Never invent a test exit, report, source hash or successful check.",
  code_review:
    "Return only the strict coding review envelope. Review the engineering plan, actual code changes and trusted test evidence; propose pass/revise and actionable structured findings. This is code review, not visual review. Never manufacture hashes or ignore blockers.",
  repair:
    "Return only the strict coding repair envelope. Use admitted tools to fix failed checks and blocking code-review findings within the Location and original scope.",
  deliver:
    "Return only the strict coding delivery envelope with a bounded summary. Final implementation, checks and code-review identities are host supplied; do not invent visual evidence.",
} satisfies Record<WorkflowCodingBuild.Role, string>

function envelope(role: WorkflowCodingBuild.Role) {
  const outcome = Schema.Struct({
    schemaVersion: Schema.Literal(1),
    role: Schema.Literal(role),
    revision: role === "design" ? Schema.Literal(0) : NonNegativeInt,
    verdict:
      role === "test" || role === "code_review"
        ? Schema.Literals(["pass", "revise"])
        : Schema.Literal(role === "deliver" ? "complete" : "ready"),
  }).annotate(exact)
  return Schema.Struct({ contractVersion: Schema.Literal(1), outcome, payload: payloads[role] }).annotate({
    identifier: `CodingContract.${role}.Envelope@1`,
    ...exact,
  })
}

export interface Authority extends Omit<WorkflowRoleContract.AuthorityV1, "role" | "route"> {
  readonly kind: "workflow.coding-role-contract.v1"
  readonly role: WorkflowCodingBuild.Role
  readonly route: Omit<WorkflowRoleContract.AuthorityV1["route"], "role"> & { readonly role: WorkflowCodingBuild.Role }
  readonly modelSelectionSha256: string
}
export interface Contract extends Omit<WorkflowRoleContract.Contract, "role" | "authority"> {
  readonly kind: "coding-build"
  readonly role: WorkflowCodingBuild.Role
  readonly authority: Authority
}
export interface BuildInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly route: CodingRouting.Route
  readonly priorArtifacts: ReadonlyArray<Workflow.Artifact | Workflow.ArtifactCommit>
  readonly messages?: readonly Message[]
}
export interface RoleResult {
  readonly contractVersion: 1
  readonly outcome: Outcome
  readonly payload: Readonly<Record<string, unknown>>
}

export function build(input: BuildInput): Contract {
  if (input.workflow.type !== "coding-build" || input.stage.workflowID !== input.workflow.id)
    throw new Error("Invalid coding contract placement")
  const role = Schema.decodeUnknownSync(WorkflowCodingBuild.Role)(input.stage.type)
  const selection = CodingModelSelection.fromWorkflow(input.workflow)
  const expected = CodingRouting.resolve({
    role,
    budget: CodingRouting.budget(input.workflow),
    selection,
    benchmarkTransport: WorkflowBenchmarkTransport.fromWorkflow(input.workflow),
  })
  const facts = (route: CodingRouting.Route) => ({
    role: route.role,
    providerID: route.providerID,
    modelID: route.modelID,
    protocol: route.protocol,
    reasoningEffort: route.reasoningEffort,
    requiredCapabilities: [...route.requiredCapabilities].sort(),
  })
  if (
    WorkflowBusinessArtifact.encode(facts(input.route)) !== WorkflowBusinessArtifact.encode(facts(expected)) ||
    WorkflowBusinessArtifact.encode(input.route.budget) !== WorkflowBusinessArtifact.encode(expected.budget)
  )
    throw new Error("Coding contract route differs from frozen admission")
  const revision = CodingArtifacts.revisionOf(input.workflow, input.stage, input.priorArtifacts)
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    throw new Error("Invalid coding revision")
  const promptVersion = `coding-build/${role}@1`
  const inputArtifacts = WorkflowRoleContract.canonicalArtifacts(input.priorArtifacts)
  const contextDigest = WorkflowRoleContract.inputContextDigest({
    workflow: input.workflow,
    stage: input.stage,
    priorArtifacts: inputArtifacts,
  })
  const messages = Object.freeze([
    ...(input.messages ?? [
      Message.user(
        JSON.stringify({
          template: promptVersion,
          workflow: { id: input.workflow.id, type: input.workflow.type, input: input.workflow.input },
          stage: { id: input.stage.id, role, revision, input: input.stage.input },
          artifacts: inputArtifacts,
        }),
      ),
    ]),
  ])
  if (messages.some((message) => message.content.some((part) => part.type === "media")))
    throw new Error("Coding contracts do not accept visual media")
  WorkflowRoleContract.assertTextSafe(systems[role], messages)
  const outputIdentifier = `CodingContract.${role}.Envelope@1`
  const output = envelope(role)
  const permissions = CodingPermissions.forRole(role)
  // Budget increases are authorized/enforced by the runtime, not a change of settled provider identity.
  const route = facts(input.route)
  const authority: Authority = Object.freeze({
    authorityVersion: 1,
    kind: "workflow.coding-role-contract.v1",
    role,
    revision,
    route,
    modelSelectionSha256: selection.sha256,
    promptVersion,
    systemSha256: Hash.sha256(systems[role]),
    messageSource: input.messages === undefined ? "default" : "trusted",
    messagesSha256: WorkflowBusinessArtifact.hash(messages),
    media: [],
    outputIdentifier,
    responseSchemaSha256: WorkflowBusinessArtifact.hash(WorkflowRoleContract.responseSchema(output)),
    permissionsSha256: WorkflowBusinessArtifact.hash(permissions),
    inputArtifacts,
    contextDigest,
  })
  return Object.freeze({
    kind: "coding-build",
    contractVersion: 1,
    role,
    revision,
    promptVersion,
    system: systems[role],
    messages,
    output,
    outputIdentifier,
    permissions,
    inputArtifacts,
    contextDigest,
    routeFingerprint: WorkflowBusinessArtifact.hash(route),
    contractFingerprint: WorkflowBusinessArtifact.hash(authority),
    authority,
  })
}

export function decode(contract: Contract, input: unknown): RoleResult {
  WorkflowRoleContract.assertGenericProviderValue(input)
  const value = Schema.decodeUnknownSync(envelope(contract.role))(input)
  const result = Schema.decodeUnknownSync(
    Schema.Struct({
      contractVersion: Schema.Literal(1),
      outcome: Outcome,
      payload: Schema.Record(Schema.String, Schema.Unknown),
    }),
  )(value)
  if (result.outcome.role !== contract.role || result.outcome.revision !== contract.revision)
    throw new Error("Coding result role/revision mismatch")
  if (contract.role === "code_review") {
    const review = Schema.decodeUnknownSync(ReviewPayload)(result.payload)
    const blocked = review.findings.some((finding) => finding.blocking)
    if (
      review.verdict !== result.outcome.verdict ||
      (review.verdict === "revise") !== blocked ||
      new Set(review.findings.map((finding) => finding.id)).size !== review.findings.length ||
      review.findings.some((finding) => finding.severity === "critical" && !finding.blocking)
    )
      throw new Error("Coding review contradicts findings")
  }
  return result
}
export function decodeJson(contract: Contract, text: string): RoleResult {
  return decode(contract, Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(text))
}
export function verifyAuthority(input: {
  readonly authority: Authority
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly priorArtifacts: ReadonlyArray<Workflow.Artifact | Workflow.ArtifactCommit>
  readonly trustedMessages?: readonly Message[]
}): void {
  if (input.authority.kind !== "workflow.coding-role-contract.v1") throw new Error("Invalid coding authority")
  const role = Schema.decodeUnknownSync(WorkflowCodingBuild.Role)(input.stage.type)
  const messages = input.authority.messageSource === "default" ? undefined : input.trustedMessages
  if (input.authority.messageSource === "trusted" && messages === undefined)
    throw new Error("Coding authority requires trusted messages")
  const expected = build({
    workflow: input.workflow,
    stage: input.stage,
    priorArtifacts: input.priorArtifacts,
    route: CodingRouting.resolve({
      role,
      budget: CodingRouting.budget(input.workflow),
      selection: CodingModelSelection.fromWorkflow(input.workflow),
      benchmarkTransport: WorkflowBenchmarkTransport.fromWorkflow(input.workflow),
    }),
    ...(messages === undefined ? {} : { messages }),
  })
  if (WorkflowBusinessArtifact.hash(input.authority) !== expected.contractFingerprint)
    throw new Error("Coding authority differs from persisted host facts")
}
