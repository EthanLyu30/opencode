import fs from "node:fs/promises"
import path from "node:path"
import { Task24Root } from "../root"

export type Task24CrashPoint =
  | "during_materialization"
  | "after_reservation"
  | "mid_stream"
  | "after_terminal_usage"
  | "during_workflow_recovery"
  | "during_capture"
  | "during_evaluation_publication"
  | "during_report_write"

/** Test-only process-death hook. It is inert unless all three private controls match. */
export async function task24CrashCheckpoint(point: Task24CrashPoint): Promise<void> {
  if (process.env.TASK24_INTERNAL_CRASH_TEST !== "task24-owned-v1") return
  if (process.env.TASK24_INTERNAL_CRASH_AT !== point) return
  const marker = process.env.TASK24_INTERNAL_CRASH_MARKER
  if (!marker || !path.isAbsolute(marker) || path.normalize(marker) !== marker) {
    throw new TypeError("TASK24_CRASH_MARKER_INVALID")
  }
  const tempRoot = path.resolve(Task24Root.ensure().tmp)
  const resolved = path.resolve(marker)
  const relative = path.relative(tempRoot, resolved)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError("TASK24_CRASH_MARKER_OUTSIDE_TEMP")
  }
  await fs.writeFile(
    resolved,
    `${JSON.stringify({ schemaVersion: 1, point, pid: process.pid })}\n`,
    { encoding: "utf8", flag: "wx" },
  )
  await new Promise<never>(() => undefined)
}
