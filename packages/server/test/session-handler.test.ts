import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PublicEventVisibility } from "@opencode-ai/core/event/public-visibility"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { SessionV2 } from "@opencode-ai/core/session"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { WorkflowRoleAgents } from "@opencode-ai/core/workflow/role-agents"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { reservedAgent } from "../src/handlers/session"
import { publicSessionEvent } from "../src/handlers/event"

function sessionAuthority(sessions: Pick<SessionV2.Interface, "get">): PublicEventVisibility.Authority {
  return {
    session: (sessionID) =>
      sessions.get(sessionID).pipe(
        Effect.as("public" as const),
        Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
      ),
    workflow: () => Effect.succeed(undefined),
    response: () => Effect.succeed(undefined),
  }
}

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
        sessionAuthority(sessions),
      ),
    )

    expect(visible).toBe(false)
  })

  test("filters non-durable workflow Session events from the global event stream", async () => {
    const hiddenID = SessionV2.ID.make("ses_hidden_ephemeral_event")
    const sessions = {
      get: () => Effect.fail(new SessionV2.NotFoundError({ sessionID: hiddenID })),
    } as Pick<SessionV2.Interface, "get">
    const visible = await Effect.runPromise(
      publicSessionEvent({ data: { sessionID: hiddenID } }, sessionAuthority(sessions)),
    )

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
          sessionAuthority(sessions),
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
        sessionAuthority(sessions),
      ),
    )

    expect(visible).toBe(true)
  })

  test("defaults only legacy deletion versions to public when visibility is absent", async () => {
    const deletedID = SessionV2.ID.make("ses_deleted_versioned")
    const sessions = {
      get: () => Effect.fail(new SessionV2.NotFoundError({ sessionID: deletedID })),
    } as Pick<SessionV2.Interface, "get">
    const deletion = { sessionID: deletedID }

    const legacy = await Effect.runPromise(
      publicSessionEvent(
        {
          durable: { aggregateID: deletedID, version: 1 },
          type: "session.deleted",
          data: deletion,
        },
        sessionAuthority(sessions),
      ),
    )
    const current = await Effect.runPromise(
      publicSessionEvent(
        {
          durable: { aggregateID: deletedID, version: 2 },
          type: "session.deleted",
          data: deletion,
        },
        sessionAuthority(sessions),
      ),
    )

    expect(legacy).toBe(true)
    expect(current).toBe(false)
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
        sessionAuthority(sessions),
      ),
    )

    expect(visible).toBe(false)
  })

  test("suppresses complete workflow and Response batches when the live surface has no relationship authority", async () => {
    const publicID = SessionV2.ID.make("ses_public_unresolved_batch")
    const related = [
      { type: "session.updated", data: { sessionID: publicID } },
      {
        type: "workflow.created",
        data: { workflowID: "wfl_public_unresolved_batch", sessionID: publicID },
      },
      {
        type: "response.created",
        data: {
          responseID: "resp_public_unresolved_batch",
          workflowID: "wfl_public_unresolved_batch",
          context: [{ type: "message", content: "UNRESOLVED_RECEIPT_SENTINEL" }],
        },
      },
    ]
    const sessions = {
      get: () => Effect.succeed({} as SessionV2.Info),
    } as Pick<SessionV2.Interface, "get">

    const visible = await Effect.runPromise(
      publicSessionEvent(
        {
          type: related[2].type,
          data: related[2].data,
          durable: {
            aggregateID: "resp_public_unresolved_batch",
            batch: { id: "evt_public_unresolved_batch", index: 2, size: related.length },
            related,
          },
        },
        sessionAuthority(sessions),
      ),
    )

    expect(visible).toBe(false)
  })

  test("fails closed when one complete live batch declares two owners for the same Workflow", async () => {
    const first = SessionV2.ID.make("ses_public_duplicate_first")
    const second = SessionV2.ID.make("ses_public_duplicate_second")
    const workflowID = "wfl_public_duplicate"
    const related = [
      { type: "session.created", data: { sessionID: first, visibility: "public" } },
      { type: "session.created", data: { sessionID: second, visibility: "public" } },
      { type: "workflow.created", data: { workflowID, sessionID: second } },
      { type: "workflow.created", data: { workflowID, sessionID: first } },
    ]
    const visible = await Effect.runPromise(
      PublicEventVisibility.isPublic(
        {
          type: related[3].type,
          data: related[3].data,
          durable: {
            aggregateID: workflowID,
            batch: { id: "evt_public_duplicate", index: 3, size: related.length },
            related,
          },
        },
        {
          session: () => Effect.succeed("public"),
          workflow: () => Effect.succeed(first),
          response: () => Effect.succeed(undefined),
        },
      ),
    )

    expect(visible).toBe(false)
  })

  test("fails closed when one complete live batch repeats the same Response owner with divergent context", async () => {
    const sessionID = SessionV2.ID.make("ses_public_duplicate_response")
    const workflowID = WorkflowV2.ID.make("wfl_public_duplicate_response")
    const responseID = ResponsesV2.ID.make("resp_public_duplicate_response")
    const related = [
      { type: "session.updated", data: { sessionID } },
      { type: "workflow.created", data: { workflowID, sessionID } },
      {
        type: "response.created",
        data: { responseID, workflowID, context: [{ type: "message", content: "public" }] },
      },
      {
        type: "response.created",
        data: { responseID, workflowID, context: [{ type: "message", content: "HIDDEN_DUPLICATE_RECEIPT" }] },
      },
    ]
    const visible = await Effect.runPromise(
      PublicEventVisibility.isPublic(
        {
          type: related[3].type,
          data: related[3].data,
          durable: {
            aggregateID: responseID,
            batch: { id: "evt_public_duplicate_response", index: 3, size: related.length },
            related,
          },
        },
        {
          session: () => Effect.succeed("public"),
          workflow: () => Effect.succeed(sessionID),
          response: () => Effect.succeed(workflowID),
        },
      ),
    )

    expect(visible).toBe(false)
  })

  test("requires authoritative Session storage for session.created despite declared public visibility", async () => {
    const sessionID = SessionV2.ID.make("ses_missing_created_authority")
    const visible = await Effect.runPromise(
      PublicEventVisibility.isPublic(
        {
          type: "session.created",
          data: { sessionID, visibility: "public" },
          durable: { aggregateID: sessionID, version: 1 },
        },
        {
          session: () => Effect.succeed(undefined),
          workflow: () => Effect.succeed(undefined),
          response: () => Effect.succeed(undefined),
        },
      ),
    )

    expect(visible).toBe(false)
  })

  test("allows a complete Response batch that matches authoritative public ownership", async () => {
    const sessionID = SessionV2.ID.make("ses_public_authoritative")
    const workflowID = WorkflowV2.ID.make("wfl_public_authoritative")
    const responseID = ResponsesV2.ID.make("resp_public_authoritative")
    const related = [
      { type: "session.updated", data: { sessionID } },
      { type: "workflow.created", data: { workflowID, sessionID } },
      { type: "response.created", data: { responseID, workflowID } },
    ]
    const visible = await Effect.runPromise(
      PublicEventVisibility.isPublic(
        {
          type: related[2].type,
          data: related[2].data,
          durable: {
            aggregateID: responseID,
            batch: { id: "evt_public_authoritative", index: 2, size: related.length },
            related,
          },
        },
        {
          session: () => Effect.succeed("public"),
          workflow: () => Effect.succeed(sessionID),
          response: () => Effect.succeed(workflowID),
        },
      ),
    )

    expect(visible).toBe(true)
  })
})
