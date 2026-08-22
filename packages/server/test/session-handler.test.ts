import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { WorkflowRoleAgents } from "@opencode-ai/core/workflow/role-agents"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { reservedAgent } from "../src/handlers/session"

describe("SessionHandler", () => {
  test("maps public selection of a reserved workflow agent to a deterministic invalid request", () => {
    const agent = WorkflowRoleAgents.agentForRole("implement")
    const error = reservedAgent(new AgentV2.ReservedSelectionError({ agent }))

    expect(error).toBeInstanceOf(InvalidRequestError)
    expect(error).toEqual(
      new InvalidRequestError({
        message: `Agent ${agent} is reserved for internal workflow use`,
        kind: "reserved_agent",
        field: "agent",
      }),
    )
    expect(error._tag).not.toBe("UnknownError")
  })
})
