import { expect, test } from "bun:test"
import { classifyOfflineRejection, expectedOfflineCalls } from "../../src/offline/outcome"

const rejection = {
  armID: "A",
  kind: "guardrail",
  classification: "exited",
  exitCode: 1,
  calls: [],
  unchanged: true,
  stdout: JSON.stringify({
    workflow: null,
    response: null,
    artifacts: [],
    error: { code: "preview_configuration_required" },
  }),
} as const

test("retains only exact zero-dispatch nonvisual guardrail capability failures", () => {
  expect(classifyOfflineRejection(rejection)).toMatchObject({
    workflowCalls: 0,
    toolCalls: 0,
    failureCategory: "preview_configuration_required",
  })
  expect(expectedOfflineCalls("A", "guardrail")).toBe(0)
  expect(expectedOfflineCalls("A", "primary")).toBe(8)
  expect(expectedOfflineCalls("C", "guardrail")).toBe(2)
  for (const change of [
    { armID: "B" },
    { kind: "primary" },
    { classification: "timed_out" },
    { exitCode: 2 },
    { unchanged: false },
    { stdout: '{"workflow":null,"response":null,"artifacts":[]}' },
    { stdout: '{"error":{"code":"unknown"}}' },
    { calls: [{ provider: "kimi", model: "kimi-k3", protocol: "chat_completions" }] },
  ] as const) {
    expect(() => classifyOfflineRejection({ ...rejection, ...change })).toThrow("TASK24_OFFLINE_BINARY_PROCESS_FAILED")
  }
})
