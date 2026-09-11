export * as VisualHostClaim from "./visual-host-claim"

import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { Database } from "bun:sqlite"
import { createHash, randomBytes } from "node:crypto"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

const CLAIM_VERSION = 1
const CLAIM_DIRECTORY = ".claims"
const MAX_CLAIM_BYTES = 16 * 1024
const registrySchema =
  "CREATE TABLE visual_host_claim (claim_key TEXT PRIMARY KEY NOT NULL, generation TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'releasing')), body TEXT NOT NULL) WITHOUT ROWID"
const cleanupLockSchema =
  "CREATE TABLE visual_host_cleanup_lock (claim_key TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY (claim_key, generation)) WITHOUT ROWID"
const claimKeys = new Set([
  "schemaVersion",
  "generation",
  "purpose",
  "kind",
  "workflowID",
  "stageID",
  "attempt",
  "leaseOwner",
  "leaseExpiresAt",
  "hostID",
  "nonce",
  "createdAt",
  "revision",
  "configurationSha256",
  "sourceSha256",
])

export type Purpose = "reference" | "implementation"

export interface Body {
  readonly schemaVersion: typeof CLAIM_VERSION
  readonly generation: string
  readonly purpose: Purpose
  readonly kind: "static" | "script"
  readonly workflowID: WorkflowVisualHost.PreviewLeaseAuthority["workflowID"]
  readonly stageID: WorkflowVisualHost.PreviewLeaseAuthority["stageID"]
  readonly attempt: number
  readonly leaseOwner: string
  readonly leaseExpiresAt: number
  readonly hostID: WorkflowVisualHost.HostID
  readonly nonce: string
  readonly createdAt: number
  readonly revision: number
  readonly configurationSha256: string
  readonly sourceSha256: string
}

export interface Owned {
  readonly key: string
  readonly file: string
  readonly body: Body
  readonly sha256: string
  readonly registered: boolean
  readonly state: "pending" | "active" | "releasing"
}

export type AcquireResult =
  | { readonly status: "acquired"; readonly claim: Owned }
  | { readonly status: "contended"; readonly claim: Owned }

export interface AcquireHooks {
  readonly afterRegistryCreated?: (file: string) => Promise<void>
  readonly afterRegistryPrecheck?: (file: string) => Promise<void>
  readonly afterRegistryPendingCreated?: (file: string) => Promise<void>
  readonly afterRegistryPendingInitialized?: (file: string) => Promise<void>
  readonly afterRegistryPublished?: (file: string) => Promise<void>
  readonly afterRegistryPendingRemoved?: (file: string) => Promise<void>
  readonly afterPendingInserted?: () => Promise<void>
  readonly afterMirrorLinked?: () => Promise<void>
  readonly afterPromoted?: () => Promise<void>
}

export interface FinishReleaseHooks {
  readonly afterCleanupRootReady?: (directory: string) => Promise<void>
  readonly afterCleanupLockCreated?: (file: string) => Promise<void>
  readonly afterCleanupLockPendingInitialized?: (file: string) => Promise<void>
  readonly afterCleanupClaimPrecheck?: () => Promise<void>
  readonly beforeCleanupLockRetire?: () => Promise<void>
  readonly afterCleanupPrecheck?: (file: string) => Promise<void>
  readonly afterLockOpened?: () => Promise<void>
  readonly afterCleanupLockRetired?: (directory: string) => Promise<void>
  readonly afterCleanupJournalRemoved?: (directory: string) => Promise<void>
  readonly afterCleanupDatabaseRemoved?: (directory: string) => Promise<void>
  readonly afterCleanupMarkerRemoved?: (directory: string) => Promise<void>
  readonly afterCleanupLockRemoved?: (cleanupRoot: string) => Promise<void>
  readonly afterCleanupRootRemoved?: (claimsRoot: string) => Promise<void>
  readonly beforeCleanupRetirementPublish?: () => Promise<void>
  readonly afterCleanupRetirementPendingCreated?: (file: string) => Promise<void>
  readonly afterCleanupRetirementLinked?: (file: string) => Promise<void>
  readonly afterMirrorUnlinked?: () => Promise<void>
  readonly afterRowDeleted?: () => Promise<void>
  readonly beforeAuthorityDelete?: () => Promise<void>
  readonly finalGate?: () => Promise<boolean>
}

interface SqliteAuthority {
  readonly root: string
  readonly file: string
  readonly journal: string
  readonly wal: string
  readonly shm: string
  readonly created: boolean
  readonly identity: {
    readonly dev: number
    readonly ino: number
    readonly birthtimeMs: number
  }
  readonly journalIdentity: {
    readonly dev: number
    readonly ino: number
    readonly birthtimeMs: number
  }
}

interface RegistryRow {
  readonly generation: string
  readonly digest: string
  readonly state: "pending" | "active" | "releasing"
  readonly body: string
}

interface CleanupLockRef {
  readonly key: string
  readonly generation: string
  readonly name: string
  readonly state: "active" | "retiring" | "pending"
}

interface CleanupRetirement {
  readonly schemaVersion: 1
  readonly claimKey: string
  readonly generation: string
  readonly database: SqliteAuthority["identity"]
  readonly journal: SqliteAuthority["identity"]
}

const sqliteAuthorities = new WeakMap<Database, SqliteAuthority>()
const cleanupTurns = new Map<string, Promise<void>>()

class RetryableRegistryBusy extends Error {
  constructor(readonly original: unknown) {
    super("Visual host claim registry is busy")
  }
}

export function make(input: Omit<Body, "schemaVersion" | "generation">): Body {
  return validate({ schemaVersion: CLAIM_VERSION, generation: randomBytes(32).toString("hex"), ...input })
}

export function keyOf(input: Pick<Body, "workflowID" | "stageID" | "purpose" | "revision">): string {
  const purpose = input.purpose === "reference" ? "reference" : `implementation:${input.revision}`
  return createHash("sha256")
    .update("opencode.workflow.visual-host.claim.v1\0")
    .update(String(input.workflowID))
    .update("\0")
    .update(String(input.stageID))
    .update("\0")
    .update(purpose)
    .digest("hex")
}

export function digest(body: Body): string {
  return createHash("sha256").update(encode(body)).digest("hex")
}

export async function acquire(root: string, body: Body, hooks: AcquireHooks = {}): Promise<AcquireResult> {
  const directory = await claimsDirectory(root, hooks)
  const key = keyOf(body)
  await assertAuthorizedClaimDirectory(directory, {
    afterExistingPrecheck: hooks.afterRegistryPrecheck,
  })
  const file = path.join(directory, `${key}.json`)
  const encoded = encode(body)
  const sha256 = createHash("sha256").update(encoded).digest("hex")
  const observed = await withRegistry(directory, (database) => registryRow(database, key))
  if (observed !== undefined) {
    return { status: "contended", claim: await registeredClaim(file, key, observed, false) }
  }
  await assertNoUnregisteredClaimEntries(directory, key)
  const pending:
    | { readonly status: "pending"; readonly claim: Owned }
    | { readonly status: "contended"; readonly row: RegistryRow } = await withRegistry(directory, (database) => {
    const existing = registryRow(database, key)
    if (existing !== undefined) return { status: "contended" as const, row: existing }
    const inserted = sqlite(database, () =>
      database
        .query(
          "INSERT INTO visual_host_claim (claim_key, generation, digest, state, body) VALUES (?, ?, ?, 'pending', ?)",
        )
        .run(key, body.generation, sha256, encoded),
    )
    if (inserted.changes !== 1) throw new TypeError("Visual host pending claim was not inserted")
    return {
      status: "pending" as const,
      claim: owned(file, key, body, sha256, "pending"),
    }
  })
  if (pending.status === "contended") {
    return { status: "contended", claim: await registeredClaim(file, key, pending.row, false) }
  }
  await hooks.afterPendingInserted?.()
  await assertAuthorizedClaimDirectory(directory)
  await withRegistry(directory, async (database) => {
    const row = registryRow(database, key)
    assertRow(row, pending.claim, "pending")
    await assertRegistrySnapshot(directory, registryRows(database))
    await createMirror(directory, key, body, encoded, hooks)
    await exactMirror(file, pending.claim)
    const promoted = sqlite(database, () =>
      database
        .query(
          "UPDATE visual_host_claim SET state = 'active' WHERE claim_key = ? AND generation = ? AND digest = ? AND state = 'pending' AND body = ?",
        )
        .run(key, body.generation, sha256, encoded),
    )
    if (promoted.changes !== 1) throw new TypeError("Visual host claim promotion lost authority")
  })
  await hooks.afterPromoted?.()
  const mirror = await exactMirror(file, { ...pending.claim, state: "active" })
  return { status: "acquired", claim: { ...mirror, registered: true, state: "active" } }
}

export async function list(root: string): Promise<readonly Owned[]> {
  const directory = await claimsDirectory(root)
  const rows = await withRegistry(directory, registryRows)
  const registered = await Promise.all(
    rows.map((row) =>
      registeredClaim(path.join(directory, `${row.claimKey}.json`), row.claimKey, {
        generation: row.generation,
        digest: row.digest,
        state: row.state,
        body: row.body,
      }),
    ),
  )
  const cleanupKeys = await assertExactClaimDirectory(directory, registered)
  const settledRows = await withRegistry(directory, registryRows)
  if (JSON.stringify(settledRows) !== JSON.stringify(rows)) {
    throw new TypeError("Visual host claim registry changed during its filesystem snapshot")
  }
  const snapshot = { registered, cleanupKeys }
  for (const lock of snapshot.cleanupKeys) await retireCleanupLock(directory, lock)
  return snapshot.registered
}

export async function assertActive(root: string, claim: Owned): Promise<Owned> {
  const directory = await claimsDirectory(root)
  await assertAuthorizedClaimDirectory(directory)
  const row = await withRegistry(directory, (database) => {
    const row = registryRow(database, claim.key)
    assertRow(row, { ...claim, state: "active" }, "active")
    return row
  })
  const registered = await registeredClaim(claim.file, claim.key, row)
  await assertAuthorizedClaimDirectory(directory)
  await withRegistry(directory, (database) => {
    assertRow(registryRow(database, claim.key), { ...claim, state: "active" }, "active")
  })
  return registered
}

