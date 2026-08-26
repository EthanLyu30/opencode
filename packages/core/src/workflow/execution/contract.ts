export * as WorkflowRoleContract from "./contract"

import { Message } from "@opencode-ai/llm"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Schema } from "effect"
import { Hash } from "../../util/hash"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowPermissions } from "../permissions"
import type { WorkflowRouting } from "../routing"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const Summary = Schema.NonEmptyString.check(
  Schema.makeFilter<string>((value) => (value.length <= 4_096 ? undefined : "Summary must not exceed 4096 characters")),
)

const DesignOutcome = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: Schema.Literal("design"),
  verdict: Schema.Literal("ready"),
  revision: Schema.Literal(0),
}).annotate({ identifier: "WorkflowRoleContract.DesignOutcome", ...exact })
const DecomposeOutcome = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: Schema.Literal("decompose"),
  verdict: Schema.Literal("ready"),
  revision: Schema.Number,
}).annotate({ identifier: "WorkflowRoleContract.DecomposeOutcome", ...exact })
const ImplementOutcome = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: Schema.Literal("implement"),
  verdict: Schema.Literal("ready"),
  revision: Schema.Number,
}).annotate({ identifier: "WorkflowRoleContract.ImplementOutcome", ...exact })
const RepairOutcome = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: Schema.Literal("repair"),
  verdict: Schema.Literal("ready"),
  revision: Schema.Number,
}).annotate({ identifier: "WorkflowRoleContract.RepairOutcome", ...exact })
const TestOutcome = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: Schema.Literal("test"),
  verdict: Schema.Literals(["pass", "revise"]),
  revision: Schema.Number,
}).annotate({ identifier: "WorkflowRoleContract.TestOutcome", ...exact })
const VisualOutcome = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: Schema.Literal("visual_review"),
  verdict: Schema.Literals(["pass", "revise"]),
  revision: Schema.Number,
}).annotate({ identifier: "WorkflowRoleContract.VisualOutcome", ...exact })
const DeliverOutcome = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: Schema.Literal("deliver"),
  verdict: Schema.Literal("complete"),
  revision: Schema.Number,
}).annotate({ identifier: "WorkflowRoleContract.DeliverOutcome", ...exact })

const ReferenceSource = Schema.Struct({
  path: DesignArtifact.SourcePath,
  content: Schema.String,
}).annotate({ identifier: "WorkflowRoleContract.ReferenceSource", ...exact })
export const DesignPayload = Schema.Struct({
  spec: DesignArtifact.Spec,
  sources: Schema.NonEmptyArray(ReferenceSource),
}).annotate({ identifier: "WorkflowRoleContract.DesignPayload", ...exact })

const DecompositionTask = Schema.Struct({
  id: DesignArtifact.SafeIdentifier,
  title: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  acceptanceCriteria: Schema.NonEmptyArray(Schema.NonEmptyString),
  dependsOn: Schema.Array(DesignArtifact.SafeIdentifier),
  files: Schema.NonEmptyArray(DesignArtifact.SourcePath),
}).annotate({ identifier: "WorkflowRoleContract.DecompositionTask", ...exact })
export const DecomposePayload = Schema.Struct({
  acceptanceCriteria: Schema.NonEmptyArray(Schema.NonEmptyString),
  tasks: Schema.NonEmptyArray(DecompositionTask),
}).annotate({ identifier: "WorkflowRoleContract.DecomposePayload", ...exact })

export const ImplementPayload = Schema.Struct({ summary: Summary }).annotate({
  identifier: "WorkflowRoleContract.ImplementPayload",
  ...exact,
})
export const RepairPayload = Schema.Struct({ summary: Summary }).annotate({
  identifier: "WorkflowRoleContract.RepairPayload",
  ...exact,
})
export const TestPayload = Schema.Struct({ summary: Summary }).annotate({
  identifier: "WorkflowRoleContract.TestPayload",
  ...exact,
})

const FindingProposal = Schema.Struct({
  id: Schema.NonEmptyString,
  severity: Schema.Literals(["critical", "major", "minor"]),
  viewport: Schema.NonEmptyString,
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
  repair: Schema.NonEmptyString,
  requiresRecapture: Schema.Boolean,
}).annotate({ identifier: "WorkflowRoleContract.FindingProposal", ...exact })
export const VisualPayload = Schema.Struct({
  verdict: Schema.Literals(["pass", "fail"]),
  score: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100)),
  findings: Schema.Array(FindingProposal),
}).annotate({ identifier: "WorkflowRoleContract.VisualPayload", ...exact })
export const DeliverPayload = Schema.Struct({ summary: Summary }).annotate({
  identifier: "WorkflowRoleContract.DeliverPayload",
  ...exact,
})

function envelope<O extends Schema.Top, P extends Schema.Top>(identifier: string, outcome: O, payload: P) {
  return Schema.Struct({
    contractVersion: Schema.Literal(1),
    outcome,
    payload,
  }).annotate({ identifier, ...exact })
}

