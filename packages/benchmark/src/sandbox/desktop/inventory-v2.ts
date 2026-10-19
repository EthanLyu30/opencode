import path from "node:path"
import { canonicalJson } from "../../campaign/canonical"
import { requireDesktopConsumedGrantV2, readDesktopConsumedRecordAnchorV2 } from "./profile-v2"
import { requireDesktopPlanV2 } from "./planning-v2"
import { decodeDesktopLaunchRecord, type DesktopLaunchRecord } from "./inventory"
import { readDesktopDirectoryV2, readDesktopFileV2 } from "./identity-v2"
import { withDesktopPublicationV2 } from "./publication-v2"
import { parseDesktopSettingsJson } from "./settings-json"
import type { DesktopPlatform } from "./contracts"
import type { DesktopPreparedProfileV2, DesktopLaunchApprovalV2 } from "./v2-contracts"
const records = new WeakMap<
  DesktopPlatform,
  Map<string, { file: string; anchor: { path: string; identity: string } }>
>()
export async function publishDesktopLaunchRecordV2(input: {
  profile: DesktopPreparedProfileV2
  approval: DesktopLaunchApprovalV2
  record: DesktopLaunchRecord
}) {
  requireDesktopConsumedGrantV2(input.profile, input.approval)
  const plan = input.profile.plan,
    platform = requireDesktopPlanV2(plan),
    record = decodeDesktopLaunchRecord(input.record)
  if (
    record.schemaVersion !== 2 ||
    record.launchID !== input.approval.launchID ||
    record.specSha256 !== plan.specSha256 ||
    record.planSha256 !== plan.planSha256 ||
    record.compatibilitySha256 !== plan.compatibilitySha256 ||
    record.manifestSha256 !== input.profile.manifestSha256 ||
    record.intentSha256 !== plan.intentSha256 ||
    record.policySha256 !== plan.policySha256 ||
    (record.inventory && record.inventory.assurance !== "fixture")
  )
    throw new TypeError("TASK24_DESKTOP_RECORD_BINDING")
  const anchor = readDesktopConsumedRecordAnchorV2(input.profile, input.approval),
    proof = await readDesktopDirectoryV2(anchor.path)
  if (
    proof.fileID !== anchor.identity ||
    (await readDesktopDirectoryV2(plan.paths.root)).fileID !== input.profile.rootIdentity
  )
    throw new TypeError("TASK24_DESKTOP_PARENT_DRIFT")
  const file = await withDesktopPublicationV2(
    {
      root: anchor.path,
      mode: "record",
      recordID: record.launchID,
      parents: proof.parents,
      signal: AbortSignal.timeout(30000),
    },
    (io) => io.write(path.join("reports", "desktop-launch", record.launchID, "inventory.json"), canonicalJson(record)),
  )
  const map = records.get(platform) ?? new Map()
  map.set(record.launchID, { file: file.path, anchor })
  records.set(platform, map)
  return file
}
/** Data only, deliberately incapable of restoring a live session or cleanup authority. */
export async function readDesktopLaunchRecordV2(platform: DesktopPlatform, launchID: string) {
  const saved = records.get(platform)?.get(launchID)
  if (!saved) return null
  if ((await readDesktopDirectoryV2(saved.anchor.path)).fileID !== saved.anchor.identity)
    throw new TypeError("TASK24_DESKTOP_PARENT_DRIFT")
  const file = await readDesktopFileV2(saved.file, 65536),
    record = decodeDesktopLaunchRecord(parseDesktopSettingsJson(file.bytes, 65536))
  if (record.schemaVersion !== 2 || record.launchID !== launchID) throw new TypeError("TASK24_DESKTOP_RECORD_BINDING")
  return { recordSha256: file.identity.sha256, record, live: false as const }
}
