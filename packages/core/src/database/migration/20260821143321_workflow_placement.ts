import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260821143321_workflow_placement",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_run\` ADD \`directory\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_run\` ADD \`workspace_id\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_run\` ADD \`session_id\` text;`)
      yield* tx.run(`ALTER TABLE \`workflow_run\` ADD \`agent\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
