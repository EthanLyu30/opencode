import { readFileSync } from "node:fs"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { sha256Bytes, sha256Text } from "../hash"
import { freeze } from "../corpus/evaluation-profile"
import { directRoot } from "../corpus/evaluation-bundle"
import { bindEvidenceFile, verifyEvidenceFile, type EvidenceReference } from "../evaluator/evidence"
import { publishImmutable } from "../offline/atomic"
import { sessionState } from "./preflight"
import { isRealDockerRunner, requireDockerExecution } from "./docker"
import { decodeOwnedInspection, requireOwnedInspection, type Owner, type ContainerInspection } from "./ownership"
import { type DockerRunner, type EngineSession, type HostManifest, type DockerExecution } from "./contracts"

export type RequestBinding = Readonly<{
  candidateSha256: string
  configSha256: string
  profileSha256: string
  dependencySha256: string
  workerSha256: string
}>
export type OperationReceipt = Readonly<{
  schemaVersion: 2
  acceptanceID: string
  manifestSha256: string
  owner: Owner
  operation: string
  binding: RequestBinding | null
  argvSha256: string
  inspection: ContainerInspection
  exitCode: number
  started: boolean
  truncated: boolean
  stdoutSha256: string
  stderrSha256: string
  assurance: "fixture" | "linux-attested"
  evidence: EvidenceReference
  receiptSha256: string
}>
const issued = new WeakSet<object>()
export function requireOperationReceipt(receipt: OperationReceipt) {
  if (!issued.has(receipt)) throw new TypeError("TASK24_LINUX_RECEIPT_AUTHORITY")
}
export async function recordOperationReceipt(input: {
  session: EngineSession
  runner: DockerRunner
  owner: Owner
  operation: string
  binding: RequestBinding | null
  argv: readonly string[]
  inspect: unknown
  execution: DockerExecution
  evidenceRoot: string
}): Promise<OperationReceipt> {
  if (isRealDockerRunner(input.runner)) {
    requireDockerExecution(input.runner, input.execution, input.argv)
    if (!input.inspect || typeof input.inspect !== "object") throw new TypeError("TASK24_LINUX_INSPECT_AUTHORITY")
    requireOwnedInspection(input.inspect, input.session, input.runner, input.owner)
  }
  const state = sessionState(input.session),
    inspection = decodeOwnedInspection(input.inspect, input.owner, input.session)
  if (
    !/^[a-z][a-z-]{0,63}$/.test(input.operation) ||
    (input.binding && Object.values(input.binding).some((h) => !/^[a-f0-9]{64}$/.test(h)))
  )
    throw new TypeError("TASK24_LINUX_RECEIPT_BINDING")
  await directRoot(input.evidenceRoot)
  if (
    input.evidenceRoot !== state.manifest.roots.evidence &&
    !input.evidenceRoot.startsWith(state.manifest.roots.evidence + path.sep)
  )
    throw new TypeError("TASK24_LINUX_EVIDENCE_ROOT")
  const body = {
    schemaVersion: 2 as const,
    acceptanceID: input.session.acceptanceID,
    manifestSha256: input.session.manifestSha256,
    owner: input.owner,
    operation: input.operation,
    binding: input.binding,
    argvSha256: sha256Text(canonicalJson(input.argv)),
    inspection,
    exitCode: input.execution.exitCode,
    started: input.execution.started,
    truncated: input.execution.truncated,
    stdoutSha256: sha256Bytes(input.execution.stdout),
    stderrSha256: sha256Bytes(input.execution.stderr),
    assurance: isRealDockerRunner(input.runner) ? ("linux-attested" as const) : ("fixture" as const),
  }
  const receiptSha256 = sha256Text(canonicalJson(body)),
    file = path.join(input.evidenceRoot, `operation-${receiptSha256}.json`)
  await publishImmutable(file, canonicalJson(body))
  const receipt = freeze({
    ...body,
    evidence: bindEvidenceFile(input.evidenceRoot, file, "linux-operation"),
    receiptSha256,
  })
  issued.add(receipt)
  return receipt
}
export function verifyOperationReceipt(input: {
  receipt: OperationReceipt
  manifest: HostManifest
  evidenceRoot: string
}): OperationReceipt {
  const receipt = input.receipt
  if (
    receipt.schemaVersion !== 2 ||
    receipt.manifestSha256 !== sha256Text(canonicalJson(input.manifest)) ||
    receipt.acceptanceID !== input.manifest.acceptanceID
  )
    throw new TypeError("TASK24_LINUX_RECEIPT_IDENTITY")
  verifyEvidenceFile(input.evidenceRoot, receipt.evidence)
  const body: unknown = JSON.parse(readFileSync(path.join(input.evidenceRoot, receipt.evidence.relativePath), "utf8"))
  const { evidence, receiptSha256, ...expected } = receipt
  if (canonicalJson(body) !== canonicalJson(expected) || sha256Text(canonicalJson(body)) !== receiptSha256)
    throw new TypeError("TASK24_LINUX_RECEIPT_DRIFT")
  return freeze(receipt)
}
