import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { WorkflowRoleAgents } from "@opencode-ai/core/workflow/role-agents"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { reservedAgent } from "../src/handlers/session"
import { publicSessionEvent } from "../src/handlers/event"

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

  test("filters workflow Session events from the global event stream", async () => {
    const hiddenID = SessionV2.ID.make("ses_hidden_global_event")
    const sessions = {
      get: () => Effect.fail(new SessionV2.NotFoundError({ sessionID: hiddenID })),
    } as Pick<SessionV2.Interface, "get">
    const visible = await Effect.runPromise(
      publicSessionEvent(
        {
          durable: { aggregateID: hiddenID },
        },
        sessions,
      ),
    )

    expect(visible).toBe(false)
  })

  test("filters non-durable workflow Session events from the global event stream", async () => {
    const hiddenID = SessionV2.ID.make("ses_hidden_ephemeral_event")
    const sessions = {
      get: () => Effect.fail(new SessionV2.NotFoundError({ sessionID: hiddenID })),
    } as Pick<SessionV2.Interface, "get">
    const visible = await Effect.runPromise(publicSessionEvent({ data: { sessionID: hiddenID } }, sessions))

    expect(visible).toBe(false)
  })
})
