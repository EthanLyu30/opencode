export * as WorkflowBenchmarkModels from "./workflow-benchmark-models"

import { Schema } from "effect"
import { WorkflowModelCatalog } from "./workflow-model-catalog"

/** Closed zero-cost admission data, never a production discovery observation. */
export const Packet = Schema.Struct({
  kind: Schema.Literal("task24.zero-cost-models.v1"),
  catalogue: WorkflowModelCatalog.Catalogue,
  policy: WorkflowModelCatalog.Policy,
  snapshot: WorkflowModelCatalog.AdmissionSnapshot,
}).annotate({ parseOptions: { onExcessProperty: "error" } })
export interface Packet extends Schema.Schema.Type<typeof Packet> {}
