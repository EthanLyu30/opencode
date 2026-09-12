import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { Task24Root } from "../root"
import type { GrantAuthority, GrantRoute } from "./grant"
import { routeKey, verifyGrant } from "./grant"
import type { PriceBook, ProviderUsage } from "./pricing"
import { settlePrice, validateUsage, worstCasePrice } from "./pricing"

type Currency = "CNY" | "USD"
export type ResultClass = "completed" | "incomplete" | "failed" | "cancelled" | "upstream_error" | "malformed"

export interface ReservationInput {
  readonly requestID: string
  readonly campaignID: string
  readonly runID: string
  readonly provider: "kimi" | "deepseek"
  readonly model: string
  readonly protocol: "chat_completions" | "responses"
  readonly route: string
  readonly requestBytes: number
  readonly requestSha256: string
  readonly inputTokenBound: number
  readonly maximumOutputTokens: number
  readonly priceSha256: string
  readonly at: string
}

export interface SettlementInput {
  readonly requestID: string
  readonly resultClass: ResultClass
  readonly responseBytes: number
  readonly responseSha256: string
  readonly terminalType?: string
  readonly usage?: ProviderUsage
  readonly at?: string
}

export interface LedgerRecord {
  readonly schemaVersion: 1
  readonly sequence: number
  readonly requestID: string
  readonly campaignID: string
  readonly runID: string
  readonly provider: "kimi" | "deepseek"
  readonly model: string
  readonly protocol: "chat_completions" | "responses"
  readonly route: string
  readonly requestBytes: number
  readonly requestSha256: string
  readonly responseBytes: number
  readonly responseSha256: string
  readonly resultClass: ResultClass
  readonly terminalType: string | null
  readonly usage: ProviderUsage | null
  readonly currency: Currency
  readonly reservedMicros: string
  readonly chargedMicros: string
  readonly priceSha256: string
  readonly reservedAt: string
  readonly settledAt: string
  readonly previousSha256: string
  readonly recordSha256: string
}

interface ReservationRow {
  readonly request_id: string
  readonly campaign_id: string
  readonly run_id: string
  readonly provider: "kimi" | "deepseek"
  readonly model: string
  readonly protocol: "chat_completions" | "responses"
  readonly route: string
  readonly request_bytes: number
  readonly request_sha256: string
  readonly price_sha256: string
  readonly currency: Currency
  readonly reserved_micros: string
  readonly reserved_at: string
  readonly state: "active" | "settled"
}

interface LedgerRow {
  readonly record_json: string
  readonly previous_sha256: string
  readonly record_sha256: string
}

interface GrantRow {
  readonly campaign_id: string
  readonly run_id: string
  readonly allowed_json: string
  readonly expires_at: number
  readonly maximum_calls: number
  readonly used_calls: number
  readonly status: "active" | "revoked"
}

export interface Service {
  readonly reserve: (input: ReservationInput) => void
  readonly settle: (input: SettlementInput) => LedgerRecord
  readonly records: () => readonly LedgerRecord[]
  readonly registerGrant: (authority: GrantAuthority) => void
  readonly authorizeGrant: (input: {
    readonly grant: string
    readonly route: GrantRoute
    readonly campaignID: string
    readonly runID: string
    readonly now: number
  }) => void
  readonly revokeGrant: (grantSha256: string) => void
  readonly close: () => void
}

interface OpenOptions {
  readonly database: string
  readonly prices: PriceBook
  readonly ceilings: Readonly<Record<Currency, bigint>>
}

const sha256Pattern = /^[a-f0-9]{64}$/
const idPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/
const zeroHash = "0".repeat(64)

