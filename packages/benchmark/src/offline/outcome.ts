import type { ArmRoute } from "../arms/types"
import { canonicalJson } from "../campaign/canonical"

const unsupportedPreviews = {
  guardrail: [
    "guardrail-data-normalization",
    "guardrail-idempotent-orders",
    "guardrail-registry-refactor",
    "guardrail-session-debug",
  ],
  primary: [
    "swe-chartjs__chart.js-10157",
    "swe-chartjs__chart.js-10301",
    "swe-diegomura__react-pdf-1363",
    "swe-markedjs__marked-1535",
  ],
} as const

function unsupportedPreview(kind: string, taskID: string) {
  return (
    (kind === "guardrail" || kind === "primary") && unsupportedPreviews[kind].some((expected) => expected === taskID)
  )
}

export function expectedOfflineCalls(armID: string, kind: string, taskID: string) {
  return armID === "A" ? (unsupportedPreview(kind, taskID) ? 0 : 8) : 2
}

export function classifyOfflineRejection(input: {
  readonly armID: string
  readonly kind: string
  readonly taskID: string
  readonly classification: string
  readonly exitCode: number | null
  readonly stdout: string
  readonly calls: readonly unknown[]
  readonly unchanged: boolean
}):
  | {
      readonly toolCalls: 0
      readonly workflowCalls: 0
      readonly workflowRoles: readonly ArmRoute["role"][]
      readonly failureCategory: "preview_configuration_required"
    }
  | undefined {
  if (input.classification === "exited" && input.exitCode === 0) return undefined
  let output: unknown
  try {
    output = JSON.parse(input.stdout.trim())
  } catch {
    throw new TypeError("TASK24_OFFLINE_BINARY_PROCESS_FAILED")
  }
  if (
    input.armID === "A" &&
    unsupportedPreview(input.kind, input.taskID) &&
    input.classification === "exited" &&
    input.exitCode === 1 &&
    input.calls.length === 0 &&
    input.unchanged &&
    canonicalJson(output) ===
      canonicalJson({
        workflow: null,
        response: null,
        artifacts: [],
        error: { code: "preview_configuration_required" },
      })
  )
    return Object.freeze({
      toolCalls: 0,
      workflowCalls: 0,
      workflowRoles: [],
      failureCategory: "preview_configuration_required",
    })
  throw new TypeError("TASK24_OFFLINE_BINARY_PROCESS_FAILED")
}
