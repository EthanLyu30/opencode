import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Session } from "@opencode-ai/schema/session"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Workspace } from "@opencode-ai/schema/workspace"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(WorkflowV2.node))

const workflowID = Workflow.ID.make("wfl_placement")
const sessionID = Session.ID.make("ses_placement")
const agent = Agent.ID.make("build")
const workspaceID = Workspace.ID.make("wrk_placement")
const location = Location.Ref.make({ directory: AbsolutePath.make("D:\\OpenCode-Audit"), workspaceID })
const otherLocation = Location.Ref.make({ directory: AbsolutePath.make("D:\\OpenCode-Other"), workspaceID })

const admitted: Workflow.AdmissionInput = {
  id: workflowID,
  type: "development",
  input: { brief: "Build a page" },
  budget: { maxAttempts: 3 },
  stages: [
    {
      type: "design",
      ordinal: 0,
      maxAttempts: 3,
      recoveryPolicy: "restart_safe",
      idempotencyKey: "wfl_placement/design",
      input: {},
    },
  ],
  location,
  sessionID,
  agent,
}

describe("Workflow placement", () => {
  it.effect("round-trips immutable placement and hidden session identity", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowV2.Service
      const created = yield* workflow.admit(admitted)

      expect(created).toMatchObject({ location, sessionID, agent })
      expect((yield* workflow.get(workflowID)).run).toMatchObject({ location, sessionID, agent })

      const conflict = yield* workflow.admit({ ...admitted, location: otherLocation }).pipe(Effect.flip)
      expect(conflict._tag).toBe("Workflow.ConflictError")
      const sessionConflict = yield* workflow
        .admit({ ...admitted, sessionID: Session.ID.make("ses_other") })
        .pipe(Effect.flip)
      expect(sessionConflict._tag).toBe("Workflow.ConflictError")
      const agentConflict = yield* workflow.admit({ ...admitted, agent: Agent.ID.make("review") }).pipe(Effect.flip)
      expect(agentConflict._tag).toBe("Workflow.ConflictError")
    }),
  )
})
