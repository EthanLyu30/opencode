export * as Workflow from "./workflow"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, PositiveInt, statics } from "./schema"
import { SessionID } from "./session-id"

// ── Identifiers ──────────────────────────────────────────────────────────────

export const ID = Schema.String.check(Schema.isStartsWith("wfl_")).pipe(
  Schema.brand("Workflow.ID"),
  statics((schema) => ({ create: () => schema.make("wfl_" + ascending()) })),
)
export type ID = typeof ID.Type

export const StageID = Schema.String.check(Schema.isStartsWith("wfs_")).pipe(
  Schema.brand("Workflow.StageID"),
  statics((schema) => ({ create: () => schema.make("wfs_" + ascending()) })),
)
export type StageID = typeof StageID.Type

export const ArtifactID = Schema.String.check(Schema.isStartsWith("wfa_")).pipe(
  Schema.brand("Workflow.ArtifactID"),
  statics((schema) => ({ create: () => schema.make("wfa_" + ascending()) })),
)
export type ArtifactID = typeof ArtifactID.Type

// ── Status & category literals ───────────────────────────────────────────────

export const RunStatus = Schema.Literals([
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
])
export type RunStatus = typeof RunStatus.Type

export const StageStatus = Schema.Literals([
  "pending",
  "leased",
  "running",
  "retry_wait",
  "waiting_input",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
])
export type StageStatus = typeof StageStatus.Type

export const RecoveryPolicy = Schema.Literals(["restart_safe", "reconcile_required", "manual_required"])
export type RecoveryPolicy = typeof RecoveryPolicy.Type

export const RecoveryAction = Schema.Literals(["retry", "fail"])
export type RecoveryAction = typeof RecoveryAction.Type

export const FailureCategory = Schema.Literals([
  "transient",
  "authentication",
  "quota",
  "invalid_request",
  "schema",
  "build",
  "visual",
  "cancelled",
  "ambiguous",
  "unknown",
])
export type FailureCategory = typeof FailureCategory.Type

// ── Composite DTOs ───────────────────────────────────────────────────────────

export const Budget = Schema.Struct({
  maxTokens: NonNegativeInt.pipe(optional),
  maxTurns: NonNegativeInt.pipe(optional),
  maxToolCalls: NonNegativeInt.pipe(optional),
  maxAttempts: PositiveInt.pipe(optional),
  maxDurationMs: PositiveInt.pipe(optional),
}).annotate({ identifier: "Workflow.Budget" })
export interface Budget extends Schema.Schema.Type<typeof Budget> {}

export const Usage = Schema.Struct({
  tokens: NonNegativeInt,
  turns: NonNegativeInt,
  toolCalls: NonNegativeInt,
  attempts: NonNegativeInt,
}).annotate({ identifier: "Workflow.Usage" })
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

export const Failure = Schema.Struct({
  category: FailureCategory,
  code: Schema.String,
  message: Schema.String,
  retryAfterMs: NonNegativeInt.pipe(optional),
  ref: Schema.String.pipe(optional),
}).annotate({ identifier: "Workflow.Failure" })
export interface Failure extends Schema.Schema.Type<typeof Failure> {}

export const StageInput = Schema.Struct({
  id: StageID.pipe(optional),
  type: Schema.NonEmptyString,
  ordinal: NonNegativeInt,
  maxAttempts: PositiveInt,
  recoveryPolicy: RecoveryPolicy,
  idempotencyKey: Schema.NonEmptyString,
  input: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "Workflow.StageInput" })
export interface StageInput extends Schema.Schema.Type<typeof StageInput> {}

export const CreateInput = Schema.Struct({
  id: ID.pipe(optional),
  type: Schema.NonEmptyString,
  input: Schema.Record(Schema.String, Schema.Unknown),
  budget: Budget,
  stages: Schema.NonEmptyArray(StageInput),
}).annotate({ identifier: "Workflow.CreateInput" })
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

// ── Projection DTOs ──────────────────────────────────────────────────────────

export const Info = Schema.Struct({
  id: ID,
  type: Schema.String,
  status: RunStatus,
  currentStageID: StageID.pipe(optional),
  input: Schema.Record(Schema.String, Schema.Unknown),
  budget: Budget,
  usage: Usage,
  cancelRequestedAt: DateTimeUtcFromMillis.pipe(optional),
  version: NonNegativeInt,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Workflow.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Stage = Schema.Struct({
  id: StageID,
  workflowID: ID,
  type: Schema.String,
  ordinal: NonNegativeInt,
  status: StageStatus,
  attempt: NonNegativeInt,
  maxAttempts: PositiveInt,
  notBefore: DateTimeUtcFromMillis.pipe(optional),
  leaseOwner: Schema.String.pipe(optional),
  leaseExpiresAt: DateTimeUtcFromMillis.pipe(optional),
  sessionID: SessionID.pipe(optional),
  checkpoint: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  recoveryPolicy: RecoveryPolicy,
  recoveryAction: RecoveryAction.pipe(optional),
  idempotencyKey: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  error: Failure.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    started: DateTimeUtcFromMillis.pipe(optional),
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Workflow.Stage" })
export interface Stage extends Schema.Schema.Type<typeof Stage> {}

export const ArtifactCommit = Schema.Struct({
  kind: Schema.NonEmptyString,
  uri: Schema.NonEmptyString,
  mime: Schema.NonEmptyString,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  size: NonNegativeInt,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "Workflow.ArtifactCommit" })
export interface ArtifactCommit extends Schema.Schema.Type<typeof ArtifactCommit> {}

export const Artifact = Schema.Struct({
  id: ArtifactID,
  workflowID: ID,
  stageID: StageID,
  ...ArtifactCommit.fields,
  timeCreated: DateTimeUtcFromMillis,
}).annotate({ identifier: "Workflow.Artifact" })
export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

export const Detail = Schema.Struct({
  run: Info,
  stages: Schema.Array(Stage),
  artifacts: Schema.Array(Artifact),
}).annotate({ identifier: "Workflow.Detail" })
export interface Detail extends Schema.Schema.Type<typeof Detail> {}
