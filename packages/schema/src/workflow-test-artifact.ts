export * as WorkflowTestArtifact from "./workflow-test-artifact"

import { Schema } from "effect"
import { DesignArtifact } from "./design-artifact"
import { NonNegativeInt } from "./schema"
import { Workflow } from "./workflow"

const exact = { parseOptions: { onExcessProperty: "error" as const } }

export const MAX_LOG_BYTES = 1_048_576
export const MAX_ARG_CHARS = 4_096

const Argument = Schema.NonEmptyString.check(
  Schema.makeFilter<string>((value) =>
    value.length <= MAX_ARG_CHARS ? undefined : `argv values must not exceed ${MAX_ARG_CHARS} characters`,
  ),
)
const WorkingDirectory = Schema.Union([Schema.Literal("."), DesignArtifact.SourcePath])
const LogSize = NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_LOG_BYTES))

const LogReference = Schema.Struct({
  uri: Schema.NonEmptyString,
  sha256: DesignArtifact.Sha256,
  size: LogSize,
}).annotate({ identifier: "WorkflowTestArtifact.LogReference", ...exact })

const Record = Schema.Struct({
  name: Schema.NonEmptyString,
  argv: Schema.NonEmptyArray(Argument),
  cwd: WorkingDirectory,
  exitCode: Schema.Int,
  log: LogReference,
}).annotate({ identifier: "WorkflowTestArtifact.Record", ...exact })

const PreviewIdentity = Schema.Struct({
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  implementationSha256: DesignArtifact.Sha256,
  uri: Schema.NonEmptyString,
}).annotate({ identifier: "WorkflowTestArtifact.PreviewIdentity", ...exact })

const ResultShapeV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  implementationSha256: DesignArtifact.Sha256,
  verdict: Schema.Literals(["pass", "fail"]),
  tests: Schema.NonEmptyArray(Record),
  preview: PreviewIdentity,
})

const ResultShapeV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  workflowID: DesignArtifact.SafeWorkflowID,
  stageID: Workflow.StageID,
  revision: NonNegativeInt,
  implementationSha256: DesignArtifact.Sha256,
  verdict: Schema.Literals(["pass", "fail"]),
  tests: Schema.NonEmptyArray(Record),
  preview: PreviewIdentity,
})

type ResultValue = Schema.Schema.Type<typeof ResultShapeV1> | Schema.Schema.Type<typeof ResultShapeV2>

const internallyConsistent = (value: ResultValue) => {
  if ((value.verdict === "pass") !== value.tests.every((record) => record.exitCode === 0))
    return "Test verdict must match every recorded exit code"
  if (new Set(value.tests.map((record) => record.name)).size !== value.tests.length)
    return "Test record names must be unique"
  if (
    value.preview.workflowID !== value.workflowID ||
    value.preview.revision !== value.revision ||
    value.preview.implementationSha256 !== value.implementationSha256
  )
    return "Preview identity must match the tested implementation"
  if (value.preview.uri !== previewURI(value.workflowID, value.revision, value.implementationSha256))
    return "Preview URI must match the tested implementation"
  if (
    value.tests.some(
      (record) =>
        record.log.uri !==
        (value.schemaVersion === 1
          ? logURI(value.workflowID, record.log.sha256)
          : exactLogURI(value.workflowID, value.stageID, value.revision, record.log.sha256)),
    )
  )
    return "Test log URI must match its workflow and hash"
  return undefined
}

export const ResultV1 = ResultShapeV1.check(Schema.makeFilter(internallyConsistent)).annotate({
  identifier: "WorkflowTestArtifact.ResultV1",
  ...exact,
})
export const ResultV2 = ResultShapeV2.check(Schema.makeFilter(internallyConsistent)).annotate({
  identifier: "WorkflowTestArtifact.ResultV2",
  ...exact,
})
export const Result = Schema.Union([ResultV1, ResultV2]).annotate({ identifier: "WorkflowTestArtifact.Result" })
export type Result = Schema.Schema.Type<typeof Result>

function previewURI(workflowID: string, revision: number, implementationSha256: string): string {
  return `workflow://preview/${workflowID}/r${revision}/${implementationSha256}`
}

function logURI(workflowID: string, sha256: string): string {
  return `workflow://artifact/${workflowID}/test-log/${sha256}.txt`
}

function exactLogURI(workflowID: string, stageID: string, revision: number, sha256: string): string {
  return `workflow://artifact/${workflowID}/stages/${stageID}/test-log/r${revision}/${sha256}.txt`
}
