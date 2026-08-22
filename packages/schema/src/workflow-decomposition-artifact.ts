export * as WorkflowDecompositionArtifact from "./workflow-decomposition-artifact"

import { Schema } from "effect"
import { DesignArtifact } from "./design-artifact"
import { NonNegativeInt } from "./schema"

const exact = { parseOptions: { onExcessProperty: "error" as const } }

const Task = Schema.Struct({
  id: DesignArtifact.SafeIdentifier,
  title: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  acceptanceCriteria: Schema.NonEmptyArray(Schema.NonEmptyString),
  dependsOn: Schema.Array(DesignArtifact.SafeIdentifier),
  files: Schema.NonEmptyArray(DesignArtifact.SourcePath),
}).annotate({ identifier: "WorkflowDecompositionArtifact.Task", ...exact })

const PlanShape = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: DesignArtifact.SafeWorkflowID,
  revision: NonNegativeInt,
  snapshotRef: Schema.NonEmptyString,
  acceptanceCriteria: Schema.NonEmptyArray(Schema.NonEmptyString),
  tasks: Schema.NonEmptyArray(Task),
})

const internallyConsistent = Schema.makeFilter<Schema.Schema.Type<typeof PlanShape>>((value) => {
  const ids = new Set(value.tasks.map((task) => task.id))
  if (ids.size !== value.tasks.length) return "Decomposition task IDs must be unique"
  for (const task of value.tasks) {
    if (new Set(task.dependsOn).size !== task.dependsOn.length) return `Task ${task.id} dependencies must be unique`
    if (task.dependsOn.includes(task.id)) return `Task ${task.id} must not depend on itself`
    if (task.dependsOn.some((dependency) => !ids.has(dependency)))
      return `Task ${task.id} references an unknown dependency`
    const topologyError = DesignArtifact.sourceTopologyError(task.files)
    if (topologyError !== undefined) return topologyError
  }
  const planTopologyError = DesignArtifact.sourceTopologyError([...new Set(value.tasks.flatMap((task) => task.files))])
  if (planTopologyError !== undefined) return planTopologyError
  return undefined
})

export const Plan = PlanShape.check(internallyConsistent).annotate({
  identifier: "WorkflowDecompositionArtifact.Plan",
  ...exact,
})
export interface Plan extends Schema.Schema.Type<typeof Plan> {}
