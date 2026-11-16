import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { Sha256 } from "../schema"
import type { HostManifest } from "./contracts"
import { registerCalibrationAuthority, type LinuxAuthority } from "./evaluation-host"
import { publishImmutable } from "../offline/atomic"

/**
 * Calibration-only authority records that a real Linux host produced the evaluation evidence while the
 * Task24 engine acceptance (security matrix plus A-E capability micro tests) was deliberately not run.
 * It is never readiness-eligible: verifyLinuxReadiness still requires an issued engine receipt and five
 * capability receipts, so a calibration report can never become a Task24 readiness claim.
 */
const Statement = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  kind: Schema.Literal("calibration-only"),
  readinessEligible: Schema.Literal(false),
  purpose: Schema.Literal("linux-oracle-calibration-not-task24-readiness"),
  acceptanceID: Schema.String,
  manifestSha256: Sha256,
  sourceSha256: Sha256,
  planSha256: Sha256,
  engineID: Schema.String,
  omitted: Schema.Array(Schema.Literals(["engine-acceptance", "capability-micro-tests"])),
  issuedAt: Schema.Int,
})
export type CalibrationStatement = typeof Statement.Type & Readonly<{ statementSha256: string }>

export async function issueCalibrationAuthority(input: {
  manifest: HostManifest
  evidenceRoot: string
  issuedAt?: number
}): Promise<LinuxAuthority> {
  if (input.manifest.phase !== "accept") throw new TypeError("TASK24_CALIBRATION_AUTHORITY_PHASE")
  const images = input.manifest.artifacts.filter((artifact) => artifact.kind === "image")
  if (
    images.length < 16 ||
    !images.some((artifact) => artifact.id === "linux-runtime") ||
    ["dependencies", "browser", "fonts", "controller-inventory"].some(
      (id) => !input.manifest.artifacts.some((artifact) => artifact.id === id),
    )
  )
    throw new TypeError("TASK24_CALIBRATION_AUTHORITY_ARTIFACTS")
  const manifestSha256 = sha256Text(canonicalJson(input.manifest)),
    body = {
      schemaVersion: 2 as const,
      kind: "calibration-only" as const,
      readinessEligible: false as const,
      purpose: "linux-oracle-calibration-not-task24-readiness" as const,
      acceptanceID: input.manifest.acceptanceID,
      manifestSha256,
      sourceSha256: input.manifest.sourceSha256,
      planSha256: input.manifest.planSha256,
      engineID: input.manifest.engine.serverID,
      omitted: ["engine-acceptance", "capability-micro-tests"] as const,
      issuedAt: input.issuedAt ?? Date.now(),
    },
    statement = Object.freeze({
      ...body,
      statementSha256: sha256Text(canonicalJson(body)),
    }) as CalibrationStatement,
    file = path.join(input.evidenceRoot, `calibration-authority-${statement.statementSha256}.json`),
    text = canonicalJson(statement)
  await publishImmutable(file, text)
  return registerCalibrationAuthority({
    manifest: input.manifest,
    evidenceRoot: input.evidenceRoot,
    statementSha256: statement.statementSha256,
    verify() {
      const current = fs.readFileSync(file, "utf8"),
        parsed = JSON.parse(current) as CalibrationStatement,
        rest = { ...parsed }
      delete (rest as { statementSha256?: string }).statementSha256
      if (
        current !== text ||
        parsed.statementSha256 !== statement.statementSha256 ||
        sha256Text(canonicalJson(rest)) !== statement.statementSha256 ||
        parsed.manifestSha256 !== manifestSha256
      )
        throw new TypeError("TASK24_CALIBRATION_AUTHORITY_STATEMENT")
      return Schema.decodeUnknownSync(Statement)(rest, { onExcessProperty: "error" })
    },
  })
}
