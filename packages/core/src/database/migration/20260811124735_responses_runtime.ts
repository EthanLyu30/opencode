import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811124735_responses_runtime",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`conversation_item\` (
          \`conversation_id\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`response_id\` text,
          \`payload\` text NOT NULL,
          CONSTRAINT \`conversation_item_pk\` PRIMARY KEY(\`conversation_id\`, \`ordinal\`),
          CONSTRAINT \`fk_conversation_item_conversation_id_conversation_id_fk\` FOREIGN KEY (\`conversation_id\`) REFERENCES \`conversation\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`conversation\` (
          \`id\` text PRIMARY KEY,
          \`metadata\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`deleted_at\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`response_item\` (
          \`response_id\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`payload\` text NOT NULL,
          CONSTRAINT \`response_item_pk\` PRIMARY KEY(\`response_id\`, \`ordinal\`),
          CONSTRAINT \`fk_response_item_response_id_response_id_fk\` FOREIGN KEY (\`response_id\`) REFERENCES \`response\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`response\` (
          \`id\` text PRIMARY KEY,
          \`workflow_id\` text NOT NULL,
          \`model\` text NOT NULL,
          \`status\` text NOT NULL,
          \`background\` integer NOT NULL,
          \`store\` integer NOT NULL,
          \`previous_response_id\` text,
          \`conversation_id\` text,
          \`request_hash\` text NOT NULL,
          \`output\` text NOT NULL,
          \`error\` text,
          \`usage\` text,
          \`created_at\` integer NOT NULL,
          \`completed_at\` integer,
          \`deleted_at\` integer,
          CONSTRAINT \`fk_response_workflow_id_workflow_run_id_fk\` FOREIGN KEY (\`workflow_id\`) REFERENCES \`workflow_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`conversation_item_response_idx\` ON \`conversation_item\` (\`response_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`response_item_response_kind_ordinal_idx\` ON \`response_item\` (\`response_id\`,\`kind\`,\`ordinal\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`response_request_hash_idx\` ON \`response\` (\`request_hash\`);`)
      yield* tx.run(`CREATE INDEX \`response_workflow_idx\` ON \`response\` (\`workflow_id\`);`)
      yield* tx.run(`CREATE INDEX \`response_previous_idx\` ON \`response\` (\`previous_response_id\`);`)
      yield* tx.run(`CREATE INDEX \`response_conversation_idx\` ON \`response\` (\`conversation_id\`);`)
      yield* tx.run(`CREATE INDEX \`response_status_created_idx\` ON \`response\` (\`status\`,\`created_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
