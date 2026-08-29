import type { Database } from "@opencode-ai/core/database/database"
import { EventTable } from "@opencode-ai/core/event/sql"
import { PublicEventVisibility } from "@opencode-ai/core/event/public-visibility"
import { and, asc, eq, lte, not, or } from "drizzle-orm"
import { Effect } from "effect"

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
  const complete = yield* db.select().from(EventTable).orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie)
  return yield* PublicEventVisibility.filterHistory(candidates, complete, PublicEventVisibility.databaseAuthority(db))
})
