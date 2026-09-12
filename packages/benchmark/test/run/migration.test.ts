import { describe, expect, test } from "bun:test"
import { RUN_DATABASE_SQL, RUN_DATABASE_SCHEMA_VERSION } from "../../src/run/sql"

describe("Task24 generated run migration", () => {
  test("matches the executable schema exactly", async () => {
    const file = Bun.file(
      new URL(
        `../../migrations/${String(RUN_DATABASE_SCHEMA_VERSION).padStart(4, "0")}_task24_run.sql`,
        import.meta.url,
      ),
    )
    expect(await file.text()).toBe(RUN_DATABASE_SQL.trim() + "\n")
  })
})