export function beginRelease(root: string, claim: Owned): Promise<Owned>
export function beginRelease(root: string, claim: Owned, finalGate: () => Promise<boolean>): Promise<Owned | undefined>
export async function beginRelease(
  root: string,
  claim: Owned,
  finalGate?: () => Promise<boolean>,
): Promise<Owned | undefined> {
  if (claim.state === "pending") {
    throw new TypeError("Visual host pending claim cannot transition directly to releasing")
  }
  const directory = await claimsDirectory(root)
  await assertAuthorizedClaimDirectory(directory)
  return withRegistry(directory, async (database) => {
    const row = registryRow(database, claim.key)
    assertRow(row, claim, claim.state)
    if (claim.state === "releasing") return { ...claim, state: "releasing" }
    if (finalGate !== undefined && !(await finalGate())) return undefined
    const transitioned = sqlite(database, () =>
      database
        .query(
          "UPDATE visual_host_claim SET state = 'releasing' WHERE claim_key = ? AND generation = ? AND digest = ? AND state = ? AND body = ?",
        )
        .run(claim.key, claim.body.generation, claim.sha256, claim.state, encode(claim.body)),
    )
    if (transitioned.changes !== 1) throw new TypeError("Visual host claim release transition lost authority")
    return { ...claim, state: "releasing" }
  })
}

export async function rollbackPending(
  root: string,
  claim: Owned,
  verifyNoSideEffect: () => Promise<void>,
  finalGate?: () => Promise<boolean>,
): Promise<boolean> {
  if (claim.state !== "pending") throw new TypeError("Visual host claim is not pending")
  const directory = await claimsDirectory(root)
  return withCleanupLock(directory, claim, async () => {
    return withRegistry(directory, async (database) => {
      await assertRegistrySnapshot(directory, registryRows(database))
      assertRow(registryRow(database, claim.key), claim, "pending")
      await verifyNoSideEffect()
      if (finalGate !== undefined && !(await finalGate())) return false
      assertRow(registryRow(database, claim.key), claim, "pending")
      if (!(await removeExactClaimFiles(directory, claim, finalGate))) return false
      if (finalGate !== undefined && !(await finalGate())) return false
      assertRow(registryRow(database, claim.key), claim, "pending")
      const removed = sqlite(database, () =>
        database
          .query(
            "DELETE FROM visual_host_claim WHERE claim_key = ? AND generation = ? AND digest = ? AND state = 'pending' AND body = ?",
          )
          .run(claim.key, claim.body.generation, claim.sha256, encode(claim.body)),
      )
      if (removed.changes !== 1) throw new TypeError("Visual host pending claim compare-delete failed")
      return true
    })
  })
}

export async function finishRelease(
  root: string,
  claim: Owned,
  cleanup: () => Promise<void | boolean>,
  hooks: FinishReleaseHooks = {},
): Promise<boolean> {
  if (claim.state !== "releasing") throw new TypeError("Visual host claim is not releasing")
  const directory = await claimsDirectory(root)
  return withCleanupLock(
    directory,
    claim,
    async () => {
      await assertAuthorizedClaimDirectory(directory)
      await withRegistry(directory, (database) => {
        assertRow(registryRow(database, claim.key), claim, "releasing")
      })
      await reconcilePendingMirror(directory, claim, false)
      if ((await cleanup()) === false) return false
      await withRegistry(directory, (database) => {
        assertRow(registryRow(database, claim.key), claim, "releasing")
      })
      await hooks.beforeAuthorityDelete?.()
      if (hooks.finalGate !== undefined && !(await hooks.finalGate())) return false
      if (!(await removeExactClaimFiles(directory, claim, hooks.finalGate))) return false
      await hooks.afterMirrorUnlinked?.()
      if (hooks.finalGate !== undefined && !(await hooks.finalGate())) return false
      await withRegistry(directory, (database) => {
        assertRow(registryRow(database, claim.key), claim, "releasing")
        const removed = sqlite(database, () =>
          database
            .query(
              "DELETE FROM visual_host_claim WHERE claim_key = ? AND generation = ? AND digest = ? AND state = 'releasing' AND body = ?",
            )
            .run(claim.key, claim.body.generation, claim.sha256, encode(claim.body)),
        )
        if (removed.changes !== 1) throw new TypeError("Visual host claim compare-delete failed")
      })
      await hooks.afterRowDeleted?.()
      return true
    },
    hooks,
  )
}

export async function read(file: string): Promise<Owned> {
  return readClaimFile(file)
}

async function readClaimFile(file: string, allowedLinks?: ReadonlySet<number>): Promise<Owned> {
  const lexical = path.resolve(file)
  const name = path.basename(lexical)
  if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new TypeError("Invalid visual host claim name")
  const key = name.slice(0, 64)
  const text = await readAuthorityFile(lexical, allowedLinks)
  const value: unknown = JSON.parse(text)
  if (JSON.stringify(value) !== text) throw new TypeError("Visual host claim is not canonical JSON")
  const body = validate(value)
  if (keyOf(body) !== key) throw new TypeError("Visual host claim slot does not match its authority")
  return {
    key,
    file: lexical,
    body,
    sha256: createHash("sha256").update(text).digest("hex"),
    registered: false,
    state: "pending",
  }
}

