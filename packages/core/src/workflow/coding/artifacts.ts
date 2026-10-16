export * as CodingArtifacts from "./artifacts"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowCodingArtifact } from "@opencode-ai/schema/workflow-coding-artifact"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { CodingHostPlan } from "./host-plan"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const CheckID = Schema.Literals(["test", "build", "typecheck"])
const Executed = Schema.Struct({
  id: CheckID,
  status: Schema.Literal("executed"),
  argv: Schema.NonEmptyArray(Schema.NonEmptyString),
  cwd: Schema.NonEmptyString,
  exitCode: Schema.Int,
  timedOut: Schema.Boolean,
  observedTests: NonNegativeInt,
  failedTests: NonNegativeInt,
  reportSha256: Schema.optional(DesignArtifact.Sha256),
  log: Schema.String.check(Schema.isMaxLength(65536)),
  logSha256: DesignArtifact.Sha256,
  ownerSha256: DesignArtifact.Sha256,
}).annotate(exact)
export const Check = Schema.Union([
  Executed,
  Schema.Struct({ id: CheckID, status: Schema.Literal("not-applicable") }).annotate(exact),
])
export type Check = typeof Check.Type
export const CheckRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: Workflow.ID,
  stageID: Workflow.StageID,
  attempt: PositiveInt,
  leaseOwner: Schema.NonEmptyString,
  revision: NonNegativeInt,
  locationSha256: DesignArtifact.Sha256,
  planSha256: DesignArtifact.Sha256,
  configSha256: DesignArtifact.Sha256,
  implementationSha256: DesignArtifact.Sha256,
  workspaceSha256: DesignArtifact.Sha256,
  snapshotRef: Schema.NonEmptyString,
  sealedAuthoritySha256: DesignArtifact.Sha256,
  checks: Schema.Array(Check),
}).annotate({ identifier: "CodingArtifacts.CheckRecord", ...exact })
export type CheckRecord = typeof CheckRecord.Type
export const schemas = {
  plan: WorkflowCodingArtifact.Plan,
  checks: CheckRecord,
  review: WorkflowCodingArtifact.Review,
  delivery: WorkflowCodingArtifact.Delivery,
}
export type Kind = keyof typeof schemas
export const kinds = {
  plan: "workflow.coding.plan",
  checks: "workflow.coding.checks",
  review: "workflow.coding.review",
  delivery: "workflow.coding.delivery",
} as const
const mime = (kind: Kind) => `application/vnd.opencode.workflow-coding-${kind}+json`
const uri = (kind: Kind, workflowID: string, locationSha256: string, revision: number) =>
  `workflow://artifact/${workflowID}/workspace-${locationSha256}/coding-${kind}-r${revision}.json`

