export * as WorkflowEvent from "./workflow-event"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"
import { Event } from "./event"
import { Workflow } from "./workflow"

const durable = { version: 1, aggregate: "workflowID" } as const

const base = {
  workflowID: Workflow.ID,
  timestamp: DateTimeUtcFromMillis,
}

const stageBase = {
  ...base,
  stageID: Workflow.StageID,
  attempt: NonNegativeInt,
  leaseOwner: Schema.String.pipe(optional),
}

const leaseFence = Schema.Union([
  Schema.Struct({
    variant: Schema.Literal("live_execution"),
    expectedStatus: Schema.Literals(["leased", "running"]),
  }),
  Schema.Struct({
    variant: Schema.Literal("expired_recovery"),
    expectedStatus: Schema.Literals(["leased", "running"]),
    observedLeaseExpiresAt: DateTimeUtcFromMillis,
  }),
])

// ── Run lifecycle ────────────────────────────────────────────────────────────

export const Created = Event.define({
  type: "workflow.created",
  durable,
  schema: {
    ...base,
    type: Schema.String,
    input: Schema.Record(Schema.String, Schema.Unknown),
    budget: Workflow.Budget,
    stages: Schema.NonEmptyArray(Workflow.StageInput),
    location: Workflow.AdmissionInput.fields.location.pipe(optional),
    sessionID: Workflow.AdmissionInput.fields.sessionID.pipe(optional),
    agent: Workflow.AdmissionInput.fields.agent.pipe(optional),
  },
})
export type Created = typeof Created.Type

export const Started = Event.define({
  type: "workflow.started",
  durable,
  schema: base,
})
export type Started = typeof Started.Type

export const Succeeded = Event.define({
  type: "workflow.succeeded",
  durable,
  schema: {
    ...base,
    usage: Workflow.Usage,
  },
})
export type Succeeded = typeof Succeeded.Type

export const Failed = Event.define({
  type: "workflow.failed",
  durable,
  schema: {
    ...base,
    failure: Workflow.Failure,
    usage: Workflow.Usage,
  },
})
export type Failed = typeof Failed.Type

// ── Stage lifecycle ──────────────────────────────────────────────────────────

export namespace Stage {
  export const Queued = Event.define({
    type: "workflow.stage.queued",
    durable,
    schema: {
      ...base,
      stageID: Workflow.StageID,
    },
  })
  export type Queued = typeof Queued.Type

  export const Leased = Event.define({
    type: "workflow.stage.leased",
    durable,
    schema: {
      ...stageBase,
      leaseExpiresAt: DateTimeUtcFromMillis,
    },
  })
  export type Leased = typeof Leased.Type

  export const Started = Event.define({
    type: "workflow.stage.started",
    durable,
    schema: stageBase,
  })
  export type Started = typeof Started.Type

  export const Checkpointed = Event.define({
    type: "workflow.stage.checkpointed",
    durable,
    schema: {
      ...stageBase,
      checkpoint: Schema.Record(Schema.String, Schema.Unknown),
    },
  })
  export type Checkpointed = typeof Checkpointed.Type

  export const RetryScheduled = Event.define({
    type: "workflow.stage.retry_scheduled",
    durable,
    schema: {
      ...stageBase,
      failure: Workflow.Failure,
      usage: Workflow.Usage,
      notBefore: DateTimeUtcFromMillis,
      leaseFence: leaseFence.pipe(optional),
    },
  })
  export type RetryScheduled = typeof RetryScheduled.Type

  export const Succeeded = Event.define({
    type: "workflow.stage.succeeded",
    durable,
    schema: {
      ...stageBase,
      usage: Workflow.Usage,
      checkpoint: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
    },
  })
  export type Succeeded = typeof Succeeded.Type

