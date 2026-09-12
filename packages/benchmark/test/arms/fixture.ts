import path from "node:path"
import type { ArmInput, BinaryAuthority, RunRoots } from "../../src/arms/types"

export function roots(runRoot: string): RunRoots {
  return {
    runRoot,
    repo: path.join(runRoot, "repo"),
    data: path.join(runRoot, "data"),
    config: path.join(runRoot, "config"),
    cache: path.join(runRoot, "cache"),
    temp: path.join(runRoot, "temp"),
    output: path.join(runRoot, "output"),
  }
}

export function binary(runtime: "modified" | "upstream", executable: string): BinaryAuthority {
  return {
    runtime,
    executable,
    version: runtime === "modified" ? "task23-test" : "upstream-test",
    sha256: "a".repeat(64),
  }
}

export function armInput(
  armID: ArmInput["armID"],
  runRoot: string,
  executable: string,
  overrides: Partial<ArmInput> = {},
): ArmInput {
  const runtime = armID === "D" || armID === "E" ? "upstream" : "modified"
  return {
    armID,
    campaignID: "campaign-a",
    runID: `run-${armID.toLowerCase()}`,
    binary: binary(runtime, executable),
    roots: roots(runRoot),
    prompt: "Build the page from assets/reference.png. CANARY_TASK_PROMPT",
    referenceFiles: ["assets/reference.png"],
    brokerOrigin: "http://127.0.0.1:43123",
    brokerGrant: "TASK24_BROKER_GRANT_abcdefghijklmnopqrstuvwxyz",
    grantExpiresAt: Date.now() + 60_000,
    budget: {
      aggregateInputTokens: 10_000,
      aggregateOutputTokens: 5_000,
      maxToolCalls: 20,
      maxRetries: 2,
      maxDurationMs: 60_000,
    },
    ...overrides,
  }
}
