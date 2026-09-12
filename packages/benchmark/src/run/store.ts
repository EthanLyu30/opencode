import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { Task24Root } from "../root"
import { assertTransition, type RunState } from "./state"
import type { AdjudicationRecord, CampaignPlan, LeaseRecord, RunRecord, StateEvent } from "./schema"
import { RUN_DATABASE_SCHEMA_VERSION, RUN_DATABASE_SQL } from "./sql"

interface CampaignRow {
  readonly campaign_id: string
  readonly campaign_sha256: string
  readonly stage: string
  readonly max_concurrency: number
}

interface RunRow {
  readonly run_id: string
  readonly campaign_id: string
  readonly task_id: string
  readonly arm_id: RunRecord["armID"]
  readonly repetition: number
  readonly order_index: number
  readonly state: RunState
}

interface EventRow {
  readonly run_id: string
  readonly sequence: number
  readonly from_state: RunState | null
  readonly to_state: RunState
  readonly at: string
}

interface LeaseRow {
  readonly run_id: string
  readonly owner_id: string
  readonly acquired_at: number
  readonly expires_at: number
  readonly generation: number
}

interface AdjudicationRow {
  readonly run_id: string
  readonly reason: string
  readonly created_at: number
}

export interface Service {
  readonly planCampaign: (plan: CampaignPlan) => void
  readonly getRun: (runID: string) => RunRecord | undefined
  readonly listRuns: (campaignID: string) => readonly RunRecord[]
  readonly transition: (runID: string, next: RunState, at: string) => RunRecord
  readonly events: (runID: string) => readonly StateEvent[]
  readonly acquireLease: (runID: string, ownerID: string, now: number, ttlMs: number) => boolean
  readonly claimNextRun: (campaignID: string, ownerID: string, now: number, ttlMs: number) => RunRecord | undefined
  readonly renewLease: (runID: string, ownerID: string, now: number, ttlMs: number) => boolean
  readonly releaseLease: (runID: string, ownerID: string) => boolean
  readonly lease: (runID: string) => LeaseRecord | undefined
  readonly expiredLeases: (now: number) => readonly LeaseRecord[]
  readonly beginAttempt: (runID: string, attemptID: string, at: number) => void
  readonly finishAttempt: (
    attemptID: string,
    status: "completed" | "failed" | "interrupted" | "canceled",
    at: number,
  ) => void
  readonly interruptActiveAttempt: (runID: string, at: number) => boolean
  readonly addAdjudication: (runID: string, reason: string, at: number) => void
  readonly adjudications: (runID: string) => readonly AdjudicationRecord[]
  readonly recordEvaluation: (runID: string, evaluatorSha256: string, resultSha256: string, at: number) => void
  readonly hasEvaluation: (runID: string) => boolean
  readonly requestCancellation: (runID: string, at: number) => void
  readonly cancellationRequested: (runID: string) => boolean
  readonly completeCancellation: (runID: string) => void
  readonly close: () => void
}

const idPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/
const shaPattern = /^[a-f0-9]{64}$/

export namespace RunStore {
  export function open(databasePath: string): Service {
    const file = verifyPath(databasePath)
    const database = new Database(file, { create: true, readwrite: true, strict: true })
    try {
      database.run("PRAGMA journal_mode = WAL")
      database.run("PRAGMA synchronous = FULL")
      database.run("PRAGMA busy_timeout = 5000")
      database.run("PRAGMA foreign_keys = ON")
      database.run("PRAGMA trusted_schema = OFF")
      database.run(RUN_DATABASE_SQL)
      const version = database
        .query<{ readonly value: string }, [string]>("SELECT value FROM benchmark_meta WHERE key = ?")
        .get("schema_version")
      if (version && version.value !== String(RUN_DATABASE_SCHEMA_VERSION))
        throw new TypeError("TASK24_RUN_SCHEMA_MISMATCH")
      if (!version) {
        database
          .query<unknown, [string, string]>("INSERT INTO benchmark_meta (key, value) VALUES (?, ?)")
          .run("schema_version", String(RUN_DATABASE_SCHEMA_VERSION))
      }
      return makeService(database)
    } catch (cause) {
      database.close()
      throw cause
    }
  }
}

