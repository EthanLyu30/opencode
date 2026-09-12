import type { ReportModel } from "./model"

export function evidenceIndex(value: ReportModel) {
  return Object.freeze({
    schemaVersion: 1 as const,
    campaignID: value.campaignID,
    evaluatorSha256: value.metadata.evaluatorSha256,
    hashes: Object.freeze([...value.evidenceHashes].toSorted()),
  })
}