async function withRegistry<A>(
  directory: string,
  run: (database: Database) => A | Promise<A>,
  hooks: {
    readonly afterCreated?: (file: string) => Promise<void>
    readonly afterExistingPrecheck?: (file: string) => Promise<void>
    readonly afterPendingCreated?: (file: string) => Promise<void>
    readonly afterPendingInitialized?: (file: string) => Promise<void>
    readonly afterPublished?: (file: string) => Promise<void>
    readonly afterPendingRemoved?: (file: string) => Promise<void>
  } = {},
): Promise<A> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      return await withRegistryAttempt(directory, run, hooks)
    } catch (cause) {
      if (!(cause instanceof RetryableRegistryBusy) || Date.now() >= deadline) {
        throw cause instanceof RetryableRegistryBusy ? cause.original : cause
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}

async function withRegistryAttempt<A>(
  directory: string,
  run: (database: Database) => A | Promise<A>,
  hooks: {
    readonly afterCreated?: (file: string) => Promise<void>
    readonly afterExistingPrecheck?: (file: string) => Promise<void>
    readonly afterPendingCreated?: (file: string) => Promise<void>
    readonly afterPendingInitialized?: (file: string) => Promise<void>
    readonly afterPublished?: (file: string) => Promise<void>
    readonly afterPendingRemoved?: (file: string) => Promise<void>
  },
): Promise<A> {
  const file = path.join(directory, "claims.sqlite")
  const authority = await prepareRegistryAuthority(directory, file, hooks)
  let database: Database | undefined
  let transaction = false
  let runStarted = false
  try {
    database = checkedSqliteBoundary(
      authority,
      () => new Database(sqlitePath(file), { create: false, readwrite: true, strict: true }),
    )
    sqliteAuthorities.set(database, authority)
    verifyRegistrySchema(database)
    sqlite(database, () => database!.exec("PRAGMA journal_mode = PERSIST"))
    sqlite(database, () => database!.exec("PRAGMA synchronous = FULL"))
    sqlite(database, () => database!.exec("PRAGMA trusted_schema = OFF"))
    sqlite(database, () => database!.exec("PRAGMA busy_timeout = 0"))
    sqlite(database, () => database!.exec("BEGIN IMMEDIATE"))
    transaction = true
    runStarted = true
    const result = await run(database)
    guardSqliteAuthority(authority)
    sqlite(database, () => database!.exec("COMMIT"))
    transaction = false
    return result
  } catch (cause) {
    if (transaction && database !== undefined) {
      try {
        sqlite(database, () => database!.exec("ROLLBACK"))
      } catch {
        // The original authority failure remains the useful failure.
      }
    }
    if (!runStarted && isSqliteBusy(cause)) throw new RetryableRegistryBusy(cause)
    throw cause
  } finally {
    if (database !== undefined) {
      try {
        checkedSqliteBoundary(authority, () => database!.close())
      } finally {
        sqliteAuthorities.delete(database)
      }
    }
    guardSqliteAuthority(authority)
  }
}

async function withCleanupLock<A>(
  directory: string,
  claim: Owned,
  run: () => Promise<A>,
  hooks: FinishReleaseHooks = {},
): Promise<A> {
  const key = claim.key
  const turnKey = process.platform === "win32" ? `${directory}\0${key}`.toLowerCase() : `${directory}\0${key}`
  const previous = cleanupTurns.get(turnKey) ?? Promise.resolve()
  let releaseTurn!: () => void
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  cleanupTurns.set(turnKey, turn)
  await previous
  try {
    return await withOwnedCleanupLock(directory, claim, run, hooks)
  } finally {
    releaseTurn()
    if (cleanupTurns.get(turnKey) === turn) cleanupTurns.delete(turnKey)
  }
}

async function withOwnedCleanupLock<A>(
  directory: string,
  claim: Owned,
  run: () => Promise<A>,
  hooks: FinishReleaseHooks,
): Promise<A> {
  const key = claim.key
  const initiallyRegistered = await withRegistry(directory, (registry) => sameRegisteredClaim(registry, claim))
  if (!initiallyRegistered) throw new TypeError("Visual host claim generation lost cleanup authority")
  await hooks.afterCleanupClaimPrecheck?.()
  const lockDirectory = path.join(directory, ".cleanup")
  let authority: SqliteAuthority
  for (;;) {
    await fs.mkdir(lockDirectory).catch((cause) => {
      if (!isFileSystemError(cause, "EEXIST")) throw cause
    })
    try {
      const canonicalDirectory = await fs.realpath(lockDirectory)
      const directoryStat = await fs.lstat(lockDirectory)
      if (canonicalDirectory !== lockDirectory || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new TypeError("Visual host cleanup lock directory changed")
      }
      await hooks.afterCleanupRootReady?.(lockDirectory)
      authority = await prepareCleanupLockAuthority(lockDirectory, claim, hooks)
      break
    } catch (cause) {
      if (isFileSystemError(cause, "ENOENT")) continue
      throw cause
    }
  }
  const file = authority.file
  let database: Database | undefined
  let transaction = false
  let outcome: { readonly success: true; readonly value: A } | { readonly success: false; readonly cause: unknown }
  try {
    database = checkedSqliteBoundary(
      authority,
      () => new Database(sqlitePath(file), { create: false, readwrite: true, strict: true }),
    )
    sqliteAuthorities.set(database, authority)
    sqlite(database, () => database!.exec("PRAGMA journal_mode = PERSIST"))
    sqlite(database, () => database!.exec("PRAGMA synchronous = FULL"))
    sqlite(database, () => database!.exec("PRAGMA trusted_schema = OFF"))
    sqlite(database, () => database!.exec("PRAGMA busy_timeout = 30000"))
    verifyCleanupLockSchemaAndRow(database, key, claim.body.generation)
    await hooks.afterLockOpened?.()
    sqlite(database, () => database!.exec("BEGIN IMMEDIATE"))
    transaction = true
    const result = await run()
    guardSqliteAuthority(authority)
    sqlite(database, () => database!.exec("COMMIT"))
    transaction = false
    outcome = { success: true, value: result }
  } catch (cause) {
    if (transaction && database !== undefined) {
      try {
        sqlite(database, () => database!.exec("ROLLBACK"))
      } catch {
        // The original authority failure remains the useful failure.
      }
    }
    outcome = { success: false, cause }
  } finally {
    if (database !== undefined) {
      try {
        checkedSqliteBoundary(authority, () => database!.close())
      } finally {
        sqliteAuthorities.delete(database)
      }
    }
    guardSqliteAuthority(authority)
  }
  let retireFailure: unknown
  try {
    await hooks.beforeCleanupLockRetire?.()
    await retireCleanupLock(
      directory,
      {
        key,
        generation: claim.body.generation,
        name: cleanupLockName(key, claim.body.generation),
        state: "active",
      },
      hooks,
    )
  } catch (cause) {
    retireFailure = cause
  }
  if (retireFailure !== undefined) {
    if (!outcome.success) throw new AggregateError([outcome.cause, retireFailure], "Visual host cleanup lock failed")
    throw retireFailure
  }
  if (!outcome.success) throw outcome.cause
  return outcome.value
}

function cleanupLockName(key: string, generation: string): string {
  return `${key}.${generation}.lock`
}

async function prepareCleanupLockAuthority(
  root: string,
  claim: Owned,
  hooks: FinishReleaseHooks,
): Promise<SqliteAuthority> {
  const name = cleanupLockName(claim.key, claim.body.generation)
  const directory = path.join(root, name)
  if (await fs.exists(directory)) {
    return cleanupLockAuthority(directory, claim.key, claim.body.generation, hooks.afterCleanupPrecheck)
  }

  const staging = path.join(root, `${claim.key}.${claim.body.generation}.${randomBytes(16).toString("hex")}.pending`)
  await fs.mkdir(staging)
  const created = await fs.lstat(staging)
  let published = false
  try {
    const file = path.join(staging, "cleanup.sqlite")
    await createEmptySqlitePair(file)
    await initializeCleanupLockPending(staging, file, claim.key, claim.body.generation)
    await hooks.afterCleanupLockPendingInitialized?.(file)
    await withRegistry(path.dirname(root), (registry) => {
      if (!sameRegisteredClaim(registry, claim)) {
        throw new TypeError("Visual host claim generation lost cleanup authority before lock publication")
      }
    })
    try {
      await fs.rename(staging, directory)
      published = true
    } catch (cause) {
      if (!isFileSystemError(cause, "EEXIST") && !isFileSystemError(cause, "ENOENT")) throw cause
      if (!(await fs.exists(directory))) throw cause
    }

    if (!published && (await fs.exists(staging))) {
      await removeCreatedCleanupStaging(root, staging, created)
    }
    const authority = await cleanupLockAuthority(
      directory,
      claim.key,
      claim.body.generation,
      published || !(await fs.exists(staging)) ? undefined : hooks.afterCleanupPrecheck,
    )
    const directoryStat = await fs.lstat(directory)
    const isCreatedAuthority =
      directoryStat.dev === created.dev &&
      directoryStat.ino === created.ino &&
      directoryStat.birthtimeMs === created.birthtimeMs
    if (isCreatedAuthority) await hooks.afterCleanupLockCreated?.(authority.file)
    return authority
  } catch (cause) {
    if (await fs.exists(staging)) {
      try {
        await removeCreatedCleanupStaging(root, staging, created)
      } catch (cleanupCause) {
        // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains both the primary and cleanup failures.
        throw new AggregateError([cause, cleanupCause], "Visual host cleanup lock staging cleanup failed", {
          cause: cleanupCause,
        })
      }
    }
    throw cause
  }
}

async function cleanupLockAuthority(
  directory: string,
  key: string,
  generation: string,
  afterPrecheck?: (file: string) => Promise<void>,
): Promise<SqliteAuthority> {
  const name = path.basename(directory)
  const active = cleanupLockName(key, generation)
  const pending = `${key}.${generation}.`
  const validName =
    name === active ||
    (name.startsWith(pending) &&
      (/^[a-f0-9]{32}\.pending$/.test(name.slice(pending.length)) ||
        /^[a-f0-9]{32}\.retiring$/.test(name.slice(pending.length))))
  if (!validName) throw new TypeError("Invalid visual host cleanup lock directory name")
  const canonical = await fs.realpath(directory)
  const stat = await fs.lstat(directory)
  if (canonical !== directory || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("Visual host cleanup lock directory changed")
  }
  const entries = await fs.readdir(directory, { withFileTypes: true })
  if (entries.some((entry) => entry.name === "cleanup.sqlite-wal" || entry.name === "cleanup.sqlite-shm")) {
    throw new TypeError("Visual host cleanup WAL/SHM sidecars are forbidden in PERSIST mode")
  }
  if (
    entries.length !== 2 ||
    entries.some(
      (entry) =>
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        (entry.name !== "cleanup.sqlite" && entry.name !== "cleanup.sqlite-journal"),
    )
  ) {
    throw new TypeError("Visual host cleanup lock PERSIST pair is incomplete")
  }
  const file = path.join(directory, "cleanup.sqlite")
  return existingSqliteAuthority(directory, file, false, afterPrecheck)
}

async function createEmptySqlitePair(file: string): Promise<void> {
  for (const candidate of [file, `${file}-journal`]) {
    const handle = await fs.open(candidate, "wx", 0o600)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

async function initializeCleanupLockPending(
  root: string,
  file: string,
  key: string,
  generation: string,
): Promise<void> {
  const authority = await existingSqliteAuthority(root, file, true)
  let database: Database | undefined
  let transaction = false
  try {
    database = checkedSqliteBoundary(
      authority,
      () => new Database(sqlitePath(file), { create: false, readwrite: true, strict: true }),
    )
    sqliteAuthorities.set(database, authority)
    sqlite(database, () => database!.exec("PRAGMA journal_mode = PERSIST"))
    sqlite(database, () => database!.exec("PRAGMA synchronous = FULL"))
    sqlite(database, () => database!.exec("PRAGMA trusted_schema = OFF"))
    sqlite(database, () => database!.exec("PRAGMA busy_timeout = 5000"))
    sqlite(database, () => database!.exec("BEGIN IMMEDIATE"))
    transaction = true
    ensureCleanupLockInitialized(database, key, generation, true)
    sqlite(database, () => database!.exec("COMMIT"))
    transaction = false
    verifyCleanupLockSchemaAndRow(database, key, generation)
  } catch (cause) {
    if (transaction && database !== undefined) {
      try {
        sqlite(database, () => database!.exec("ROLLBACK"))
      } catch {
        // Preserve the initialization failure.
      }
    }
    throw cause
  } finally {
    if (database !== undefined) {
      try {
        checkedSqliteBoundary(authority, () => database!.close())
      } finally {
        sqliteAuthorities.delete(database)
      }
    }
    guardSqliteAuthority(authority)
  }
  const handle = await fs.open(file, "r+")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  guardSqliteAuthority(authority)
}

async function removeCreatedCleanupStaging(root: string, directory: string, created: fsSync.Stats): Promise<void> {
  if (
    path.dirname(directory) !== root ||
    !/^[a-f0-9]{64}\.[a-f0-9]{64}\.[a-f0-9]{32}\.pending$/.test(path.basename(directory))
  ) {
    throw new TypeError("Invalid visual host cleanup staging path")
  }
  const canonical = await fs.realpath(directory)
  const stat = await fs.lstat(directory)
  if (
    canonical !== directory ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== created.dev ||
    stat.ino !== created.ino ||
    stat.birthtimeMs !== created.birthtimeMs
  ) {
    throw new TypeError("Visual host cleanup staging identity changed")
  }
  const entries = await fs.readdir(directory, { withFileTypes: true })
  if (
    entries.some(
      (entry) =>
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        (entry.name !== "cleanup.sqlite" && entry.name !== "cleanup.sqlite-journal"),
    )
  ) {
    throw new TypeError("Unexpected visual host cleanup staging state")
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (!singleOwnerRegular(await fs.lstat(file)) || (await fs.realpath(file)) !== file) {
      throw new TypeError("Visual host cleanup staging file identity changed")
    }
  }
  for (const entry of entries) await fs.unlink(path.join(directory, entry.name))
  await fs.rmdir(directory)
}

async function retireCleanupLock(
  directory: string,
  lock: CleanupLockRef,
  hooks: FinishReleaseHooks = {},
): Promise<boolean> {
  const { key, generation } = lock
  const lockDirectory = path.join(directory, ".cleanup")
  let ownedDirectory = path.join(lockDirectory, lock.name)
  if (!(await fs.exists(ownedDirectory))) {
    await removeEmptyCleanupDirectory(lockDirectory)
    if (!(await fs.exists(lockDirectory))) await hooks.afterCleanupRootRemoved?.(directory)
    return true
  }
  if (lock.state !== "active") {
    const registered = await withRegistry(directory, (registry) => registryGeneration(registry, key) === generation)
    if (registered) return false
    if (!(await removeRetiringCleanupLock(ownedDirectory, key, generation, hooks))) return false
    await hooks.afterCleanupLockRemoved?.(lockDirectory)
    await removeEmptyCleanupDirectory(lockDirectory)
    if (!(await fs.exists(lockDirectory))) await hooks.afterCleanupRootRemoved?.(directory)
    return true
  }
  if (lock.state === "active") {
    const registered = await withRegistry(directory, (registry) => registryGeneration(registry, key) === generation)
    if (registered) return false
    let retirement = await readCleanupRetirement(ownedDirectory, key, generation)
    if (retirement === undefined) {
      const authority = await cleanupLockAuthority(ownedDirectory, key, generation)
      let database: Database | undefined
      let transaction = false
      try {
        database = checkedSqliteBoundary(
          authority,
          () => new Database(sqlitePath(authority.file), { create: false, readwrite: true, strict: true }),
        )
        sqliteAuthorities.set(database, authority)
        sqlite(database, () => database!.exec("PRAGMA journal_mode = PERSIST"))
        sqlite(database, () => database!.exec("PRAGMA synchronous = FULL"))
        sqlite(database, () => database!.exec("PRAGMA trusted_schema = OFF"))
        sqlite(database, () => database!.exec("PRAGMA busy_timeout = 0"))
        verifyCleanupLockSchemaAndRow(database, key, generation)
        sqlite(database, () => database!.exec("BEGIN IMMEDIATE"))
        transaction = true
        sqlite(database, () => database!.exec("COMMIT"))
        transaction = false
      } catch (cause) {
        if (transaction && database !== undefined) {
          try {
            sqlite(database, () => database!.exec("ROLLBACK"))
          } catch {
            // Preserve the first cleanup-lock failure.
          }
        }
        if (isSqliteBusy(cause)) return false
        throw cause
      } finally {
        if (database !== undefined) {
          try {
            checkedSqliteBoundary(authority, () => database!.close())
          } finally {
            sqliteAuthorities.delete(database)
          }
        }
        guardSqliteAuthority(authority)
      }
      retirement = await ensureCleanupRetirement(ownedDirectory, authority, key, generation, hooks)
    }
    await validateCleanupRetirementFiles(ownedDirectory, retirement)
    const retiringName = `${key}.${generation}.${randomBytes(16).toString("hex")}.retiring`
    const retiring = path.join(lockDirectory, retiringName)
    try {
      await fs.rename(ownedDirectory, retiring)
    } catch (cause) {
      if (isSharingViolation(cause)) return false
      throw cause
    }
    ownedDirectory = retiring
    await hooks.afterCleanupLockRetired?.(retiring)
  }
  if (!(await removeRetiringCleanupLock(ownedDirectory, key, generation, hooks))) return false
  await hooks.afterCleanupLockRemoved?.(lockDirectory)
  await removeEmptyCleanupDirectory(lockDirectory)
  if (!(await fs.exists(lockDirectory))) await hooks.afterCleanupRootRemoved?.(directory)
  return true
}

async function removeRetiringCleanupLock(
  directory: string,
  key: string,
  generation: string,
  hooks: FinishReleaseHooks = {},
): Promise<boolean> {
  const name = path.basename(directory)
  const transient = new RegExp(`^${key}\\.${generation}\\.[a-f0-9]{32}\\.(?:pending|retiring)$`)
  if (path.dirname(directory) === directory || !transient.test(name)) {
    throw new TypeError("Invalid visual host cleanup retirement path")
  }
  if ((await fs.readdir(directory)).length === 0) {
    await fs.rmdir(directory)
    return true
  }
  let retirement = await readCleanupRetirement(directory, key, generation)
  if (retirement === undefined) {
    const authority = await cleanupLockAuthority(directory, key, generation)
    let database: Database | undefined
    try {
      database = checkedSqliteBoundary(
        authority,
        () => new Database(sqlitePath(authority.file), { create: false, readonly: true, strict: true }),
      )
      sqliteAuthorities.set(database, authority)
      verifyCleanupLockSchemaAndRow(database, key, generation)
    } finally {
      if (database !== undefined) {
        try {
          checkedSqliteBoundary(authority, () => database!.close())
        } finally {
          sqliteAuthorities.delete(database)
        }
      }
      guardSqliteAuthority(authority)
    }
    retirement = await ensureCleanupRetirement(directory, authority, key, generation, hooks)
  }
  await validateCleanupRetirementFiles(directory, retirement)
  try {
    const journal = path.join(directory, "cleanup.sqlite-journal")
    if (await fs.exists(journal)) await fs.unlink(journal)
    await hooks.afterCleanupJournalRemoved?.(directory)
    const database = path.join(directory, "cleanup.sqlite")
    if (await fs.exists(database)) await fs.unlink(database)
    await hooks.afterCleanupDatabaseRemoved?.(directory)
    await fs.unlink(path.join(directory, "retire.json"))
    await hooks.afterCleanupMarkerRemoved?.(directory)
    await fs.rmdir(directory)
  } catch (cause) {
    if (isSharingViolation(cause)) return false
    throw cause
  }
  return true
}

async function ensureCleanupRetirement(
  directory: string,
  authority: SqliteAuthority,
  key: string,
  generation: string,
  hooks: FinishReleaseHooks = {},
): Promise<CleanupRetirement> {
  const existing = await readCleanupRetirement(directory, key, generation)
  if (existing !== undefined) return existing
  await hooks.beforeCleanupRetirementPublish?.()
  const body: CleanupRetirement = Object.freeze({
    schemaVersion: 1,
    claimKey: key,
    generation,
    database: authority.identity,
    journal: authority.journalIdentity,
  })
  const encoded = JSON.stringify(body)
  const pending = path.join(directory, `.retire.${randomBytes(16).toString("hex")}.pending`)
  const handle = await fs.open(pending, "wx", 0o600)
  let created: Awaited<ReturnType<typeof fs.lstat>>
  try {
    await handle.writeFile(encoded, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  created = await fs.lstat(pending)
  await hooks.afterCleanupRetirementPendingCreated?.(pending)
  const target = path.join(directory, "retire.json")
  try {
    await fs.link(pending, target)
    await hooks.afterCleanupRetirementLinked?.(target)
    await fs.unlink(pending).catch((cause) => {
      if (!isFileSystemError(cause, "ENOENT")) throw cause
    })
  } catch (cause) {
    if (!(await fs.exists(target))) throw cause
    await removeCreatedRetirementPending(pending, created, encoded)
  }
  return (await readCleanupRetirement(directory, key, generation)) ?? body
}

async function removeCreatedRetirementPending(
  file: string,
  created: Awaited<ReturnType<typeof fs.lstat>>,
  encoded: string,
): Promise<void> {
  if (!/^\.retire\.[a-f0-9]{32}\.pending$/.test(path.basename(file))) {
    throw new TypeError("Invalid visual host cleanup retirement pending path")
  }
  if (!(await fs.exists(file))) return
  const canonical = await fs.realpath(file)
  const stat = await fs.lstat(file)
  if (
    canonical !== file ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.dev !== created.dev ||
    stat.ino !== created.ino ||
    stat.birthtimeMs !== created.birthtimeMs ||
    (await fs.readFile(file, "utf8")) !== encoded
  ) {
    throw new TypeError("Visual host cleanup retirement pending identity changed")
  }
  await fs.unlink(file)
}

async function readCleanupRetirement(
  directory: string,
  key: string,
  generation: string,
): Promise<CleanupRetirement | undefined> {
  const target = path.join(directory, "retire.json")
  for (;;) {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const pending = entries
      .filter((entry) => /^\.retire\.[a-f0-9]{32}\.pending$/.test(entry.name))
      .toSorted((left, right) => left.name.localeCompare(right.name))
    const hasTarget = entries.some((entry) => entry.name === "retire.json")
    if (!hasTarget && pending.length === 0) return undefined
    if (pending.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      throw new TypeError("Ambiguous visual host cleanup retirement marker")
    }

    const markerNames = new Set([...(hasTarget ? ["retire.json"] : []), ...pending.map((entry) => entry.name)])
    const markers = [...markerNames].map((name) => path.join(directory, name))
    let retirement: CleanupRetirement | undefined
    let encoded: string | undefined
    let changed = false
    const markerStats = new Map<string, fsSync.Stats>()
    for (const marker of markers) {
      try {
        markerStats.set(marker, await fs.lstat(marker))
      } catch (cause) {
        if (isFileSystemError(cause, "ENOENT") || !(await fs.exists(marker))) {
          changed = true
          break
        }
        throw cause
      }
    }
    if (changed) continue
    assertCleanupRetirementMarkerLinks(
      target,
      pending.map((entry) => path.join(directory, entry.name)),
      markerStats,
      hasTarget,
    )
    for (const marker of markers) {
      let text: string
      try {
        text = await readAuthorityFile(marker, new Set([1, 2]))
      } catch (cause) {
        if (isFileSystemError(cause, "ENOENT") || !(await fs.exists(marker))) {
          changed = true
          break
        }
        throw cause
      }
      const current = validateCleanupRetirement(JSON.parse(text) as unknown, key, generation)
      if (encoded !== undefined && text !== encoded) {
        throw new TypeError("Visual host cleanup retirement marker changed")
      }
      encoded = text
      retirement = current
    }
    if (changed) continue
    if (retirement === undefined || encoded === undefined) continue
    await validateCleanupRetirementFiles(directory, retirement, markerNames)

    if (!hasTarget) {
      const source = path.join(directory, pending[0]!.name)
      try {
        await fs.link(source, target)
      } catch (cause) {
        if (!(await fs.exists(target))) {
          if (isFileSystemError(cause, "ENOENT")) continue
          throw cause
        }
      }
      continue
    }

    for (const entry of pending) {
      const file = path.join(directory, entry.name)
      await fs.unlink(file).catch((cause) => {
        if (!isFileSystemError(cause, "ENOENT")) throw cause
      })
    }
    if (pending.length !== 0) continue
    return retirement
  }
}

function assertCleanupRetirementMarkerLinks(
  target: string,
  pending: readonly string[],
  stats: ReadonlyMap<string, fsSync.Stats>,
  hasTarget: boolean,
): void {
  const targetStat = hasTarget ? stats.get(target) : undefined
  if (
    hasTarget &&
    (targetStat === undefined ||
      !targetStat.isFile() ||
      targetStat.isSymbolicLink() ||
      (targetStat.nlink !== 1 && targetStat.nlink !== 2))
  ) {
    throw new TypeError("Ambiguous visual host cleanup retirement marker")
  }
  const independent = new Set<string>()
  let targetLinks = 0
  for (const file of pending) {
    const stat = stats.get(file)
    if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
      throw new TypeError("Ambiguous visual host cleanup retirement marker")
    }
    const sameTarget = targetStat !== undefined && stat.dev === targetStat.dev && stat.ino === targetStat.ino
    if (sameTarget) {
      targetLinks++
      if (stat.nlink !== 2 || targetStat.nlink !== 2) {
        throw new TypeError("Ambiguous visual host cleanup retirement marker")
      }
      continue
    }
    if (stat.nlink !== 1) throw new TypeError("Ambiguous visual host cleanup retirement marker")
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
    if (independent.has(identity)) throw new TypeError("Ambiguous visual host cleanup retirement marker")
    independent.add(identity)
  }
  if (
    targetLinks > 1 ||
    (targetStat?.nlink === 2 && targetLinks !== 1) ||
    (targetStat?.nlink === 1 && targetLinks !== 0)
  ) {
    throw new TypeError("Ambiguous visual host cleanup retirement marker")
  }
}

function validateCleanupRetirement(value: unknown, key: string, generation: string): CleanupRetirement {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 5 ||
    Reflect.get(value, "schemaVersion") !== 1 ||
    Reflect.get(value, "claimKey") !== key ||
    Reflect.get(value, "generation") !== generation
  ) {
    throw new TypeError("Invalid visual host cleanup retirement marker")
  }
  const database = cleanupRetirementIdentity(Reflect.get(value, "database"))
  const journal = cleanupRetirementIdentity(Reflect.get(value, "journal"))
  return Object.freeze({ schemaVersion: 1, claimKey: key, generation, database, journal })
}

function cleanupRetirementIdentity(value: unknown): SqliteAuthority["identity"] {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 3 ||
    !Number.isInteger(Reflect.get(value, "dev")) ||
    Number(Reflect.get(value, "dev")) < 0 ||
    !Number.isInteger(Reflect.get(value, "ino")) ||
    Number(Reflect.get(value, "ino")) < 0 ||
    !Number.isFinite(Reflect.get(value, "birthtimeMs"))
  ) {
    throw new TypeError("Invalid visual host cleanup retirement identity")
  }
  return Object.freeze({
    dev: Number(Reflect.get(value, "dev")),
    ino: Number(Reflect.get(value, "ino")),
    birthtimeMs: Number(Reflect.get(value, "birthtimeMs")),
  })
}

async function validateCleanupRetirementFiles(
  directory: string,
  retirement: CleanupRetirement,
  markerNames: ReadonlySet<string> = new Set(["retire.json"]),
): Promise<void> {
  const canonical = await fs.realpath(directory)
  const directoryStat = await fs.lstat(directory)
  if (canonical !== directory || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new TypeError("Visual host cleanup retirement directory changed")
  }
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const allowed = new Set(["cleanup.sqlite", "cleanup.sqlite-journal", ...markerNames])
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !allowed.has(entry.name))) {
    throw new TypeError("Unexpected visual host cleanup retirement state")
  }
  for (const [name, expected] of [
    ["cleanup.sqlite", retirement.database],
    ["cleanup.sqlite-journal", retirement.journal],
  ] as const) {
    const file = path.join(directory, name)
    if (!(await fs.exists(file))) continue
    const current = sqliteFileIdentity(file)
    if (!sameRegistryIdentity(current, expected)) {
      throw new TypeError("Visual host cleanup retirement file identity changed")
    }
  }
}

