import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { Sha256 } from "../../schema"
import { StorageRecord } from "../contracts"
import { directoryIdentity } from "../storage"
import { type DesktopPlatform, type DesktopPreparedProfile, type DesktopLaunchApproval } from "./contracts"
import { requireDesktopConsumedGrant, readDesktopConsumedRecordAnchor } from "./profile"
import { requireDesktopPlan } from "./planning"
import { isNativeDesktopPlatform } from "./platform"
import { canonicalDesktopPath, readDesktopText } from "./compatibility"
import { withDesktopRecordPublication } from "./publication"

const Code = Schema.NonEmptyString.check(Schema.isPattern(/^[a-zA-Z0-9_.:-]{1,200}$/))
const ID = Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/))
const Ready = {
  engine_verified: Schema.Literal(false),
  tool_capability_verified: Schema.Literal(false),
  corpus_engine_ready: Schema.Literal(false),
}
const Status = Schema.Literals(["inventory_observed_not_accepted", "blocked", "cleanup_uncertain"])
const Inventory = Schema.Struct({
  launchID: ID,
  assurance: Schema.Literals(["fixture", "native"]),
  status: Status,
  missing: Schema.Array(Code),
  observationSha256: Sha256,
  storage: Schema.NullOr(StorageRecord),
  profileEndpoint: Schema.NullOr(Schema.String),
  productionDefaultEndpoint: Schema.NullOr(Schema.String),
  production_default_compatible: Schema.NullOr(Schema.Boolean),
  ...Ready,
})
const Record = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  launchID: ID,
  specSha256: Sha256,
  planSha256: Sha256,
  compatibilitySha256: Sha256,
  manifestSha256: Sha256,
  status: Status,
  code: Code,
  missing: Schema.Array(Code),
  inventory: Schema.NullOr(Inventory),
  cleanup: Schema.Literals(["stopped", "uncertain", "not_needed"]),
  ...Ready,
})
export type DesktopLaunchRecord = typeof Record.Type
const fixtureRecords = new WeakMap<
  DesktopPlatform,
  Map<string, { file: string; anchor: { path: string; identity: string } }>
>()
export function decodeDesktopLaunchRecord(raw: unknown): DesktopLaunchRecord {
  const result = Schema.decodeUnknownSync(Record)(raw, { onExcessProperty: "error" })
  if (
    Buffer.byteLength(canonicalJson(result)) > 65536 ||
    result.missing.length > 128 ||
    (result.inventory && (result.inventory.launchID !== result.launchID || result.inventory.missing.length > 128)) ||
    (result.cleanup === "uncertain" && result.status !== "cleanup_uncertain")
  )
    throw new TypeError("TASK24_DESKTOP_RECORD_BINDING")
  return freeze(result)
}
export async function publishDesktopLaunchRecord(input: {
  profile: DesktopPreparedProfile
  approval: DesktopLaunchApproval
  record: DesktopLaunchRecord
}) {
  requireDesktopConsumedGrant(input.profile, input.approval)
  const platform = requireDesktopPlan(input.profile.plan),
    native = isNativeDesktopPlatform(platform)
  const plan = input.profile.plan,
    approval = input.approval
  const record = decodeDesktopLaunchRecord(input.record)
  if (
    record.launchID !== approval.launchID ||
    record.specSha256 !== plan.specSha256 ||
    record.planSha256 !== plan.planSha256 ||
    record.compatibilitySha256 !== plan.compatibilitySha256 ||
    record.manifestSha256 !== input.profile.manifestSha256 ||
    (record.inventory && record.inventory.assurance !== (native ? "native" : "fixture"))
  )
    throw new TypeError("TASK24_DESKTOP_RECORD_BINDING")
  const anchor = readDesktopConsumedRecordAnchor(input.profile, approval)
  if (
    (await directoryIdentity(anchor.path)) !== anchor.identity ||
    (await directoryIdentity(plan.paths.root)) !== input.profile.rootIdentity
  )
    throw new TypeError("TASK24_DESKTOP_PARENT_DRIFT")
  if (!native) {
    const temp = canonicalDesktopPath(process.env.TMPDIR ?? "")
    if (!/^D:\\OpenCode-Benchmark\\Task24\\tmp\\bprep1-[^\\]+$/i.test(temp) || !anchor.path.startsWith(temp + path.sep))
      throw new TypeError("TASK24_DESKTOP_FIXTURE_SCOPE")
    const owner = Schema.decodeUnknownSync(
      Schema.Struct({ nonce: Schema.Literal("bprep2-0786b1f11abc"), runOwner: Schema.String }),
    )(JSON.parse((await readDesktopText(path.join(temp, "owner.json"))).text), { onExcessProperty: "error" })
    if (!/^[a-z0-9-]{8,128}$/.test(owner.runOwner)) throw new TypeError("TASK24_DESKTOP_FIXTURE_SCOPE")
  }
  const root = path.join(anchor.path, "reports", "desktop-launch", record.launchID)
  const file = await withDesktopRecordPublication(
    root,
    (publication) => publication.write("inventory.json", canonicalJson(record)),
    anchor,
  )
  if (!native) {
    const records = fixtureRecords.get(platform) ?? new Map()
    records.set(record.launchID, { file: file.path, anchor })
    fixtureRecords.set(platform, records)
  }
  return file
}
/** Historical data only. No session, approval or engine capability is reconstructed. */
export async function readDesktopLaunchRecord(platform: DesktopPlatform, launchID: string) {
  Schema.decodeUnknownSync(ID)(launchID)
  const fixture = fixtureRecords.get(platform)?.get(launchID)
  const file = isNativeDesktopPlatform(platform)
    ? path.join("D:\\OpenCode-Benchmark\\Task24\\reports\\desktop-launch", launchID, "inventory.json")
    : fixture?.file
  if (!file || !(await fs.exists(file))) return null
  if (fixture && (await directoryIdentity(fixture.anchor.path)) !== fixture.anchor.identity)
    throw new TypeError("TASK24_DESKTOP_PARENT_DRIFT")
  const text = await readDesktopText(file, 65536)
  const record = decodeDesktopLaunchRecord(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(text.text))
  if (record.launchID !== launchID) throw new TypeError("TASK24_DESKTOP_RECORD_BINDING")
  return { recordSha256: text.sha256, record, live: false as const }
}
