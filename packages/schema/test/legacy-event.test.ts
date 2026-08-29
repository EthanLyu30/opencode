import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { Durable } from "../src/durable-event-manifest"
import { LegacyEvent } from "../src/legacy-event"
import { EventManifest } from "../src/event-manifest"
import { PermissionV1 } from "../src/permission-v1"
import { QuestionV1 } from "../src/question-v1"
import { Project } from "../src/project"
import { SessionV1 } from "../src/session-v1"
import { SessionID } from "../src/session-id"

describe("legacy public event schemas", () => {
  const deletion = {
    sessionID: SessionID.make("ses_legacy_delete"),
    info: {
      id: "ses_legacy_delete",
      slug: "legacy-delete",
      projectID: "global",
      directory: "D:/legacy-delete",
      title: "legacy delete",
      version: "legacy",
      time: { created: 0, updated: 0 },
    },
  }

  test("owns all SessionV1 definitions", () => {
    expect(SessionV1.Event.Definitions.map((event) => event.type)).toEqual([
      "session.created",
      "session.updated",
      "session.deleted",
      "session.deleted",
      "session.deleted",
      "message.updated",
      "message.removed",
      "message.part.updated",
      "message.part.removed",
      "message.part.delta",
      "session.diff",
      "session.error",
    ])
    const durable = SessionV1.Event.Definitions.filter((event) => event.durable !== undefined)
    expect(durable.every((event) => event.durable?.aggregate === "sessionID")).toBe(true)
    expect(durable).toHaveLength(9)
    expect(durable.map((event) => event.durable?.version)).toEqual([1, 1, 1, 2, 3, 1, 1, 1, 1])
  })

  test("owns the legacy transient public definitions", () => {
    expect([
      SessionV1.PartDelta.type,
      SessionV1.Diff.type,
      SessionV1.Error.type,
      PermissionV1.Event.Asked.type,
      PermissionV1.Event.Replied.type,
      QuestionV1.Event.Asked.type,
      QuestionV1.Event.Replied.type,
      QuestionV1.Event.Rejected.type,
      Project.Event.Updated.type,
      LegacyEvent.CommandExecuted.type,
    ]).toEqual([
      "message.part.delta",
      "session.diff",
      "session.error",
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.replied",
      "question.rejected",
      "project.updated",
      "command.executed",
    ])
  })

  test("requires visibility and canonical deletion time on v3 while retaining v1 and v2 decoding", () => {
    expect(SessionV1.Event.Deleted.durable?.version).toBe(3)
    expect(Result.isFailure(Schema.decodeUnknownResult(SessionV1.Event.Deleted.data)(deletion))).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(SessionV1.Event.Deleted.data)({ ...deletion, visibility: "public" })),
    ).toBe(true)
    expect(
      Schema.decodeUnknownSync(SessionV1.Event.Deleted.data)({
        ...deletion,
        visibility: "public",
        timeDeleted: 123,
      }),
    ).toEqual({
      sessionID: deletion.sessionID,
      visibility: "public",
      timeDeleted: 123,
    })

    const legacy = Durable.get("session.deleted.1")
    expect(legacy?.durable?.version).toBe(1)
    expect(Result.isSuccess(Schema.decodeUnknownResult(legacy!.data)(deletion))).toBe(true)
    const v2 = Durable.get("session.deleted.2")
    expect(v2?.durable?.version).toBe(2)
    expect(Result.isSuccess(Schema.decodeUnknownResult(v2!.data)({ ...deletion, visibility: "public" }))).toBe(true)
    expect(Durable.get("session.deleted.3")).toBe(SessionV1.Event.Deleted)
  })

  test("does not decode a v3 deletion without current authority through legacy branches", () => {
    const publicEvent = Schema.Union(EventManifest.ServerDefinitions)
    const payload = {
      id: "evt_legacy_delete_version_guard",
      type: "session.deleted",
      durable: {
        aggregateID: deletion.sessionID,
        seq: 0,
        version: 3,
      },
      data: deletion,
    }

    expect(Result.isFailure(Schema.decodeUnknownResult(publicEvent)(payload))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(publicEvent)({
          ...payload,
          durable: { ...payload.durable, version: 2 },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(publicEvent)({
          ...payload,
          durable: { ...payload.durable, version: 1 },
        }),
      ),
    ).toBe(true)
  })
})