const outputs = {
  design: envelope("WorkflowRoleContract.DesignEnvelope", DesignOutcome, DesignPayload),
  decompose: envelope("WorkflowRoleContract.DecomposeEnvelope", DecomposeOutcome, DecomposePayload),
  implement: envelope("WorkflowRoleContract.ImplementEnvelope", ImplementOutcome, ImplementPayload),
  test: envelope("WorkflowRoleContract.TestEnvelope", TestOutcome, TestPayload),
  visual_review: envelope("WorkflowRoleContract.VisualReviewEnvelope", VisualOutcome, VisualPayload),
  repair: envelope("WorkflowRoleContract.RepairEnvelope", RepairOutcome, RepairPayload),
  deliver: envelope("WorkflowRoleContract.DeliverEnvelope", DeliverOutcome, DeliverPayload),
} as const satisfies Record<WorkflowRole.Role, Schema.Top>

const promptVersions = {
  design: "workflow-role/design@1",
  decompose: "workflow-role/decompose@1",
  implement: "workflow-role/implement@1",
  test: "workflow-role/test@1",
  visual_review: "workflow-role/visual-review@1",
  repair: "workflow-role/repair@1",
  deliver: "workflow-role/deliver@1",
} as const satisfies Record<WorkflowRole.Role, string>

const systems = {
  design:
    "Return only the strict design envelope. Provide the design specification and complete reference source text; never provide a preview URL or build command.",
  decompose:
    "Return only the strict decomposition envelope. Provide semantic tasks and acceptance criteria; never provide workflow, revision, snapshot, or hash authority.",
  implement:
    "Return only the strict implementation envelope. Use the admitted tools for workspace work; never claim manifest, snapshot, workspace, source, selector, or URL authority.",
  test: "Return only the strict test envelope. Use the admitted tools for testing; never self-report logs, manifests, previews, or host identity.",
  visual_review:
    "Return only the strict visual-review envelope. Propose verdict, score, and findings; evidence, limits, usage, revision, selectors, and identities are host supplied.",
  repair:
    "Return only the strict repair envelope. Use the admitted tools for workspace work; never claim manifest, snapshot, workspace, source, selector, or URL authority.",
  deliver:
    "Return only the strict delivery envelope with a bounded summary; all artifact hashes and current-workspace facts are host supplied.",
} as const satisfies Record<WorkflowRole.Role, string>

export interface ArtifactDigest {
  readonly kind: string
  readonly uri: string
  readonly mime: string
  readonly sha256: string
  readonly size: number
}

export interface Contract {
  readonly contractVersion: 1
  readonly role: WorkflowRole.Role
  readonly revision: number
  readonly promptVersion: string
  readonly system: string
  readonly messages: readonly Message[]
  readonly output: Schema.Top
  readonly outputIdentifier: string
  readonly permissions: ReturnType<typeof WorkflowPermissions.forRole>
  readonly inputArtifacts: readonly ArtifactDigest[]
  readonly contextDigest: string
  readonly routeFingerprint: string
  readonly contractFingerprint: string
}

export interface BuildInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly route: WorkflowRouting.Route
  readonly priorArtifacts: ReadonlyArray<Workflow.Artifact | Workflow.ArtifactCommit>
  readonly messages?: readonly Message[]
}

export function build(input: BuildInput): Contract {
  const role = Schema.decodeUnknownSync(WorkflowRole.Role)(input.stage.type)
  if (role !== input.route.role) throw new Error("Role contract route does not match the persisted stage")
  const revision = revisionOf(input.stage)
  const output = outputs[role]
  const outputIdentifier = `WorkflowRoleContract.${role}.Envelope@1`
  const inputArtifacts = canonicalArtifacts(input.priorArtifacts)
  const contextDigest = inputContextDigest({
    workflow: input.workflow,
    stage: input.stage,
    priorArtifacts: inputArtifacts,
  })
  const permissions = WorkflowPermissions.forRole(role)
  const routeFacts = {
    role,
    providerID: input.route.providerID,
    modelID: input.route.modelID,
    protocol: input.route.protocol,
    reasoningEffort: input.route.reasoningEffort,
    requiredCapabilities: [...input.route.requiredCapabilities].sort(),
  }
  const routeFingerprint = hash(routeFacts)
  const messages = Object.freeze([...(input.messages ?? defaultMessages(input, inputArtifacts))])
  assertTextSafe(systems[role], messages)
  const contractFingerprint = hash({
    contractVersion: 1,
    role,
    revision,
    route: routeFacts,
    promptVersion: promptVersions[role],
    system: systems[role],
    messages: canonicalMessageValue(messages),
    outputIdentifier,
    permissions,
    inputArtifacts,
    contextDigest,
  })
  return Object.freeze({
    contractVersion: 1,
    role,
    revision,
    promptVersion: promptVersions[role],
    system: systems[role],
    messages,
    output,
    outputIdentifier,
    permissions,
    inputArtifacts,
    contextDigest,
    routeFingerprint,
    contractFingerprint,
  })
}

