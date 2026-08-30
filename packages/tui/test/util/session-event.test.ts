import { describe, expect, test } from "bun:test"
import { deletedSessionID } from "../../src/util/session-event"

describe("deletedSessionID", () => {
  test("reads the authoritative v3 deletion identity", () => {
    expect(deletedSessionID({ sessionID: "ses_v3", visibility: "public", timeDeleted: 1 })).toBe("ses_v3")
  })

  test("keeps legacy deletion payloads compatible and fails closed for malformed input", () => {
    expect(deletedSessionID({ sessionID: "ses_v1", info: { id: "ses_legacy_info" } })).toBe("ses_v1")
    expect(deletedSessionID({ info: { id: "ses_legacy_info" } })).toBe("ses_legacy_info")
    expect(deletedSessionID({ info: {} })).toBeUndefined()
  })
})
