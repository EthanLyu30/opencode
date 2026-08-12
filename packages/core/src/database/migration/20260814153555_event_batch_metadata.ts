import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260814153555_event_batch_metadata",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`event\` ADD \`batch_id\` text;`)
      yield* tx.run(`ALTER TABLE \`event\` ADD \`batch_index\` integer;`)
      yield* tx.run(`ALTER TABLE \`event\` ADD \`batch_size\` integer;`)
      yield* tx.run(`CREATE INDEX \`event_batch_idx\` ON \`event\` (\`batch_id\`,\`batch_index\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