async function removeEmptyCleanupDirectory(directory: string): Promise<void> {
  if (!(await fs.exists(directory))) return
  const canonical = await fs.realpath(directory)
  const stat = await fs.lstat(directory)
  if (canonical !== directory || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("Visual host cleanup lock directory changed before retirement")
  }
  try {
    await fs.rmdir(directory)
  } catch (cause) {
    if (isFileSystemError(cause, "ENOENT") || isFileSystemError(cause, "ENOTEMPTY")) return
    throw cause
  }
}

function ensureCleanupLockInitialized(database: Database, key: string, generation: string, registered: boolean): void {
  const objects = sqlite(
    database,
    () =>
      database
        .query(
          "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as Array<{
        readonly type: unknown
        readonly name: unknown
        readonly tableName: unknown
        readonly sql: unknown
      }>,
  )
  if (objects.length === 0) {
    if (!registered) throw new TypeError("Uninitialized visual host cleanup lock has no exact registered generation")
    sqlite(database, () => database.exec(cleanupLockSchema))
    sqlite(database, () =>
      database.query("INSERT INTO visual_host_cleanup_lock (claim_key, generation) VALUES (?, ?)").run(key, generation),
    )
  }
  verifyCleanupLockSchemaAndRow(database, key, generation)
}

function verifyCleanupLockSchemaAndRow(database: Database, key: string, generation: string): void {
  const settledObjects = sqlite(
    database,
    () =>
      database
        .query(
          "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as Array<{
        readonly type: unknown
        readonly name: unknown
        readonly tableName: unknown
        readonly sql: unknown
      }>,
  )
  if (
    settledObjects.length !== 1 ||
    settledObjects[0]?.type !== "table" ||
    settledObjects[0]?.name !== "visual_host_cleanup_lock" ||
    settledObjects[0]?.tableName !== "visual_host_cleanup_lock" ||
    typeof settledObjects[0]?.sql !== "string" ||
    normalizeSql(settledObjects[0].sql) !== normalizeSql(cleanupLockSchema)
  ) {
    throw new TypeError("Invalid visual host cleanup lock objects")
  }
  const columns = sqlite(
    database,
    () =>
      database.query("PRAGMA table_info(visual_host_cleanup_lock)").all() as Array<{
        readonly name: unknown
        readonly type: unknown
        readonly notnull: unknown
        readonly pk: unknown
      }>,
  )
  if (
    columns.length !== 2 ||
    columns[0]?.name !== "claim_key" ||
    columns[0]?.type !== "TEXT" ||
    columns[0]?.notnull !== 1 ||
    columns[0]?.pk !== 1 ||
    columns[1]?.name !== "generation" ||
    columns[1]?.type !== "TEXT" ||
    columns[1]?.notnull !== 1 ||
    columns[1]?.pk !== 2
  ) {
    throw new TypeError("Invalid visual host cleanup lock schema")
  }
  const rows = sqlite(
    database,
    () =>
      database.query("SELECT claim_key AS claimKey, generation FROM visual_host_cleanup_lock").all() as Array<{
        readonly claimKey: unknown
        readonly generation: unknown
      }>,
  )
  if (rows.length !== 1 || rows[0]?.claimKey !== key || rows[0]?.generation !== generation) {
    throw new TypeError("Visual host cleanup lock is not bound to its claim generation")
  }
  for (const pragma of ["quick_check", "integrity_check"] as const) {
    const result = sqlite(database, () => database.query(`PRAGMA ${pragma}`).get() as Record<string, unknown> | null)
    if (result?.[pragma] !== "ok" || Reflect.ownKeys(result).length !== 1) {
      throw new TypeError("Visual host cleanup lock integrity check failed")
    }
  }
}

