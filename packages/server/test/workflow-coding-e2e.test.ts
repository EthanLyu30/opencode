import { describe, expect, test } from "bun:test"
import { runCodingProbe } from "./workflow-coding-probe"

const executable = process.env.OPENCODE_CODING_ACCEPTANCE_EXE ?? process.execPath

describe("recorded nonvisual coding acceptance", () => {
  test("real library edit fails Bun checks, repairs, gets independent Kimi code review and delivers without a browser", async () => {
    const result = await runCodingProbe(executable, "repair")
    expect(result.workflowType).toBe("coding-build")
    expect(result.workflowStatus).toBe("succeeded")
    expect(result.responseStatus).toBe("completed")
    expect(result.roleModels).toEqual({
      design: "kimi-k3",
      decompose: "kimi-k3",
      implement: "deepseek-v4-pro",
      test: "deepseek-v4-flash",
      code_review: "kimi-k3",
      repair: "deepseek-v4-pro",
      deliver: "deepseek-v4-pro",
    })
    expect(result.checks).toEqual([
      { revision: 0, observedTests: 2, failedTests: 2, exitCode: 1 },
      { revision: 1, observedTests: 2, failedTests: 0, exitCode: 0 },
    ])
    expect(result.writes).toBe(2)
    expect(result.reviewReads).toBe(1)
    expect(result.previewCalls + result.browserCalls + result.outboundCalls).toBe(0)
    expect(result.deliveryValid).toBe(true)
    expect(result.sourceCorrect).toBe(true)
    expect(result.sseReplayExclusive).toBe(true)
    expect(result.settledCallsReplayed).toBe(0)
    expect(result.forgedAdmissionRejected).toBe(true)
  }, 180000)
  test("blocking code review drives a measured repair instead of bypassing the reviewer", async () => {
    const result = await runCodingProbe(executable, "review")
    expect(result.workflowStatus).toBe("succeeded")
    expect(result.checks).toEqual([
      { revision: 0, observedTests: 2, failedTests: 0, exitCode: 0 },
      { revision: 1, observedTests: 2, failedTests: 0, exitCode: 0 },
    ])
    expect(result.reviewReads).toBe(2)
    expect(result.writes).toBe(2)
    expect(result.deliveryValid).toBe(true)
  }, 180000)
  test("an admitted smaller coding budget pauses the real provider loop before delivery", async () => {
    const result = await runCodingProbe(executable, "review-budget")
    expect(result.workflowStatus).toBe("waiting_approval")
    expect(result.errorCode).toBe("workflow_budget_exhausted")
    expect(result.checks).toEqual([
      { revision: 0, observedTests: 2, failedTests: 0, exitCode: 0 },
      { revision: 1, observedTests: 2, failedTests: 0, exitCode: 0 },
    ])
    expect(result.writes).toBe(2)
    expect(result.reviewReads).toBe(2)
    expect(result.deliveryValid).toBe(false)
    expect(result.previewCalls + result.browserCalls + result.outboundCalls).toBe(0)
  }, 180000)
  for (const scenario of ["exhaust", "forged-pass", "config-drift", "source-drift", "ignored-config"] as const) {
    test(`${scenario} cannot produce a successful coding delivery`, async () => {
      const result = await runCodingProbe(executable, scenario)
      expect(result.workflowStatus).toBe("failed")
      expect(result.deliveryValid).toBe(false)
      expect(result.previewCalls + result.browserCalls + result.outboundCalls).toBe(0)
      if (scenario === "forged-pass") expect(result.errorCode).toBe("forged_coding_test_verdict")
      if (scenario === "config-drift") expect(result.errorCode).toBe("invalid_coding_evidence")
      if (scenario === "source-drift") expect(result.errorCode).toBe("coding_source_drift")
      if (scenario === "ignored-config") {
        expect(result.errorCode).toBe("coding_snapshot_unavailable")
        expect(result.checks).toEqual([])
      }
    }, 180000)
  }
  for (const scenario of ["crash-settled", "crash-write"] as const) {
    test(`${scenario} proves worker death, preserves model pins and never automatically repeats an unknown effect`, async () => {
      const result = await runCodingProbe(executable, scenario)
      expect(result.workerDeathProven).toBe(true)
      expect(result.settledCallsReplayed).toBe(0)
      expect(result.roleModels.design).toBe("kimi-k3")
      expect(result.previewCalls + result.browserCalls + result.outboundCalls).toBe(0)
      if (scenario === "crash-settled") {
        expect(result.workflowStatus).toBe("succeeded")
        expect(result.deliveryValid).toBe(true)
      } else {
        expect(result.workflowStatus).toBe("waiting_approval")
        expect(result.errorCode).toBe("tool_execution_ambiguous")
        expect(result.writes).toBe(1)
        expect(result.deliveryValid).toBe(false)
        expect(result.cancellationVerified).toBe(true)
      }
    }, 180000)
  }
})
