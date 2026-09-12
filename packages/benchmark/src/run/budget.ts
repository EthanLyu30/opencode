import { createHmac, timingSafeEqual } from "node:crypto"
import { canonicalJson } from "../campaign/canonical"

export type CampaignStage = "offline" | "pilot" | "campaign"

export interface ApprovalAuthority {
  readonly campaignID: string
  readonly campaignSha256: string
  readonly stage: Exclude<CampaignStage, "offline">
  readonly stageSha256: string
  readonly expiresAt: number
  readonly ceilings: Readonly<{ CNY: string; USD: string }>
}

export interface StageApproval extends ApprovalAuthority {
  readonly schemaVersion: 1
  readonly signatureSha256: string
}

export function decodeStageApproval(input: unknown): StageApproval {
  if (!isRecord(input)) {
    throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  }
  const value = input
  if (
    !sameKeys(value, [
      "schemaVersion",
      "campaignID",
      "campaignSha256",
      "stage",
      "stageSha256",
      "expiresAt",
      "ceilings",
      "signatureSha256",
    ])
  ) {
    throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  }
  const ceilings = value.ceilings
  if (ceilings === null || typeof ceilings !== "object" || Array.isArray(ceilings)) {
    throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  }
  if (!sameKeys(ceilings, ["CNY", "USD"])) throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  const result = {
    schemaVersion: value.schemaVersion,
    campaignID: value.campaignID,
    campaignSha256: value.campaignSha256,
    stage: value.stage,
    stageSha256: value.stageSha256,
    expiresAt: value.expiresAt,
    ceilings: { CNY: Reflect.get(ceilings, "CNY"), USD: Reflect.get(ceilings, "USD") },
    signatureSha256: value.signatureSha256,
  }
  if (
    result.schemaVersion !== 1 ||
    typeof result.campaignID !== "string" ||
    typeof result.campaignSha256 !== "string" ||
    (result.stage !== "pilot" && result.stage !== "campaign") ||
    typeof result.stageSha256 !== "string" ||
    typeof result.expiresAt !== "number" ||
    typeof result.ceilings.CNY !== "string" ||
    typeof result.ceilings.USD !== "string" ||
    typeof result.signatureSha256 !== "string"
  ) {
    throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  }
  const decoded: StageApproval = {
    schemaVersion: 1,
    campaignID: result.campaignID,
    campaignSha256: result.campaignSha256,
    stage: result.stage,
    stageSha256: result.stageSha256,
    expiresAt: result.expiresAt,
    ceilings: result.ceilings,
    signatureSha256: result.signatureSha256,
  }
  validateAuthority(decoded)
  if (!/^[a-f0-9]{64}$/.test(decoded.signatureSha256)) throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  return Object.freeze(decoded)
}

export function signStageApproval(authority: ApprovalAuthority, localSecret: string): StageApproval {
  validateAuthority(authority)
  validateSecret(localSecret)
  const body = Object.freeze({
    schemaVersion: 1 as const,
    ...authority,
    ceilings: Object.freeze({ ...authority.ceilings }),
  })
  return Object.freeze({ ...body, signatureSha256: signature(body, localSecret) })
}

export function requireStageApproval(
  stage: CampaignStage,
  approval: StageApproval | undefined,
  expected: ApprovalAuthority | undefined,
  localSecret: string | undefined,
  now: number,
): Readonly<{ CNY: bigint; USD: bigint }> {
  if (stage === "offline") return Object.freeze({ CNY: 0n, USD: 0n })
  if (!approval || !expected || !localSecret) throw new TypeError("TASK24_STAGE_APPROVAL_REQUIRED")
  validateAuthority(approval)
  validateAuthority(expected)
  validateSecret(localSecret)
  if (!/^[a-f0-9]{64}$/.test(approval.signatureSha256)) throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  if (approval.expiresAt <= now) throw new TypeError("TASK24_STAGE_APPROVAL_EXPIRED")
  const body = {
    schemaVersion: 1 as const,
    campaignID: approval.campaignID,
    campaignSha256: approval.campaignSha256,
    stage: approval.stage,
    stageSha256: approval.stageSha256,
    expiresAt: approval.expiresAt,
    ceilings: approval.ceilings,
  }
  if (!same(signature(body, localSecret), approval.signatureSha256))
    throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  for (const key of ["campaignID", "campaignSha256", "stage", "stageSha256", "expiresAt"] as const) {
    if (approval[key] !== expected[key]) throw new TypeError("TASK24_STAGE_APPROVAL_MISMATCH")
  }
  if (approval.stage !== stage || canonicalJson(approval.ceilings) !== canonicalJson(expected.ceilings)) {
    throw new TypeError("TASK24_STAGE_APPROVAL_MISMATCH")
  }
  return Object.freeze({ CNY: BigInt(approval.ceilings.CNY), USD: BigInt(approval.ceilings.USD) })
}

function validateAuthority(authority: ApprovalAuthority): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(authority.campaignID)) throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  if (authority.stage !== "pilot" && authority.stage !== "campaign")
    throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  if (!/^[a-f0-9]{64}$/.test(authority.campaignSha256) || !/^[a-f0-9]{64}$/.test(authority.stageSha256)) {
    throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  }
  if (!Number.isSafeInteger(authority.expiresAt) || authority.expiresAt <= 0) {
    throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  }
  for (const value of Object.values(authority.ceilings)) {
    if (!/^[1-9]\d*$/.test(value)) throw new TypeError("TASK24_STAGE_APPROVAL_INVALID")
  }
}

function validateSecret(value: string): void {
  if (value.length < 32) throw new TypeError("TASK24_STAGE_APPROVAL_SECRET_INVALID")
}

function signature(value: object, secret: string): string {
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("hex")
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex")
  const b = Buffer.from(right, "hex")
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sameKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...expected].toSorted())
}
