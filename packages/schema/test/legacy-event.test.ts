import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { Durable } from "../src/durable-event-manifest"
import { LegacyEvent } from "../src/legacy-event"
import { PermissionV1 } from "../src/permission-v1"
import { QuestionV1 } from "../src/question-v1"
import { Project } from "../src/project"
import { SessionV1 } from "../src/session-v1"

describe("legacy public event schemas", () => {
  const deletion = {
    sessionID: "ses_legacy_delete",
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
      "message.updated",
      "message.removed",
      "message.part.updated",
      "message.part.removed",
      "message.part.delta",
      "session.diff",
      "session.error",
    ])
    const durable = SessionV1.Event.Definitions.filter((event) => event.durable !== undefined)
    expect(durable).toHaveLength(8)
    expect(durable.every((event) => event.durable?.aggregate === "sessionID")).toBe(true)
    expect(durable.map((event) => event.durable?.version)).toEqual([1, 1, 1, 2, 1, 1, 1, 1])
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

  test("requires visibility on the current deletion while retaining explicit legacy v1 decoding", () => {
    expect(SessionV1.Event.Deleted.durable?.version).toBe(2)
    expect(Result.isFailure(Schema.decodeUnknownResult(SessionV1.Event.Deleted.data)(deletion))).toBe(true)

    const legacy = Durable.get("session.deleted.1")
    expect(legacy?.durable?.version).toBe(1)
    expect(Result.isSuccess(Schema.decodeUnknownResult(legacy!.data)(deletion))).toBe(true)
    expect(Durable.get("session.deleted.2")).toBe(SessionV1.Event.Deleted)
  })
})