function registryRow(database: Database, key: string): RegistryRow | undefined {
  const value = sqlite(
    database,
    () =>
      database.query("SELECT generation, digest, state, body FROM visual_host_claim WHERE claim_key = ?").get(key) as {
        readonly generation: unknown
        readonly digest: unknown
        readonly state: unknown
        readonly body: unknown
      } | null,
  )
  if (value === null) return undefined
  if (
    typeof value.generation !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.generation) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    (value.state !== "pending" && value.state !== "active" && value.state !== "releasing") ||
    typeof value.body !== "string"
  ) {
    throw new TypeError("Invalid visual host claim registry row")
  }
  return { generation: value.generation, digest: value.digest, state: value.state, body: value.body }
}

function registryGeneration(database: Database, key: string): string | undefined {
  return registryRow(database, key)?.generation
}

function sameRegisteredClaim(database: Database, claim: Owned): boolean {
  const row = registryRow(database, claim.key)
  return (
    row !== undefined &&
    row.generation === claim.body.generation &&
    row.digest === claim.sha256 &&
    row.body === encode(claim.body)
  )
}

function registryRows(database: Database): readonly (RegistryRow & { readonly claimKey: string })[] {
  const rows = sqlite(
    database,
    () =>
      database
        .query(
          "SELECT claim_key AS claimKey, generation, digest, state, body FROM visual_host_claim ORDER BY claim_key",
        )
        .all() as Array<{
        readonly claimKey: unknown
        readonly generation: unknown
        readonly digest: unknown
        readonly state: unknown
        readonly body: unknown
      }>,
  )
  return rows.map((row) => {
    if (typeof row.claimKey !== "string" || !/^[a-f0-9]{64}$/.test(row.claimKey)) {
      throw new TypeError("Invalid visual host claim registry key")
    }
    const settled = registryRow(database, row.claimKey)
    if (settled === undefined) throw new TypeError("Visual host claim registry row disappeared")
    return { claimKey: row.claimKey, ...settled }
  })
}

async function assertAuthorizedClaimDirectory(
  directory: string,
  hooks: {
    readonly afterCreated?: (file: string) => Promise<void>
    readonly afterExistingPrecheck?: (file: string) => Promise<void>
    readonly afterPendingCreated?: (file: string) => Promise<void>
    readonly afterPendingInitialized?: (file: string) => Promise<void>
    readonly afterPublished?: (file: string) => Promise<void>
    readonly afterPendingRemoved?: (file: string) => Promise<void>
  } = {},
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await withRegistry(directory, registryRows, attempt === 0 ? hooks : {})
    try {
      await assertRegistrySnapshot(directory, rows)
    } catch (cause) {
      const changed = JSON.stringify(await withRegistry(directory, registryRows)) !== JSON.stringify(rows)
      if (changed) continue
      throw cause
    }
    const settled = await withRegistry(directory, registryRows)
    if (JSON.stringify(settled) === JSON.stringify(rows)) return
  }
  throw new TypeError("Visual host claim registry did not settle during authorization")
}

async function assertRegistrySnapshot(
  directory: string,
  rows: readonly (RegistryRow & { readonly claimKey: string })[],
): Promise<void> {
  const claims = await Promise.all(
    rows.map((row) =>
      registeredClaim(
        path.join(directory, `${row.claimKey}.json`),
        row.claimKey,
        {
          generation: row.generation,
          digest: row.digest,
          state: row.state,
          body: row.body,
        },
        false,
      ),
    ),
  )
  await assertExactClaimDirectory(directory, claims)
}