function makeService(database: Database): Service {
  let closed = false
  const active = () => {
    if (closed) throw new TypeError("TASK24_RUN_STORE_CLOSED")
  }
  const service: Service = {
    planCampaign(plan) {
      active()
      validatePlan(plan)
      immediate(database, () => {
        const existing = database
          .query<CampaignRow, [string]>("SELECT * FROM campaigns WHERE campaign_id = ?")
          .get(plan.campaignID)
        if (existing) {
          if (
            existing.campaign_sha256 !== plan.campaignSha256 ||
            existing.stage !== plan.stage ||
            existing.max_concurrency !== plan.maxConcurrency
          ) {
            throw new TypeError("TASK24_CAMPAIGN_SEAL_CONFLICT")
          }
          const current = service.listRuns(plan.campaignID)
          if (JSON.stringify(current.map(planShape)) !== JSON.stringify(plan.runs.map(planShape))) {
            throw new TypeError("TASK24_CAMPAIGN_PLAN_CONFLICT")
          }
          return
        }
        database
          .query<
            unknown,
            [string, string, string, number, number]
          >("INSERT INTO campaigns (campaign_id, campaign_sha256, stage, max_concurrency, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(plan.campaignID, plan.campaignSha256, plan.stage, plan.maxConcurrency, Date.now())
        for (const taskID of new Set(plan.runs.map((run) => run.taskID))) {
          database
            .query<unknown, [string, string]>("INSERT INTO tasks (campaign_id, task_id) VALUES (?, ?)")
            .run(plan.campaignID, taskID)
        }
        for (const armID of new Set(plan.runs.map((run) => run.armID))) {
          database
            .query<unknown, [string, string]>("INSERT INTO arms (campaign_id, arm_id) VALUES (?, ?)")
            .run(plan.campaignID, armID)
        }
        for (const run of plan.runs) {
          database
            .query<unknown, [string, string, string, string, number, number]>(
              `INSERT INTO runs (run_id, campaign_id, task_id, arm_id, repetition, order_index, state)
               VALUES (?, ?, ?, ?, ?, ?, 'planned')`,
            )
            .run(run.runID, plan.campaignID, run.taskID, run.armID, run.repetition, run.orderIndex)
          database
            .query<
              unknown,
              [string, string]
            >("INSERT INTO state_events (run_id, sequence, from_state, to_state, at) VALUES (?, 1, NULL, 'planned', ?)")
            .run(run.runID, new Date().toISOString())
        }
      })
    },
    getRun(runID) {
      active()
      const row = database.query<RunRow, [string]>("SELECT * FROM runs WHERE run_id = ?").get(runID)
      return row ? decodeRun(row) : undefined
    },
    listRuns(campaignID) {
      active()
      return database
        .query<RunRow, [string]>("SELECT * FROM runs WHERE campaign_id = ? ORDER BY order_index")
        .all(campaignID)
        .map(decodeRun)
    },
    transition(runID, next, at) {
      active()
      return immediate(database, () => {
        const current = service.getRun(runID)
        if (!current) throw new TypeError("TASK24_RUN_NOT_FOUND")
        assertTransition(current.state, next)
        if (next === "completed" && !service.hasEvaluation(runID)) {
          throw new TypeError("TASK24_RUN_EVALUATION_REQUIRED")
        }
        if (!Number.isFinite(Date.parse(at))) throw new TypeError("TASK24_RUN_EVENT_TIME_INVALID")
        const sequence =
          database
            .query<
              { readonly value: number },
              [string]
            >("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM state_events WHERE run_id = ?")
            .get(runID)?.value ?? 1
        database.query<unknown, [RunState, string]>("UPDATE runs SET state = ? WHERE run_id = ?").run(next, runID)
        database
          .query<
            unknown,
            [string, number, RunState, RunState, string]
          >("INSERT INTO state_events (run_id, sequence, from_state, to_state, at) VALUES (?, ?, ?, ?, ?)")
          .run(runID, sequence, current.state, next, at)
        return Object.freeze({ ...current, state: next })
      })
    },
    events(runID) {
      active()
      return database
        .query<EventRow, [string]>("SELECT * FROM state_events WHERE run_id = ? ORDER BY sequence")
        .all(runID)
        .map((row) =>
          Object.freeze({
            runID: row.run_id,
            sequence: row.sequence,
            from: row.from_state,
            to: row.to_state,
            at: row.at,
          }),
        )
    },
    acquireLease(runID, ownerID, now, ttlMs) {
      active()
      validateLease(runID, ownerID, now, ttlMs)
      return immediate(database, () => {
        if (!service.getRun(runID)) throw new TypeError("TASK24_RUN_NOT_FOUND")
        const current = service.lease(runID)
        if (!current) {
          database
            .query<
              unknown,
              [string, string, number, number]
            >("INSERT INTO leases (run_id, owner_id, acquired_at, expires_at, generation) VALUES (?, ?, ?, ?, 1)")
            .run(runID, ownerID, now, now + ttlMs)
          return true
        }
        if (current.ownerID !== ownerID && current.expiresAt > now) return false
        database
          .query<
            unknown,
            [string, number, number, number, string]
          >("UPDATE leases SET owner_id = ?, acquired_at = ?, expires_at = ?, generation = ? WHERE run_id = ?")
          .run(ownerID, now, now + ttlMs, current.generation + 1, runID)
        return true
      })
    },
    claimNextRun(campaignID, ownerID, now, ttlMs) {
      active()
      validateID(campaignID)
      validateLease("candidate", ownerID, now, ttlMs)
      return immediate(database, () => {
        const campaign = database
          .query<CampaignRow, [string]>("SELECT * FROM campaigns WHERE campaign_id = ?")
          .get(campaignID)
        if (!campaign) throw new TypeError("TASK24_CAMPAIGN_NOT_FOUND")
        const expiredLeases =
          database
            .query<{ readonly count: number }, [string, number]>(
              `SELECT COUNT(*) AS count
               FROM leases
               JOIN runs ON runs.run_id = leases.run_id
               WHERE runs.campaign_id = ? AND leases.expires_at <= ?`,
            )
            .get(campaignID, now)?.count ?? 0
        if (expiredLeases > 0) return undefined
        const activeLeases =
          database
            .query<{ readonly count: number }, [string, number]>(
              `SELECT COUNT(*) AS count
               FROM leases
               JOIN runs ON runs.run_id = leases.run_id
               WHERE runs.campaign_id = ? AND leases.expires_at > ?`,
            )
            .get(campaignID, now)?.count ?? 0
        if (activeLeases >= campaign.max_concurrency) return undefined
        const candidate = database
          .query<RunRow, [string, number]>(
            `SELECT runs.*
             FROM runs
             LEFT JOIN leases ON leases.run_id = runs.run_id
             WHERE runs.campaign_id = ?
               AND runs.state IN ('planned', 'resumable')
               AND (leases.run_id IS NULL OR leases.expires_at <= ?)
               AND NOT EXISTS (
                 SELECT 1 FROM cancellation_requests
                 WHERE cancellation_requests.run_id = runs.run_id
                   AND cancellation_requests.status = 'pending'
               )
             ORDER BY runs.order_index
             LIMIT 1`,
          )
          .get(campaignID, now)
        if (!candidate) return undefined
        const current = database
          .query<LeaseRow, [string]>("SELECT * FROM leases WHERE run_id = ?")
          .get(candidate.run_id)
        if (current) {
          database
            .query<
              unknown,
              [string, number, number, number, string]
            >("UPDATE leases SET owner_id = ?, acquired_at = ?, expires_at = ?, generation = ? WHERE run_id = ?")
            .run(ownerID, now, now + ttlMs, current.generation + 1, candidate.run_id)
        } else {
          database
            .query<
              unknown,
              [string, string, number, number]
            >("INSERT INTO leases (run_id, owner_id, acquired_at, expires_at, generation) VALUES (?, ?, ?, ?, 1)")
            .run(candidate.run_id, ownerID, now, now + ttlMs)
        }
        return decodeRun(candidate)
      })
    },
    renewLease(runID, ownerID, now, ttlMs) {
      active()
      validateLease(runID, ownerID, now, ttlMs)
      return immediate(database, () => {
        const current = service.lease(runID)
        if (!current || current.ownerID !== ownerID || current.expiresAt <= now) return false
        database
          .query<unknown, [number, string]>("UPDATE leases SET expires_at = ? WHERE run_id = ?")
          .run(now + ttlMs, runID)
        return true
      })
    },
    releaseLease(runID, ownerID) {
      active()
      const result = database
        .query<unknown, [string, string]>("DELETE FROM leases WHERE run_id = ? AND owner_id = ?")
        .run(runID, ownerID)
      return result.changes === 1
    },
    lease(runID) {
      active()
      const row = database.query<LeaseRow, [string]>("SELECT * FROM leases WHERE run_id = ?").get(runID)
      return row ? decodeLease(row) : undefined
    },
    expiredLeases(now) {
      active()
      return database
        .query<LeaseRow, [number]>("SELECT * FROM leases WHERE expires_at <= ? ORDER BY run_id")
        .all(now)
        .map(decodeLease)
    },
    beginAttempt(runID, attemptID, at) {
      active()
      validateID(attemptID)
      if (!Number.isSafeInteger(at) || at < 0) throw new TypeError("TASK24_ATTEMPT_TIME_INVALID")
      const run = service.getRun(runID)
      if (!run) throw new TypeError("TASK24_RUN_NOT_FOUND")
      if (run.state !== "reserved" && run.state !== "running" && run.state !== "resumable") {
        throw new TypeError("TASK24_ATTEMPT_STATE_INVALID")
      }
      database
        .query<
          unknown,
          [string, string, number]
        >("INSERT INTO attempts (attempt_id, run_id, status, started_at) VALUES (?, ?, 'active', ?)")
        .run(attemptID, runID, at)
    },
    finishAttempt(attemptID, status, at) {
      active()
      const result = database
        .query<
          unknown,
          [string, number, string]
        >("UPDATE attempts SET status = ?, finished_at = ? WHERE attempt_id = ? AND status = 'active'")
        .run(status, at, attemptID)
      if (result.changes !== 1) throw new TypeError("TASK24_ATTEMPT_NOT_ACTIVE")
    },
    interruptActiveAttempt(runID, at) {
      active()
      const result = database
        .query<
          unknown,
          [number, string]
        >("UPDATE attempts SET status = 'interrupted', finished_at = ? WHERE run_id = ? AND status = 'active'")
        .run(at, runID)
      return result.changes === 1
    },
    addAdjudication(runID, reason, at) {
      active()
      if (reason.length === 0) throw new TypeError("TASK24_ADJUDICATION_INVALID")
      database
        .query<
          unknown,
          [string, string, number]
        >("INSERT INTO adjudications (run_id, reason, created_at) VALUES (?, ?, ?)")
        .run(runID, reason, at)
    },
    adjudications(runID) {
      active()
      return database
        .query<AdjudicationRow, [string]>(
          "SELECT run_id, reason, created_at FROM adjudications WHERE run_id = ? ORDER BY id",
        )
        .all(runID)
        .map((row) => Object.freeze({ runID: row.run_id, reason: row.reason, createdAt: row.created_at }))
    },
    recordEvaluation(runID, evaluatorSha256, resultSha256, at) {
      active()
      if (!shaPattern.test(evaluatorSha256) || !shaPattern.test(resultSha256) || !Number.isSafeInteger(at) || at < 0) {
        throw new TypeError("TASK24_EVALUATION_INVALID")
      }
      database
        .query<
          unknown,
          [string, string, string, number]
        >("INSERT INTO evaluations (run_id, evaluator_sha256, result_sha256, completed_at) VALUES (?, ?, ?, ?)")
        .run(runID, evaluatorSha256, resultSha256, at)
    },
    hasEvaluation(runID) {
      active()
      return Boolean(
        database
          .query<{ readonly run_id: string }, [string]>("SELECT run_id FROM evaluations WHERE run_id = ?")
          .get(runID),
      )
    },
    requestCancellation(runID, at) {
      active()
      if (!Number.isSafeInteger(at) || at < 0 || !service.getRun(runID)) {
        throw new TypeError("TASK24_CANCELLATION_REQUEST_INVALID")
      }
      database
        .query<
          unknown,
          [string, number]
        >("INSERT INTO cancellation_requests (run_id, requested_at, status) VALUES (?, ?, 'pending') ON CONFLICT(run_id) DO NOTHING")
        .run(runID, at)
    },
    cancellationRequested(runID) {
      active()
      return Boolean(
        database
          .query<
            { readonly run_id: string },
            [string]
          >("SELECT run_id FROM cancellation_requests WHERE run_id = ? AND status = 'pending'")
          .get(runID),
      )
    },
    completeCancellation(runID) {
      active()
      database
        .query<unknown, [string]>("UPDATE cancellation_requests SET status = 'completed' WHERE run_id = ?")
        .run(runID)
    },
    close() {
      if (closed) return
      closed = true
      database.close()
    },
  }
  return Object.freeze(service)
}

function decodeRun(row: RunRow): RunRecord {
  return Object.freeze({
    runID: row.run_id,
    campaignID: row.campaign_id,
    taskID: row.task_id,
    armID: row.arm_id,
    repetition: row.repetition,
    orderIndex: row.order_index,
    state: row.state,
  })
}

function decodeLease(row: LeaseRow): LeaseRecord {
  return Object.freeze({
    runID: row.run_id,
    ownerID: row.owner_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    generation: row.generation,
  })
}

function validatePlan(plan: CampaignPlan): void {
  validateID(plan.campaignID)
  if (
    !shaPattern.test(plan.campaignSha256) ||
    (plan.stage !== "offline" && plan.stage !== "pilot" && plan.stage !== "campaign") ||
    !Number.isSafeInteger(plan.maxConcurrency) ||
    plan.maxConcurrency <= 0 ||
    plan.runs.length === 0
  )
    throw new TypeError("TASK24_CAMPAIGN_PLAN_INVALID")
  const runIDs = new Set<string>()
  const identities = new Set<string>()
  const indexes = new Set<number>()
  for (const run of plan.runs) {
    validateID(run.runID)
    validateID(run.taskID)
    if (
      !Number.isSafeInteger(run.repetition) ||
      run.repetition < 0 ||
      !Number.isSafeInteger(run.orderIndex) ||
      run.orderIndex < 0
    ) {
      throw new TypeError("TASK24_CAMPAIGN_PLAN_INVALID")
    }
    const identity = `${run.taskID}/${run.armID}/${run.repetition}`
    if (runIDs.has(run.runID) || identities.has(identity) || indexes.has(run.orderIndex))
      throw new TypeError("TASK24_CAMPAIGN_PLAN_DUPLICATE")
    runIDs.add(run.runID)
    identities.add(identity)
    indexes.add(run.orderIndex)
  }
}

function validateLease(runID: string, ownerID: string, now: number, ttlMs: number): void {
  validateID(runID)
  validateID(ownerID)
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || now < 0 || ttlMs <= 0) {
    throw new TypeError("TASK24_LEASE_INVALID")
  }
}

