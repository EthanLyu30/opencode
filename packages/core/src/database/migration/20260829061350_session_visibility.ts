import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260829061350_session_visibility",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`visibility\` text DEFAULT 'public' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
