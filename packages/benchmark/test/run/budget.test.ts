import { describe, expect, test } from "bun:test"
import { decodeStageApproval, requireStageApproval, signStageApproval } from "../../src/run/budget"

const secret = "TASK24_LOCAL_APPROVAL_SECRET_abcdefghijklmnopqrstuvwxyz"
const authority = {
  campaignID: "campaign-a",
  campaignSha256: "a".repeat(64),
  stage: "pilot" as const,
  stageSha256: "b".repeat(64),
  expiresAt: 2_000,
  ceilings: { CNY: "1000000", USD: "2000000" },
}

describe("Task24 paid-stage approval", () => {
  test("requires an HMAC-bound campaign, stage, expiry, and native-currency ceilings", () => {
    const approval = signStageApproval(authority, secret)
    expect(requireStageApproval("pilot", approval, authority, secret, 1_000)).toEqual({
      CNY: 1_000_000n,
      USD: 2_000_000n,
    })
    expect(() =>
      requireStageApproval("pilot", { ...approval, stageSha256: "c".repeat(64) }, authority, secret, 1_000),
    ).toThrow(/approval/i)
    expect(() => requireStageApproval("pilot", approval, authority, secret, 2_001)).toThrow(/expired/i)
  })

  test("offline runs need no paid approval while campaign approval cannot authorize pilot", () => {
    expect(requireStageApproval("offline", undefined, undefined, undefined, 1_000)).toEqual({ CNY: 0n, USD: 0n })
    const approval = signStageApproval({ ...authority, stage: "campaign" }, secret)
    expect(() => requireStageApproval("pilot", approval, authority, secret, 1_000)).toThrow(/stage|approval/i)
  })

  test("rejects unsigned or excess approval fields instead of silently dropping them", () => {
    const approval = signStageApproval(authority, secret)
    expect(() => decodeStageApproval({ ...approval, extra: true })).toThrow(/approval/i)
    expect(() => decodeStageApproval({ ...approval, ceilings: { ...approval.ceilings, EUR: "1" } })).toThrow(
      /approval/i,
    )
  })
})
