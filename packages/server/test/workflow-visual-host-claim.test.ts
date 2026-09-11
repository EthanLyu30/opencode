import { describe, expect, test } from "bun:test"
import { WorkflowSchema } from "@opencode-ai/core/workflow"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { VisualHostClaim } from "../src/workflow/visual-host-claim"

const acceptanceRoot = "D:\\OpenCode-Local\\tmp\\workflow-host\\acceptance"
const workflowID = WorkflowSchema.ID.make("wfl_visual_claim_registry")
const stageID = WorkflowSchema.StageID.make("wfs_visual_claim_registry")

describe("VisualHostClaim generation registry", () => {
  test("publishes only a fully initialized registry authority", async () => {
    await using root = await caseRoot("claim-registry-atomic-publish")
    let observedObjects: unknown

    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0), {
      afterRegistryCreated: async (file) => {
        const database = new Database(`\\\\?\\${file}`, { create: false, readonly: true, strict: true })
        try {
          observedObjects = database
            .query("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
            .all()
        } finally {
          database.close()
        }
      },
    })

    expect(acquired.status).toBe("acquired")
    expect(observedObjects).toEqual([{ type: "table", name: "visual_host_claim" }])
  })

  test("preserves an unauthenticated staging file while publishing an independent initialized registry", async () => {
    await using root = await caseRoot("claim-registry-pending-recovery")
    const staging = path.join(root.path, `.claims.${"a".repeat(32)}.pending`)
    await fs.mkdir(staging)
    const pending = path.join(staging, "claims.sqlite")
    await fs.writeFile(pending, "", { flag: "wx" })

    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))

    expect(acquired.status).toBe("acquired")
    expect(await fs.exists(pending)).toBe(true)
    expect((await fs.stat(path.join(root.path, ".claims", "claims.sqlite"))).size).toBeGreaterThan(0)
  })

  test("arbitrates concurrent first registry creation instead of rejecting the loser", async () => {
    await using root = await caseRoot("claim-registry-first-race")

    const results = await Promise.all([
      VisualHostClaim.acquire(root.path, body("reference", 0)),
      VisualHostClaim.acquire(root.path, body("reference", 0)),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(["acquired", "contended"])
    expect(new Set(results.map((result) => result.claim.body.generation)).size).toBe(1)
  })

  test("publishes a fully readable registry before the creation owner resumes", async () => {
    await using root = await caseRoot("claim-registry-publish-interleave")
    let markPublished!: () => void
    const published = new Promise<void>((resolve) => {
      markPublished = resolve
    })
    let continueOwner!: () => void
    const holdOwner = new Promise<void>((resolve) => {
      continueOwner = resolve
    })
    const owner = VisualHostClaim.acquire(root.path, body("reference", 0), {
      afterRegistryPublished: async () => {
        markPublished()
        await holdOwner
      },
    })
    await published

    expect(await VisualHostClaim.list(root.path)).toEqual([])
    expect((await fs.lstat(path.join(root.path, ".claims", "claims.sqlite"))).nlink).toBe(1)

    continueOwner()
    expect((await owner).status).toBe("acquired")
  })

  test("keeps a cleanup lock private until its initialized PERSIST pair can be published atomically", async () => {
    await using root = await caseRoot("claim-cleanup-atomic-publish")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    let markInitialized!: (file: string) => void
    const initialized = new Promise<string>((resolve) => {
      markInitialized = resolve
    })
    let continueOwner!: () => void
    const holdOwner = new Promise<void>((resolve) => {
      continueOwner = resolve
    })
    const owner = VisualHostClaim.finishRelease(root.path, releasing, async () => undefined, {
      afterCleanupLockPendingInitialized: async (file) => {
        markInitialized(file)
        await holdOwner
      },
    })
    const pendingFile = await initialized
    const cleanupRoot = path.join(root.path, ".claims", ".cleanup")
    const published = path.join(cleanupRoot, `${releasing.key}.${releasing.body.generation}.lock`)

    expect(await fs.exists(published)).toBe(false)
    expect(path.dirname(path.dirname(pendingFile))).toBe(cleanupRoot)
    expect((await fs.stat(pendingFile)).size).toBeGreaterThan(0)
    expect(await fs.exists(`${pendingFile}-journal`)).toBe(true)

    continueOwner()
    await owner
    expect(await fs.exists(cleanupRoot)).toBe(false)
  })

  test("keeps the published cleanup PERSIST database and journal identities fixed across its operational open", async () => {
    await using root = await caseRoot("claim-cleanup-persist-identity")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    let file = ""
    let before:
      | {
          readonly database: { readonly dev: number; readonly ino: number; readonly birthtimeMs: number }
          readonly journal: { readonly dev: number; readonly ino: number; readonly birthtimeMs: number }
        }
      | undefined

    expect(
      await VisualHostClaim.finishRelease(root.path, releasing, async () => false, {
        afterCleanupLockCreated: async (created) => {
          file = created
          before = {
            database: identity(await fs.lstat(created)),
            journal: identity(await fs.lstat(`${created}-journal`)),
          }
        },
        afterLockOpened: async () => {
          if (before === undefined) throw new TypeError("cleanup authority was not observed")
          expect(identity(await fs.lstat(file))).toEqual(before.database)
          expect(identity(await fs.lstat(`${file}-journal`))).toEqual(before.journal)
        },
      }),
    ).toBe(false)
    if (before === undefined) throw new TypeError("cleanup creation hook did not run")
    expect(identity(await fs.lstat(file))).toEqual(before.database)
    expect(identity(await fs.lstat(`${file}-journal`))).toEqual(before.journal)
  })

  test("recreates an empty cleanup parent removed before its first child is published", async () => {
    await using root = await caseRoot("claim-cleanup-parent-gap")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    let markReady!: (directory: string) => void
    const ready = new Promise<string>((resolve) => {
      markReady = resolve
    })
    let continueOwner!: () => void
    const holdOwner = new Promise<void>((resolve) => {
      continueOwner = resolve
    })
    const owner = VisualHostClaim.finishRelease(root.path, releasing, async () => undefined, {
      afterCleanupRootReady: async (directory) => {
        markReady(directory)
        await holdOwner
      },
    })
    const cleanup = await ready
    await fs.rmdir(cleanup)
    continueOwner()

    expect(await owner).toBe(true)
    expect(await VisualHostClaim.list(root.path)).toEqual([])
    expect(await fs.exists(cleanup)).toBe(false)
  })

  test("serializes one active generation per exact purpose and keeps implementation revisions independent", async () => {
    await using root = await caseRoot("claim-purpose")
    const reference = await VisualHostClaim.acquire(root.path, body("reference", 0))
    const contender = await VisualHostClaim.acquire(root.path, body("reference", 0))
    const implementation0 = await VisualHostClaim.acquire(root.path, body("implementation", 0))
    const implementation1 = await VisualHostClaim.acquire(root.path, body("implementation", 1))

    expect(reference.status).toBe("acquired")
    expect(contender).toMatchObject({ status: "contended", claim: { state: "active" } })
    expect(contender.claim.body.generation).toBe(reference.claim.body.generation)
    expect(implementation0.status).toBe("acquired")
    expect(implementation1.status).toBe("acquired")
    expect(new Set([reference.claim.key, implementation0.claim.key, implementation1.claim.key]).size).toBe(3)
    expect((await fs.lstat(reference.claim.file)).nlink).toBe(1)
    expect((await VisualHostClaim.list(root.path)).map((claim) => claim.state)).toEqual(["active", "active", "active"])

    for (const claim of [reference.claim, implementation0.claim, implementation1.claim]) {
      const releasing = await VisualHostClaim.beginRelease(root.path, claim)
      await VisualHostClaim.finishRelease(root.path, releasing, async () => undefined)
    }
    expect(await VisualHostClaim.list(root.path)).toEqual([])
    expect(await fs.exists(path.join(root.path, ".claims", ".cleanup"))).toBe(false)
  })

  test("an old releasing generation cannot unlink or clean a replacement after a forced CAS interleaving", async () => {
    await using root = await caseRoot("claim-cas")
    const old = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (old.status !== "acquired") throw new TypeError("old generation did not acquire")
    const oldReleasing = await VisualHostClaim.beginRelease(root.path, old.claim)
    const staleCleaner = (await VisualHostClaim.list(root.path))[0]
    if (staleCleaner === undefined) throw new TypeError("stale cleaner did not observe releasing generation")
    const operations: string[] = []

    await VisualHostClaim.finishRelease(root.path, oldReleasing, async () => {
      operations.push("old-cleanup")
    })
    const replacement = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (replacement.status !== "acquired") throw new TypeError("replacement did not acquire")
    await expect(
      VisualHostClaim.finishRelease(root.path, staleCleaner, async () => {
        operations.push("stale-cleanup")
      }),
    ).rejects.toThrow("generation")

    expect(operations).toEqual(["old-cleanup"])
    expect(await VisualHostClaim.assertActive(root.path, replacement.claim)).toMatchObject({
      body: { generation: replacement.claim.body.generation },
      state: "active",
    })
    expect(await fs.readFile(replacement.claim.file, "utf8")).toBe(JSON.stringify(replacement.claim.body))
    const releasing = await VisualHostClaim.beginRelease(root.path, replacement.claim)
    await VisualHostClaim.finishRelease(root.path, releasing, async () => undefined)
  })

  test("keeps the exact releasing mirror and row when the final authority gate closes", async () => {
    await using root = await caseRoot("claim-final-gate")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    let gate = true
    let cleanupCalls = 0
    let deleteSeams = 0

    expect(
      await VisualHostClaim.finishRelease(
        root.path,
        releasing,
        async () => {
          cleanupCalls++
        },
        {
          beforeAuthorityDelete: async () => {
            deleteSeams++
            gate = false
          },
          finalGate: async () => gate,
        },
      ),
    ).toBe(false)
    expect({ cleanupCalls, deleteSeams }).toEqual({ cleanupCalls: 1, deleteSeams: 1 })
    expect(await fs.readFile(releasing.file, "utf8")).toBe(JSON.stringify(releasing.body))
    expect(await VisualHostClaim.list(root.path)).toMatchObject([
      { state: "releasing", body: { generation: releasing.body.generation } },
    ])

    await VisualHostClaim.finishRelease(root.path, releasing, async () => {
      cleanupCalls++
    })
    expect(cleanupCalls).toBe(2)
    expect(await VisualHostClaim.list(root.path)).toEqual([])
  })

  test("keeps an active generation active when its release transition gate closes", async () => {
    await using root = await caseRoot("claim-active-release-gate")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")

    expect(await VisualHostClaim.beginRelease(root.path, acquired.claim, async () => false)).toBeUndefined()

    expect(await VisualHostClaim.list(root.path)).toMatchObject([
      { state: "active", body: { generation: acquired.claim.body.generation } },
    ])
    expect(await fs.readFile(acquired.claim.file, "utf8")).toBe(JSON.stringify(acquired.claim.body))
  })

  test("never transitions a pending generation directly into releasing", async () => {
    await using root = await caseRoot("claim-pending-release-transition")
    const requested = body("reference", 0)
    await expect(
      VisualHostClaim.acquire(root.path, requested, {
        afterMirrorLinked: async () => {
          throw new Error("simulated crash after mirror link")
        },
      }),
    ).rejects.toThrow("simulated crash")
    const [pending] = await VisualHostClaim.list(root.path)
    if (pending === undefined) throw new TypeError("pending claim is missing")
    const mirror = await fs.readFile(pending.file, "utf8")

    await expect(VisualHostClaim.beginRelease(root.path, pending)).rejects.toThrow("pending")

    expect(await fs.readFile(pending.file, "utf8")).toBe(mirror)
    expect(await VisualHostClaim.list(root.path)).toMatchObject([
      { state: "pending", body: { generation: pending.body.generation } },
    ])
    expect(await fs.exists(path.join(root.path, ".claims", ".cleanup"))).toBe(false)
  })

  test("preserves a pending generation when its final recovery gate closes before rollback", async () => {
    await using root = await caseRoot("claim-pending-rollback-gate")
    await expect(
      VisualHostClaim.acquire(root.path, body("reference", 0), {
        afterMirrorLinked: async () => {
          throw new Error("simulated pending owner crash")
        },
      }),
    ).rejects.toThrow("simulated pending owner crash")
    const [pending] = await VisualHostClaim.list(root.path)
    if (pending === undefined) throw new TypeError("pending claim is missing")
    const mirror = await fs.readFile(pending.file, "utf8")
    let live = false

    expect(
      await VisualHostClaim.rollbackPending(
        root.path,
        pending,
        async () => {
          live = true
        },
        async () => !live,
      ),
    ).toBe(false)

    expect(await fs.readFile(pending.file, "utf8")).toBe(mirror)
    expect(await VisualHostClaim.list(root.path)).toMatchObject([
      { state: "pending", body: { generation: pending.body.generation } },
    ])
  })

  test("rejects a pending authority beside a releasing generation before cleanup", async () => {
    await using root = await caseRoot("claim-releasing-pending-hostile")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    const pending = path.join(
      root.path,
      ".claims",
      `${releasing.key}.${releasing.body.hostID}.${releasing.body.nonce}.${"f".repeat(32)}.pending`,
    )
    const encoded = JSON.stringify(releasing.body)
    await fs.writeFile(pending, encoded, { flag: "wx" })
    let cleanupCalls = 0

    await expect(
      VisualHostClaim.finishRelease(root.path, releasing, async () => {
        cleanupCalls++
      }),
    ).rejects.toThrow("pending")

    expect(cleanupCalls).toBe(0)
    expect(await fs.readFile(pending, "utf8")).toBe(encoded)
    expect(await fs.readFile(releasing.file, "utf8")).toBe(encoded)
    await expect(VisualHostClaim.list(root.path)).rejects.toThrow("pending")
  })

  test.each(["unrelated", "mirror", "pending"] as const)(
    "rejects an unrelated %s entry before assertActive or a new claim side effect",
    async (variant) => {
      await using root = await caseRoot(`claim-global-${variant}`)
      const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
      if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
      const claims = path.join(root.path, ".claims")
      const hostile =
        variant === "unrelated"
          ? path.join(claims, "unrelated")
          : variant === "mirror"
            ? path.join(claims, `${"a".repeat(64)}.json`)
            : path.join(claims, `${"a".repeat(64)}.${"b".repeat(64)}.${"c".repeat(64)}.${"d".repeat(32)}.pending`)
      await fs.writeFile(hostile, "foreign", { flag: "wx" })
      const before = (await fs.readdir(claims)).sort()

      await expect(VisualHostClaim.assertActive(root.path, acquired.claim)).rejects.toThrow()
      await expect(VisualHostClaim.acquire(root.path, body("implementation", 0))).rejects.toThrow()

      expect((await fs.readdir(claims)).sort()).toEqual(before)
      expect(await fs.readFile(hostile, "utf8")).toBe("foreign")
      expect(await fs.readFile(acquired.claim.file, "utf8")).toBe(JSON.stringify(acquired.claim.body))
    },
  )

  test("rejects a malformed cleanup database before assertActive or a new claim side effect", async () => {
    await using root = await caseRoot("claim-global-cleanup")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const cleanup = path.join(root.path, ".claims", ".cleanup")
    await fs.mkdir(cleanup)
    const base = path.join(cleanup, `${"a".repeat(64)}.${"b".repeat(64)}.sqlite`)
    await fs.writeFile(base, "foreign-database", { flag: "wx" })
    await fs.writeFile(`${base}-journal`, "foreign-journal", { flag: "wx" })
    const before = (await fs.readdir(path.join(root.path, ".claims"))).sort()

    await expect(VisualHostClaim.assertActive(root.path, acquired.claim)).rejects.toThrow()
    await expect(VisualHostClaim.acquire(root.path, body("implementation", 0))).rejects.toThrow()

    expect((await fs.readdir(path.join(root.path, ".claims"))).sort()).toEqual(before)
    expect(await fs.readFile(base, "utf8")).toBe("foreign-database")
    expect(await fs.readFile(`${base}-journal`, "utf8")).toBe("foreign-journal")
    expect(await fs.readFile(acquired.claim.file, "utf8")).toBe(JSON.stringify(acquired.claim.body))
  })

  test("a contender waits without blocking the owner that is linking and promoting its mirror", async () => {
    await using root = await caseRoot("claim-pending-race")
    let markLinked!: () => void
    const linked = new Promise<void>((resolve) => {
      markLinked = resolve
    })
    let continueOwner!: () => void
    const holdOwner = new Promise<void>((resolve) => {
      continueOwner = resolve
    })
    const owner = VisualHostClaim.acquire(root.path, body("reference", 0), {
      afterMirrorLinked: async () => {
        markLinked()
        await holdOwner
      },
    })
    await linked

    let contenderSettled = false
    const contenderPromise = VisualHostClaim.acquire(root.path, body("reference", 0)).then((result) => {
      contenderSettled = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(contenderSettled).toBe(false)
    continueOwner()
    const [admitted, contender] = await Promise.all([owner, contenderPromise])
    expect(admitted).toMatchObject({ status: "acquired", claim: { state: "active" } })
    expect(contender).toMatchObject({ status: "contended", claim: { state: "active" } })
    if (admitted.status !== "acquired") throw new TypeError("pending generation did not promote")
    expect((await VisualHostClaim.list(root.path)).map((claim) => claim.state)).toEqual(["active"])
    expect((await fs.lstat(admitted.claim.file)).nlink).toBe(1)

    const releasing = await VisualHostClaim.beginRelease(root.path, admitted.claim)
    await VisualHostClaim.finishRelease(root.path, releasing, async () => undefined)
  })

  test("a slow cleanup lock for one purpose does not block a different claim key", async () => {
    await using root = await caseRoot("claim-independent-cleanup")
    const first = await VisualHostClaim.acquire(root.path, body("reference", 0))
    const second = await VisualHostClaim.acquire(root.path, body("implementation", 0))
    if (first.status !== "acquired" || second.status !== "acquired") throw new TypeError("claims did not acquire")
    const firstReleasing = await VisualHostClaim.beginRelease(root.path, first.claim)
    const secondReleasing = await VisualHostClaim.beginRelease(root.path, second.claim)
    let markFirstEntered!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve
    })
    let releaseFirst!: () => void
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const slow = VisualHostClaim.finishRelease(root.path, firstReleasing, async () => {
      markFirstEntered()
      await holdFirst
    })
    await firstEntered
    let markSecondEntered!: () => void
    const secondEntered = new Promise<void>((resolve) => {
      markSecondEntered = resolve
    })
    const independent = VisualHostClaim.finishRelease(root.path, secondReleasing, async () => {
      markSecondEntered()
    })

    await secondEntered
    await independent
    releaseFirst()
    await slow
    expect(await VisualHostClaim.list(root.path)).toEqual([])
  })

  test("serializes same-key finishers before any synchronous SQLite transaction", async () => {
    await using root = await caseRoot("claim-same-key-cleanup")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    const cleanupOwners: string[] = []

    const results = await Promise.allSettled([
      VisualHostClaim.finishRelease(root.path, releasing, async () => {
        cleanupOwners.push("first")
      }),
      VisualHostClaim.finishRelease(root.path, releasing, async () => {
        cleanupOwners.push("second")
      }),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(cleanupOwners).toHaveLength(1)
    expect(await VisualHostClaim.list(root.path)).toEqual([])
  })

  test("does not retire a cleanup lock beneath an already-open waiter", async () => {
    await using root = await caseRoot("claim-cleanup-waiter")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    let markOwnerCleanup!: () => void
    const ownerCleanup = new Promise<void>((resolve) => {
      markOwnerCleanup = resolve
    })
    let continueOwner!: () => void
    const holdOwner = new Promise<void>((resolve) => {
      continueOwner = resolve
    })
    const owner = VisualHostClaim.finishRelease(root.path, releasing, async () => {
      markOwnerCleanup()
      await holdOwner
    })
    await ownerCleanup
    const lock = path.join(
      root.path,
      ".claims",
      ".cleanup",
      `${releasing.key}.${releasing.body.generation}.lock`,
      "cleanup.sqlite",
    )
    const waiter = new Database(`\\\\?\\${lock}`, { create: false, readwrite: true, strict: true })

    continueOwner()
    await owner
    expect(await fs.exists(lock)).toBe(true)
    waiter.close()
    expect(await VisualHostClaim.list(root.path)).toEqual([])
    expect(await fs.exists(path.join(root.path, ".claims", ".cleanup"))).toBe(false)
  })

  test("garbage-collects only a generation-authenticated ownerless cleanup database", async () => {
    await using root = await caseRoot("claim-cleanup-gc")
    const claims = path.join(root.path, ".claims")
    expect(await VisualHostClaim.list(root.path)).toEqual([])
    const cleanup = path.join(claims, ".cleanup")
    await fs.mkdir(cleanup)
    const key = "a".repeat(64)
    const generation = "b".repeat(64)
    const orphan = path.join(cleanup, `${key}.${generation}.lock`)
    await createCleanupAuthority(orphan, key, generation)

    expect(await VisualHostClaim.list(root.path)).toEqual([])
    expect(await fs.exists(cleanup)).toBe(false)
  })

  test("retires every authenticated duplicate pending cleanup staging directory", async () => {
    await using root = await caseRoot("claim-cleanup-duplicate-pending-gc")
    expect(await VisualHostClaim.list(root.path)).toEqual([])
    const cleanup = path.join(root.path, ".claims", ".cleanup")
    await fs.mkdir(cleanup)
    const key = "a".repeat(64)
    const generation = "b".repeat(64)
    for (const nonce of ["c".repeat(32), "d".repeat(32)]) {
      await createCleanupAuthority(path.join(cleanup, `${key}.${generation}.${nonce}.pending`), key, generation)
    }

    expect(await VisualHostClaim.list(root.path)).toEqual([])
    expect(await fs.exists(cleanup)).toBe(false)
  })

  test("recovers an authenticated retiring cleanup pair after a crash between journal and database deletion", async () => {
    await using root = await caseRoot("claim-cleanup-retiring-crash")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)

    await expect(
      VisualHostClaim.finishRelease(root.path, releasing, async () => undefined, {
        afterCleanupJournalRemoved: async () => {
          throw new Error("simulated crash after cleanup journal deletion")
        },
      }),
    ).rejects.toThrow("simulated crash")

    const cleanup = path.join(root.path, ".claims", ".cleanup")
    const entries = await fs.readdir(cleanup)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/\.retiring$/)
    const retiring = path.join(cleanup, entries[0]!)
    expect(await fs.exists(path.join(retiring, "retire.json"))).toBe(true)
    expect(await fs.exists(path.join(retiring, "cleanup.sqlite"))).toBe(true)
    expect(await fs.exists(path.join(retiring, "cleanup.sqlite-journal"))).toBe(false)

    expect(await VisualHostClaim.list(root.path)).toEqual([])
    expect(await fs.exists(cleanup)).toBe(false)
  })

  test("recovers the empty terminal retirement directory after a crash between marker deletion and rmdir", async () => {
    await using root = await caseRoot("claim-cleanup-empty-retiring-crash")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)

    await expect(
      VisualHostClaim.finishRelease(root.path, releasing, async () => undefined, {
        afterCleanupMarkerRemoved: async () => {
          throw new Error("simulated crash after cleanup marker deletion")
        },
      }),
    ).rejects.toThrow("simulated crash")

    const cleanup = path.join(root.path, ".claims", ".cleanup")
    const entries = await fs.readdir(cleanup)
    expect(entries).toHaveLength(1)
    const retiring = path.join(cleanup, entries[0]!)
    expect(entries[0]).toMatch(/\.retiring$/)
    expect(await fs.readdir(retiring)).toEqual([])

    expect(await VisualHostClaim.list(root.path)).toEqual([])
    expect(await fs.exists(cleanup)).toBe(false)
  })

  test("does not poison cleanup retirement when two real finishers publish the same marker", async () => {
    await using root = await caseRoot("claim-cleanup-retirement-publish-race")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    const claimFile = path.join(root.path, "releasing-claim.json")
    await fs.writeFile(claimFile, JSON.stringify(releasing), { flag: "wx" })
    const marker = (owner: string, seam: string) => path.join(root.path, `${owner}-${seam}.marker`)
    const owner = (name: string, blockCleanup: boolean) =>
      spawnClaimWorker(root.path, [
        "finish-known-race",
        claimFile,
        marker(name, "started"),
        marker(name, "prechecked"),
        blockCleanup ? marker(name, "cleanup-ready") : "-",
        blockCleanup ? marker(name, "cleanup-resume") : "-",
        marker(name, "retire-ready"),
        marker(name, "retire-resume"),
        marker(name, "publish-ready"),
        marker(name, "publish-resume"),
      ])
    const first = owner("first", true)
    await waitForFile(marker("first", "cleanup-ready"))
    const second = owner("second", false)
    await waitForFile(marker("second", "prechecked"))
    await fs.writeFile(marker("first", "cleanup-resume"), "resume", { flag: "wx" })
    await Promise.all([waitForFile(marker("first", "retire-ready")), waitForFile(marker("second", "retire-ready"))])
    await Promise.all([
      fs.writeFile(marker("first", "retire-resume"), "resume", { flag: "wx" }),
      fs.writeFile(marker("second", "retire-resume"), "resume", { flag: "wx" }),
    ])
    await Promise.all([waitForFile(marker("first", "publish-ready")), waitForFile(marker("second", "publish-ready"))])
    await Promise.all([
      fs.writeFile(marker("first", "publish-resume"), "resume", { flag: "wx" }),
      fs.writeFile(marker("second", "publish-resume"), "resume", { flag: "wx" }),
    ])

    const results = await Promise.all([workerResult(first), workerResult(second)])
    expect(results).toMatchObject([
      { ok: true, result: { cleanupCalls: 1 } },
      { ok: true, result: { cleanupCalls: 0, rejected: true } },
    ])
    expect(await VisualHostClaim.list(root.path)).toEqual([])
    expect(await fs.exists(path.join(root.path, ".claims", ".cleanup"))).toBe(false)
  }, 30_000)

  test("converges two durable retirement pending markers left by real crashed publishers", async () => {
    await using root = await caseRoot("claim-cleanup-retirement-two-pending")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    const claimFile = path.join(root.path, "releasing-claim.json")
    await fs.writeFile(claimFile, JSON.stringify(releasing), { flag: "wx" })
    const marker = (owner: string, seam: string) => path.join(root.path, `${owner}-${seam}.marker`)
    const owner = (name: string, blockCleanup: boolean) =>
      spawnClaimWorker(root.path, [
        "finish-known-race",
        claimFile,
        marker(name, "started"),
        marker(name, "prechecked"),
        blockCleanup ? marker(name, "cleanup-ready") : "-",
        blockCleanup ? marker(name, "cleanup-resume") : "-",
        marker(name, "retire-ready"),
        marker(name, "retire-resume"),
        marker(name, "publish-ready"),
        marker(name, "publish-resume"),
        marker(name, "pending-ready"),
        marker(name, "pending-resume"),
      ])
    const first = owner("first", true)
    await waitForFile(marker("first", "cleanup-ready"))
    const second = owner("second", false)
    await waitForFile(marker("second", "prechecked"))
    await fs.writeFile(marker("first", "cleanup-resume"), "resume", { flag: "wx" })
    await Promise.all([waitForFile(marker("first", "retire-ready")), waitForFile(marker("second", "retire-ready"))])
    await Promise.all([
      fs.writeFile(marker("first", "retire-resume"), "resume", { flag: "wx" }),
      fs.writeFile(marker("second", "retire-resume"), "resume", { flag: "wx" }),
    ])
    await Promise.all([waitForFile(marker("first", "publish-ready")), waitForFile(marker("second", "publish-ready"))])
    await Promise.all([
      fs.writeFile(marker("first", "publish-resume"), "resume", { flag: "wx" }),
      fs.writeFile(marker("second", "publish-resume"), "resume", { flag: "wx" }),
    ])
    await Promise.all([waitForFile(marker("first", "pending-ready")), waitForFile(marker("second", "pending-ready"))])

    first.kill()
    second.kill()
    await Promise.all([first.exited, second.exited])
    const cleanup = path.join(root.path, ".claims", ".cleanup")
    const [lock] = await fs.readdir(cleanup)
    if (lock === undefined) throw new TypeError("cleanup lock is missing")
    const pending = (await fs.readdir(path.join(cleanup, lock))).filter((name) =>
      /^\.retire\.[a-f0-9]{32}\.pending$/.test(name),
    )
    expect(pending).toHaveLength(2)

    expect(await workerResult(spawnClaimWorker(root.path, ["list"]))).toMatchObject({ ok: true, result: [] })
    expect(await fs.exists(cleanup)).toBe(false)
  })

  test("does not publish authority from multiply-linked retirement pending markers", async () => {
    await using root = await caseRoot("claim-cleanup-retirement-pending-hardlink")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    await expect(
      VisualHostClaim.finishRelease(root.path, releasing, async () => undefined, {
        afterCleanupRetirementPendingCreated: async () => {
          throw new Error("simulated crash after retirement pending sync")
        },
      }),
    ).rejects.toThrow("simulated crash")
    const cleanup = path.join(root.path, ".claims", ".cleanup")
    const [lock] = await fs.readdir(cleanup)
    if (lock === undefined) throw new TypeError("cleanup lock is missing")
    const lockDirectory = path.join(cleanup, lock)
    const [first] = (await fs.readdir(lockDirectory)).filter((name) => /^\.retire\.[a-f0-9]{32}\.pending$/.test(name))
    if (first === undefined) throw new TypeError("retirement pending marker is missing")
    const second = `.retire.${"f".repeat(32)}.pending`
    await fs.link(path.join(lockDirectory, first), path.join(lockDirectory, second))
    const before = await fs.readFile(path.join(lockDirectory, first))

    await expect(VisualHostClaim.list(root.path)).rejects.toThrow(/marker/)

    expect(await fs.exists(path.join(lockDirectory, "retire.json"))).toBe(false)
    expect(await fs.readFile(path.join(lockDirectory, first))).toEqual(before)
    expect(await fs.readFile(path.join(lockDirectory, second))).toEqual(before)
  })

  test("preserves an unknown cleanup retirement pending marker without deleting authority", async () => {
    await using root = await caseRoot("claim-cleanup-retirement-foreign-pending")
    expect(await VisualHostClaim.list(root.path)).toEqual([])
    const cleanup = path.join(root.path, ".claims", ".cleanup")
    await fs.mkdir(cleanup)
    const key = "a".repeat(64)
    const generation = "b".repeat(64)
    const lock = path.join(cleanup, `${key}.${generation}.lock`)
    await createCleanupAuthority(lock, key, generation)
    const pending = path.join(lock, `.retire.${"c".repeat(32)}.pending`)
    await fs.writeFile(pending, "foreign", { flag: "wx" })
    const database = await fs.readFile(path.join(lock, "cleanup.sqlite"))
    const journal = await fs.readFile(path.join(lock, "cleanup.sqlite-journal"))

    await expect(VisualHostClaim.list(root.path)).rejects.toThrow()

    expect(await fs.readFile(pending, "utf8")).toBe("foreign")
    expect(await fs.readFile(path.join(lock, "cleanup.sqlite"))).toEqual(database)
    expect(await fs.readFile(path.join(lock, "cleanup.sqlite-journal"))).toEqual(journal)
  })

  test.each(["empty", "damaged"] as const)(
    "preserves and rejects an unauthenticated %s ownerless cleanup database",
    async (variant) => {
      await using root = await caseRoot(`claim-cleanup-${variant}-hostile`)
      const claims = path.join(root.path, ".claims")
      expect(await VisualHostClaim.list(root.path)).toEqual([])
      const cleanup = path.join(claims, ".cleanup")
      await fs.mkdir(cleanup)
      const file = path.join(cleanup, `${"c".repeat(64)}.${"d".repeat(64)}.sqlite`)
      if (variant === "empty") new Database(`\\\\?\\${file}`, { create: true }).close()
      else await fs.writeFile(file, "not a sqlite authority")
      const before = await fs.readFile(file)

      await expect(VisualHostClaim.list(root.path)).rejects.toThrow()
      expect(await fs.readFile(file)).toEqual(before)
    },
  )

  test.each(["hardlink", "symlink"] as const)(
    "rejects a %s claims.sqlite journal before SQLite can change its outside owner",
    async (variant) => {
      await using root = await caseRoot(`claim-registry-journal-${variant}`)
      await using outside = await caseRoot(`claim-registry-journal-outside-${variant}`)
      expect(await VisualHostClaim.list(root.path)).toEqual([])
      const sentinel = path.join(outside.path, "sentinel.sqlite-journal")
      const bytes = Buffer.from("outside-registry-journal-owner")
      await fs.writeFile(sentinel, bytes)
      const sentinelBefore = await fs.stat(sentinel)
      const journal = path.join(root.path, ".claims", "claims.sqlite-journal")
      await fs.rename(journal, path.join(outside.path, "original.sqlite-journal"))
      if (variant === "hardlink") await fs.link(sentinel, journal)
      else await fs.symlink(sentinel, journal, "file")

      await expect(VisualHostClaim.list(root.path)).rejects.toThrow()
      expect(await fs.readFile(sentinel)).toEqual(bytes)
      expect((await fs.stat(sentinel)).mtimeMs).toBe(sentinelBefore.mtimeMs)
      expect((await fs.lstat(sentinel)).nlink).toBe(variant === "hardlink" ? 2 : 1)
      expect(await fs.lstat(journal)).toMatchObject({ nlink: variant === "hardlink" ? 2 : 1 })
    },
  )

  test.each(
    (["-wal", "-shm"] as const).flatMap((suffix) =>
      (["hardlink", "symlink"] as const).map((variant) => ({ suffix, variant })),
    ),
  )(
    "rejects a $variant claims.sqlite$suffix before SQLite can touch its outside owner",
    async ({ suffix, variant }) => {
      await using root = await caseRoot(`claim-registry${suffix}-${variant}`)
      await using outside = await caseRoot(`claim-registry${suffix}-outside-${variant}`)
      expect(await VisualHostClaim.list(root.path)).toEqual([])
      const sentinel = path.join(outside.path, `sentinel${suffix}`)
      const bytes = Buffer.from(`outside-registry${suffix}-owner`)
      await fs.writeFile(sentinel, bytes)
      const sentinelBefore = await fs.stat(sentinel)
      const sidecar = path.join(root.path, ".claims", `claims.sqlite${suffix}`)
      if (variant === "hardlink") await fs.link(sentinel, sidecar)
      else await fs.symlink(sentinel, sidecar, "file")

      await expect(VisualHostClaim.list(root.path)).rejects.toThrow(/WAL|SHM/)
      expect(await fs.readFile(sentinel)).toEqual(bytes)
      expect((await fs.stat(sentinel)).mtimeMs).toBe(sentinelBefore.mtimeMs)
      expect((await fs.lstat(sentinel)).nlink).toBe(variant === "hardlink" ? 2 : 1)
      expect(await fs.lstat(sidecar)).toMatchObject({ nlink: variant === "hardlink" ? 2 : 1 })
    },
  )

  test("rejects an existing empty registry before any schema or journal mutation", async () => {
    await using root = await caseRoot("claim-registry-empty-hostile")
    const directory = path.join(root.path, ".claims")
    await fs.mkdir(directory)
    const registry = path.join(directory, "claims.sqlite")
    await fs.writeFile(registry, "")

    await expect(VisualHostClaim.list(root.path)).rejects.toThrow(/schema|registry/i)
    expect(await fs.readFile(registry)).toEqual(Buffer.alloc(0))
    expect(await fs.exists(`${registry}-journal`)).toBe(false)
  })

  test("rejects extra existing registry objects without executing permissive DDL", async () => {
    await using root = await caseRoot("claim-registry-extra-object")
    expect(await VisualHostClaim.list(root.path)).toEqual([])
    const registry = path.join(root.path, ".claims", "claims.sqlite")
    const database = new Database(registry, { create: false, readwrite: true })
    database.exec("CREATE TABLE hostile_extra (value TEXT)")
    database.close()
    const before = await fs.readFile(registry)

    await expect(VisualHostClaim.list(root.path)).rejects.toThrow(/schema|registry/i)
    expect(await fs.readFile(registry)).toEqual(before)
    expect(await fs.exists(`${registry}-journal`)).toBe(false)
  })

  test.each(["hardlink", "symlink"] as const)(
    "rejects a %s cleanup journal before SQLite or cleanup can change foreign state",
    async (variant) => {
      await using root = await caseRoot(`claim-cleanup-journal-${variant}`)
      await using outside = await caseRoot(`claim-cleanup-journal-outside-${variant}`)
      const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
      if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
      const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
      expect(await VisualHostClaim.finishRelease(root.path, releasing, async () => false)).toBe(false)
      const sentinel = path.join(outside.path, "sentinel.cleanup-journal")
      const bytes = Buffer.from("outside-cleanup-journal-owner")
      await fs.writeFile(sentinel, bytes)
      const sentinelBefore = await fs.stat(sentinel)
      const journal = path.join(
        root.path,
        ".claims",
        ".cleanup",
        `${releasing.key}.${releasing.body.generation}.lock`,
        "cleanup.sqlite-journal",
      )
      await fs.rename(journal, path.join(outside.path, "original.cleanup-journal"))
      if (variant === "hardlink") await fs.link(sentinel, journal)
      else await fs.symlink(sentinel, journal, "file")
      let cleanupCalls = 0

      await expect(
        VisualHostClaim.finishRelease(root.path, releasing, async () => {
          cleanupCalls++
        }),
      ).rejects.toThrow()
      expect(cleanupCalls).toBe(0)
      expect(await fs.readFile(sentinel)).toEqual(bytes)
      expect((await fs.stat(sentinel)).mtimeMs).toBe(sentinelBefore.mtimeMs)
      expect((await fs.lstat(sentinel)).nlink).toBe(variant === "hardlink" ? 2 : 1)
      expect(await fs.lstat(journal)).toMatchObject({ nlink: variant === "hardlink" ? 2 : 1 })
    },
  )

  test.each(
    (["-wal", "-shm"] as const).flatMap((suffix) =>
      (["hardlink", "symlink"] as const).map((variant) => ({ suffix, variant })),
    ),
  )("rejects a $variant cleanup$suffix before SQLite can touch foreign state", async ({ suffix, variant }) => {
    await using root = await caseRoot(`claim-cleanup${suffix}-${variant}`)
    await using outside = await caseRoot(`claim-cleanup${suffix}-outside-${variant}`)
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    expect(await VisualHostClaim.finishRelease(root.path, releasing, async () => false)).toBe(false)
    const sentinel = path.join(outside.path, `sentinel${suffix}`)
    const bytes = Buffer.from(`outside-cleanup${suffix}-owner`)
    await fs.writeFile(sentinel, bytes)
    const sentinelBefore = await fs.stat(sentinel)
    const sidecar = path.join(
      root.path,
      ".claims",
      ".cleanup",
      `${releasing.key}.${releasing.body.generation}.lock`,
      `cleanup.sqlite${suffix}`,
    )
    if (variant === "hardlink") await fs.link(sentinel, sidecar)
    else await fs.symlink(sentinel, sidecar, "file")
    let cleanupCalls = 0

    await expect(
      VisualHostClaim.finishRelease(root.path, releasing, async () => {
        cleanupCalls++
      }),
    ).rejects.toThrow(/WAL|SHM/)
    expect(cleanupCalls).toBe(0)
    expect(await fs.readFile(sentinel)).toEqual(bytes)
    expect((await fs.stat(sentinel)).mtimeMs).toBe(sentinelBefore.mtimeMs)
    expect((await fs.lstat(sentinel)).nlink).toBe(variant === "hardlink" ? 2 : 1)
    expect(await fs.lstat(sidecar)).toMatchObject({ nlink: variant === "hardlink" ? 2 : 1 })
  })

  test("keeps the exclusively-created registry inode fixed across its first SQLite open", async () => {
    await using root = await caseRoot("claim-registry-first-open-swap")
    let created: { readonly dev: number; readonly ino: number; readonly birthtimeMs: number } | undefined
    let publishedBytesHex = ""
    let parked = ""
    let replacement = ""

    await expect(
      VisualHostClaim.acquire(root.path, body("reference", 0), {
        afterRegistryCreated: async (file) => {
          const stat = await fs.lstat(file)
          created = { dev: Number(stat.dev), ino: Number(stat.ino), birthtimeMs: stat.birthtimeMs }
          publishedBytesHex = (await fs.readFile(file)).toString("hex")
          parked = `${file}.parked`
          replacement = file
          await fs.rename(file, parked)
          await fs.writeFile(replacement, "")
        },
      }),
    ).rejects.toThrow("fixed identity")

    if (created === undefined) throw new TypeError("registry creation hook did not run")
    const parkedStat = await fs.lstat(parked)
    const replacementStat = await fs.lstat(replacement)
    expect({ dev: Number(parkedStat.dev), ino: Number(parkedStat.ino), birthtimeMs: parkedStat.birthtimeMs }).toEqual({
      dev: created.dev,
      ino: created.ino,
      birthtimeMs: created.birthtimeMs,
    })
    expect(Number(replacementStat.ino)).not.toBe(created.ino)
    expect(publishedBytesHex.length).toBeGreaterThan(0)
    expect((await fs.readFile(parked)).toString("hex")).toBe(publishedBytesHex)
    expect(await fs.readFile(replacement)).toEqual(Buffer.alloc(0))
  })

  test("keeps an existing registry inode fixed from precheck through SQLite open", async () => {
    await using root = await caseRoot("claim-registry-existing-swap")
    expect(await VisualHostClaim.list(root.path)).toEqual([])
    const registry = path.join(root.path, ".claims", "claims.sqlite")
    const parked = `${registry}.parked`
    let prechecked: { readonly dev: number; readonly ino: number; readonly birthtimeMs: number } | undefined

    await expect(
      VisualHostClaim.acquire(root.path, body("reference", 0), {
        afterRegistryPrecheck: async (file) => {
          const stat = await fs.lstat(file)
          prechecked = { dev: Number(stat.dev), ino: Number(stat.ino), birthtimeMs: stat.birthtimeMs }
          await fs.rename(file, parked)
          await fs.copyFile(parked, file)
        },
      }),
    ).rejects.toThrow("prechecked identity")

    if (prechecked === undefined) throw new TypeError("registry precheck hook did not run")
    const parkedStat = await fs.lstat(parked)
    const replacementStat = await fs.lstat(registry)
    expect({ dev: Number(parkedStat.dev), ino: Number(parkedStat.ino), birthtimeMs: parkedStat.birthtimeMs }).toEqual(
      prechecked,
    )
    expect(Number(replacementStat.ino)).not.toBe(prechecked.ino)
  })

  test("keeps the exclusively-created cleanup-lock inode fixed across its first SQLite open", async () => {
    await using root = await caseRoot("claim-cleanup-first-open-swap")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    let created: { readonly dev: number; readonly ino: number; readonly birthtimeMs: number } | undefined
    let parked = ""
    let replacement = ""
    let cleanupCalls = 0

    await expect(
      VisualHostClaim.finishRelease(
        root.path,
        releasing,
        async () => {
          cleanupCalls++
        },
        {
          afterCleanupLockCreated: async (file) => {
            const stat = await fs.lstat(file)
            created = { dev: Number(stat.dev), ino: Number(stat.ino), birthtimeMs: stat.birthtimeMs }
            parked = `${file}.parked`
            replacement = file
            await fs.rename(file, parked)
            await fs.writeFile(replacement, "")
          },
        },
      ),
    ).rejects.toThrow("fixed identity")

    if (created === undefined) throw new TypeError("cleanup creation hook did not run")
    const parkedStat = await fs.lstat(parked)
    const replacementStat = await fs.lstat(replacement)
    expect(cleanupCalls).toBe(0)
    expect({ dev: Number(parkedStat.dev), ino: Number(parkedStat.ino), birthtimeMs: parkedStat.birthtimeMs }).toEqual({
      dev: created.dev,
      ino: created.ino,
      birthtimeMs: created.birthtimeMs,
    })
    expect(Number(replacementStat.ino)).not.toBe(created.ino)
    expect((await fs.stat(parked)).size).toBeGreaterThan(0)
    expect(await fs.readFile(replacement)).toEqual(Buffer.alloc(0))
  })

  test("keeps an existing cleanup-lock inode fixed from precheck through SQLite open", async () => {
    await using root = await caseRoot("claim-cleanup-existing-swap")
    const acquired = await VisualHostClaim.acquire(root.path, body("reference", 0))
    if (acquired.status !== "acquired") throw new TypeError("claim did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root.path, acquired.claim)
    expect(await VisualHostClaim.finishRelease(root.path, releasing, async () => false)).toBe(false)
    const lock = path.join(
      root.path,
      ".claims",
      ".cleanup",
      `${releasing.key}.${releasing.body.generation}.lock`,
      "cleanup.sqlite",
    )
    const parked = `${lock}.parked`
    let prechecked: { readonly dev: number; readonly ino: number; readonly birthtimeMs: number } | undefined
    let cleanupCalls = 0

    await expect(
      VisualHostClaim.finishRelease(
        root.path,
        releasing,
        async () => {
          cleanupCalls++
        },
        {
          afterCleanupPrecheck: async (file) => {
            const stat = await fs.lstat(file)
            prechecked = { dev: Number(stat.dev), ino: Number(stat.ino), birthtimeMs: stat.birthtimeMs }
            await fs.rename(file, parked)
            await fs.copyFile(parked, file)
          },
        },
      ),
    ).rejects.toThrow("prechecked identity")

    if (prechecked === undefined) throw new TypeError("cleanup precheck hook did not run")
    expect(cleanupCalls).toBe(0)
    const parkedStat = await fs.lstat(parked)
    const replacementStat = await fs.lstat(lock)
    expect({ dev: Number(parkedStat.dev), ino: Number(parkedStat.ino), birthtimeMs: parkedStat.birthtimeMs }).toEqual(
      prechecked,
    )
    expect(Number(replacementStat.ino)).not.toBe(prechecked.ino)
  })

  test("arbitrates the same claim key once across real processes while a different key stays nonblocking", async () => {
    await using root = await caseRoot("claim-cross-process-arbitration")
    const contenders = [
      spawnClaimWorker(root.path, ["acquire", "reference", "0", "same-key-a"]),
      spawnClaimWorker(root.path, ["acquire", "reference", "0", "same-key-b"]),
    ]
    const results = await Promise.all(contenders.map((child) => workerResult(child)))
    expect(results.map((result) => result.ok)).toEqual([true, true])
    expect(results.map((result) => (result.result as { readonly status: string }).status).sort()).toEqual([
      "acquired",
      "contended",
    ])
    const winner = (await VisualHostClaim.list(root.path))[0]
    if (winner === undefined) throw new TypeError("cross-process winner is missing")
    await VisualHostClaim.finishRelease(
      root.path,
      await VisualHostClaim.beginRelease(root.path, winner),
      async () => undefined,
    )

    const marker = path.join(root.path, "blocked-reference.marker")
    const blocked = spawnClaimWorker(root.path, [
      "block-release",
      "cleanup-callback",
      marker,
      "reference",
      "0",
      "blocked-reference",
    ])
    await waitForFile(marker)
    const independent = await workerResult(
      spawnClaimWorker(root.path, ["release", "implementation", "1", "independent-implementation"]),
      10_000,
    )
    expect(independent).toMatchObject({ ok: true, result: { status: "released" } })

    blocked.kill()
    await blocked.exited
    const stranded = (await VisualHostClaim.list(root.path))[0]
    if (stranded === undefined) throw new TypeError("blocked releasing generation is missing")
    expect(stranded.state).toBe("releasing")
    await VisualHostClaim.finishRelease(root.path, stranded, async () => undefined)
    expect(await VisualHostClaim.list(root.path)).toEqual([])
  }, 30_000)

  test("recovers real-process crashes at registry, claim mirror, manifest, and cleanup retirement boundaries", async () => {
    for (const seam of ["registry-published", "pending-inserted", "mirror-linked", "promoted"] as const) {
      await using root = await caseRoot(`claim-cross-process-${seam}`)
      const marker = path.join(root.path, `${seam}.marker`)
      const child = spawnClaimWorker(root.path, ["block-acquire", seam, marker, seam])
      await waitForFile(marker)
      child.kill()
      await child.exited
      const claims = await VisualHostClaim.list(root.path)
      if (seam === "mirror-linked" || seam === "pending-inserted") {
        expect(claims).toHaveLength(1)
        await VisualHostClaim.rollbackPending(root.path, claims[0]!, async () => undefined)
      } else if (seam === "promoted") {
        expect(claims).toHaveLength(1)
        await VisualHostClaim.finishRelease(
          root.path,
          await VisualHostClaim.beginRelease(root.path, claims[0]!),
          async () => undefined,
        )
      } else {
        expect(claims).toEqual([])
      }
      const recovered = await workerResult(spawnClaimWorker(root.path, ["release", "reference", "0", `next-${seam}`]))
      expect(recovered).toMatchObject({ ok: true, result: { status: "released" } })
    }

    for (const seam of ["directory-created", "manifest-synced", "final-published"] as const) {
      await using root = await caseRoot(`claim-cross-process-${seam}`)
      const marker = path.join(root.path, `${seam}.marker`)
      const child = spawnClaimWorker(root.path, ["manifest-block", seam, marker])
      await waitForFile(marker)
      child.kill()
      await child.exited
      const recovered = await workerResult(spawnClaimWorker(root.path, ["recover-host"]))
      expect(recovered).toMatchObject({ ok: true, result: { status: "recovered" } })
      expect(await VisualHostClaim.list(root.path)).toEqual([])
    }

    for (const seam of ["journal-removed", "database-removed", "marker-removed"] as const) {
      await using root = await caseRoot(`claim-cross-process-${seam}`)
      const marker = path.join(root.path, `${seam}.marker`)
      const child = spawnClaimWorker(root.path, ["block-release", seam, marker, "reference", "0", seam])
      await waitForFile(marker)
      child.kill()
      await child.exited
      const recovered = await workerResult(spawnClaimWorker(root.path, ["list"]))
      expect(recovered).toMatchObject({ ok: true, result: [] })
      expect(await VisualHostClaim.list(root.path)).toEqual([])
    }

    for (const seam of ["mirror-unlinked", "row-deleted"] as const) {
      await using root = await caseRoot(`claim-cross-process-${seam}`)
      const marker = path.join(root.path, `${seam}.marker`)
      const child = spawnClaimWorker(root.path, ["block-release", seam, marker, "reference", "0", seam])
      await waitForFile(marker)
      child.kill()
      await child.exited
      const claims = await VisualHostClaim.list(root.path)
      if (seam === "mirror-unlinked") {
        expect(claims).toHaveLength(1)
        await VisualHostClaim.finishRelease(root.path, claims[0]!, async () => undefined)
      } else {
        expect(claims).toEqual([])
      }
      expect(await VisualHostClaim.list(root.path)).toEqual([])
    }
  }, 60_000)

  test("preserves unknown registry staging while recovering real pre-publication construction crashes", async () => {
    for (const seam of ["registry-pending-created", "registry-pending-initialized"] as const) {
      await using root = await caseRoot(`claim-cross-process-${seam}`)
      const marker = path.join(root.path, `${seam}.marker`)
      const child = spawnClaimWorker(root.path, ["block-acquire", seam, marker, seam])
      await waitForFile(marker)
      child.kill()
      await child.exited
      const [stagingName] = (await fs.readdir(root.path)).filter((name) =>
        /^\.claims\.[a-f0-9]{32}\.pending$/.test(name),
      )
      if (stagingName === undefined) throw new TypeError("registry staging directory is missing")
      const staging = path.join(root.path, stagingName)
      const database = path.join(staging, "claims.sqlite")
      const journal = `${database}-journal`
      const before = { database: identity(await fs.lstat(database)), journal: identity(await fs.lstat(journal)) }

      expect(await VisualHostClaim.list(root.path)).toEqual([])
      expect(identity(await fs.lstat(database))).toEqual(before.database)
      expect(identity(await fs.lstat(journal))).toEqual(before.journal)
      const recovered = await workerResult(spawnClaimWorker(root.path, ["release", "reference", "0", `next-${seam}`]))
      expect(recovered).toMatchObject({ ok: true, result: { status: "released" } })
    }
  }, 30_000)

  test("recovers real crashes around release transition and cleanup authority publication", async () => {
    {
      await using root = await caseRoot("claim-cross-process-begin-release")
      const marker = path.join(root.path, "begin-release.marker")
      const child = spawnClaimWorker(root.path, ["block-begin-release", marker, "begin-release"])
      await waitForFile(marker)
      child.kill()
      await child.exited
      const [releasing] = await VisualHostClaim.list(root.path)
      if (releasing === undefined) throw new TypeError("releasing claim is missing")
      expect(releasing.state).toBe("releasing")
      await VisualHostClaim.finishRelease(root.path, releasing, async () => undefined)
      expect(await VisualHostClaim.list(root.path)).toEqual([])
    }

    for (const seam of [
      "cleanup-pending-initialized",
      "cleanup-lock-created",
      "cleanup-retired",
      "retirement-linked",
      "cleanup-lock-removed",
      "cleanup-root-removed",
    ] as const) {
      await using root = await caseRoot(`claim-cross-process-${seam}`)
      const marker = path.join(root.path, `${seam}.marker`)
      const child = spawnClaimWorker(root.path, ["block-release", seam, marker, "reference", "0", seam])
      await waitForFile(marker)
      child.kill()
      await child.exited
      const claims = await VisualHostClaim.list(root.path)
      if (seam === "cleanup-pending-initialized" || seam === "cleanup-lock-created") {
        expect(claims).toHaveLength(1)
        await VisualHostClaim.finishRelease(root.path, claims[0]!, async () => undefined)
      } else {
        expect(claims).toEqual([])
      }
      expect(await VisualHostClaim.list(root.path)).toEqual([])
      expect(await fs.exists(path.join(root.path, ".claims", ".cleanup"))).toBe(false)
    }
  }, 45_000)

  test("a real recovery process deletes nothing from an unknown unclaimed staging directory", async () => {
    await using root = await caseRoot("claim-cross-process-unknown")
    expect(await VisualHostClaim.list(root.path)).toEqual([])
    const foreign = path.join(root.path, `.host.${"1".repeat(64)}.${"2".repeat(64)}.${"3".repeat(64)}.pending`)
    await fs.mkdir(foreign)
    const sentinel = path.join(foreign, "foreign.txt")
    await fs.writeFile(sentinel, "preserve")

    const result = await workerResult(spawnClaimWorker(root.path, ["recover-host"]))

    expect(result.ok).toBe(false)
    expect(await fs.readFile(sentinel, "utf8")).toBe("preserve")
    expect(await fs.readdir(foreign)).toEqual(["foreign.txt"])
  }, 20_000)

  test("recovers an authenticated script process after its real host worker crashes immediately after start", async () => {
    await using root = await caseRoot("claim-cross-process-script-start")
    await using workspace = await caseRoot("claim-cross-process-script-workspace")
    await fs.writeFile(path.join(workspace.path, "server.mjs"), "setInterval(() => undefined, 60_000)\n")
    const marker = path.join(root.path, "process-started.marker")
    const pidFile = path.join(root.path, "owned-process.pid")
    const recoveredMarker = path.join(root.path, "process-recovered.marker")
    let pid: number | undefined
    try {
      const child = spawnClaimWorker(root.path, ["script-block", workspace.path, marker, pidFile])
      await waitForFile(marker)
      pid = Number(await fs.readFile(pidFile, "utf8"))
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("owned process pid is invalid")
      expect(processIsAlive(pid)).toBe(true)
      child.kill()
      await child.exited
      expect(processIsAlive(pid)).toBe(true)

      const recovered = await workerResult(spawnClaimWorker(root.path, ["recover-script", pidFile, recoveredMarker]))
      expect(recovered).toMatchObject({ ok: true, result: { status: "recovered" } })
      await waitForFile(recoveredMarker)
      await waitForProcessExit(pid)
      expect(await VisualHostClaim.list(root.path)).toEqual([])
      expect((await fs.readdir(root.path)).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([])
    } finally {
      if (pid !== undefined && processIsAlive(pid)) process.kill(pid)
    }
  }, 30_000)

  test("serializes a real pending rollback ahead of its paused owner without leaving an orphan mirror", async () => {
    await using root = await caseRoot("claim-cross-process-pending-rollback-wins")
    const ownerReady = path.join(root.path, "owner-ready.marker")
    const ownerResume = path.join(root.path, "owner-resume.marker")
    const claimFile = path.join(root.path, "pending-claim.json")
    const rollbackStarted = path.join(root.path, "rollback-started.marker")
    const rollbackReady = path.join(root.path, "rollback-ready.marker")
    const rollbackResume = path.join(root.path, "rollback-resume.marker")
    const owner = spawnClaimWorker(root.path, [
      "pause-acquire",
      "pending-inserted",
      ownerReady,
      ownerResume,
      claimFile,
      "rollback-wins",
    ])
    await waitForFile(ownerReady)
    const candidate = JSON.parse(await fs.readFile(claimFile, "utf8")) as VisualHostClaim.Body
    const key = VisualHostClaim.keyOf(candidate)
    const rollback = spawnClaimWorker(root.path, [
      "rollback-known",
      claimFile,
      rollbackStarted,
      rollbackReady,
      rollbackResume,
    ])
    await waitForFile(rollbackReady)
    await fs.writeFile(ownerResume, "resume", { flag: "wx" })

    expect(await exitsWithin(owner, 250)).toBe(false)
    expect(await fs.exists(path.join(root.path, ".claims", `${key}.json`))).toBe(false)
    await fs.writeFile(rollbackResume, "resume", { flag: "wx" })

    expect(await workerResult(rollback)).toMatchObject({ ok: true, result: { rolledBack: true } })
    expect(await workerResult(owner)).toMatchObject({ ok: false })
    expect(await VisualHostClaim.list(root.path)).toEqual([])
    expect(await fs.exists(path.join(root.path, ".claims", `${key}.json`))).toBe(false)
  }, 30_000)

  test("serializes a paused real mirror publisher ahead of stale rollback without deleting the active owner", async () => {
    await using root = await caseRoot("claim-cross-process-pending-owner-wins")
    const ownerReady = path.join(root.path, "owner-ready.marker")
    const ownerResume = path.join(root.path, "owner-resume.marker")
    const claimFile = path.join(root.path, "pending-claim.json")
    const rollbackStarted = path.join(root.path, "rollback-started.marker")
    const owner = spawnClaimWorker(root.path, [
      "pause-acquire",
      "mirror-linked",
      ownerReady,
      ownerResume,
      claimFile,
      "owner-wins",
    ])
    await waitForFile(ownerReady)
    const candidate = JSON.parse(await fs.readFile(claimFile, "utf8")) as VisualHostClaim.Body
    const key = VisualHostClaim.keyOf(candidate)
    const mirror = path.join(root.path, ".claims", `${key}.json`)
    const rollback = spawnClaimWorker(root.path, ["rollback-known", claimFile, rollbackStarted])
    await waitForFile(rollbackStarted)

    expect(await exitsWithin(rollback, 250)).toBe(false)
    expect((await fs.lstat(mirror)).nlink).toBe(2)
    await fs.writeFile(ownerResume, "resume", { flag: "wx" })

    expect(await workerResult(owner)).toMatchObject({ ok: true, result: { status: "acquired" } })
    expect(await workerResult(rollback)).toMatchObject({ ok: false })
    const [active] = await VisualHostClaim.list(root.path)
    if (active === undefined) throw new TypeError("active owner is missing")
    expect(active).toMatchObject({ state: "active", body: { generation: candidate.generation } })
    expect(await fs.readFile(mirror, "utf8")).toBe(JSON.stringify(candidate))

    await VisualHostClaim.finishRelease(
      root.path,
      await VisualHostClaim.beginRelease(root.path, active),
      async () => undefined,
    )
  }, 30_000)

  test("rejects a paused real old finisher before cleanup after another process installs a replacement", async () => {
    await using root = await caseRoot("claim-cross-process-old-finisher")
    const claimFile = path.join(root.path, "old-finisher-claim.json")
    const ready = path.join(root.path, "old-finisher-ready.marker")
    const resume = path.join(root.path, "old-finisher-resume.marker")
    const old = spawnClaimWorker(root.path, ["pause-old-finisher", claimFile, ready, resume, "old-generation"])
    await waitForFile(ready)

    const replacementResult = await workerResult(
      spawnClaimWorker(root.path, ["finish-known-and-replace", claimFile, "replacement-generation"]),
    )
    expect(replacementResult).toMatchObject({
      ok: true,
      result: { cleanupCalls: 1, status: "acquired" },
    })
    const [replacement] = await VisualHostClaim.list(root.path)
    if (replacement === undefined) throw new TypeError("replacement claim is missing")
    const replacementMirror = await fs.readFile(replacement.file, "utf8")
    await fs.writeFile(resume, "resume", { flag: "wx" })

    expect(await workerResult(old)).toMatchObject({
      ok: true,
      result: { rejected: true, cleanupCalls: 0 },
    })
    expect(await fs.readFile(replacement.file, "utf8")).toBe(replacementMirror)
    expect(await VisualHostClaim.list(root.path)).toMatchObject([
      { state: "active", body: { generation: replacement.body.generation } },
    ])

    await VisualHostClaim.finishRelease(
      root.path,
      await VisualHostClaim.beginRelease(root.path, replacement),
      async () => undefined,
    )
  }, 30_000)
})

function body(purpose: VisualHostClaim.Purpose, revision: number): VisualHostClaim.Body {
  const lease: WorkflowVisualHost.PreviewLeaseAuthority = {
    workflowID,
    stageID,
    attempt: 1,
    leaseOwner: "visual-claim-owner",
    leaseExpiresAt: 2_000_000_000_000,
  }
  return VisualHostClaim.make({
    purpose,
    kind: "static",
    ...lease,
    hostID: WorkflowVisualHost.HostID.make(crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")),
    nonce: crypto.randomUUID().replaceAll("-", "").padEnd(64, "1"),
    createdAt: 10,
    revision,
    configurationSha256: "c".repeat(64),
    sourceSha256: "d".repeat(64),
  })
}

function identity(value: {
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly birthtimeMs: number
}) {
  return { dev: Number(value.dev), ino: Number(value.ino), birthtimeMs: value.birthtimeMs }
}

async function createCleanupAuthority(directory: string, key: string, generation: string): Promise<void> {
  await fs.mkdir(directory)
  const file = path.join(directory, "cleanup.sqlite")
  await fs.writeFile(file, "", { flag: "wx" })
  await fs.writeFile(`${file}-journal`, "", { flag: "wx" })
  const database = new Database(`\\\\?\\${file}`, { create: false, readwrite: true, strict: true })
  try {
    database.exec("PRAGMA journal_mode = PERSIST")
    database.exec("PRAGMA synchronous = FULL")
    database.exec(
      "CREATE TABLE visual_host_cleanup_lock (claim_key TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY (claim_key, generation)) WITHOUT ROWID",
    )
    database.query("INSERT INTO visual_host_cleanup_lock (claim_key, generation) VALUES (?, ?)").run(key, generation)
  } finally {
    database.close()
  }
}

function spawnClaimWorker(root: string, args: readonly string[]) {
  const environment = Object.fromEntries(
    ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"].flatMap((name) => {
      const value = process.env[name]
      return value === undefined ? [] : [[name, value]]
    }),
  )
  environment.TEMP = root
  environment.TMP = root
  const [mode, ...rest] = args
  if (mode === undefined) throw new TypeError("claim worker mode is required")
  return Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "workflow-visual-host-claim-worker.ts"), mode, root, ...rest],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
}

