import fs from "node:fs/promises"
import path from "node:path"
import { Task24Root } from "../../src/root"
import { RunStore } from "../../src/run/store"
import { removeClosedStoreFixture } from "./fixture-cleanup"

export async function storeFixture(label: string) {
  const directory = path.join(Task24Root.ensure().tmp, `run-${label}-${crypto.randomUUID()}`)
  await fs.mkdir(directory)
  const database = path.join(directory, "scheduler.sqlite")
  return {
    directory,
    database,
    store: RunStore.open(database),
    async dispose() {
      await removeClosedStoreFixture(directory)
    },
  }
}

export const plannedRuns = [
  { runID: "run-a", taskID: "task-a", armID: "A", repetition: 0, orderIndex: 0 },
  { runID: "run-b", taskID: "task-a", armID: "B", repetition: 0, orderIndex: 1 },
] as const
