import type { ArmRoute } from "../arms/types"
import { canonicalJson } from "../campaign/canonical"

export function expectedOfflineCalls(armID: string, kind: string) {
  return armID === "A" ? (kind === "guardrail" ? 0 : 8) : 2
}

export function classifyOfflineRejection(input: {
  readonly armID: string
  readonly kind: string
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
    input.kind === "guardrail" &&
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
