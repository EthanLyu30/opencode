import { canonicalJson } from "../../campaign/canonical"
import {
  freeze,
  type CheckCommand,
  type DependencyResolution,
  type EvaluationIdentityV2,
  type TaskExecutionProfile,
} from "../../corpus/evaluation-profile"
import type { FileEntry } from "../../corpus/manifest"
import { sha256Text } from "../../hash"
import { decodeProbeResponse, type ProbeResponse } from "./probe"
import { validateCandidateEntries } from "./snapshot"
import { requireLinuxObservation } from "../../sandbox/evaluation-host"

export type CandidateReference = Readonly<{
  archiveFile: string
  archiveSha256: string
  candidateSha256: string
  configSha256: string
}>
export type CommonRequest = Readonly<{
  identity: EvaluationIdentityV2
  candidate: CandidateReference
  profileSha256: string
  timeoutMs: number
}>
export type BuildRequest = CommonRequest &
  Readonly<{ commands: readonly CheckCommand[]; dependency: DependencyResolution }>
export type ProbeRequest = CommonRequest &
  Readonly<{
    module: string
    inputs: readonly { id: string; fixtures?: Readonly<Record<string, unknown>> }[]
    operations: readonly {
      id: string
      steps: readonly { kind: string; target: string; args: readonly unknown[]; store?: string }[]
    }[]
  }>
export type BuildManifest = Readonly<{
  candidateSha256: string
  configSha256: string
  dependencySha256: string
  files: readonly FileEntry[]
  buildSha256: string
}>
export function buildManifest(value: Omit<BuildManifest, "buildSha256">): BuildManifest {
  validateCandidateEntries(value.files)
  for (const hash of [value.candidateSha256, value.configSha256, value.dependencySha256])
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError("TASK24_BUILD_HASH_INVALID")
  return freeze({ ...value, buildSha256: sha256Text(canonicalJson(value)) })
}
export type PreviewRequest = CommonRequest &
  Readonly<{ build: BuildManifest; preview: NonNullable<TaskExecutionProfile["preview"]> }>
export type BuildPayload = Readonly<{
  kind: "ok"
  commands: readonly { id: string; exitCode: number }[]
  build: BuildManifest
}>
export type ProbePayload = Readonly<{ kind: "ok"; response: ProbeResponse }>
export type PreviewPayload = Readonly<{
  kind: "ok"
  handle: string
  buildSha256: string
  browserSha256: string
  fontSha256: string
  previewID?: string
}>
export type FailurePayload =
  | Readonly<{ kind: "candidate_failure"; reason: string }>
  | Readonly<{ kind: "unavailable"; reason: string }>
type Bound<T> = T &
  Readonly<{
    identity: EvaluationIdentityV2
    candidate: CandidateReference
    profileSha256: string
    assurance: "fixture" | "linux-attested"
    hostReceiptSha256: string
  }>
export type BuildObservation = Bound<BuildPayload | FailurePayload>
export type ProbeObservation = Bound<ProbePayload | FailurePayload>
export type PreviewObservation = Bound<PreviewPayload | FailurePayload>
export interface EvaluationHost {
  build(request: BuildRequest): Promise<BuildObservation>
  probe(request: ProbeRequest): Promise<ProbeObservation>
  preview(request: PreviewRequest): Promise<PreviewObservation>
}
const issued = new WeakSet<object>()
export function requireFixtureObservation(observation: object): void {
  if (!issued.has(observation)) throw new TypeError("TASK24_HOST_AUTHORITY_INVALID")
}
/** Test-only assurance: it deliberately cannot mint a Linux attestation. */
export function fixtureObservation<T extends BuildPayload | ProbePayload | PreviewPayload | FailurePayload>(
  request: CommonRequest,
  payload: T,
): Bound<T> {
  const base = {
    ...structuredClone(payload),
    identity: request.identity,
    candidate: request.candidate,
    profileSha256: request.profileSha256,
    assurance: "fixture" as const,
  }
  const o = freeze({ ...base, hostReceiptSha256: sha256Text(canonicalJson(base)) })
  issued.add(o)
  return o
}
export function validateObservation(
  request: CommonRequest,
  observation: BuildObservation | ProbeObservation | PreviewObservation,
): void {
  if (observation.assurance === "linux-attested") requireLinuxObservation(observation)
  else if (!issued.has(observation) || observation.assurance !== "fixture")
    throw new TypeError("TASK24_HOST_AUTHORITY_INVALID")
  if (
    canonicalJson(observation.identity) !== canonicalJson(request.identity) ||
    canonicalJson(observation.candidate) !== canonicalJson(request.candidate) ||
    observation.profileSha256 !== request.profileSha256
  )
    throw new TypeError("TASK24_HOST_IDENTITY_INVALID")
  if (observation.kind === "ok" && "response" in observation)
    decodeProbeResponse(Buffer.from(canonicalJson(observation.response)))
  if (observation.kind === "ok" && "build" in observation) {
    const { buildSha256, ...value } = observation.build
    if (
      buildManifest(value).buildSha256 !== buildSha256 ||
      value.candidateSha256 !== request.candidate.candidateSha256 ||
      value.configSha256 !== request.candidate.configSha256
    )
      throw new TypeError("TASK24_BUILD_IDENTITY_INVALID")
    if (!observation.commands.length || observation.commands.some((c) => !Number.isInteger(c.exitCode)))
      throw new TypeError("TASK24_BUILD_COMMAND_INVALID")
  }
}
export function makeUnavailableEvaluationHost(): EvaluationHost {
  const unavailable = async (r: CommonRequest) =>
    fixtureObservation(r, { kind: "unavailable" as const, reason: "EVALUATION_HOST_UNAVAILABLE" })
  return { build: unavailable, probe: unavailable, preview: unavailable }
}
