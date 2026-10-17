import { canonicalJson } from "../campaign/canonical"
import type { HostManifest } from "./contracts"
import type { OperationReceipt } from "./receipt"
import { sha256Text } from "../hash"
export const engineCheckIDs = [
  "engine-storage-image",
  "privilege-root",
  "network-canary",
  "mounts-archive",
  "build-noexec-dotenv",
  "bounded-resources",
  "preview-browser-pdf",
  "exact-production-tools",
  "cancellation-recovery",
  "foreign-isolation",
] as const
export type EngineCheckID = (typeof engineCheckIDs)[number]
export type EngineReceipt = Readonly<{
  schemaVersion: 2
  acceptanceID: string
  manifestSha256: string
  checks: readonly { id: EngineCheckID; receipt: OperationReceipt }[]
  receiptSha256: string
}>
// The acceptance implementation is the sole issuer. Until its matrix executes there is no authority.
const issued = new WeakSet<object>()
export function requireEngineReceipt(receipt: EngineReceipt, manifest: HostManifest) {
  if (
    !issued.has(receipt) ||
    receipt.manifestSha256 !== sha256Text(canonicalJson(manifest)) ||
    receipt.acceptanceID !== manifest.acceptanceID
  )
    throw new TypeError("TASK24_ENGINE_RECEIPT_AUTHORITY")
}