async function registeredClaim(
  file: string,
  key: string,
  row: {
    readonly generation: string
    readonly digest: string
    readonly state: "pending" | "active" | "releasing"
    readonly body: string
  },
  normalizePending = true,
): Promise<Owned> {
  const value: unknown = JSON.parse(row.body)
  if (JSON.stringify(value) !== row.body) throw new TypeError("Visual host claim registry body is not canonical")
  const body = validate(value)
  if (
    keyOf(body) !== key ||
    body.generation !== row.generation ||
    createHash("sha256").update(row.body).digest("hex") !== row.digest ||
    path.basename(file) !== `${key}.json`
  ) {
    throw new TypeError("Visual host claim registry authority is invalid")
  }
  await reconcilePendingMirror(path.dirname(file), owned(file, key, body, row.digest, row.state), normalizePending)
  if (row.state === "pending" && !normalizePending) {
    const claim = owned(file, key, body, row.digest, row.state)
    if ((await fs.exists(file)) && (await fs.lstat(file)).nlink === 1) await exactMirror(file, claim)
    return claim
  }
  if (!(await fs.exists(file))) {
    if (row.state === "active") throw new TypeError("Active visual host claim has no exact mirror")
    return owned(file, key, body, row.digest, row.state)
  }
  const mirror = await exactMirror(file, owned(file, key, body, row.digest, row.state))
  return { ...mirror, registered: true, state: row.state }
}

function owned(file: string, key: string, body: Body, sha256: string, state: Owned["state"]): Owned {
  return { key, file, body, sha256, registered: true, state }
}

function assertRow(
  row: ReturnType<typeof registryRow>,
  claim: Owned,
  state: Owned["state"],
): asserts row is NonNullable<ReturnType<typeof registryRow>> {
  if (
    row === undefined ||
    row.generation !== claim.body.generation ||
    row.digest !== claim.sha256 ||
    row.state !== state ||
    row.body !== encode(claim.body)
  ) {
    throw new TypeError("Visual host claim generation lost registry authority")
  }
}

async function exactMirror(file: string, claim: Owned): Promise<Owned> {
  const mirror = await readClaimFile(file, claim.state === "pending" ? new Set([1, 2]) : undefined)
  if (
    mirror.key !== claim.key ||
    mirror.sha256 !== claim.sha256 ||
    mirror.body.generation !== claim.body.generation ||
    encode(mirror.body) !== encode(claim.body)
  ) {
    throw new TypeError("Visual host claim mirror differs from registry authority")
  }
  return { ...mirror, registered: true, state: claim.state }
}

async function reconcilePendingMirror(
  directory: string,
  claim: Owned,
  normalize = true,
  finalGate?: () => Promise<boolean>,
): Promise<boolean> {
  const prefix = `${claim.key}.${claim.body.hostID}.${claim.body.nonce}.`
  const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(
    (entry) => entry.name.startsWith(prefix) && entry.name.endsWith(".pending"),
  )
  if (entries.length === 0) return true
  if (entries.length !== 1 || !entries[0]?.isFile() || claim.state !== "pending") {
    throw new TypeError("Unexpected visual host pending claim state")
  }
  const pending = path.join(directory, entries[0].name)
  let text: string
  try {
    text = await readAuthorityFile(pending, new Set([1, 2]))
  } catch (cause) {
    if (isFileSystemError(cause, "ENOENT") || !(await fs.exists(pending))) return true
    throw cause
  }
  if (text !== encode(claim.body) || createHash("sha256").update(text).digest("hex") !== claim.sha256) {
    throw new TypeError("Visual host pending claim differs from registry authority")
  }
  if (!(await fs.exists(claim.file))) return true
  let pendingStat: fsSync.Stats
  try {
    pendingStat = await fs.lstat(pending)
  } catch (cause) {
    if (isFileSystemError(cause, "ENOENT") || !(await fs.exists(pending))) return true
    throw cause
  }
  const mirrorStat = await fs.lstat(claim.file)
  if (
    pendingStat.dev !== mirrorStat.dev ||
    pendingStat.ino !== mirrorStat.ino ||
    pendingStat.nlink !== 2 ||
    mirrorStat.nlink !== 2
  ) {
    throw new TypeError("Visual host pending hard-link state is ambiguous")
  }
  if (!normalize) return true
  if (finalGate !== undefined && !(await finalGate())) return false
  await fs.unlink(pending)
  return true
}

async function removeExactClaimFiles(
  directory: string,
  claim: Owned,
  finalGate?: () => Promise<boolean>,
): Promise<boolean> {
  if (!(await reconcilePendingMirror(directory, claim, claim.state === "pending", finalGate))) return false
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const prefix = `${claim.key}.${claim.body.hostID}.${claim.body.nonce}.`
  const pending = entries.filter((entry) => entry.name.startsWith(prefix) && entry.name.endsWith(".pending"))
  if (claim.state !== "pending" && pending.length !== 0) {
    throw new TypeError("Unexpected visual host pending claim state")
  }
  if (pending.length > 1) throw new TypeError("Multiple visual host pending files are ambiguous")
  for (const entry of pending) {
    if (!entry.isFile()) throw new TypeError("Visual host pending authority is not a file")
    const file = path.join(directory, entry.name)
    const text = await readAuthorityFile(file)
    if (text !== encode(claim.body)) throw new TypeError("Visual host pending authority changed")
    if (finalGate !== undefined && !(await finalGate())) return false
    await fs.unlink(file)
  }
  if (await fs.exists(claim.file)) {
    await exactMirror(claim.file, claim)
    if (finalGate !== undefined && !(await finalGate())) return false
    await fs.unlink(claim.file)
  }
  return true
}

async function assertNoUnregisteredClaimEntries(directory: string, key: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  if (entries.some((entry) => entry.name === `${key}.json` || entry.name.startsWith(`${key}.`))) {
    throw new TypeError("Visual host claim slot has unregistered authority")
  }
}

async function assertExactClaimDirectory(
  directory: string,
  claims: readonly Owned[],
): Promise<readonly CleanupLockRef[]> {
  const byKey = new Map(claims.map((claim) => [claim.key, claim]))
  const cleanupLocks: CleanupLockRef[] = []
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === ".cleanup") {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new TypeError("Visual host cleanup lock state is invalid")
      }
      const cleanupDirectory = path.join(directory, entry.name)
      const locks = await assertCleanupLockDirectory(cleanupDirectory)
      for (const lock of locks) {
        cleanupLocks.push(lock)
      }
      if (locks.length === 0) await removeEmptyCleanupDirectory(cleanupDirectory)
      continue
    }
    if (entry.name === "claims.sqlite" || entry.name === "claims.sqlite-journal") {
      if (!entry.isFile()) throw new TypeError("Visual host claim registry entry is not a file")
      continue
    }
    const mirror = /^([a-f0-9]{64})\.json$/.exec(entry.name)
    if (mirror !== null) {
      const claim = byKey.get(mirror[1] ?? "")
      if (claim === undefined || !entry.isFile()) throw new TypeError("Unregistered visual host claim mirror")
      await exactMirror(path.join(directory, entry.name), claim)
      continue
    }
    const pending = /^([a-f0-9]{64})\.([a-f0-9]{64})\.([a-f0-9]{64})\.([a-f0-9]{32})\.pending$/.exec(entry.name)
    if (pending !== null) {
      const claim = byKey.get(pending[1] ?? "")
      if (
        claim === undefined ||
        claim.state !== "pending" ||
        pending[2] !== claim.body.hostID ||
        pending[3] !== claim.body.nonce ||
        !entry.isFile()
      ) {
        throw new TypeError("Unregistered visual host pending authority")
      }
      continue
    }
    throw new TypeError("Unexpected visual host claim state")
  }
  for (const claim of claims) {
    if (claim.state === "active" && !(await fs.exists(claim.file))) {
      throw new TypeError("Active visual host claim mirror is missing")
    }
  }
  return cleanupLocks
}

async function assertCleanupLockDirectory(directory: string): Promise<readonly CleanupLockRef[]> {
  const canonical = await fs.realpath(directory)
  const stat = await fs.lstat(directory)
  if (canonical !== directory || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("Visual host cleanup lock directory is not canonical")
  }
  const locks: CleanupLockRef[] = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const active = /^([a-f0-9]{64})\.([a-f0-9]{64})\.lock$/.exec(entry.name)
    const transient = /^([a-f0-9]{64})\.([a-f0-9]{64})\.([a-f0-9]{32})\.(pending|retiring)$/.exec(entry.name)
    const match = active ?? transient
    if (match === null || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new TypeError("Unexpected visual host cleanup lock state")
    }
    const key = match[1] ?? ""
    const generation = match[2] ?? ""
    const state: CleanupLockRef["state"] = active !== null ? "active" : match[4] === "pending" ? "pending" : "retiring"
    const ownedDirectory = path.join(directory, entry.name)
    const canonicalDirectory = await fs.realpath(ownedDirectory)
    const directoryStat = await fs.lstat(ownedDirectory)
    if (canonicalDirectory !== ownedDirectory || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new TypeError("Visual host cleanup lock identity changed")
    }
    locks.push({ key, generation, name: entry.name, state })
  }
  const identities = new Set<string>()
  for (const lock of locks) {
    const identity = `${lock.key}:${lock.generation}:${lock.state}`
    if (identities.has(identity) && lock.state !== "pending") {
      throw new TypeError("Duplicate visual host cleanup lock authority")
    }
    identities.add(identity)
    await attestCleanupLock(path.join(directory, lock.name), lock)
  }
  return locks
}

async function attestCleanupLock(directory: string, lock: CleanupLockRef): Promise<void> {
  if (lock.state === "retiring" && (await fs.readdir(directory)).length === 0) return
  const retirement = await readCleanupRetirement(directory, lock.key, lock.generation)
  if (retirement !== undefined) {
    await validateCleanupRetirementFiles(directory, retirement)
    return
  }
  const authority = await cleanupLockAuthority(directory, lock.key, lock.generation)
  const file = authority.file
  let database: Database | undefined
  try {
    database = checkedSqliteBoundary(
      authority,
      () => new Database(sqlitePath(file), { create: false, readonly: true, strict: true }),
    )
    sqliteAuthorities.set(database, authority)
    verifyCleanupLockSchemaAndRow(database, lock.key, lock.generation)
  } finally {
    if (database !== undefined) {
      try {
        checkedSqliteBoundary(authority, () => database!.close())
      } finally {
        sqliteAuthorities.delete(database)
      }
    }
    guardSqliteAuthority(authority)
  }
}

