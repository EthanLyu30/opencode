import type { ReportModel } from "./model"

const columns = [
  "run_id",
  "task_id",
  "family",
  "arm_id",
  "qualified_success",
  "functional_success",
  "first_pass_functional_success",
  "first_pass_visual_success",
  "diagnostic_score",
  "visual_composite",
  "duration_ms",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "tool_calls",
  "retries",
  "revision_loops",
  "changed_files",
  "recovery_count",
  "cost_cny_micros",
  "failure_category",
] as const

export function reportCsv(value: ReportModel): string {
  const rows = value.runs.map((run) => [
    run.runID,
    run.taskID,
    run.family,
    run.armID,
    run.qualifiedSuccess,
    run.functionalSuccess,
    run.firstPassFunctionalSuccess,
    run.firstPassVisualSuccess,
    run.diagnosticScore,
    run.visualComposite,
    run.durationMs,
    run.inputTokens,
    run.cachedInputTokens,
    run.outputTokens,
    run.toolCalls,
    run.retries,
    run.revisionLoops,
    run.changedFiles,
    run.recoveryCount,
    run.costCnyMicros,
    run.failureCategory ?? "",
  ])
  return [columns, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
}

function cell(value: string | number | boolean): string {
  let text = String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
