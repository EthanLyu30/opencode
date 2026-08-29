import type { Database } from "@opencode-ai/core/database/database"
import { EventTable } from "@opencode-ai/core/event/sql"
import { PublicEventVisibility } from "@opencode-ai/core/event/public-visibility"
import { and, asc, eq, inArray, lte, not, or } from "drizzle-orm"
import { Effect } from "effect"

const batchChunkSize = 250

function chunks<A>(items: ReadonlyArray<A>, size: number) {
  const output: A[][] = []
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size))
  return output
}

export const publicHistory = Effect.fn("SyncHttpApi.publicHistory")(function* (
  db: Database.Interface["db"],
  fence: Readonly<Record<string, number>>,
) {
  const exclude = Object.entries(fence)
  const candidates = yield* db
    .select()
    .from(EventTable)
    .where(
      exclude.length > 0
        ? not(or(...exclude.map(([id, seq]) => and(eq(EventTable.aggregate_id, id), lte(EventTable.seq, seq))))!)
        : undefined,
    )
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  if (candidates.length === 0) return []

  const batchIDs = [...new Set(candidates.flatMap((row) => (row.batch_id === null ? [] : [row.batch_id])))]
  const complete = (yield* Effect.forEach(
    chunks(batchIDs, batchChunkSize),
    (ids) =>
      db
        .select()
        .from(EventTable)
        .where(inArray(EventTable.batch_id, ids))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    { concurrency: 1 },
  )).flat()
  return yield* PublicEventVisibility.filterHistory(candidates, complete, PublicEventVisibility.databaseAuthority(db))
})