  export const Skipped = Event.define({
    type: "workflow.stage.skipped",
    durable,
    schema: {
      ...base,
      stageID: Workflow.StageID,
      sourceStageID: Workflow.StageID,
      outcomeSha256: Workflow.ArtifactCommit.fields.sha256,
    },
  })
  export type Skipped = typeof Skipped.Type

  export const Failed = Event.define({
    type: "workflow.stage.failed",
    durable,
    schema: {
      ...stageBase,
      failure: Workflow.Failure,
      usage: Workflow.Usage,
      source: Schema.Literals(["execution", "recovery"]),
    },
  })
  export type Failed = typeof Failed.Type

  export const Cancelled = Event.define({
    type: "workflow.stage.cancelled",
    durable,
    schema: {
      ...stageBase,
      source: Schema.Literals(["execution", "request"]),
    },
  })
  export type Cancelled = typeof Cancelled.Type
}

// ── Artifacts ────────────────────────────────────────────────────────────────

export namespace Artifact {
  export const Created = Event.define({
    type: "workflow.artifact.created",
    durable,
    schema: {
      ...base,
      stageID: Workflow.StageID,
      artifact: Workflow.Artifact,
    },
  })
  export type Created = typeof Created.Type
}

// ── Approval ─────────────────────────────────────────────────────────────────

export namespace Approval {
  export const Requested = Event.define({
    type: "workflow.approval.requested",
    durable,
    schema: {
      ...base,
      stageID: Workflow.StageID.pipe(optional),
      attempt: NonNegativeInt.pipe(optional),
      leaseOwner: Schema.String.pipe(optional),
      leaseFence: leaseFence.pipe(optional),
      reason: Schema.Literals(["ambiguous_execution", "budget_exhausted", "workflow_location_required"]),
      failure: Workflow.Failure.pipe(optional),
      usage: Workflow.Usage.pipe(optional),
    },
  })
  export type Requested = typeof Requested.Type

  export const Resolved = Event.define({
    type: "workflow.approval.resolved",
    durable,
    schema: {
      ...base,
      stageID: Workflow.StageID,
      action: Workflow.RecoveryAction,
    },
  })
  export type Resolved = typeof Resolved.Type
}

// ── Budget ───────────────────────────────────────────────────────────────────

export namespace Budget {
  export const ThresholdReached = Event.define({
    type: "workflow.budget.threshold_reached",
    durable,
    schema: {
      ...base,
      percent: Schema.Literals([50, 80, 100] as const),
      dimension: Schema.String,
      usage: Workflow.Usage,
      budget: Workflow.Budget,
    },
  })
  export type ThresholdReached = typeof ThresholdReached.Type

  export const Updated = Event.define({
    type: "workflow.budget.updated",
    durable,
    schema: {
      ...base,
      budget: Workflow.Budget,
    },
  })
  export type Updated = typeof Updated.Type
}

// ── Cancellation ─────────────────────────────────────────────────────────────

export const CancelRequested = Event.define({
  type: "workflow.cancel.requested",
  durable,
  schema: base,
})
export type CancelRequested = typeof CancelRequested.Type

export const Cancelled = Event.define({
  type: "workflow.cancelled",
  durable,
  schema: base,
})
export type Cancelled = typeof Cancelled.Type

// ── Durable inventory ────────────────────────────────────────────────────────

export const DurableDefinitions = Event.inventory(
  Created,
  Started,
  Stage.Queued,
  Stage.Leased,
  Stage.Started,
  Stage.Checkpointed,
  Artifact.Created,
  Stage.RetryScheduled,
  Stage.Succeeded,
  Stage.Skipped,
  Stage.Failed,
  Approval.Requested,
  Approval.Resolved,
  Budget.ThresholdReached,
  Budget.Updated,
  CancelRequested,
  Stage.Cancelled,
  Cancelled,
  Succeeded,
  Failed,
)

export const Definitions = DurableDefinitions

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "WorkflowDurableEvent" })
export type DurableEvent = typeof Durable.Type

export const All = Durable
