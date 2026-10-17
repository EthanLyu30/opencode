import { Workflow } from "@opencode-ai/schema/workflow"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { DateTime } from "effect"
import { CodingModelSelection } from "../../src/workflow/coding/model-selection"
import { ModelSelection } from "../../src/workflow/model-selection"
import { fixtureAdmissionSnapshot } from "./workflow-model-catalog"

export const codingBudget = { maxTokens: 20000, maxTurns: 20, maxToolCalls: 40, maxAttempts: 27 }
export const codingLocation = Location.Ref.make({ directory: AbsolutePath.make("D:/coding-contract-fixture") })

export function codingFixture(role = "design", revision = 0) {
  const selection = CodingModelSelection.freeze(fixtureAdmissionSnapshot(), codingLocation)
  const time = { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) }
  const workflow = Workflow.Info.make({
    id: Workflow.ID.make("wfl_coding_contract"),
    type: "coding-build",
    status: "running",
    input: {
      brief: "Fix the library function",
      coding: { maxRevisions: 1, maxTokens: 20000, maxTurns: 20, maxToolCalls: 40 },
      [CodingModelSelection.RESERVED_INPUT_KEY]: selection,
    },
    budget: codingBudget,
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
    location: codingLocation,
    version: 1,
    time,
  })
  const stage = Workflow.Stage.make({
    id: Workflow.StageID.make(`wfs_coding_${role}_${revision}`),
    workflowID: workflow.id,
    type: role,
    ordinal: 0,
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    recoveryPolicy: "restart_safe",
    idempotencyKey: `coding-build/${role}/r${revision}`,
    input: { revision },
    time,
  })
  return { workflow, stage, selection }
}

export function codingLegacyFixture() {
  const location = Location.Ref.make({ directory: AbsolutePath.make("D:/coding-contract-legacy") })
  const selection = ModelSelection.freeze(fixtureAdmissionSnapshot(), location)
  const time = { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) }
  const workflow = Workflow.Info.make({
    id: Workflow.ID.make("wfl_coding_legacy"),
    type: "visual-build",
    status: "running",
    input: { brief: "Legacy visual fixture", [ModelSelection.RESERVED_INPUT_KEY]: selection },
    budget: codingBudget,
    usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 1 },
    location,
    version: 1,
    time,
  })
  const stage = Workflow.Stage.make({
    id: Workflow.StageID.make("wfs_coding_legacy_design"),
    workflowID: workflow.id,
    type: "design",
    ordinal: 0,
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    recoveryPolicy: "restart_safe",
    idempotencyKey: "legacy/design/r0",
    input: { revision: 0 },
    time,
  })
  return { workflow, stage, selection }
}
