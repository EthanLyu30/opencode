import { describe, expect, spyOn } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import { Database } from "@opencode-ai/core/database/database"
import { CredentialTable } from "@opencode-ai/core/credential/sql"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Credential.node, Database.node])))

describe("Credential", () => {
  it.effect("advances credential metadata on same-millisecond updates and a backwards clock", () =>
    Effect.gen(function* () {
      // The shared SQL timestamp hook reads Date.now directly; keep the wall-clock double scoped.
      const clock = yield* Effect.acquireRelease(
        Effect.sync(() => spyOn(Date, "now").mockReturnValue(1_700_000_000_000)),
        (clock) => Effect.sync(() => clock.mockRestore()),
      )
      const credentials = yield* Credential.Service
      const database = yield* Database.Service
      const created = yield* credentials.create({
        integrationID: Integration.ID.make("kimi"),
        value: Credential.Key.make({ type: "key", key: "offline-credential-first" }),
      })
      const metadata = () =>
        database.db
          .select({ updatedAt: CredentialTable.time_updated })
          .from(CredentialTable)
          .where(eq(CredentialTable.id, created.id))
          .get()
          .pipe(Effect.orDie)
      expect((yield* metadata())?.updatedAt).toBe(1_700_000_000_000)
      yield* credentials.update(created.id, {
        value: Credential.Key.make({ type: "key", key: "offline-credential-second" }),
      })
      expect((yield* metadata())?.updatedAt).toBe(1_700_000_000_001)
      yield* credentials.update(created.id, { label: "same millisecond" })
      expect((yield* metadata())?.updatedAt).toBe(1_700_000_000_002)
      clock.mockReturnValue(1_699_999_000_000)
      yield* credentials.update(created.id, { label: "backwards clock" })
      expect((yield* metadata())?.updatedAt).toBe(1_700_000_000_003)
    }),
  )
  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      const replacement = yield* credentials.create({
        integrationID,
        label: "Replacement",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )
})
