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

  test("filters every member of a related workflow Session batch", async () => {
    const hiddenID = SessionV2.ID.make("ses_hidden_related_batch")
    const sessions = {
      get: () => Effect.fail(new SessionV2.NotFoundError({ sessionID: hiddenID })),
    } as Pick<SessionV2.Interface, "get">
    const related = [
      {
        type: "session.created",
        data: { sessionID: hiddenID, visibility: "workflow" },
      },
      {
        type: "workflow.created",
        data: { workflowID: "wfl_hidden_related_batch", sessionID: hiddenID },
      },
      {
        type: "response.created",
        data: {
          responseID: "resp_hidden_related_batch",
          workflowID: "wfl_hidden_related_batch",
          context: [{ type: "workflow.visual-build.admission-receipt.v1", receipt: { secret: "do-not-leak" } }],
        },
      },
    ]

    for (const [index, member] of related.entries()) {
      const visible = await Effect.runPromise(
        publicSessionEvent(
          {
            durable: {
              aggregateID: member.data.sessionID ?? member.data.workflowID ?? member.data.responseID,
              batch: { id: "evt_hidden_related_batch", index, size: related.length },
              related,
            },
            data: member.data,
            type: member.type,
          },
          sessions,
        ),
      )
      expect(visible).toBe(false)
    }
  })

  test("delivers immutable public deletion tombstones after the Session row is gone", async () => {
    const deletedID = SessionV2.ID.make("ses_deleted_public")
    const sessions = {
      get: () => Effect.fail(new SessionV2.NotFoundError({ sessionID: deletedID })),
    } as Pick<SessionV2.Interface, "get">

    const visible = await Effect.runPromise(
      publicSessionEvent(
        {
          durable: { aggregateID: deletedID },
          type: "session.deleted",
          data: { sessionID: deletedID, visibility: "public" },
        },
        sessions,
      ),
    )

    expect(visible).toBe(true)
  })

  test("fails closed for an incomplete workflow batch", async () => {
    const sessions = {
      get: () => Effect.die(new Error("unknown workflow ownership must not query a public Session")),
    } as Pick<SessionV2.Interface, "get">

    const visible = await Effect.runPromise(
      publicSessionEvent(
        {
          durable: {
            aggregateID: "resp_unknown_batch",
            batch: { id: "evt_unknown_batch", index: 0, size: 2 },
          },
          type: "response.created",
          data: { responseID: "resp_unknown_batch", workflowID: "wfl_unknown_batch" },
        },
        sessions,
      ),
    )

    expect(visible).toBe(false)
  })
})
