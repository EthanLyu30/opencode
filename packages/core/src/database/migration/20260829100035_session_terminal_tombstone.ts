import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { DatabaseMigration } from "../migration"

interface Candidate {
  readonly id: string
  readonly aggregate_id: string
  readonly type: "session.deleted" | "session.deleted.1" | "session.deleted.2"
  readonly data: string
  readonly creation_type: string | null
  readonly creation_data: string | null
}

const decodeV1 = Schema.decodeUnknownOption(SessionV1.Event.DeletedV1.data)
const decodeV2 = Schema.decodeUnknownOption(SessionV1.Event.DeletedV2.data)
const decodeCreation = Schema.decodeUnknownOption(SessionV1.Event.Created.data)
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export default {
  id: "20260829100035_session_terminal_tombstone",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_tombstone\` (
          \`session_id\` text PRIMARY KEY,
          \`visibility\` text NOT NULL,
          \`deletion_event_id\` text NOT NULL,
          \`deletion_version\` integer NOT NULL,
          \`time_deleted\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_tombstone_deletion_event_idx\` ON \`session_tombstone\` (\`deletion_event_id\`);`,
      )

      const candidates = yield* tx.all<Candidate>(`
        SELECT
          deletion.\`id\`,
          deletion.\`aggregate_id\`,
          deletion.\`type\`,
          deletion.\`data\`,
          (
            SELECT created.\`type\`
            FROM \`event\` AS created
            WHERE created.\`aggregate_id\` = deletion.\`aggregate_id\`
              AND (created.\`type\` = 'session.created' OR created.\`type\` GLOB 'session.created.*')
          ) AS creation_type,
          (
            SELECT created.\`data\`
            FROM \`event\` AS created
            WHERE created.\`aggregate_id\` = deletion.\`aggregate_id\`
              AND (created.\`type\` = 'session.created' OR created.\`type\` GLOB 'session.created.*')
          ) AS creation_data
        FROM \`event\` AS deletion
        INNER JOIN \`event_sequence\` AS sequence
          ON sequence.\`aggregate_id\` = deletion.\`aggregate_id\`
          AND sequence.\`seq\` = deletion.\`seq\`
        WHERE deletion.\`type\` IN ('session.deleted', 'session.deleted.1', 'session.deleted.2')
          AND substr(deletion.\`id\`, 1, 4) = 'evt_'
          AND substr(deletion.\`aggregate_id\`, 1, 4) = 'ses_'
          AND deletion.\`seq\` >= 0
          AND NOT EXISTS (
            SELECT 1
            FROM \`session\` AS live
            WHERE live.\`id\` = deletion.\`aggregate_id\`
          )
          AND NOT EXISTS (
            SELECT 1
            FROM \`event\` AS later
            WHERE later.\`aggregate_id\` = deletion.\`aggregate_id\`
              AND later.\`seq\` > deletion.\`seq\`
          )
          AND 1 = (
            SELECT count(*)
            FROM \`event\` AS duplicate
            WHERE duplicate.\`aggregate_id\` = deletion.\`aggregate_id\`
              AND (
                duplicate.\`type\` = 'session.deleted'
                OR duplicate.\`type\` GLOB 'session.deleted.*'
              )
          )
          AND 1 = (
            SELECT count(*)
            FROM \`event\` AS position
            WHERE position.\`aggregate_id\` = deletion.\`aggregate_id\`
              AND position.\`seq\` = deletion.\`seq\`
          )
          AND 1 >= (
            SELECT count(*)
            FROM \`event\` AS created
            WHERE created.\`aggregate_id\` = deletion.\`aggregate_id\`
              AND (created.\`type\` = 'session.created' OR created.\`type\` GLOB 'session.created.*')
          )
          AND (
            (
              deletion.\`batch_id\` IS NULL
              AND deletion.\`batch_index\` IS NULL
              AND deletion.\`batch_size\` IS NULL
            )
            OR (
              deletion.\`batch_id\` IS NOT NULL
              AND substr(deletion.\`batch_id\`, 1, 4) = 'evt_'
              AND deletion.\`batch_index\` BETWEEN 0 AND deletion.\`batch_size\` - 1
              AND deletion.\`batch_size\` > 0
              AND deletion.\`batch_size\` = (
                SELECT count(*)
                FROM \`event\` AS member
                WHERE member.\`batch_id\` = deletion.\`batch_id\`
              )
              AND deletion.\`batch_size\` = (
                SELECT count(DISTINCT member.\`batch_index\`)
                FROM \`event\` AS member
                WHERE member.\`batch_id\` = deletion.\`batch_id\`
              )
              AND 0 = (
                SELECT min(member.\`batch_index\`)
                FROM \`event\` AS member
                WHERE member.\`batch_id\` = deletion.\`batch_id\`
              )
              AND deletion.\`batch_size\` - 1 = (
                SELECT max(member.\`batch_index\`)
                FROM \`event\` AS member
                WHERE member.\`batch_id\` = deletion.\`batch_id\`
              )
              AND NOT EXISTS (
                SELECT 1
                FROM \`event\` AS member
                WHERE member.\`batch_id\` = deletion.\`batch_id\`
                  AND (
                    member.\`batch_index\` IS NULL
                    OR member.\`batch_size\` != deletion.\`batch_size\`
                  )
              )
            )
          )
        ORDER BY deletion.\`id\`;
      `)

      yield* Effect.forEach(
        candidates,
        (candidate) =>
          Effect.gen(function* () {
            const parsed = decodeJson(candidate.data)
            if (Option.isNone(parsed)) return
            const decoded = candidate.type === "session.deleted.2" ? decodeV2(parsed.value) : decodeV1(parsed.value)
            if (Option.isNone(decoded)) return
            const data = decoded.value
            if (data.sessionID !== candidate.aggregate_id || data.info.id !== data.sessionID) return
            if ((candidate.creation_type === null) !== (candidate.creation_data === null)) return
            if (candidate.creation_type !== null && candidate.creation_data !== null) {
              if (candidate.creation_type !== "session.created" && candidate.creation_type !== "session.created.1")
                return
              const parsedCreation = decodeJson(candidate.creation_data)
              if (Option.isNone(parsedCreation)) return
              const creation = decodeCreation(parsedCreation.value)
              if (Option.isNone(creation)) return
              if (
                creation.value.sessionID !== data.sessionID ||
                creation.value.info.id !== data.sessionID ||
                (creation.value.visibility ?? "public") !== (data.visibility ?? "public")
              )
                return
            }

            yield* tx.run(sql`
              INSERT INTO \`session_tombstone\` (
                \`session_id\`,
                \`visibility\`,
                \`deletion_event_id\`,
                \`deletion_version\`,
                \`time_deleted\`
              ) VALUES (
                ${data.sessionID},
                ${data.visibility ?? "public"},
                ${candidate.id},
                ${candidate.type === "session.deleted.2" ? 2 : 1},
                ${data.info.time.updated}
              )
            `)
          }),
        { concurrency: 1, discard: true },
      )
    })
  },
} satisfies DatabaseMigration.Migration