export namespace BrokerLedger {
  export function open(options: OpenOptions): Service {
    const databasePath = verifyDatabasePath(options.database)
    const database = new Database(databasePath, { create: true, readwrite: true, strict: true })
    try {
      database.run("PRAGMA journal_mode = WAL")
      database.run("PRAGMA synchronous = FULL")
      database.run("PRAGMA busy_timeout = 5000")
      database.run("PRAGMA foreign_keys = ON")
      database.run("PRAGMA trusted_schema = OFF")
      database.run(`
        CREATE TABLE IF NOT EXISTS broker_budget (
          currency TEXT PRIMARY KEY NOT NULL,
          ceiling_micros TEXT NOT NULL,
          reserved_micros TEXT NOT NULL,
          settled_micros TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS broker_reservation (
          request_id TEXT PRIMARY KEY NOT NULL,
          campaign_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          protocol TEXT NOT NULL,
          route TEXT NOT NULL,
          request_bytes INTEGER NOT NULL,
          request_sha256 TEXT NOT NULL,
          price_sha256 TEXT NOT NULL,
          currency TEXT NOT NULL,
          reserved_micros TEXT NOT NULL,
          reserved_at TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'settled'))
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS broker_ledger (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT UNIQUE NOT NULL,
          record_json TEXT NOT NULL,
          previous_sha256 TEXT NOT NULL,
          record_sha256 TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS broker_ledger_no_update BEFORE UPDATE ON broker_ledger
          BEGIN SELECT RAISE(ABORT, 'BROKER_LEDGER_APPEND_ONLY'); END;
        CREATE TRIGGER IF NOT EXISTS broker_ledger_no_delete BEFORE DELETE ON broker_ledger
          BEGIN SELECT RAISE(ABORT, 'BROKER_LEDGER_APPEND_ONLY'); END;
        CREATE TABLE IF NOT EXISTS broker_grant (
          grant_sha256 TEXT PRIMARY KEY NOT NULL,
          campaign_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          allowed_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          maximum_calls INTEGER NOT NULL,
          used_calls INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'revoked'))
        ) WITHOUT ROWID;
      `)
      initializeBudgets(database, options.ceilings)
      return service(database, options.prices)
    } catch (cause) {
      database.close()
      throw cause
    }
  }
}