export function commit(
  kind: Kind,
  workflowID: Workflow.ID,
  location: Location.Ref,
  input: unknown,
): Workflow.ArtifactCommit {
  const value = Schema.decodeUnknownSync(schemas[kind])(input)
  if (value.workflowID !== workflowID) throw new Error("Foreign coding artifact owner")
  const locationSha256 = WorkflowBusinessArtifact.locationSha256(location)
  const payload = { schemaVersion: 1, workflowID, locationSha256, kind, value }
  return WorkflowBusinessArtifact.commit({
    kind: kinds[kind],
    mime: mime(kind),
    uri: uri(kind, workflowID, locationSha256, value.revision),
    payload,
  })
}
export function decode<K extends Kind>(
  kind: K,
  input: Workflow.ArtifactCommit,
  workflowID: Workflow.ID,
  location: Location.Ref,
): Schema.Schema.Type<(typeof schemas)[K]> {
  const artifact = WorkflowBusinessArtifact.requireCommit(input)
  const payload = Schema.decodeUnknownSync(
    Schema.Struct({
      schemaVersion: Schema.Literal(1),
      workflowID: Workflow.ID,
      locationSha256: DesignArtifact.Sha256,
      kind: Schema.Literals(["plan", "checks", "review", "delivery"]),
      value: Schema.Unknown,
    }).annotate(exact),
  )(WorkflowBusinessArtifact.metadataPayload(artifact))
  const value = Schema.decodeUnknownSync(schemas[kind])(payload.value)
  if (
    payload.kind !== kind ||
    payload.workflowID !== workflowID ||
    value.workflowID !== workflowID ||
    payload.locationSha256 !== WorkflowBusinessArtifact.locationSha256(location)
  )
    throw new Error("Foreign coding artifact placement")
  WorkflowBusinessArtifact.validateCommit(
    artifact,
    { ...payload, value },
    kinds[kind],
    mime(kind),
    uri(kind, workflowID, payload.locationSha256, value.revision),
  )
  return value as Schema.Schema.Type<(typeof schemas)[K]>
}
export function validateChecks(input: unknown, plan: CodingHostPlan.Plan): readonly Check[] {
  const checks = Schema.decodeUnknownSync(Schema.Array(Check))(input)
  if (checks.length !== 3 || new Set(checks.map((check) => check.id)).size !== 3)
    throw new Error("Coding check set is incomplete")
  for (const id of ["test", "build", "typecheck"] as const) {
    const check = checks.find((check) => check.id === id)!
    const command = plan.commands.find((command) => command.id === id)
    if (!command) {
      if (id === "test" || check.status !== "not-applicable") throw new Error("Coding check applicability mismatch")
      continue
    }
    if (
      check.status !== "executed" ||
      check.cwd !== plan.cwd ||
      WorkflowBusinessArtifact.encode(check.argv) !== WorkflowBusinessArtifact.encode(command.argv) ||
      check.logSha256 !== WorkflowBusinessArtifact.hash(check.log)
    )
      throw new Error("Coding check invocation does not match frozen policy")
  }
  return checks
}
export function checksPassed(input: unknown, plan: CodingHostPlan.Plan): boolean {
  const parsed = Schema.decodeUnknownOption(Schema.Array(Check))(input)
  if (parsed._tag === "None") return false
  const checks = validateChecks(parsed.value, plan)
  return checks.every(
    (check) =>
      check.status === "not-applicable" ||
      (check.exitCode === 0 &&
        !check.timedOut &&
        check.failedTests === 0 &&
        (check.id !== "test" || (check.observedTests > 0 && check.reportSha256 !== undefined))),
  )
}

export function toCommit(artifact: Workflow.Artifact | Workflow.ArtifactCommit): Workflow.ArtifactCommit {
  return Workflow.ArtifactCommit.make({
    kind: artifact.kind,
    uri: artifact.uri,
    mime: artifact.mime,
    sha256: artifact.sha256,
    size: artifact.size,
    metadata: artifact.metadata,
  })
}

/** Read only the exact host record already fenced with a coding provider continuation. */
export function checkpointChecks(stage: Workflow.Stage): CheckRecord | undefined {
  const checkpoint = stage.checkpoint
  if (!checkpoint || !Object.hasOwn(checkpoint, "codingChecks")) return undefined
  if (checkpoint.kind !== "workflow.model.continuation" || checkpoint.version !== 2 || stage.type !== "test")
    throw new Error("Invalid coding check continuation")
  const record = Schema.decodeUnknownSync(CheckRecord)(checkpoint.codingChecks)
  if (
    record.workflowID !== stage.workflowID ||
    record.stageID !== stage.id ||
    record.revision !== stage.input.revision ||
    record.attempt > stage.attempt
  )
    throw new Error("Foreign coding check continuation")
  return record
}

/** Delivery's graph slot is fixed; its semantic revision is the actual passing review, not the upper bound. */
export function revisionOf(
  workflow: Workflow.Info,
  stage: Workflow.Stage,
  prior: readonly (Workflow.Artifact | Workflow.ArtifactCommit)[],
): number {
  const declared = stage.input.revision
  if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared < 0 || declared > 10)
    throw new Error("Invalid coding revision")
  if (stage.type !== "deliver" || !workflow.location) return declared
  const reviews = prior
    .filter((artifact) => artifact.kind === kinds.review)
    .map((artifact) => decode("review", toCommit(artifact), workflow.id, workflow.location!))
    .filter((review) => review.verdict === "pass")
  if (reviews.length > 1 || reviews.some((review) => review.revision > declared))
    throw new Error("Ambiguous final coding revision")
  return reviews[0]?.revision ?? declared
}