export function decode(contract: Contract, input: unknown): RoleResult {
  assertGenericProviderValue(input)
  const result = decodeForRole(contract.role, input)
  if (result.outcome.role !== contract.role || result.outcome.revision !== contract.revision)
    throw new Error("Role result does not match its contract role and revision")
  if (result.outcome.role === "visual_review") {
    const payload = Schema.decodeUnknownSync(VisualPayload)(result.payload)
    if ((result.outcome.verdict === "pass") !== (payload.verdict === "pass" && payload.findings.length === 0))
      throw new Error("Visual-review outcome does not match its semantic proposal")
  }
  return result
}

export function decodeJson(contract: Contract, input: string): RoleResult {
  return decode(contract, JSON.parse(input))
}

export interface RoleResult {
  readonly contractVersion: 1
  readonly outcome: WorkflowRole.Outcome
  readonly payload: Readonly<Record<string, unknown>>
}

export function canonicalArtifacts(
  artifacts: ReadonlyArray<Workflow.Artifact | Workflow.ArtifactCommit | ArtifactDigest>,
): readonly ArtifactDigest[] {
  return Object.freeze(
    artifacts
      .map((artifact) => ({
        kind: artifact.kind,
        uri: artifact.uri,
        mime: artifact.mime,
        sha256: artifact.sha256,
        size: artifact.size,
      }))
      .toSorted(compareArtifact),
  )
}

export function inputContextDigest(input: {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly priorArtifacts: ReadonlyArray<Workflow.Artifact | Workflow.ArtifactCommit | ArtifactDigest>
}): string {
  return hash({
    workflow: {
      id: input.workflow.id,
      type: input.workflow.type,
      input: input.workflow.input,
      location: input.workflow.location,
    },
    stage: {
      id: input.stage.id,
      workflowID: input.stage.workflowID,
      type: input.stage.type,
      ordinal: input.stage.ordinal,
      input: input.stage.input,
    },
    inputArtifacts: canonicalArtifacts(input.priorArtifacts),
  })
}

export function assertTextSafe(system: string, messages: readonly Message[]): void {
  scanText(system)
  for (const message of messages) scanMessage(message)
}

export function assertGenericProviderValue(value: unknown): void {
  scanMessage(value)
}

function scanMessage(value: unknown): void {
  if (typeof value === "string") {
    scanText(value)
    return
  }
  if (value instanceof Uint8Array) throw new Error("Screenshot bytes require an explicit media message")
  if (value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) scanMessage(item)
    return
  }
  const media = "type" in value && value.type === "media"
  for (const [key, item] of Object.entries(value)) {
    if (media && key === "data" && item instanceof Uint8Array) continue
    scanMessage(item)
  }
}

function scanText(value: string): void {
  if (/data\s*:\s*image\//i.test(value) || /(?:^|[^A-Za-z0-9+/])iVBORw0KGgo[A-Za-z0-9+/=]*/.test(value))
    throw new Error("Screenshot bytes are forbidden in generic provider text")
  if (/"?dataBase64"?\s*:/.test(value)) throw new Error("Screenshot dataBase64 is forbidden in generic provider text")
}

function defaultMessages(input: BuildInput, artifacts: readonly ArtifactDigest[]): readonly Message[] {
  return [
    Message.user(
      JSON.stringify({
        template: promptVersions[input.route.role],
        workflow: { id: input.workflow.id, type: input.workflow.type, input: input.workflow.input },
        stage: {
          id: input.stage.id,
          role: input.route.role,
          revision: revisionOf(input.stage),
          input: input.stage.input,
        },
        artifacts,
      }),
    ),
  ]
}

function revisionOf(stage: Workflow.Stage): number {
  const revision = stage.input.revision ?? 0
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    throw new Error("Role stage revision is invalid")
  return revision
}

function compareArtifact(left: ArtifactDigest, right: ArtifactDigest): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.uri.localeCompare(right.uri) ||
    left.mime.localeCompare(right.mime) ||
    left.sha256.localeCompare(right.sha256) ||
    left.size - right.size
  )
}

function canonicalMessageValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { mediaSha256: Hash.sha256(Buffer.from(value)), mediaSize: value.byteLength }
  if (Array.isArray(value)) return value.map(canonicalMessageValue)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonicalMessageValue(item)]))
}

function hash(input: unknown): string {
  return WorkflowBusinessArtifact.hash(input)
}

function decodeForRole(role: WorkflowRole.Role, input: unknown): RoleResult {
  if (role === "design") return Schema.decodeUnknownSync(outputs.design)(input)
  if (role === "decompose") return Schema.decodeUnknownSync(outputs.decompose)(input)
  if (role === "implement") return Schema.decodeUnknownSync(outputs.implement)(input)
  if (role === "test") return Schema.decodeUnknownSync(outputs.test)(input)
  if (role === "visual_review") return Schema.decodeUnknownSync(outputs.visual_review)(input)
  if (role === "repair") return Schema.decodeUnknownSync(outputs.repair)(input)
  return Schema.decodeUnknownSync(outputs.deliver)(input)
}