function service(database: Database, prices: PriceBook): Service {
  let closed = false
  const active = () => {
    if (closed) throw new TypeError("BROKER_LEDGER_CLOSED")
  }
  const result: Service = {
    reserve(input) {
      active()
      validateReservation(input)
      const price = prices[input.provider]
      if (input.priceSha256 !== price.sha256) throw new TypeError("BROKER_PRICE_REVISION_MISMATCH")
      const amount = worstCasePrice(price, {
        inputTokens: input.inputTokenBound,
        maximumOutputTokens: input.maximumOutputTokens,
      })
      immediate(database, () => {
        const duplicate = database
          .query<
            { readonly request_id: string },
            [string]
          >("SELECT request_id FROM broker_reservation WHERE request_id = ?")
          .get(input.requestID)
        if (duplicate) throw new TypeError("BROKER_REQUEST_ID_DUPLICATE")
        const budget = budgetRow(database, price.currency)
        const ceiling = BigInt(budget.ceiling_micros)
        const reserved = BigInt(budget.reserved_micros)
        const settled = BigInt(budget.settled_micros)
        if (settled + reserved + amount > ceiling) throw new TypeError("BUDGET_RESERVATION_EXCEEDED")
        database
          .query<
            unknown,
            [string, string, string, string, string, string, string, number, string, string, string, string, string]
          >(
            `INSERT INTO broker_reservation
             (request_id, campaign_id, run_id, provider, model, protocol, route, request_bytes, request_sha256,
              price_sha256, currency, reserved_micros, reserved_at, state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          )
          .run(
            input.requestID,
            input.campaignID,
            input.runID,
            input.provider,
            input.model,
            input.protocol,
            input.route,
            input.requestBytes,
            input.requestSha256,
            input.priceSha256,
            price.currency,
            amount.toString(),
            input.at,
          )
        database
          .query<unknown, [string, Currency]>("UPDATE broker_budget SET reserved_micros = ? WHERE currency = ?")
          .run((reserved + amount).toString(), price.currency)
      })
    },
    settle(input) {
      active()
      validateSettlement(input)
      return immediate(database, () => {
        const existing = findRecord(database, input.requestID)
        if (existing) return existing
        const reservation = database
          .query<ReservationRow, [string]>("SELECT * FROM broker_reservation WHERE request_id = ?")
          .get(input.requestID)
        if (!reservation || reservation.state !== "active") throw new TypeError("BROKER_RESERVATION_NOT_ACTIVE")
        const price = prices[reservation.provider]
        if (reservation.price_sha256 !== price.sha256) throw new TypeError("BROKER_PRICE_REVISION_MISMATCH")
        const reserved = BigInt(reservation.reserved_micros)
        const charge = actualCharge(price, input.usage, reserved)
        const budget = budgetRow(database, reservation.currency)
        database
          .query<
            unknown,
            [string, string, Currency]
          >("UPDATE broker_budget SET reserved_micros = ?, settled_micros = ? WHERE currency = ?")
          .run(
            (BigInt(budget.reserved_micros) - reserved).toString(),
            (BigInt(budget.settled_micros) + charge).toString(),
            reservation.currency,
          )
        database
          .query<unknown, [string]>("UPDATE broker_reservation SET state = 'settled' WHERE request_id = ?")
          .run(input.requestID)
        const previous =
          database
            .query<
              { readonly record_sha256: string },
              []
            >("SELECT record_sha256 FROM broker_ledger ORDER BY sequence DESC LIMIT 1")
            .get()?.record_sha256 ?? zeroHash
        const sequence =
          database
            .query<{ readonly value: number }, []>("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM broker_ledger")
            .get()?.value ?? 1
        const settledAt = input.at ?? new Date().toISOString()
        const body = {
          schemaVersion: 1 as const,
          sequence,
          requestID: reservation.request_id,
          campaignID: reservation.campaign_id,
          runID: reservation.run_id,
          provider: reservation.provider,
          model: reservation.model,
          protocol: reservation.protocol,
          route: reservation.route,
          requestBytes: reservation.request_bytes,
          requestSha256: reservation.request_sha256,
          responseBytes: input.responseBytes,
          responseSha256: input.responseSha256,
          resultClass: input.resultClass,
          terminalType: input.terminalType ?? null,
          usage: input.usage ?? null,
          currency: reservation.currency,
          reservedMicros: reservation.reserved_micros,
          chargedMicros: charge.toString(),
          priceSha256: reservation.price_sha256,
          reservedAt: reservation.reserved_at,
          settledAt,
        }
        const recordJson = canonicalJson(body)
        const recordSha256 = sha256(`${previous}\n${recordJson}`)
        database
          .query<
            unknown,
            [string, string, string, string]
          >("INSERT INTO broker_ledger (request_id, record_json, previous_sha256, record_sha256) VALUES (?, ?, ?, ?)")
          .run(input.requestID, recordJson, previous, recordSha256)
        return Object.freeze({ ...body, previousSha256: previous, recordSha256 })
      })
    },
    records() {
      active()
      return database
        .query<LedgerRow, []>("SELECT record_json, previous_sha256, record_sha256 FROM broker_ledger ORDER BY sequence")
        .all()
        .map(decodeRecord)
    },
    registerGrant(authority) {
      active()
      const allowedJson = canonicalJson(authority.allowed)
      const existing = database
        .query<GrantRow, [string]>("SELECT * FROM broker_grant WHERE grant_sha256 = ?")
        .get(authority.grantSha256)
      if (existing) {
        if (
          existing.campaign_id !== authority.campaignID ||
          existing.run_id !== authority.runID ||
          existing.allowed_json !== allowedJson ||
          existing.expires_at !== authority.expiresAt ||
          existing.maximum_calls !== authority.maximumCalls ||
          existing.status !== authority.status
        ) {
          throw new TypeError("BROKER_GRANT_AUTHORITY_CONFLICT")
        }
        return
      }
      database
        .query<unknown, [string, string, string, string, number, number, string]>(
          `INSERT INTO broker_grant
           (grant_sha256, campaign_id, run_id, allowed_json, expires_at, maximum_calls, used_calls, status)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(grant_sha256) DO NOTHING`,
        )
        .run(
          authority.grantSha256,
          authority.campaignID,
          authority.runID,
          allowedJson,
          authority.expiresAt,
          authority.maximumCalls,
          authority.status,
        )
    },
    authorizeGrant(input) {
      active()
      immediate(database, () => {
        const hash = sha256(input.grant)
        const row = database.query<GrantRow, [string]>("SELECT * FROM broker_grant WHERE grant_sha256 = ?").get(hash)
        if (!row) throw new TypeError("BROKER_GRANT_INVALID")
        const allowed = decodeGrantRoutes(row.allowed_json)
        const authority: GrantAuthority = {
          schemaVersion: 1,
          campaignID: row.campaign_id,
          runID: row.run_id,
          grantSha256: hash,
          allowed,
          expiresAt: row.expires_at,
          maximumCalls: row.maximum_calls,
          status: row.status,
        }
        if (
          input.campaignID !== row.campaign_id ||
          input.runID !== row.run_id ||
          !verifyGrant(authority, input.grant, input.now, input.route) ||
          row.used_calls >= row.maximum_calls
        ) {
          throw new TypeError("BROKER_GRANT_INVALID")
        }
        database
          .query<unknown, [string]>("UPDATE broker_grant SET used_calls = used_calls + 1 WHERE grant_sha256 = ?")
          .run(hash)
      })
    },
    revokeGrant(grantSha256) {
      active()
      if (!sha256Pattern.test(grantSha256)) throw new TypeError("BROKER_GRANT_HASH_INVALID")
      database
        .query<unknown, [string]>("UPDATE broker_grant SET status = 'revoked' WHERE grant_sha256 = ?")
        .run(grantSha256)
    },
    close() {
      if (closed) return
      closed = true
      database.close()
    },
  }
  return Object.freeze(result)
}

function initializeBudgets(database: Database, ceilings: Readonly<Record<Currency, bigint>>): void {
  for (const currency of ["CNY", "USD"] as const) {
    const ceiling = ceilings[currency]
    if (ceiling < 0n) throw new TypeError("BROKER_BUDGET_INVALID")
    const row = database
      .query<
        { readonly ceiling_micros: string },
        [Currency]
      >("SELECT ceiling_micros FROM broker_budget WHERE currency = ?")
      .get(currency)
    if (row && row.ceiling_micros !== ceiling.toString()) throw new TypeError("BROKER_BUDGET_REVISION_MISMATCH")
    if (!row) {
      database
        .query<
          unknown,
          [Currency, string]
        >("INSERT INTO broker_budget (currency, ceiling_micros, reserved_micros, settled_micros) VALUES (?, ?, '0', '0')")
        .run(currency, ceiling.toString())
    }
  }
}

function budgetRow(database: Database, currency: Currency) {
  const row = database
    .query<
      { readonly ceiling_micros: string; readonly reserved_micros: string; readonly settled_micros: string },
      [Currency]
    >("SELECT ceiling_micros, reserved_micros, settled_micros FROM broker_budget WHERE currency = ?")
    .get(currency)
  if (!row) throw new TypeError("BROKER_BUDGET_MISSING")
  return row
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

function actualCharge(price: PriceBook["kimi"], usage: ProviderUsage | undefined, reserved: bigint): bigint {
  if (!usage) return reserved
  try {
    validateUsage(usage)
    const amount = settlePrice(price, usage)
    return amount <= reserved ? amount : reserved
  } catch {
    return reserved
  }
}

function findRecord(database: Database, requestID: string): LedgerRecord | undefined {
  const row = database
    .query<
      LedgerRow,
      [string]
    >("SELECT record_json, previous_sha256, record_sha256 FROM broker_ledger WHERE request_id = ?")
    .get(requestID)
  return row ? decodeRecord(row) : undefined
}

function decodeRecord(row: LedgerRow): LedgerRecord {
  const parsed: unknown = JSON.parse(row.record_json)
  if (!isObject(parsed)) throw new TypeError("BROKER_LEDGER_RECORD_INVALID")
  const usageValue = parsed.usage
  const usage = usageValue === null ? null : decodeUsage(usageValue)
  const body = {
    schemaVersion: readLiteral(parsed, "schemaVersion", 1),
    sequence: readNumber(parsed, "sequence"),
    requestID: readString(parsed, "requestID"),
    campaignID: readString(parsed, "campaignID"),
    runID: readString(parsed, "runID"),
    provider: readUnion(parsed, "provider", ["kimi", "deepseek"] as const),
    model: readString(parsed, "model"),
    protocol: readUnion(parsed, "protocol", ["chat_completions", "responses"] as const),
    route: readString(parsed, "route"),
    requestBytes: readNumber(parsed, "requestBytes"),
    requestSha256: readString(parsed, "requestSha256"),
    responseBytes: readNumber(parsed, "responseBytes"),
    responseSha256: readString(parsed, "responseSha256"),
    resultClass: readUnion(parsed, "resultClass", [
      "completed",
      "incomplete",
      "failed",
      "cancelled",
      "upstream_error",
      "malformed",
    ] as const),
    terminalType: readNullableString(parsed, "terminalType"),
    usage,
    currency: readUnion(parsed, "currency", ["CNY", "USD"] as const),
    reservedMicros: readString(parsed, "reservedMicros"),
    chargedMicros: readString(parsed, "chargedMicros"),
    priceSha256: readString(parsed, "priceSha256"),
    reservedAt: readString(parsed, "reservedAt"),
    settledAt: readString(parsed, "settledAt"),
  }
  return Object.freeze({ ...body, previousSha256: row.previous_sha256, recordSha256: row.record_sha256 })
}

function decodeGrantRoutes(value: string): GrantRoute[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length === 0) throw new TypeError("BROKER_GRANT_POLICY_INVALID")
  return parsed.map((item) => {
    if (!isObject(item)) throw new TypeError("BROKER_GRANT_POLICY_INVALID")
    const provider = readUnion(item, "provider", ["kimi", "deepseek"] as const)
    const model = readUnion(item, "model", ["kimi-k3", "deepseek-v4-pro", "deepseek-v4-flash"] as const)
    const protocol = readUnion(item, "protocol", ["chat_completions", "responses"] as const)
    const route = { provider, model, protocol }
    const permitted = new Set([
      "kimi/kimi-k3/chat_completions",
      "deepseek/deepseek-v4-pro/responses",
      "deepseek/deepseek-v4-flash/responses",
    ])
    if (!permitted.has(routeKey(route))) throw new TypeError("BROKER_GRANT_POLICY_INVALID")
    return route
  })
}

function validateReservation(input: ReservationInput): void {
  for (const value of [input.requestID, input.campaignID, input.runID]) {
    if (!idPattern.test(value)) throw new TypeError("BROKER_RESERVATION_IDENTITY_INVALID")
  }
  if (!sha256Pattern.test(input.requestSha256) || !sha256Pattern.test(input.priceSha256)) {
    throw new TypeError("BROKER_RESERVATION_HASH_INVALID")
  }
  for (const value of [input.requestBytes, input.inputTokenBound, input.maximumOutputTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("BROKER_RESERVATION_NUMBER_INVALID")
  }
  if (!Number.isFinite(Date.parse(input.at))) throw new TypeError("BROKER_RESERVATION_TIME_INVALID")
}

function validateSettlement(input: SettlementInput): void {
  if (!idPattern.test(input.requestID) || !sha256Pattern.test(input.responseSha256)) {
    throw new TypeError("BROKER_SETTLEMENT_INVALID")
  }
  if (!Number.isSafeInteger(input.responseBytes) || input.responseBytes < 0)
    throw new TypeError("BROKER_SETTLEMENT_INVALID")
  if (input.at !== undefined && !Number.isFinite(Date.parse(input.at))) throw new TypeError("BROKER_SETTLEMENT_INVALID")
}

function verifyDatabasePath(value: string): string {
  const layout = Task24Root.ensure()
  if (!path.isAbsolute(value) || path.normalize(value) !== value || path.extname(value) !== ".sqlite") {
    throw new TypeError("BROKER_DATABASE_PATH_INVALID")
  }
  const resolved = path.resolve(value)
  const permitted = [layout.runs, layout.tmp].some((root) => resolved.startsWith(path.resolve(root) + path.sep))
  if (!permitted) throw new TypeError("BROKER_DATABASE_PATH_INVALID")
  let current = path.parse(resolved).root
  for (const segment of resolved.slice(current.length).split(path.sep).filter(Boolean).slice(0, -1)) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) throw new TypeError("BROKER_DATABASE_PARENT_MISSING")
    if (fs.lstatSync(current).isSymbolicLink()) throw new TypeError("BROKER_DATABASE_PATH_REDIRECTED")
  }
  return resolved
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readString(value: Record<string, unknown>, key: string): string {
  const result = value[key]
  if (typeof result !== "string") throw new TypeError("BROKER_LEDGER_RECORD_INVALID")
  return result
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const result = value[key]
  if (result !== null && typeof result !== "string") throw new TypeError("BROKER_LEDGER_RECORD_INVALID")
  return result
}

function readNumber(value: Record<string, unknown>, key: string): number {
  const result = value[key]
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    throw new TypeError("BROKER_LEDGER_RECORD_INVALID")
  }
  return result
}

function readLiteral<T extends string | number>(value: Record<string, unknown>, key: string, literal: T): T {
  if (value[key] !== literal) throw new TypeError("BROKER_LEDGER_RECORD_INVALID")
  return literal
}

function readUnion<const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const result = value[key]
  if (typeof result !== "string" || !allowed.includes(result)) throw new TypeError("BROKER_LEDGER_RECORD_INVALID")
  return result
}

function decodeUsage(value: unknown): ProviderUsage {
  if (!isObject(value)) throw new TypeError("BROKER_LEDGER_RECORD_INVALID")
  const usage = {
    inputTokens: readNumber(value, "inputTokens"),
    cachedInputTokens: readNumber(value, "cachedInputTokens"),
    outputTokens: readNumber(value, "outputTokens"),
    reasoningTokens: readNumber(value, "reasoningTokens"),
  }
  validateUsage(usage)
  return usage
}