async function createMirror(
  directory: string,
  key: string,
  body: Body,
  encoded: string,
  hooks: AcquireHooks = {},
): Promise<void> {
  const file = path.join(directory, `${key}.json`)
  const pending = path.join(directory, `${key}.${body.hostID}.${body.nonce}.${randomBytes(16).toString("hex")}.pending`)
  const handle = await fs.open(pending, "wx")
  try {
    await handle.writeFile(encoded, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.link(pending, file)
    await hooks.afterMirrorLinked?.()
    try {
      await fs.unlink(pending)
    } catch (cause) {
      if (!isFileSystemError(cause, "ENOENT")) throw cause
      const settled = await read(file)
      if (settled.sha256 !== createHash("sha256").update(encoded).digest("hex")) {
        throw new TypeError("Visual host claim mirror changed during pending reconciliation", { cause })
      }
    }
  } catch (cause) {
    await fs.unlink(pending).catch(() => undefined)
    throw cause
  }
}

async function prepareRegistryAuthority(
  root: string,
  file: string,
  hooks: {
    readonly afterCreated?: (file: string) => Promise<void>
    readonly afterExistingPrecheck?: (file: string) => Promise<void>
    readonly afterPendingCreated?: (file: string) => Promise<void>
    readonly afterPendingInitialized?: (file: string) => Promise<void>
    readonly afterPublished?: (file: string) => Promise<void>
    readonly afterPendingRemoved?: (file: string) => Promise<void>
  },
): Promise<SqliteAuthority> {
  return existingSqliteAuthority(root, file, false, hooks.afterExistingPrecheck)
}

async function existingSqliteAuthority(
  root: string,
  file: string,
  created: boolean,
  afterPrecheck?: (file: string) => Promise<void>,
): Promise<SqliteAuthority> {
  verifySqliteRoot(root)
  verifySqliteOwnedSet(root, file, true)
  const observed = sqliteFileIdentity(file)
  const observedJournal = sqliteFileIdentity(`${file}-journal`)
  await afterPrecheck?.(file)
  const identity = sqliteFileIdentity(file)
  const journalIdentity = sqliteFileIdentity(`${file}-journal`)
  if (!sameRegistryIdentity(observed, identity) || !sameRegistryIdentity(observedJournal, journalIdentity)) {
    throw new TypeError(
      created
        ? "Visual host SQLite path changed fixed identity"
        : "Visual host SQLite path changed prechecked identity",
    )
  }
  const authority: SqliteAuthority = {
    root,
    file,
    journal: `${file}-journal`,
    wal: `${file}-wal`,
    shm: `${file}-shm`,
    created,
    identity,
    journalIdentity,
  }
  guardSqliteAuthority(authority)
  return authority
}

async function initializeRegistryPending(root: string, file: string): Promise<void> {
  const authority: SqliteAuthority = {
    root,
    file,
    journal: `${file}-journal`,
    wal: `${file}-wal`,
    shm: `${file}-shm`,
    created: true,
    identity: sqliteFileIdentity(file),
    journalIdentity: sqliteFileIdentity(`${file}-journal`),
  }
  let database: Database | undefined
  let transaction = false
  try {
    database = checkedSqliteBoundary(
      authority,
      () => new Database(sqlitePath(file), { create: false, readwrite: true, strict: true }),
    )
    sqliteAuthorities.set(database, authority)
    sqlite(database, () => database!.exec("PRAGMA journal_mode = PERSIST"))
    sqlite(database, () => database!.exec("PRAGMA synchronous = FULL"))
    sqlite(database, () => database!.exec("PRAGMA trusted_schema = OFF"))
    sqlite(database, () => database!.exec("PRAGMA busy_timeout = 5000"))
    sqlite(database, () => database!.exec("BEGIN IMMEDIATE"))
    transaction = true
    sqlite(database, () => database!.exec(registrySchema))
    sqlite(database, () => database!.exec("COMMIT"))
    transaction = false
    verifyRegistrySchema(database)
    const count = sqlite(
      database,
      () => database!.query("SELECT COUNT(*) AS count FROM visual_host_claim").get() as { readonly count: unknown },
    )
    if (count.count !== 0) throw new TypeError("New visual host registry is not empty")
  } catch (cause) {
    if (transaction && database !== undefined) {
      try {
        sqlite(database, () => database!.exec("ROLLBACK"))
      } catch {
        // Preserve the first initialization failure.
      }
    }
    throw cause
  } finally {
    if (database !== undefined) {
      try {
        checkedSqliteBoundary(authority, () => database!.close())
      } finally {
        sqliteAuthorities.delete(database)
      }
    }
    guardSqliteAuthority(authority)
  }
  const handle = await fs.open(file, "r+")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  guardSqliteAuthority(authority)
}

function sqlite<A>(database: Database, work: () => A): A {
  const authority = sqliteAuthorities.get(database)
  if (authority === undefined) throw new TypeError("SQLite handle has no visual host authority")
  return checkedSqliteFileBoundary(authority, work)
}

function checkedSqliteFileBoundary<A>(authority: SqliteAuthority, work: () => A): A {
  guardSqliteFileIdentities(authority)
  let value: A | undefined
  let failure: unknown
  try {
    value = work()
  } catch (cause) {
    failure = cause
  }
  try {
    guardSqliteFileIdentities(authority)
  } catch (cause) {
    failure = failure === undefined ? cause : new AggregateError([failure, cause], "Visual host SQLite boundary failed")
  }
  if (failure !== undefined) throw failure
  return value as A
}

function checkedSqliteBoundary<A>(authority: SqliteAuthority, work: () => A): A {
  const before = sqliteOwnedSnapshot(authority)
  let value: A | undefined
  let failure: unknown
  try {
    value = work()
  } catch (cause) {
    failure = cause
  }
  try {
    const after = sqliteOwnedSnapshot(authority)
    for (const [file, identity] of before) {
      const settled = after.get(file)
      if (settled !== undefined && !sameRegistryIdentity(identity, settled)) {
        throw new TypeError("Visual host SQLite file identity changed across a boundary")
      }
    }
  } catch (cause) {
    failure = failure === undefined ? cause : new AggregateError([failure, cause], "Visual host SQLite boundary failed")
  }
  if (failure !== undefined) throw failure
  return value as A
}

function guardSqliteAuthority(authority: SqliteAuthority): void {
  const snapshot = sqliteOwnedSnapshot(authority)
  const current = snapshot.get(authority.file)
  const journal = snapshot.get(authority.journal)
  if (
    current === undefined ||
    journal === undefined ||
    !sameRegistryIdentity(current, authority.identity) ||
    !sameRegistryIdentity(journal, authority.journalIdentity)
  ) {
    throw new TypeError("Visual host SQLite path changed fixed identity")
  }
}

function sqliteOwnedSnapshot(authority: SqliteAuthority): Map<string, SqliteAuthority["identity"]> {
  verifySqliteRoot(authority.root)
  if (path.dirname(authority.file) !== authority.root) {
    throw new TypeError("Visual host SQLite escaped its owned root")
  }
  const result = new Map<string, SqliteAuthority["identity"]>()
  if (fsSync.existsSync(authority.wal) || fsSync.existsSync(authority.shm)) {
    throw new TypeError("Visual host SQLite WAL/SHM sidecars are forbidden in PERSIST mode")
  }
  for (const file of [authority.file, authority.journal]) {
    result.set(file, sqliteFileIdentity(file))
  }
  const current = result.get(authority.file)
  const journal = result.get(authority.journal)
  if (
    current === undefined ||
    journal === undefined ||
    !sameRegistryIdentity(current, authority.identity) ||
    !sameRegistryIdentity(journal, authority.journalIdentity)
  ) {
    throw new TypeError("Visual host SQLite database lost fixed identity")
  }
  return result
}

function guardSqliteFileIdentities(authority: SqliteAuthority): void {
  if (fsSync.existsSync(authority.wal) || fsSync.existsSync(authority.shm)) {
    throw new TypeError("Visual host SQLite WAL/SHM sidecars are forbidden in PERSIST mode")
  }
  for (const [file, expected] of [
    [authority.file, authority.identity],
    [authority.journal, authority.journalIdentity],
  ] as const) {
    const stat = fsSync.lstatSync(file)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.birthtimeMs !== expected.birthtimeMs
    ) {
      throw new TypeError("Visual host SQLite database lost fixed identity")
    }
  }
}

function verifySqliteRoot(root: string): void {
  const canonical = fsSync.realpathSync.native(root)
  const stat = fsSync.lstatSync(root)
  if (canonical !== root || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("Visual host SQLite root changed")
  }
}

function verifySqliteOwnedSet(root: string, file: string, requireDatabase: boolean): void {
  if (path.dirname(file) !== root) throw new TypeError("Visual host SQLite escaped its owned root")
  for (const candidate of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    let stat: fsSync.Stats
    try {
      stat = fsSync.lstatSync(candidate)
    } catch (cause) {
      if (isFileSystemError(cause, "ENOENT") && (!requireDatabase || candidate !== file)) continue
      throw cause
    }
    if (candidate === `${file}-wal` || candidate === `${file}-shm`) {
      throw new TypeError("Visual host SQLite WAL/SHM sidecars are forbidden in DELETE mode")
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new TypeError("Visual host SQLite files must be singly-owned regular files")
    }
    const canonical = fsSync.realpathSync.native(candidate)
    if (canonical !== candidate || path.dirname(canonical) !== root) {
      throw new TypeError("Visual host SQLite file identity escaped its owned root")
    }
  }
}

function sqliteFileIdentity(file: string): SqliteAuthority["identity"] {
  const stat = fsSync.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new TypeError("Visual host SQLite database must be singly owned")
  }
  const canonical = fsSync.realpathSync.native(file)
  if (canonical !== file) throw new TypeError("Visual host SQLite database path is not canonical")
  return Object.freeze({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs })
}

