import { expect, test } from "bun:test"
import { classifyOfflineRejection, expectedOfflineCalls } from "../../src/offline/outcome"

const rejection = {
  armID: "A",
  kind: "guardrail",
  taskID: "guardrail-data-normalization",
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
  expect(expectedOfflineCalls("A", "guardrail", rejection.taskID)).toBe(0)
  expect(expectedOfflineCalls("A", "primary", "private-analytics-dashboard")).toBe(8)
  expect(expectedOfflineCalls("C", "guardrail", rejection.taskID)).toBe(2)
  for (const change of [
    { armID: "B" },
    { kind: "primary" },
    { taskID: "unknown-guardrail" },
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

test("retains the four frozen unsupported library tasks as capability failures, never arbitrary primary failures", () => {
  for (const taskID of [
    "swe-chartjs__chart.js-10157",
    "swe-chartjs__chart.js-10301",
    "swe-diegomura__react-pdf-1363",
    "swe-markedjs__marked-1535",
  ]) {
    expect(classifyOfflineRejection({ ...rejection, kind: "primary", taskID })).toMatchObject({
      failureCategory: "preview_configuration_required",
      workflowCalls: 0,
    })
    expect(expectedOfflineCalls("A", "primary", taskID)).toBe(0)
    expect(expectedOfflineCalls("B", "primary", taskID)).toBe(2)
  }
  expect(() =>
    classifyOfflineRejection({ ...rejection, kind: "primary", taskID: "private-analytics-dashboard" }),
  ).toThrow("TASK24_OFFLINE_BINARY_PROCESS_FAILED")
})
