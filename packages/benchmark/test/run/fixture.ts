import fs from "node:fs/promises"
import path from "node:path"
import { Task24Root } from "../../src/root"
import { RunStore } from "../../src/run/store"

export async function storeFixture(label: string) {
  const directory = path.join(Task24Root.ensure().tmp, `run-${label}-${crypto.randomUUID()}`)
  await fs.mkdir(directory)
  const database = path.join(directory, "scheduler.sqlite")
  return {
    directory,
    database,
    store: RunStore.open(database),
    async dispose() {
      Bun.gc(true)
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rm(directory, { recursive: true, force: true })
          return
        } catch (cause) {
          if (attempt >= 9 || !isBusy(cause)) throw cause
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
    },
  }
}

function isBusy(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EBUSY"
}

export const plannedRuns = [
  { runID: "run-a", taskID: "task-a", armID: "A", repetition: 0, orderIndex: 0 },
  { runID: "run-b", taskID: "task-a", armID: "B", repetition: 0, orderIndex: 1 },
] as const
