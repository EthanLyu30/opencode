import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260730135739_workflow_stage_a",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workflow_artifact\` (
          \`id\` text PRIMARY KEY,
          \`workflow_id\` text NOT NULL,
          \`stage_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`uri\` text NOT NULL,
          \`mime\` text NOT NULL,
          \`sha256\` text NOT NULL,
          \`size\` integer NOT NULL,
          \`metadata\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_workflow_artifact_workflow_id_workflow_run_id_fk\` FOREIGN KEY (\`workflow_id\`) REFERENCES \`workflow_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_workflow_artifact_stage_id_workflow_stage_id_fk\` FOREIGN KEY (\`stage_id\`) REFERENCES \`workflow_stage\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workflow_run\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`status\` text NOT NULL,
          \`current_stage_id\` text,
          \`input\` text NOT NULL,
          \`budget\` text NOT NULL,
          \`usage\` text NOT NULL,
          \`budget_notified\` integer DEFAULT 0 NOT NULL,
          \`cancel_requested_at\` integer,
          \`time_completed\` integer,
          \`version\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workflow_stage\` (
          \`id\` text PRIMARY KEY,
          \`workflow_id\` text NOT NULL,
          \`stage_type\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`attempt\` integer DEFAULT 0 NOT NULL,
          \`max_attempts\` integer NOT NULL,
          \`not_before\` integer,
          \`lease_owner\` text,
          \`lease_expires_at\` integer,
          \`session_id\` text,
          \`checkpoint\` text,
          \`recovery_policy\` text NOT NULL,
          \`recovery_action\` text,
          \`idempotency_key\` text NOT NULL,
          \`input\` text NOT NULL,
          \`error\` text,
          \`time_started\` integer,
          \`time_completed\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_workflow_stage_workflow_id_workflow_run_id_fk\` FOREIGN KEY (\`workflow_id\`) REFERENCES \`workflow_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`workflow_artifact_stage_kind_sha_idx\` ON \`workflow_artifact\` (\`stage_id\`,\`kind\`,\`sha256\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_artifact_workflow_created_idx\` ON \`workflow_artifact\` (\`workflow_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_run_status_updated_idx\` ON \`workflow_run\` (\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`workflow_stage_workflow_ordinal_idx\` ON \`workflow_stage\` (\`workflow_id\`,\`ordinal\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`workflow_stage_workflow_idempotency_idx\` ON \`workflow_stage\` (\`workflow_id\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_stage_claim_idx\` ON \`workflow_stage\` (\`status\`,\`not_before\`,\`lease_expires_at\`,\`ordinal\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_stage_workflow_status_idx\` ON \`workflow_stage\` (\`workflow_id\`,\`status\`,\`ordinal\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