function validateID(value: string): void {
  if (!idPattern.test(value)) throw new TypeError("TASK24_ID_INVALID")
}

function planShape(run: Pick<RunRecord, "runID" | "taskID" | "armID" | "repetition" | "orderIndex">) {
  return {
    runID: run.runID,
    taskID: run.taskID,
    armID: run.armID,
    repetition: run.repetition,
    orderIndex: run.orderIndex,
  }
}

function immediate<T>(database: Database, operation: () => T): T {
  database.run("BEGIN IMMEDIATE")
  try {
    const result = operation()
    database.run("COMMIT")
    return result
  } catch (cause) {
    database.run("ROLLBACK")
    throw cause
  }
}

function verifyPath(value: string): string {
  const layout = Task24Root.ensure()
  if (!path.isAbsolute(value) || path.normalize(value) !== value || path.extname(value) !== ".sqlite") {
    throw new TypeError("TASK24_RUN_DATABASE_PATH_INVALID")
  }
  const resolved = path.resolve(value)
  if (![layout.runs, layout.tmp].some((root) => resolved.startsWith(path.resolve(root) + path.sep))) {
    throw new TypeError("TASK24_RUN_DATABASE_PATH_INVALID")
  }
  const parent = path.dirname(resolved)
  if (!fs.existsSync(parent) || fs.lstatSync(parent).isSymbolicLink())
    throw new TypeError("TASK24_RUN_DATABASE_PARENT_INVALID")
  return resolved
}