function verifyRegistrySchema(database: Database): void {
  const objects = sqlite(
    database,
    () =>
      database
        .query(
          "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as Array<{
        readonly type: unknown
        readonly name: unknown
        readonly tableName: unknown
        readonly sql: unknown
      }>,
  )
  if (
    objects.length !== 1 ||
    objects[0]?.type !== "table" ||
    objects[0]?.name !== "visual_host_claim" ||
    objects[0]?.tableName !== "visual_host_claim" ||
    typeof objects[0]?.sql !== "string" ||
    normalizeSql(objects[0].sql) !== normalizeSql(registrySchema)
  ) {
    throw new TypeError("Invalid visual host claim registry objects")
  }
  const columns = sqlite(
    database,
    () =>
      database.query("PRAGMA table_info(visual_host_claim)").all() as Array<{
        readonly name: unknown
        readonly type: unknown
        readonly notnull: unknown
        readonly pk: unknown
      }>,
  )
  const expected = [
    { name: "claim_key", type: "TEXT", notnull: 1, pk: 1 },
    { name: "generation", type: "TEXT", notnull: 1, pk: 0 },
    { name: "digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "state", type: "TEXT", notnull: 1, pk: 0 },
    { name: "body", type: "TEXT", notnull: 1, pk: 0 },
  ]
  if (
    columns.length !== expected.length ||
    columns.some(
      (column, index) =>
        column.name !== expected[index]?.name ||
        column.type !== expected[index]?.type ||
        column.notnull !== expected[index]?.notnull ||
        column.pk !== expected[index]?.pk,
    )
  ) {
    throw new TypeError("Invalid visual host claim registry schema")
  }
  for (const pragma of ["quick_check", "integrity_check"] as const) {
    const result = sqlite(database, () => database.query(`PRAGMA ${pragma}`).get() as Record<string, unknown> | null)
    if (result?.[pragma] !== "ok" || Reflect.ownKeys(result).length !== 1) {
      throw new TypeError("Visual host claim registry integrity check failed")
    }
  }
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function validate(value: unknown): Body {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== claimKeys.size ||
    [...claimKeys].some((key) => !Object.hasOwn(value, key)) ||
    Reflect.get(value, "schemaVersion") !== CLAIM_VERSION ||
    !/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "generation"))) ||
    (Reflect.get(value, "purpose") !== "reference" && Reflect.get(value, "purpose") !== "implementation") ||
    (Reflect.get(value, "kind") !== "static" && Reflect.get(value, "kind") !== "script") ||
    typeof Reflect.get(value, "hostID") !== "string" ||
    !/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "hostID"))) ||
    typeof Reflect.get(value, "nonce") !== "string" ||
    !/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "nonce"))) ||
    !Number.isSafeInteger(Reflect.get(value, "createdAt")) ||
    Number(Reflect.get(value, "createdAt")) < 0 ||
    !Number.isSafeInteger(Reflect.get(value, "revision")) ||
    Number(Reflect.get(value, "revision")) < 0 ||
    !/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "configurationSha256"))) ||
    !/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "sourceSha256")))
  ) {
    throw new TypeError("Invalid visual host claim")
  }
  const lease = WorkflowVisualHost.validatePreviewLeaseAuthority({
    workflowID: Reflect.get(value, "workflowID"),
    stageID: Reflect.get(value, "stageID"),
    attempt: Reflect.get(value, "attempt"),
    leaseOwner: Reflect.get(value, "leaseOwner"),
    leaseExpiresAt: Reflect.get(value, "leaseExpiresAt"),
  })
  return Object.freeze({
    schemaVersion: CLAIM_VERSION,
    generation: String(Reflect.get(value, "generation")),
    purpose: Reflect.get(value, "purpose") as Purpose,
    kind: Reflect.get(value, "kind") as "static" | "script",
    ...lease,
    hostID: WorkflowVisualHost.HostID.make(String(Reflect.get(value, "hostID"))),
    nonce: String(Reflect.get(value, "nonce")),
    createdAt: Number(Reflect.get(value, "createdAt")),
    revision: Number(Reflect.get(value, "revision")),
    configurationSha256: String(Reflect.get(value, "configurationSha256")),
    sourceSha256: String(Reflect.get(value, "sourceSha256")),
  })
}

function encode(body: Body): string {
  return JSON.stringify(body)
}

async function claimsDirectory(root: string, hooks: AcquireHooks = {}): Promise<string> {
  const lexicalRoot = path.resolve(root)
  const canonicalRoot = await fs.realpath(lexicalRoot)
  if (canonicalRoot !== lexicalRoot || !(await fs.lstat(lexicalRoot)).isDirectory()) {
    throw new TypeError("Visual host claim root changed")
  }
  const directory = path.join(canonicalRoot, CLAIM_DIRECTORY)
  if (!(await fs.exists(directory))) {
    const staging = path.join(canonicalRoot, `.claims.${randomBytes(16).toString("hex")}.pending`)
    await fs.mkdir(staging)
    const created = await fs.lstat(staging)
    let published = false
    try {
      const file = path.join(staging, "claims.sqlite")
      const handle = await fs.open(file, "wx", 0o600)
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      const journalHandle = await fs.open(`${file}-journal`, "wx", 0o600)
      try {
        await journalHandle.sync()
      } finally {
        await journalHandle.close()
      }
      await hooks.afterRegistryPendingCreated?.(file)
      await initializeRegistryPending(staging, file)
      await hooks.afterRegistryPendingInitialized?.(file)
      try {
        await fs.rename(staging, directory)
        published = true
      } catch (cause) {
        if (!(await fs.exists(directory))) throw cause
      }
      if (published) {
        const final = path.join(directory, "claims.sqlite")
        await hooks.afterRegistryPublished?.(final)
        await hooks.afterRegistryPendingRemoved?.(final)
        await existingSqliteAuthority(directory, final, true, hooks.afterRegistryCreated)
      } else {
        await removeCreatedRegistryStaging(canonicalRoot, staging, created)
      }
    } catch (cause) {
      if (!published && (await fs.exists(staging))) {
        try {
          await removeCreatedRegistryStaging(canonicalRoot, staging, created)
        } catch (cleanupCause) {
          // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains both the primary and cleanup failures.
          throw new AggregateError([cause, cleanupCause], "Visual host registry staging cleanup failed", {
            cause: cleanupCause,
          })
        }
      }
      throw cause
    }
  }
  const canonical = await fs.realpath(directory)
  const stat = await fs.lstat(directory)
  if (canonical !== directory || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("Visual host claim directory changed")
  }
  return directory
}

async function removeCreatedRegistryStaging(root: string, directory: string, created: fsSync.Stats): Promise<void> {
  if (path.dirname(directory) !== root || !/^\.claims\.[a-f0-9]{32}\.pending$/.test(path.basename(directory))) {
    throw new TypeError("Invalid visual host registry staging path")
  }
  const canonical = await fs.realpath(directory)
  const stat = await fs.lstat(directory)
  if (
    canonical !== directory ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== created.dev ||
    stat.ino !== created.ino ||
    stat.birthtimeMs !== created.birthtimeMs
  ) {
    throw new TypeError("Visual host registry staging identity changed")
  }
  const entries = await fs.readdir(directory, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile() || !["claims.sqlite", "claims.sqlite-journal"].includes(entry.name))) {
    throw new TypeError("Unexpected visual host registry staging state")
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    const fileStat = await fs.lstat(file)
    if (!singleOwnerRegular(fileStat) || (await fs.realpath(file)) !== file) {
      throw new TypeError("Visual host registry staging file identity changed")
    }
  }
  for (const entry of entries) await fs.unlink(path.join(directory, entry.name))
  await fs.rmdir(directory)
}

async function readAuthorityFile(file: string, allowedLinks: ReadonlySet<number> = new Set([1])): Promise<string> {
  const canonicalBefore = await fs.realpath(file)
  const before = await fs.lstat(file)
  if (
    canonicalBefore !== file ||
    !regularWithLinks(before, allowedLinks) ||
    before.size <= 0 ||
    before.size > MAX_CLAIM_BYTES
  ) {
    throw new TypeError("Invalid visual host claim identity")
  }
  const handle = await fs.open(file, "r")
  try {
    const opened = await handle.stat()
    if (!regularWithLinks(opened, allowedLinks) || !sameIdentity(before, opened)) {
      throw new TypeError("Visual host claim changed before read")
    }
    const bytes = Buffer.alloc(opened.size)
    const result = await handle.read(bytes, 0, bytes.length, 0)
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length)
    const settled = await handle.stat()
    const pathSettled = await fs.lstat(file)
    const canonicalSettled = await fs.realpath(file)
    if (
      result.bytesRead !== bytes.length ||
      extra.bytesRead !== 0 ||
      canonicalSettled !== file ||
      !regularWithLinks(settled, allowedLinks) ||
      !regularWithLinks(pathSettled, allowedLinks) ||
      !sameIdentity(opened, settled) ||
      !sameIdentity(opened, pathSettled)
    ) {
      throw new TypeError("Visual host claim changed during read")
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } finally {
    await handle.close()
  }
}

function singleOwnerRegular(value: { readonly nlink: number; isFile(): boolean; isSymbolicLink(): boolean }) {
  return regularWithLinks(value, new Set([1]))
}

function regularWithLinks(
  value: { readonly nlink: number; isFile(): boolean; isSymbolicLink(): boolean },
  allowedLinks: ReadonlySet<number>,
) {
  return value.isFile() && !value.isSymbolicLink() && allowedLinks.has(value.nlink)
}

function sameIdentity(
  left: {
    readonly dev: number
    readonly ino: number
    readonly mode: number
    readonly nlink: number
    readonly size: number
    readonly mtimeMs: number
    readonly ctimeMs: number
    readonly birthtimeMs: number
  },
  right: {
    readonly dev: number
    readonly ino: number
    readonly mode: number
    readonly nlink: number
    readonly size: number
    readonly mtimeMs: number
    readonly ctimeMs: number
    readonly birthtimeMs: number
  },
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs
  )
}

function sameRegistryIdentity(
  left: { readonly dev: number; readonly ino: number; readonly birthtimeMs: number },
  right: { readonly dev: number; readonly ino: number; readonly birthtimeMs: number },
) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs
}

function sqlitePath(file: string): string {
  return process.platform === "win32" && !file.startsWith("\\\\?\\") ? `\\\\?\\${file}` : file
}

function isSqliteBusy(cause: unknown): boolean {
  return cause instanceof Error && Reflect.get(cause, "code") === "SQLITE_BUSY"
}

function isSharingViolation(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false
  const code = Reflect.get(cause, "code")
  return code === "EBUSY" || code === "EACCES" || code === "EPERM"
}

function isFileSystemError(cause: unknown, code: string): cause is Error & { readonly code: string } {
  return cause instanceof Error && Reflect.get(cause, "code") === code
}