async function workerResult(
  child: ReturnType<typeof spawnClaimWorker>,
  timeoutMs = 15_000,
): Promise<{ readonly ok: boolean; readonly result?: unknown; readonly error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("claim worker timed out")), timeoutMs)
      }),
    ])
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    if (exitCode !== 0) throw new Error(`claim worker exited ${exitCode}: ${stderr}`)
    const line = stdout.trim().split(/\r?\n/).at(-1)
    if (line === undefined || line === "") throw new Error(`claim worker returned no result: ${stderr}`)
    return JSON.parse(line) as { readonly ok: boolean; readonly result?: unknown; readonly error?: string }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fs.exists(file)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`claim worker marker timed out: ${path.basename(file)}`)
}

async function exitsWithin(child: ReturnType<typeof spawnClaimWorker>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    child.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if (cause instanceof Error && Reflect.get(cause, "code") === "ESRCH") return false
    throw cause
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("owned process did not exit after authenticated recovery")
}

async function caseRoot(name: string) {
  await fs.mkdir(acceptanceRoot, { recursive: true })
  const parent = await fs.realpath(acceptanceRoot)
  const directory = await fs.realpath(await fs.mkdtemp(path.join(parent, `${name}-${crypto.randomUUID()}-`)))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      const canonical = await fs.realpath(directory)
      const stat = await fs.lstat(directory)
      if (
        path.dirname(canonical) !== parent ||
        canonical !== directory ||
        !stat.isDirectory() ||
        stat.isSymbolicLink()
      ) {
        throw new TypeError("Refusing to clean a foreign claim test root")
      }
      await fs.rm(canonical, { recursive: true })
      if (await fs.exists(canonical)) throw new TypeError(`Claim test root remains: ${canonical}`)
    },
  }
}
