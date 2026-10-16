export * as CodingAdmissionReceipt from "./admission-receipt"

import { Agent } from "@opencode-ai/schema/agent"
import { Responses } from "@opencode-ai/schema/responses"
import { Session } from "@opencode-ai/schema/session"
import { Location } from "@opencode-ai/schema/location"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowBenchmarkTransport } from "../benchmark-transport"
import { WorkflowSecretGuard } from "../secret-guard"
import { CodingGraph } from "./graph"
import { CodingHostPlan } from "./host-plan"
import { CodingModelSelection } from "./model-selection"

export const KIND = "workflow.coding-build.admission-receipt.v1"
export const CLAIM_KEY = "workflow.coding-admission-claim.v1"
const exact = { parseOptions: { onExcessProperty: "error" as const } }
export const Receipt = Schema.Struct({
  kind: Schema.Literal(KIND),
  requestHash: Schema.NonEmptyString,
  request: WorkflowCodingBuild.CreateInput,
  location: Location.Ref,
  selection: CodingModelSelection.FrozenSelection,
  hostPlan: Schema.Unknown,
  workflowID: Workflow.ID,
  sessionID: Session.ID,
  responseID: Responses.ID,
  agent: Agent.ID,
  graph: Schema.NonEmptyArray(Workflow.StageInput),
  benchmarkTransport: Schema.optional(Schema.Unknown),
}).annotate(exact)
export type Receipt = typeof Receipt.Type
export function identities(claim: string) {
  const id = (kind: string) => WorkflowBusinessArtifact.hash({ domain: "opencode.coding-build.ids.v1", claim, kind })
  return {
    workflowID: Workflow.ID.make(`wfl_${id("workflow")}`),
    sessionID: Session.ID.make(`ses_${id("session")}`),
    responseID: Responses.ID.make(`resp_${id("response")}`),
  }
}
export function graph(claim: string, maxRevisions: number, responseID: Responses.ID) {
  return CodingGraph.expand({ maxRevisions, maxAttempts: 3, responseID }).map((stage) => ({
    ...stage,
    id: Workflow.StageID.make(
      `wfs_${WorkflowBusinessArtifact.hash({ claim, type: "coding-build", ordinal: stage.ordinal })}`,
    ),
  }))
}
export function decode(input: unknown): Receipt {
  const envelope = Schema.decodeUnknownSync(
    Schema.Struct({ type: Schema.Literal(KIND), receipt: Receipt }).annotate(exact),
  )(input)
  const receipt = envelope.receipt
  if (Buffer.byteLength(WorkflowBusinessArtifact.encode(envelope)) > 256 * 1024)
    throw new Error("Coding receipt too large")
  WorkflowSecretGuard.assertSafe(envelope)
  const selection = CodingModelSelection.validate(receipt.selection)
  const plan = CodingHostPlan.decode(receipt.hostPlan, receipt.location)
  const ids = identities(receipt.requestHash)
  if (
    selection.locationSha256 !== WorkflowBusinessArtifact.locationSha256(receipt.location) ||
    !isDeepStrictEqual(plan.checks, receipt.request.checks) ||
    !isDeepStrictEqual(
      graph(receipt.requestHash, receipt.request.coding.maxRevisions, receipt.responseID),
      receipt.graph,
    ) ||
    ids.workflowID !== receipt.workflowID ||
    ids.sessionID !== receipt.sessionID ||
    ids.responseID !== receipt.responseID
  )
    throw new Error("Invalid coding receipt authority")
  if (receipt.benchmarkTransport !== undefined) WorkflowBenchmarkTransport.decodeBinding(receipt.benchmarkTransport)
  return { ...receipt, selection, hostPlan: plan }
}
export function tryDecode(input: unknown): Receipt | undefined {
  try {
    return decode(input)
  } catch {
    return undefined
  }
}
export function workflowInput(receipt: Receipt) {
  return {
    schemaVersion: 1,
    prompt: receipt.request.prompt,
    coding: receipt.request.coding,
    checks: receipt.request.checks,
    delivery: receipt.request.delivery,
    [CLAIM_KEY]: receipt.requestHash,
    [CodingModelSelection.RESERVED_INPUT_KEY]: receipt.selection,
    [CodingHostPlan.RESERVED_INPUT_KEY]: receipt.hostPlan,
    ...(receipt.benchmarkTransport === undefined
      ? {}
      : { [WorkflowBenchmarkTransport.RESERVED_INPUT_KEY]: receipt.benchmarkTransport }),
  }
}
